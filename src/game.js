import * as THREE from "three";
import { PointerLockControls } from "three/addons/controls/PointerLockControls.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { DecalGeometry } from "three/addons/geometries/DecalGeometry.js";
import Stats from "three/addons/libs/stats.module.js";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { SMAAPass } from "three/addons/postprocessing/SMAAPass.js";
import {
  MeshBVH,
  acceleratedRaycast,
  computeBoundsTree,
  disposeBoundsTree,
} from "three-mesh-bvh";
import { N8AOPass } from "n8ao";
import {
  MAZE_COLS,
  MAZE_ROWS,
  CELL_SIZE,
  WALL_HEIGHT,
  PLAYER_HEIGHT,
  PLAYER_RADIUS,
  PLAYER_SPEED,
  SPRINT_MULTIPLIER,
  WALL_POM_HEIGHT_SCALE_DEFAULT,
  WALL_POM_MIN_LAYERS,
  WALL_POM_MAX_LAYERS,
  FLOOR_POM_HEIGHT_SCALE,
  FLOOR_POM_MIN_LAYERS,
  FLOOR_POM_MAX_LAYERS,
  ROOF_POM_HEIGHT_SCALE,
  ROOF_POM_MIN_LAYERS,
  ROOF_POM_MAX_LAYERS,
  TARGET_FRAME_INTERVAL_MS,
  FLASHLIGHT_BASE_INTENSITY,
  FLASHLIGHT_BASE_DISTANCE,
  FLASHLIGHT_FLICKER_RATE,
  FLASHLIGHT_FLICKER_MIN_HOLD,
  FLASHLIGHT_FLICKER_MAX_HOLD,
  FLASHLIGHT_FLICKER_MIN_INTENSITY,
  FLASHLIGHT_FLICKER_MAX_INTENSITY,
  FLASHLIGHT_FLICKER_DROP_CHANCE,
  FLASHLIGHT_BOUNCE_EMA_HALF_LIFE,
  FLASHLIGHT_BOUNCE_POSITION_EMA_HALF_LIFE,
  TWO_PI,
  GAMEPLAY_HINT,
} from "./config.js";
import { createTextureHelpers } from "./graphics/textures.js";
import {
  inferWallHeightTexture,
  applyParallaxOcclusionToMaterial,
} from "./graphics/pom.js";
import { loadFlashlightModel } from "./entities/flashlightModel.js";
import {
  buildWallSurfaceGeometry,
  generateMaze,
  findFarthestOpenCell,
  findPath,
  collectNearbyCells,
} from "./world/maze.js";
import { createWarehousePropScatter } from "./world/props.js";
import { createPickupSystem } from "./world/pickups.js";

THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
THREE.BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree;
THREE.Mesh.prototype.raycast = acceleratedRaycast;
const PISTOL_MUZZLE_FLASH_FRAME_COUNT = 4;
const PISTOL_MUZZLE_FLASH_FRAME_WIDTH = 1 / PISTOL_MUZZLE_FLASH_FRAME_COUNT;

const app = document.querySelector("#app");
const overlay = document.querySelector("#overlay");
const startButton = document.querySelector("#start-btn");
const status = document.querySelector("#status");
const crosshair = document.querySelector("#crosshair");
const inventoryRadial = document.querySelector("#inventory-radial");
const inventoryCount = document.querySelector("#inventory-count");
const interactionHint = document.querySelector("#interaction-hint");
const healthRingFill = document.querySelector("#health-ring-fill");
const healthRingLoss = document.querySelector("#health-ring-loss");
const healthHeartImage = document.querySelector("#health-heart-image");
const consumeProgress = document.querySelector("#consume-progress");
const consumeProgressFill = document.querySelector("#consume-progress-fill");
const consumeProgressLabel = document.querySelector("#consume-progress-label");
const sodaBoostIndicator = document.querySelector("#soda-boost-indicator");
const sodaBoostTimer = document.querySelector("#soda-boost-timer");
const regenIndicator = document.querySelector("#regen-indicator");
const regenTimer = document.querySelector("#regen-timer");

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x101117);
const mazeFog = new THREE.Fog(0x101117, 12, 120);
scene.fog = mazeFog;

const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 300);
camera.position.set(0, PLAYER_HEIGHT, 0);
const topDownCamera = new THREE.PerspectiveCamera(56, window.innerWidth / window.innerHeight, 0.1, 500);
scene.add(camera);

const renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: "high-performance" });
const initialPixelRatio = 1;
renderer.setPixelRatio(initialPixelRatio);
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.setClearColor(0x101117, 1);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
app.append(renderer.domElement);

const stats = new Stats();
stats.showPanel(0);
stats.dom.style.zIndex = "6";
document.body.append(stats.dom);

const composer = new EffectComposer(renderer);
const n8aoPass = new N8AOPass(scene, camera, window.innerWidth, window.innerHeight);
const smaaPass = new SMAAPass(
  Math.floor(window.innerWidth * initialPixelRatio),
  Math.floor(window.innerHeight * initialPixelRatio),
);
if (n8aoPass.configuration) {
  n8aoPass.configuration.aoRadius = 1.0;
  n8aoPass.configuration.distanceFalloff = 0.2;
  n8aoPass.configuration.intensity = 5.0;
  n8aoPass.configuration.screenSpaceRadius = false;
  n8aoPass.configuration.gammaCorrection = true;
}
n8aoPass.setDisplayMode("Combined");
composer.addPass(n8aoPass);
composer.addPass(smaaPass);
composer.setPixelRatio(initialPixelRatio);
composer.setSize(window.innerWidth, window.innerHeight);

const textureLoader = new THREE.TextureLoader();
const modelLoader = new GLTFLoader();
const maxAnisotropy = renderer.capabilities.getMaxAnisotropy();
const FLASHLIGHT_BOUNCE_DEFAULT_REFLECTANCE = new THREE.Color(0.6, 0.6, 0.6);
const { loadTextureSet, loadSpotlightMapTexture } = createTextureHelpers({
  textureLoader,
  maxAnisotropy,
  fallbackReflectance: FLASHLIGHT_BOUNCE_DEFAULT_REFLECTANCE,
});
const flashlightPatternTexture = loadSpotlightMapTexture(
  "./assets/textures/light/flashlight-pattern-incandescent.png",
);
const bulletDecalTexture = textureLoader.load(
  "./assets/textures/decals/bullet-hole-impact-cc0.png",
);
bulletDecalTexture.colorSpace = THREE.SRGBColorSpace;
bulletDecalTexture.wrapS = THREE.ClampToEdgeWrapping;
bulletDecalTexture.wrapT = THREE.ClampToEdgeWrapping;
const bulletDecalLitMaterial = new THREE.MeshStandardMaterial({
  map: bulletDecalTexture,
  color: 0xa3a3a3,
  transparent: true,
  alphaTest: 0.2,
  depthWrite: false,
  polygonOffset: true,
  polygonOffsetFactor: -4,
  side: THREE.DoubleSide,
  roughness: 1,
  metalness: 0,
});
const bulletDecalDebugMaterial = new THREE.MeshBasicMaterial({
  map: bulletDecalTexture,
  transparent: true,
  alphaTest: 0.1,
  depthWrite: false,
  polygonOffset: true,
  polygonOffsetFactor: -4,
  side: THREE.DoubleSide,
  color: 0xf8ece5,
  opacity: 0.92,
  toneMapped: false,
});
const muzzleFlashTexture = textureLoader.load(
  "./assets/textures/light/muzzle-flash-sheet-cc0.png",
);
muzzleFlashTexture.colorSpace = THREE.SRGBColorSpace;
muzzleFlashTexture.wrapS = THREE.ClampToEdgeWrapping;
muzzleFlashTexture.wrapT = THREE.ClampToEdgeWrapping;
// Use one frame from the 4-frame horizontal strip.
muzzleFlashTexture.repeat.set(PISTOL_MUZZLE_FLASH_FRAME_WIDTH, 1);
muzzleFlashTexture.offset.set(PISTOL_MUZZLE_FLASH_FRAME_WIDTH, 0);
muzzleFlashTexture.needsUpdate = true;
const pistolMuzzleFlashMaterial = new THREE.SpriteMaterial({
  map: muzzleFlashTexture,
  color: 0xffe2b0,
  transparent: true,
  opacity: 0,
  depthWrite: false,
  depthTest: true,
  blending: THREE.AdditiveBlending,
  toneMapped: false,
});

const controls = new PointerLockControls(camera, renderer.domElement);
const clock = new THREE.Clock();
const worldUp = new THREE.Vector3(0, 1, 0);
const forward = new THREE.Vector3();
const right = new THREE.Vector3();
const move = new THREE.Vector3();
const VIEW_BOB_BASE_FREQUENCY = 8.5;
const VIEW_BOB_BASE_AMPLITUDE = 0.035;
const VIEW_BOB_SMOOTHING = 12;
const PICKUP_INTERACT_DISTANCE = 1.9;
const INVENTORY_MAX_ITEMS = 8;
const INVENTORY_ROTATION_STEP_DEGREES = 360 / INVENTORY_MAX_ITEMS;
const INVENTORY_SLOT_RADIUS_PX = 90;
const PLAYER_MAX_HEALTH = 120;
const PLAYER_TEST_DAMAGE_PER_PRESS = 5;
const HEALTH_DAMAGE_TRAIL_DECAY_RATE = 3.2;
const HEALTH_DAMAGE_TRAIL_MIN_DELTA = 0.01;
const HEALTH_DAMAGE_TRAIL_HOLD_SECONDS = 0.12;
const JERKY_ITEM_ID = "meat_jerky_01";
const JERKY_HEAL_AMOUNT = 60;
const JERKY_CONSUME_DURATION_SECONDS = 2;
const JERKY_EAT_BOB_FREQUENCY = 3.6;
const JERKY_EAT_BOB_AMPLITUDE = 0.05;
const JERKY_EAT_BOB_DEPTH = 0.018;
const FIRST_AID_KIT_ITEM_ID = "first_aid_kit_01";
const FIRST_AID_KIT_HEAL_AMOUNT = 120;
const FIRST_AID_USE_DURATION_SECONDS = 4;
const FIRST_AID_REGEN_DURATION_SECONDS = 30;
const FIRST_AID_REGEN_PER_SECOND = 4;
const SODA_CAN_ITEM_ID = "soda_can_01";
const SODA_SPEED_MULTIPLIER = 1.5;
const SODA_USE_DURATION_SECONDS = 1;
const SODA_SPEED_DURATION_SECONDS = 30;
const HEALTH_HEARTBEAT_CYCLE_SECONDS = 1.45;
const HEALTH_HEARTBEAT_PRIMARY_TIME = 0.09;
const HEALTH_HEARTBEAT_SECONDARY_TIME = 0.24;
const HEALTH_HEARTBEAT_PRIMARY_AMPLITUDE = 0.11;
const HEALTH_HEARTBEAT_SECONDARY_AMPLITUDE = 0.18;
const HEALTH_HEARTBEAT_WIDTH = 0.035;
const PISTOL_ITEM_ID = "pistol_01";
const BULLET_ITEM_ID = "bullet_01";
const BASEBALL_BAT_ITEM_ID = "baseball_bat_01";
const PISTOL_FIRE_RANGE = 72;
const PISTOL_FIRE_COOLDOWN_SECONDS = 0.14;
const BULLET_DECAL_SIZE = 0.52;
const BULLET_DECAL_SIZE_VARIANCE = 0.1;
const BULLET_DECAL_MAX_COUNT = 10;
const PISTOL_RECOIL_RETURN_RATE = 17;
const PISTOL_RECOIL_POSITION_KICK = new THREE.Vector3(-0.045, -0.06, 0.24);
const PISTOL_RECOIL_ROTATION_KICK = new THREE.Vector3(-0.38, 0.1, 0.14);
const PISTOL_MUZZLE_FLASH_FALLBACK_LOCAL_POSITION = new THREE.Vector3(0.52, 0.04, -0.23);
const PISTOL_MUZZLE_FORWARD_WORLD_OFFSET = 0.09;
const PISTOL_MUZZLE_FLASH_DURATION = 0.11;
const PISTOL_PROP_DEBUG_MARKER_LIFETIME = 0.48;
const MELEE_WEAPON_CONFIG = {
  "knife_01": {
    displayName: "Knife slash",
    range: 2.2,
    cooldownSeconds: 0.25,
    swingDurationSeconds: 0.5,
    swingPositionOffset: [1.0, -0.3, 0.16],
    swingRotationOffset: [Math.PI / 2, -0.2, 0.3],
  },
  "baseball_bat_01": {
    displayName: "Bat swing",
    range: 2.8,
    cooldownSeconds: 0.2,
    swingDurationSeconds: 0.4,
    swingPositionOffset: [0.5, -0.1, -0.1],
    swingRotationOffset: [-2, 1.2, 0.0],
  },
};
const DEBUG_INVENTORY_ITEMS = [
  { id: "knife_01", name: "Knife" },
  { id: "pistol_01", name: "Pistol" },
  { id: "bullet_01", name: "Bullet" },
  { id: "meat_jerky_01", name: "Jerky" },
  { id: "first_aid_kit_01", name: "First Aid Kit" },
  { id: "skull_01", name: "Skull" },
  { id: "soda_can_01", name: "Soda Can" },
  { id: "baseball_bat_01", name: "Baseball Bat" },
];
const HELD_ITEM_DISPLAY_TUNING = {
  "knife_01": {
    "targetSize": 1,
    "offset": [
      0.012,
      0.2,
      -0.264
    ],
    "rotation": [
      0.088407346410207,
      -2.39159265358979,
      0.428407346410207
    ]
  },
  "pistol_01": {
    "targetSize": 0.56,
    "offset": [
      0.4,
      0.052,
      -0.02
    ],
    "rotation": [
      0.248407346410207,
      0.998407346410207,
      -0.021592653589793
    ]
  },
  bullet_01: {
    targetSize: 0.12,
    offset: [0.04, -0.07, -0.02],
    rotation: [0.34, -1.1, 0.52],
  },
"meat_jerky_01": {
  "targetSize": 0.365,
  "offset": [
    0.216,
    0.11,
    0.014
  ],
  "rotation": [
    1.46840734641021,
    -1,
    0.968407346410207
  ]
},
  "first_aid_kit_01": {
  "targetSize": 0.545,
  "offset": [
    0.03,
    0.024,
    -0.02
  ],
  "rotation": [
    0.26,
    0.008407346410207,
    0.7
  ]
},
"skull_01": {
  "targetSize": 0.415,
  "offset": [
    0.16,
    0.292,
    -0.132
  ],
  "rotation": [
    2.75840734641021,
    3.13840734641021,
    3.13840734641021
  ]
},
"soda_can_01": {
  "targetSize": 0.29,
  "offset": [
    0.03,
    -0.03,
    -0.02
  ],
  "rotation": [
    0.208407346410207,
    0.208407346410207,
    -0.211592653589793
  ]
},
"baseball_bat_01": {
  "targetSize": 1,
  "offset": [
    0.034,
    0.194,
    -0.05
  ],
  "rotation": [
    1.48840734641021,
    -1.17159265358979,
    1.43840734641021
  ]
}
};
const ENABLE_HELD_ITEM_TUNING_UI = false;
const HELD_ITEM_TUNING_SLIDER_DEFS = [
  { key: "targetSize", label: "size", min: 0.04, max: 1.0, step: 0.005 },
  { key: "offsetX", label: "off x", min: -0.4, max: 0.4, step: 0.002 },
  { key: "offsetY", label: "off y", min: -0.4, max: 0.4, step: 0.002 },
  { key: "offsetZ", label: "off z", min: -0.4, max: 0.4, step: 0.002 },
  { key: "rotX", label: "rot x", min: -Math.PI, max: Math.PI, step: 0.01 },
  { key: "rotY", label: "rot y", min: -Math.PI, max: Math.PI, step: 0.01 },
  { key: "rotZ", label: "rot z", min: -Math.PI, max: Math.PI, step: 0.01 },
];
const TOP_DOWN_PLAYER_LOOK_LENGTH = CELL_SIZE * 2.4;
const FLASHLIGHT_RIG_BASE_POSITION = new THREE.Vector3(0.24, -0.22, -0.38);
const FLASHLIGHT_RIG_BASE_ROTATION = new THREE.Euler(0.03, -0.1, 0.02);
const LEFT_HAND_RIG_BASE_POSITION = new THREE.Vector3(-0.34, -0.31, -0.58);
const LEFT_HAND_RIG_BASE_ROTATION = new THREE.Euler(0.08, 0.42, -0.1);
const LEFT_HAND_ITEM_BASE_ROTATION = new THREE.Euler(0, 0, 0);
const LEFT_HAND_ITEM_TARGET_SIZE = 0.22;
const flashlightRig = new THREE.Group();
const flashlightModelAnchor = new THREE.Group();
const inventoryLeftHandRig = new THREE.Group();
const inventoryLeftHandItemAnchor = new THREE.Group();
const heldItemInspectionLight = new THREE.PointLight(0xffffff, 2.8, 6, 1.7);
const HELD_ITEM_AMBIENT_BOOST_INTENSITY = 0.42;
const heldItemAmbientFillLight = new THREE.AmbientLight(0xe9f3ff, 0.0);
const flashlightTarget = new THREE.Object3D();
const topDownLookDirection = new THREE.Vector3();
const heldItemBounds = new THREE.Box3();
const heldItemCenter = new THREE.Vector3();
const heldItemSize = new THREE.Vector3();
const meleeAttackForward = new THREE.Vector3();
const bulletDecalNormal = new THREE.Vector3();
const bulletDecalPosition = new THREE.Vector3();
const bulletDecalLookTarget = new THREE.Vector3();
const bulletDecalSize = new THREE.Vector3();
const bulletDecalRotation = new THREE.Euler();
const bulletDecalProjector = new THREE.Object3D();
const bulletDecalRayDirection = new THREE.Vector3();
const bulletDecalNormalMatrix = new THREE.Matrix3();
const bulletDecalInstanceMatrix = new THREE.Matrix4();
const bulletDecalInstanceWorldMatrix = new THREE.Matrix4();
const heldItemLocalBoundsScratch = new THREE.Box3();
const pistolMuzzleWorldPosition = new THREE.Vector3();
const pistolMuzzleFallbackWorldPosition = new THREE.Vector3();
const pistolMuzzleDirectionWorld = new THREE.Vector3();
const pistolMuzzleDirectionLocal = new THREE.Vector3();
const pistolMuzzleSupportLocalPoint = new THREE.Vector3();
const pistolMuzzleBoundsCenter = new THREE.Vector3();
const pistolMuzzleBoundsSize = new THREE.Vector3();
const pistolMuzzleModelWorldQuaternion = new THREE.Quaternion();
const pistolShotDirection = new THREE.Vector3();
const pistolHitDebugNormal = new THREE.Vector3();
const pistolDebugHitPoint = new THREE.Vector3();
const pistolNearestPropDirection = new THREE.Vector3();
const pistolNearestPropWorld = new THREE.Vector3();
const pistolPropBounds = new THREE.Box3();
const pistolPropCenter = new THREE.Vector3();

const flashlight = new THREE.SpotLight(
  0xdce8ff,
  FLASHLIGHT_BASE_INTENSITY,
  FLASHLIGHT_BASE_DISTANCE,
  Math.PI / 5.4,
  0.58,
  1.1,
);
flashlight.castShadow = true;
const flashlightBounceLight = new THREE.PointLight(0xffffff, 0, 0, 2);
flashlightBounceLight.castShadow = false;
flashlightBounceLight.visible = true;
const bounceLightDebugMarker = new THREE.Mesh(
  new THREE.SphereGeometry(0.11, 14, 10),
  new THREE.MeshBasicMaterial({
    color: 0xff2e2e,
    toneMapped: false,
    depthTest: false,
    depthWrite: false,
  }),
);
bounceLightDebugMarker.visible = false;
bounceLightDebugMarker.renderOrder = 1000;
const topDownPlayerMarker = new THREE.Mesh(
  new THREE.CapsuleGeometry(
    PLAYER_RADIUS,
    Math.max(0.01, PLAYER_HEIGHT - PLAYER_RADIUS * 2),
    8,
    16,
  ),
  new THREE.MeshBasicMaterial({
    color: 0x56c8ff,
    toneMapped: false,
    depthTest: false,
    depthWrite: false,
    transparent: true,
    opacity: 0.95,
  }),
);
topDownPlayerMarker.visible = false;
topDownPlayerMarker.renderOrder = 1001;
const topDownLookLineGeometry = new THREE.BufferGeometry();
topDownLookLineGeometry.setAttribute(
  "position",
  new THREE.Float32BufferAttribute([0, 0, 0, 0, 0, 0], 3),
);
const topDownLookLine = new THREE.Line(
  topDownLookLineGeometry,
  new THREE.LineBasicMaterial({
    color: 0xffd65a,
    toneMapped: false,
    depthTest: false,
    depthWrite: false,
  }),
);
topDownLookLine.visible = false;
topDownLookLine.renderOrder = 1002;
const pistolMuzzleFlashSprite = new THREE.Sprite(pistolMuzzleFlashMaterial);
pistolMuzzleFlashSprite.visible = false;
pistolMuzzleFlashSprite.position.copy(PISTOL_MUZZLE_FLASH_FALLBACK_LOCAL_POSITION);
pistolMuzzleFlashSprite.scale.setScalar(0.35);
pistolMuzzleFlashSprite.renderOrder = 1003;
const pistolMuzzleFlashLight = new THREE.PointLight(0xffbd84, 0, 4.4, 1.8);
pistolMuzzleFlashLight.visible = true;
pistolMuzzleFlashLight.position.copy(PISTOL_MUZZLE_FLASH_FALLBACK_LOCAL_POSITION);
const pistolHitDebugMarker = new THREE.Mesh(
  new THREE.SphereGeometry(0.06, 10, 8),
  new THREE.MeshBasicMaterial({
    color: 0xffc354,
    toneMapped: false,
    depthTest: false,
    depthWrite: false,
  }),
);
pistolHitDebugMarker.visible = false;
pistolHitDebugMarker.renderOrder = 1004;
flashlight.map = flashlightPatternTexture;
flashlight.shadow.camera.near = 0.01;
flashlight.shadow.camera.far = FLASHLIGHT_BASE_DISTANCE;
flashlight.shadow.mapSize.set(1024, 1024);
flashlight.shadow.bias = -0.00008;
flashlight.shadow.normalBias = 0.02;
flashlight.shadow.camera.updateProjectionMatrix();

const flashlightRaycaster = new THREE.Raycaster();
const meleeRaycaster = new THREE.Raycaster();
const pistolRaycaster = new THREE.Raycaster();
const flashlightBounceOrigin = new THREE.Vector3();
const flashlightBounceDirection = new THREE.Vector3();
const flashlightHitDirection = new THREE.Vector3();
const flashlightTargetWorld = new THREE.Vector3();
const flashlightBounceNormal = new THREE.Vector3();
const flashlightBounceColor = new THREE.Color();
const flashlightBounceTargetColor = new THREE.Color();
const flashlightBounceTargetPosition = new THREE.Vector3();
const flashlightBounceSmoothedColor = new THREE.Color();
const flashlightBounceSmoothedPosition = new THREE.Vector3();
const bounceLightDebugPosition = new THREE.Vector3();
let flashlightBounceSmoothedIntensity = 0;
let flashlightBounceEmaInitialized = false;
let bounceLightDebugHasHit = false;

const collisionOffsets = [
  [0, 0],
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
  [0.7, 0.7],
  [0.7, -0.7],
  [-0.7, 0.7],
  [-0.7, -0.7],
];
const worldCollisionCapsule = new THREE.Line3(new THREE.Vector3(), new THREE.Vector3());
const worldCollisionBounds = new THREE.Box3();
const worldCollisionInverseMatrix = new THREE.Matrix4();
const worldCollisionTriPoint = new THREE.Vector3();
const worldCollisionCapsulePoint = new THREE.Vector3();
const worldCollisionDelta = new THREE.Vector3();
const worldCollisionNormal = new THREE.Vector3();
const worldCollisionResolved = new THREE.Vector3();
const worldCollisionWorldPoint = new THREE.Vector3();

flashlightRig.position.copy(FLASHLIGHT_RIG_BASE_POSITION);
flashlightRig.rotation.copy(FLASHLIGHT_RIG_BASE_ROTATION);
flashlight.position.set(0, 0.025, -0.22);
flashlightTarget.position.set(0, 0.02, -6.5);
flashlightModelAnchor.position.set(0, 0, 0);
camera.add(flashlightRig);
flashlightRig.add(flashlightModelAnchor);
flashlightRig.add(flashlight);
flashlightRig.add(flashlightTarget);
flashlight.target = flashlightTarget;

inventoryLeftHandRig.position.copy(LEFT_HAND_RIG_BASE_POSITION);
inventoryLeftHandRig.rotation.copy(LEFT_HAND_RIG_BASE_ROTATION);
inventoryLeftHandItemAnchor.rotation.copy(LEFT_HAND_ITEM_BASE_ROTATION);
heldItemInspectionLight.position.set(-0.14, -0.03, -0.17);
camera.add(inventoryLeftHandRig);
inventoryLeftHandRig.add(inventoryLeftHandItemAnchor);
//inventoryLeftHandRig.add(heldItemInspectionLight);

scene.add(new THREE.HemisphereLight(0x5d6f8a, 0x1a1714, 0.22));
scene.add(new THREE.AmbientLight(0x1d2430, 0.1));
scene.add(heldItemAmbientFillLight);
scene.add(pistolMuzzleFlashSprite);
scene.add(pistolMuzzleFlashLight);
scene.add(flashlightBounceLight);
scene.add(bounceLightDebugMarker);
scene.add(pistolHitDebugMarker);
scene.add(topDownPlayerMarker);
scene.add(topDownLookLine);
const topDownFillLight = new THREE.AmbientLight(0xe4edf9, 0.92);
topDownFillLight.visible = true;
topDownFillLight.intensity = 0;
scene.add(topDownFillLight);

const worldWidth = MAZE_COLS * CELL_SIZE;
const worldDepth = MAZE_ROWS * CELL_SIZE;
const worldHalfWidth = worldWidth * 0.5;
const worldHalfDepth = worldDepth * 0.5;
const propScatter = createWarehousePropScatter({
  THREE,
  scene,
  modelLoader,
  cols: MAZE_COLS,
  rows: MAZE_ROWS,
  cellSize: CELL_SIZE,
  worldHalfWidth,
  worldHalfDepth,
});
const pickupSystem = createPickupSystem({
  THREE,
  scene,
  modelLoader,
  cols: MAZE_COLS,
  rows: MAZE_ROWS,
  cellSize: CELL_SIZE,
  worldHalfWidth,
  worldHalfDepth,
});

const canUsePointerLock = typeof document.body.requestPointerLock === "function" && !navigator.webdriver;

const floorTextures = loadTextureSet({
  colorPath: "./assets/textures/floor/metal_plate_02_diff_1k.jpg",
  normalPath: "./assets/textures/floor/metal_plate_02_nor_gl_1k.jpg",
  roughnessPath: "./assets/textures/floor/metal_plate_02_rough_1k.jpg",
  heightPath: "./assets/textures/floor/metal_plate02_height_1k.png",
  repeatX: MAZE_COLS,
  repeatY: MAZE_ROWS,
});
const wallTextures = loadTextureSet({
  colorPath: "./assets/textures/wall/factory_wall_diff_1k.jpg",
  normalPath: "./assets/textures/wall/factory_wall_nor_gl_1k.jpg",
  roughnessPath: "./assets/textures/wall/factory_wall_rough_1k.jpg",
  heightPath: "./assets/textures/wall/factory_wall_height_1k.png",
  repeatX: 1,
  repeatY: 1,
});
const roofTextures = loadTextureSet({
  colorPath: "./assets/textures/roof/rusty_metal_05_diff_1k.jpg",
  normalPath: "./assets/textures/roof/rusty_metal_05_nor_gl_1k.jpg",
  roughnessPath: "./assets/textures/roof/rusty_metal_05_rough_1k.jpg",
  heightPath: "./assets/textures/roof/rusty_metal_05_height_1k.png",
  repeatX: MAZE_COLS * 0.5,
  repeatY: MAZE_ROWS * 0.5,
});

const wallHeightTexture = inferWallHeightTexture(wallTextures);
if (wallHeightTexture) {
  wallHeightTexture.generateMipmaps = false;
  wallHeightTexture.minFilter = THREE.LinearFilter;
  wallHeightTexture.needsUpdate = true;
}

const floorMaterial = new THREE.MeshStandardMaterial({
  map: floorTextures.color,
  normalMap: floorTextures.normal,
  roughnessMap: floorTextures.roughness,
  roughness: 1,
  metalness: 0.32,
  normalScale: new THREE.Vector2(0.82, 0.82),
});
const wallMaterial = new THREE.MeshStandardMaterial({
  map: wallTextures.color,
  normalMap: wallTextures.normal,
  roughnessMap: wallTextures.roughness,
  roughness: 0.95,
  metalness: 0.07,
  normalScale: new THREE.Vector2(0.6, 0.6),
});
const roofMaterial = new THREE.MeshStandardMaterial({
  map: roofTextures.color,
  normalMap: roofTextures.normal,
  roughnessMap: roofTextures.roughness,
  roughness: 0.9,
  metalness: 0.26,
  normalScale: new THREE.Vector2(0.7, 0.7),
  side: THREE.BackSide,
});

let maze = [];
let wallMesh = null;
let roofMesh = null;
let floorMesh = null;
let exitMarker = null;
let hasWon = false;
let gameActive = false;
let isTopDownView = false;
let suppressUnlockPause = false;
let flashlightEnabled = true;
let flashlightModelLoaded = false;
let flashlightFlickerTarget = 1;
let flashlightFlickerValue = 1;
let flashlightFlickerTimer = 0;
let previousAnimationTimeMs = 0;
let frameAccumulatorMs = 0;
let n8aoSplitDebug = false;
let bounceLightDebugEnabled = false;

const wallPomUniforms = {
  heightScale: { value: WALL_POM_HEIGHT_SCALE_DEFAULT },
  minLayers: { value: WALL_POM_MIN_LAYERS },
  maxLayers: { value: WALL_POM_MAX_LAYERS },
};
const floorPomUniforms = {
  heightScale: { value: FLOOR_POM_HEIGHT_SCALE },
  minLayers: { value: FLOOR_POM_MIN_LAYERS },
  maxLayers: { value: FLOOR_POM_MAX_LAYERS },
};
const roofPomUniforms = {
  heightScale: { value: ROOF_POM_HEIGHT_SCALE },
  minLayers: { value: ROOF_POM_MIN_LAYERS },
  maxLayers: { value: ROOF_POM_MAX_LAYERS },
};

const mazePerf = {
  renderedFrames: 0,
  startTimeMs: performance.now(),
};
window.__mazePerf = mazePerf;

let elapsed = 0;
let startCell = { col: 1, row: 1 };
let exitCell = { col: MAZE_COLS - 2, row: MAZE_ROWS - 2 };
let viewBobPhase = 0;
let viewBobBlend = 0;
let movementBobSignal = 0;

const keyState = {
  forward: false,
  backward: false,
  left: false,
  right: false,
  sprint: false,
};
const inventory = [];
const inventorySlots = [];
const heldInventoryModelById = new Map();
const heldInventoryModelPromiseById = new Map();
let inventoryWheelRotationSteps = 0;
let heldInventoryItemId = null;
let heldInventoryLoadToken = 0;
let inventorySelectionOutline = null;
let playerHealth = PLAYER_MAX_HEALTH;
let playerHealthDamageTrail = PLAYER_MAX_HEALTH;
let playerHealthDamageTrailHoldRemaining = 0;
let meleeCooldownRemaining = 0;
let meleeSwingElapsed = 0;
let meleeSwingDuration = 0;
let meleeSwingActive = false;
let meleeSwingWeaponId = null;
let pistolInfiniteAmmo = false;
let pistolFireCooldownRemaining = 0;
let pistolRecoilAmount = 0;
let pistolMuzzleFlashRemaining = 0;
let pistolImpactDebugEnabled = false;
let pistolPropDebugMarkerRemaining = 0;
let lastPistolHitInfo = null;
let jerkyConsumeActive = false;
let jerkyConsumeElapsed = 0;
let consumableUseItemId = null;
let consumableUseDuration = 0;
let consumableUseLabel = "";
let firstAidRegenRemaining = 0;
let sodaSpeedBoostRemaining = 0;
const bulletDecals = [];
const heldItemTuningUi = {
  panel: null,
  selectedLabel: null,
  rows: new Map(),
  exportBox: null,
};

applyParallaxOcclusionToMaterial(
  wallMaterial,
  wallHeightTexture,
  wallPomUniforms,
  "wall-pom-v2",
);
applyParallaxOcclusionToMaterial(
  floorMaterial,
  floorTextures.height,
  floorPomUniforms,
  "floor-pom-v2",
);
applyParallaxOcclusionToMaterial(
  roofMaterial,
  roofTextures.height,
  roofPomUniforms,
  "roof-pom-v2",
);

createFloorAndCeiling();
regenerateMaze();
setupInteractions();
loadFlashlightModel({
  modelLoader,
  modelPath: "./assets/models/old_flashlight.glb",
  flashlightModelAnchor,
  flashlight,
  flashlightTarget,
  onLoaded: (loaded) => {
    flashlightModelLoaded = loaded;
    if (!loaded) {
      console.warn("Flashlight model failed to load.");
    }
  },
});
setStatus("Click Enter Maze to begin exploring.");
initInventoryRadial();
if (ENABLE_HELD_ITEM_TUNING_UI) {
  initHeldItemTuningPanel();
}
updateInventoryHud();
updateHealthHud();
updatePickupPrompt();
updateJerkyConsumeHud();
updateBuffHud();
render();
renderer.setAnimationLoop(animationFrame);

function createFloorAndCeiling() {
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(worldWidth, worldDepth), floorMaterial);
  floorMesh = floor;
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = 0;
  floor.castShadow = false;
  floor.receiveShadow = true;
  scene.add(floor);
  buildMeshBVH(floor);

  const ceiling = new THREE.Mesh(new THREE.PlaneGeometry(worldWidth, worldDepth), roofMaterial);
  ceiling.rotation.x = -Math.PI / 2;
  ceiling.position.y = WALL_HEIGHT;
  ceiling.castShadow = false;
  ceiling.receiveShadow = true;
  roofMesh = ceiling;
  scene.add(roofMesh);
  buildMeshBVH(ceiling);
}

function buildMeshBVH(mesh) {
  if (!mesh?.geometry) return;
  if (mesh.geometry.boundsTree?.dispose) {
    mesh.geometry.boundsTree.dispose();
  }
  mesh.geometry.boundsTree = new MeshBVH(mesh.geometry);
}

function resolveMaterialBounceReflectance(material) {
  const sourceMaterial = Array.isArray(material) ? material[0] : material;
  if (!sourceMaterial) {
    return FLASHLIGHT_BOUNCE_DEFAULT_REFLECTANCE;
  }

  const mapAverage = sourceMaterial.map?.userData?.averageAlbedoColor;
  if (mapAverage) {
    flashlightBounceColor.copy(mapAverage);
    if (sourceMaterial.color) {
      flashlightBounceColor.multiply(sourceMaterial.color);
    }
  } else if (sourceMaterial.color) {
    flashlightBounceColor.copy(sourceMaterial.color);
  } else {
    flashlightBounceColor.copy(FLASHLIGHT_BOUNCE_DEFAULT_REFLECTANCE);
  }

  const metalness = THREE.MathUtils.clamp(sourceMaterial.metalness ?? 0, 0, 1);
  flashlightBounceColor.multiplyScalar(1 - metalness);

  flashlightBounceColor.r = THREE.MathUtils.clamp(flashlightBounceColor.r, 0, 1);
  flashlightBounceColor.g = THREE.MathUtils.clamp(flashlightBounceColor.g, 0, 1);
  flashlightBounceColor.b = THREE.MathUtils.clamp(flashlightBounceColor.b, 0, 1);

  return flashlightBounceColor;
}

function regenerateMaze() {
  hasWon = false;
  gameActive = false;
  isTopDownView = false;
  keyState.forward = false;
  keyState.backward = false;
  keyState.left = false;
  keyState.right = false;
  keyState.sprint = false;
  viewBobPhase = 0;
  viewBobBlend = 0;
  movementBobSignal = 0;
  camera.position.y = PLAYER_HEIGHT;
  flashlightRig.position.copy(FLASHLIGHT_RIG_BASE_POSITION);
  flashlightRig.rotation.copy(FLASHLIGHT_RIG_BASE_ROTATION);
  setPlayerHealth(PLAYER_MAX_HEALTH);
  meleeCooldownRemaining = 0;
  meleeSwingElapsed = 0;
  meleeSwingDuration = 0;
  meleeSwingActive = false;
  meleeSwingWeaponId = null;
  pistolInfiniteAmmo = false;
  pistolFireCooldownRemaining = 0;
  pistolRecoilAmount = 0;
  pistolMuzzleFlashRemaining = 0;
  pistolImpactDebugEnabled = false;
  pistolPropDebugMarkerRemaining = 0;
  lastPistolHitInfo = null;
  pistolHitDebugMarker.visible = false;
  pistolMuzzleFlashSprite.visible = false;
  pistolMuzzleFlashLight.visible = true;
  pistolMuzzleFlashLight.intensity = 0;
  pistolMuzzleFlashMaterial.opacity = 0;
  cancelJerkyConsume();
  firstAidRegenRemaining = 0;
  sodaSpeedBoostRemaining = 0;
  updateBuffHud();
  syncBulletDecalMaterials();
  clearBulletDecals();
  inventory.length = 0;
  setInventoryWheelRotationSteps(0);
  updateInventoryHud();
  updatePickupPrompt();

  maze = generateMaze(MAZE_COLS, MAZE_ROWS);
  startCell = { col: 1, row: 1 };
  exitCell = findFarthestOpenCell(startCell, isWalkableCell);

  rebuildWalls();
  void propScatter.regenerate({ maze, startCell, exitCell });
  void pickupSystem.regenerate({ maze, startCell, exitCell });
  if (exitMarker) {
    scene.remove(exitMarker);
    exitMarker.geometry.dispose();
    exitMarker.material.dispose();
    exitMarker = null;
  }
  resetPlayerToStart();
  setStatus("New maze generated.");
}

function rebuildWalls() {
  if (wallMesh) {
    if (wallMesh.geometry?.boundsTree?.dispose) {
      wallMesh.geometry.boundsTree.dispose();
    }
    scene.remove(wallMesh);
    wallMesh.geometry.dispose();
    wallMesh = null;
  }

  const geometry = buildWallSurfaceGeometry({
    THREE,
    maze,
    cols: MAZE_COLS,
    rows: MAZE_ROWS,
    cellSize: CELL_SIZE,
    wallHeight: WALL_HEIGHT,
    worldHalfWidth,
    worldHalfDepth,
  });
  wallMesh = new THREE.Mesh(geometry, wallMaterial);
  wallMesh.castShadow = true;
  wallMesh.receiveShadow = true;
  buildMeshBVH(wallMesh);
  scene.add(wallMesh);
}

function rebuildExitMarker() {
  if (exitMarker) {
    scene.remove(exitMarker);
    exitMarker.geometry.dispose();
    exitMarker.material.dispose();
    exitMarker = null;
  }

  exitMarker = new THREE.Mesh(
    new THREE.CylinderGeometry(0.5, 0.5, 2.4, 8),
    new THREE.MeshStandardMaterial({
      color: 0xdf383d,
      emissive: 0x4f1113,
      roughness: 0.35,
      metalness: 0.15,
    }),
  );

  const exitPos = cellToWorld(exitCell.col, exitCell.row);
  exitMarker.position.set(exitPos.x, 1.2, exitPos.z);
  exitMarker.castShadow = true;
  exitMarker.receiveShadow = true;
  scene.add(exitMarker);
}

function resetPlayerToStart() {
  const spawn = cellToWorld(startCell.col, startCell.row);
  camera.position.set(spawn.x, PLAYER_HEIGHT, spawn.z);
  camera.quaternion.identity();

  const path = findPath(startCell, exitCell, isWalkableCell);
  if (path.length > 1) {
    const next = path[1];
    const target = cellToWorld(next.col, next.row);
    camera.lookAt(target.x, PLAYER_HEIGHT, target.z);
  }
}

function setupInteractions() {
  startButton.addEventListener("click", () => {
    if (hasWon) {
      regenerateMaze();
    }
    activateGameplay();
  });

  renderer.domElement.addEventListener("click", () => {
    if (!gameActive) {
      activateGameplay();
    } else if (canUsePointerLock && !controls.isLocked) {
      controls.lock();
    }
  });
  renderer.domElement.addEventListener("pointerdown", onPointerDown);
  renderer.domElement.addEventListener("pointerup", onPointerUp);
  renderer.domElement.addEventListener("pointercancel", onPointerUp);

  controls.addEventListener("lock", () => {
    isTopDownView = false;
    overlay.classList.add("hidden");
    crosshair.style.opacity = "1";
    if (!hasWon) {
      setStatus(GAMEPLAY_HINT);
    }
  });

  controls.addEventListener("unlock", () => {
    cancelJerkyConsume();
    if (suppressUnlockPause) {
      suppressUnlockPause = false;
      return;
    }

    if (canUsePointerLock) {
      gameActive = false;
      isTopDownView = false;
      crosshair.style.opacity = "0.25";
      if (hasWon) {
        overlay.classList.remove("hidden");
        return;
      }

      overlay.classList.add("hidden");
      setStatus("Pointer unlocked. Adjust settings, then click the scene to resume.");
    }
  });

  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("keyup", onKeyUp);
  window.addEventListener("blur", () => cancelJerkyConsume());
  window.addEventListener("resize", resizeRenderer);
  document.addEventListener("fullscreenchange", resizeRenderer);

  window.render_game_to_text = renderGameToText;
  window.advanceTime = (ms) => {
    const seconds = Math.max(0, Number(ms) || 0) / 1000;
    const stepCount = Math.max(1, Math.round(seconds / (1 / 60)));
    const fixedStep = seconds / stepCount;
    for (let i = 0; i < stepCount; i++) {
      update(fixedStep);
    }
    render();
  };
  window.__debugGrantInventory = grantDebugInventory;
  window.__debugRotateInventory = rotateInventoryWheel;
  window.__debugGetSelectedInventoryId = () => getSelectedInventoryItem()?.id || null;
  window.__debugSetPistolInfiniteAmmo = (enabled) => {
    pistolInfiniteAmmo = Boolean(enabled);
    return pistolInfiniteAmmo;
  };
  window.__debugGetPistolInfiniteAmmo = () => pistolInfiniteAmmo;
  window.__debugGetBulletAmmoCount = getBulletAmmoCount;
  window.__debugGetBulletDecalCount = () => bulletDecals.length;
  window.__debugGetBulletDecalMaterialType = () => bulletDecals[0]?.material?.type || null;
  window.__debugSetPistolImpactDebug = (enabled) => {
    setPistolImpactDebugEnabled(Boolean(enabled));
    return pistolImpactDebugEnabled;
  };
  window.__debugGetPistolImpactDebug = () => pistolImpactDebugEnabled;
  window.__debugGetLastPistolHit = () =>
    lastPistolHitInfo
      ? {
          ...lastPistolHitInfo,
        }
      : null;
  window.__debugShootPistolDirection = (x, y, z, bypassCooldown = true) => {
    const nx = Number(x);
    const ny = Number(y);
    const nz = Number(z);
    if (!Number.isFinite(nx) || !Number.isFinite(ny) || !Number.isFinite(nz)) {
      return false;
    }
    return tryShootPistol({
      direction: new THREE.Vector3(nx, ny, nz),
      bypassCooldown: Boolean(bypassCooldown),
    });
  };
  window.__debugShootPistolAtNearestProp = () => tryShootPistolAtNearestProp();
  window.__debugGetMuzzleFlashLightState = () => ({
    visible: pistolMuzzleFlashLight.visible,
    intensity: round(pistolMuzzleFlashLight.intensity),
    distance: round(pistolMuzzleFlashLight.distance),
    x: round(pistolMuzzleFlashLight.position.x),
    y: round(pistolMuzzleFlashLight.position.y),
    z: round(pistolMuzzleFlashLight.position.z),
  });
  window.__debugGetMuzzleFlashSpriteWorldPosition = () => ({
    visible: pistolMuzzleFlashSprite.visible,
    opacity: round(pistolMuzzleFlashMaterial.opacity),
    x: round(pistolMuzzleFlashSprite.position.x),
    y: round(pistolMuzzleFlashSprite.position.y),
    z: round(pistolMuzzleFlashSprite.position.z),
  });
  window.__debugGetMuzzleFlashFrame = () =>
    Math.round(muzzleFlashTexture.offset.x / PISTOL_MUZZLE_FLASH_FRAME_WIDTH);
  window.__debugGetPlayerHealth = () => ({
    current: round(playerHealth),
    trail: round(playerHealthDamageTrail),
    max: PLAYER_MAX_HEALTH,
    ratio: round(playerHealth / PLAYER_MAX_HEALTH),
    trailRatio: round(playerHealthDamageTrail / PLAYER_MAX_HEALTH),
  });
  window.__debugSetPlayerHealth = (value) => {
    setPlayerHealth(Number(value));
    return playerHealth;
  };
  window.__debugDamagePlayer = (amount = PLAYER_TEST_DAMAGE_PER_PRESS) => {
    applyPlayerDamage(Number(amount), "debug");
    return playerHealth;
  };
  window.__debugGetJerkyConsumeState = () => {
    const jerkyActive = jerkyConsumeActive && consumableUseItemId === JERKY_ITEM_ID;
    return {
      active: jerkyActive,
      elapsed: round(jerkyActive ? jerkyConsumeElapsed : 0),
      progress: round(getJerkyConsumeProgress()),
      itemId: consumableUseItemId,
    };
  };
  window.__debugGetConsumableEffects = () => ({
    sodaSpeedBoostRemaining: round(sodaSpeedBoostRemaining),
    firstAidRegenRemaining: round(firstAidRegenRemaining),
    speedMultiplier: round(getPlayerSpeedMultiplier()),
    consumableUseRemaining: round(
      jerkyConsumeActive ? Math.max(0, consumableUseDuration - jerkyConsumeElapsed) : 0,
    ),
  });
  window.__debugGetHeldItemAnchorOffset = () => ({
    x: round(inventoryLeftHandItemAnchor.position.x),
    y: round(inventoryLeftHandItemAnchor.position.y),
    z: round(inventoryLeftHandItemAnchor.position.z),
  });
}

function activateGameplay() {
  gameActive = true;
  isTopDownView = false;
  cancelJerkyConsume();
  overlay.classList.add("hidden");
  crosshair.style.opacity = "1";
  setStatus(GAMEPLAY_HINT);
  if (canUsePointerLock && !controls.isLocked) {
    controls.lock();
  }
}

function onKeyDown(event) {
  const code = event.code;
  if (code === "ArrowLeft" || code === "ArrowRight" || code === "Space") {
    event.preventDefault();
  }

  if (code === "ArrowLeft") {
    rotateInventoryWheel(-1);
    return;
  }

  if (code === "ArrowRight") {
    rotateInventoryWheel(1);
    return;
  }

  if (code === "KeyW") keyState.forward = true;
  if (code === "KeyS") keyState.backward = true;
  if (code === "KeyA") keyState.left = true;
  if (code === "KeyD") keyState.right = true;
  if (code === "ShiftLeft" || code === "ShiftRight") keyState.sprint = true;

  if (code === "KeyF") {
    void toggleFullscreen();
  }
  if (code === "KeyL") {
    toggleFlashlight();
  }
  if (code === "KeyV") {
    toggleTopDownView();
  }
  if (code === "KeyO") {
    toggleN8AODebugView();
  }
  if (code === "KeyN") {
    regenerateMaze();
  }
  if (code === "KeyE") {
    tryPickupNearest();
  }
  if (code === "KeyI") {
    grantDebugInventory();
  }
  if (code === "KeyU") {
    heldItemAmbientFillLight.intensity =
      heldItemAmbientFillLight.intensity > 0.0 ? 0.0 : HELD_ITEM_AMBIENT_BOOST_INTENSITY;
    setStatus(
      heldItemAmbientFillLight.intensity > 0.0
        ? "Held-item ambient debug light enabled."
        : "Held-item ambient debug light disabled."
    );
  }
  if (code === "KeyB") {
    toggleBounceLightDebugMarker();
  }
  if (code === "KeyP") {
    togglePistolImpactDebug();
  }
  if (code === "KeyT") {
    applyPlayerDamage(PLAYER_TEST_DAMAGE_PER_PRESS, "debug");
  }
}

function onKeyUp(event) {
  const code = event.code;
  if (code === "KeyW") keyState.forward = false;
  if (code === "KeyS") keyState.backward = false;
  if (code === "KeyA") keyState.left = false;
  if (code === "KeyD") keyState.right = false;
  if (code === "ShiftLeft" || code === "ShiftRight") keyState.sprint = false;
}

function onPointerDown(event) {
  if (event.button !== 0) {
    return;
  }
  if (!gameActive || hasWon || isTopDownView) {
    return;
  }
  if (canUsePointerLock && !controls.isLocked) {
    return;
  }
  if (tryStartJerkyConsume()) {
    return;
  }
  if (tryShootPistol()) {
    return;
  }
  tryMeleeAttack();
}

function onPointerUp(event) {
  if (event.type !== "pointercancel" && event.button !== 0) {
    return;
  }
  cancelJerkyConsume(getActiveConsumableCancelStatus());
}

function update(deltaSeconds) {
  elapsed += deltaSeconds;
  pistolFireCooldownRemaining = Math.max(0, pistolFireCooldownRemaining - deltaSeconds);
  updateConsumableEffects(deltaSeconds);
  updateHealthHeartBeatVisual();
  updateHealthDamageTrail(deltaSeconds);
  updateJerkyConsume(deltaSeconds);
  updateFlashlightFlicker(deltaSeconds);
  updateFlashlightBounceLight(deltaSeconds);
  pickupSystem.update(deltaSeconds);
  if (exitMarker) {
    exitMarker.rotation.y += deltaSeconds * 1.6;
    exitMarker.position.y = 1.2 + Math.sin(elapsed * 2.8) * 0.12;
  }

  updatePlayerMovement(deltaSeconds);
  updateViewBobbing(deltaSeconds);
  updateMeleeAttack(deltaSeconds);
  updateConsumableUseVisuals();
  updatePistolVisualEffects(deltaSeconds);
  updatePistolPropDebugMarker(deltaSeconds);
  updatePickupPrompt();
}

function updatePlayerMovement(deltaSeconds) {
  if (!gameActive) {
    movementBobSignal = 0;
    return;
  }

  const inputX = Number(keyState.right) - Number(keyState.left);
  const inputZ = Number(keyState.forward) - Number(keyState.backward);
  if (inputX === 0 && inputZ === 0) {
    movementBobSignal = 0;
    return;
  }

  forward.set(0, 0, -1).applyQuaternion(camera.quaternion);
  forward.y = 0;
  if (forward.lengthSq() < 0.000001) {
    forward.set(0, 0, -1);
  }
  forward.normalize();
  right.crossVectors(forward, worldUp).normalize();

  move.set(0, 0, 0);
  move.addScaledVector(forward, inputZ);
  move.addScaledVector(right, inputX);
  if (move.lengthSq() > 1) {
    move.normalize();
  }

  const speed =
    PLAYER_SPEED *
    (keyState.sprint ? SPRINT_MULTIPLIER : 1) *
    getPlayerSpeedMultiplier();
  const stepX = move.x * speed * deltaSeconds;
  const stepZ = move.z * speed * deltaSeconds;
  const current = camera.position;
  const previousX = current.x;
  const previousZ = current.z;
  const nextX = current.x + stepX;
  const nextZ = current.z + stepZ;
  const resolvedFromWorld = resolveWorldCollision(nextX, nextZ);
  current.x = resolvedFromWorld.x;
  current.z = resolvedFromWorld.z;

  const maxDisplacement = Math.max(speed * deltaSeconds, 0.00001);
  const movedDistance = Math.hypot(current.x - previousX, current.z - previousZ);
  movementBobSignal = THREE.MathUtils.clamp(movedDistance / maxDisplacement, 0, 1);
}

function updateViewBobbing(deltaSeconds) {
  const bobAllowed = gameActive && !hasWon && !isTopDownView;
  if (!bobAllowed) {
    viewBobBlend = 0;
  } else {
    viewBobBlend +=
      (movementBobSignal - viewBobBlend) *
      Math.min(1, deltaSeconds * VIEW_BOB_SMOOTHING);

    if (viewBobBlend > 0.0005) {
      const sprintScale = keyState.sprint ? 1.2 : 1;
      viewBobPhase +=
        deltaSeconds *
        VIEW_BOB_BASE_FREQUENCY *
        sprintScale *
        (0.45 + viewBobBlend * 0.55);
    }
  }

  const sprintAmplitudeScale = keyState.sprint && bobAllowed ? 1.2 : 1;
  const amplitude = VIEW_BOB_BASE_AMPLITUDE * viewBobBlend * sprintAmplitudeScale;
  const bobY = Math.sin(viewBobPhase * 2.0) * amplitude;
  const bobX = Math.cos(viewBobPhase) * amplitude * 0.45;
  const bobRoll = Math.sin(viewBobPhase) * amplitude * 0.22;

  camera.position.y = PLAYER_HEIGHT + bobY;
  flashlightRig.position.set(
    FLASHLIGHT_RIG_BASE_POSITION.x + bobX,
    FLASHLIGHT_RIG_BASE_POSITION.y + bobY * 0.4,
    FLASHLIGHT_RIG_BASE_POSITION.z,
  );
  flashlightRig.rotation.set(
    FLASHLIGHT_RIG_BASE_ROTATION.x,
    FLASHLIGHT_RIG_BASE_ROTATION.y,
    FLASHLIGHT_RIG_BASE_ROTATION.z + bobRoll,
  );

  inventoryLeftHandRig.position.set(
    LEFT_HAND_RIG_BASE_POSITION.x - bobX,
    LEFT_HAND_RIG_BASE_POSITION.y + bobY * 0.36,
    LEFT_HAND_RIG_BASE_POSITION.z,
  );
  inventoryLeftHandRig.rotation.set(
    LEFT_HAND_RIG_BASE_ROTATION.x,
    LEFT_HAND_RIG_BASE_ROTATION.y,
    LEFT_HAND_RIG_BASE_ROTATION.z - bobRoll,
  );
}

function canOccupy(x, z, radius) {
  for (const [offsetX, offsetZ] of collisionOffsets) {
    const sampleX = x + offsetX * radius;
    const sampleZ = z + offsetZ * radius;
    const cell = worldToCell(sampleX, sampleZ);
    if (!isWalkableCell(cell.col, cell.row)) {
      return false;
    }
  }
  return true;
}

function resolveWorldCollision(x, z) {
  worldCollisionResolved.set(x, PLAYER_HEIGHT, z);
  const radius = PLAYER_RADIUS;
  const capsuleTopY = PLAYER_HEIGHT - radius;
  const capsuleBottomY = radius;
  const colliders = [wallMesh, propScatter.collider].filter(
    (collider) => collider?.geometry?.boundsTree,
  );
  if (!colliders.length) {
    return worldCollisionResolved;
  }

  for (let iteration = 0; iteration < 2; iteration++) {
    let moved = false;

    for (const collider of colliders) {
      const boundsTree = collider.geometry.boundsTree;
      worldCollisionCapsule.start.set(
        worldCollisionResolved.x,
        capsuleTopY,
        worldCollisionResolved.z,
      );
      worldCollisionCapsule.end.set(
        worldCollisionResolved.x,
        capsuleBottomY,
        worldCollisionResolved.z,
      );

      collider.updateMatrixWorld(true);
      worldCollisionInverseMatrix.copy(collider.matrixWorld).invert();
      worldCollisionCapsule.start.applyMatrix4(worldCollisionInverseMatrix);
      worldCollisionCapsule.end.applyMatrix4(worldCollisionInverseMatrix);

      worldCollisionBounds.makeEmpty();
      worldCollisionBounds.expandByPoint(worldCollisionCapsule.start);
      worldCollisionBounds.expandByPoint(worldCollisionCapsule.end);
      worldCollisionBounds.min.addScalar(-radius);
      worldCollisionBounds.max.addScalar(radius);

      let colliderPushed = false;
      boundsTree.shapecast({
        intersectsBounds: (box) => box.intersectsBox(worldCollisionBounds),
        intersectsTriangle: (triangle) => {
          const distance = triangle.closestPointToSegment(
            worldCollisionCapsule,
            worldCollisionTriPoint,
            worldCollisionCapsulePoint,
          );
          if (distance >= radius) {
            return false;
          }

          const depth = radius - distance;
          worldCollisionDelta.subVectors(
            worldCollisionCapsulePoint,
            worldCollisionTriPoint,
          );
          if (worldCollisionDelta.lengthSq() > 1e-10) {
            worldCollisionDelta.normalize().multiplyScalar(depth);
          } else {
            triangle.getNormal(worldCollisionNormal);
            worldCollisionDelta.copy(worldCollisionNormal).multiplyScalar(depth);
          }

          worldCollisionCapsule.start.add(worldCollisionDelta);
          worldCollisionCapsule.end.add(worldCollisionDelta);
          worldCollisionBounds.makeEmpty();
          worldCollisionBounds.expandByPoint(worldCollisionCapsule.start);
          worldCollisionBounds.expandByPoint(worldCollisionCapsule.end);
          worldCollisionBounds.min.addScalar(-radius);
          worldCollisionBounds.max.addScalar(radius);
          colliderPushed = true;
          return false;
        },
      });

      if (colliderPushed) {
        worldCollisionWorldPoint
          .copy(worldCollisionCapsule.start)
          .applyMatrix4(collider.matrixWorld);
        worldCollisionResolved.x = worldCollisionWorldPoint.x;
        worldCollisionResolved.z = worldCollisionWorldPoint.z;
        moved = true;
      }
    }

    if (!moved) {
      break;
    }
  }

  worldCollisionResolved.y = PLAYER_HEIGHT;
  return worldCollisionResolved;
}

function isWalkableCell(col, row) {
  if (row < 0 || row >= MAZE_ROWS || col < 0 || col >= MAZE_COLS) {
    return false;
  }
  return maze[row][col] === 0;
}

function cellToWorld(col, row) {
  return {
    x: col * CELL_SIZE - worldHalfWidth + CELL_SIZE * 0.5,
    z: row * CELL_SIZE - worldHalfDepth + CELL_SIZE * 0.5,
  };
}

function worldToCell(x, z) {
  return {
    col: Math.floor((x + worldHalfWidth) / CELL_SIZE),
    row: Math.floor((z + worldHalfDepth) / CELL_SIZE),
  };
}

function animationFrame(timeMs = performance.now()) {
  if (previousAnimationTimeMs === 0) {
    previousAnimationTimeMs = timeMs;
    return;
  }

  const elapsedMs = Math.max(0, Math.min(250, timeMs - previousAnimationTimeMs));
  previousAnimationTimeMs = timeMs;
  frameAccumulatorMs += elapsedMs;
  if (frameAccumulatorMs < TARGET_FRAME_INTERVAL_MS) {
    return;
  }
  frameAccumulatorMs %= TARGET_FRAME_INTERVAL_MS;

  const delta = Math.min(clock.getDelta(), 0.05);
  update(delta);
  render();
  mazePerf.renderedFrames += 1;
  stats.update();
}

function render() {
  const flashlightModelVisibleInFirstPerson = !isFlashlightSuppressedByTwoHandedBat();
  if (isTopDownView) {
    if (roofMesh) {
      roofMesh.visible = false;
    }
    flashlightModelAnchor.visible = false;
    inventoryLeftHandRig.visible = false;
    topDownFillLight.intensity = 0.92;
    updateTopDownCamera();
    updateTopDownPlayerDebug();
    topDownPlayerMarker.visible = true;
    topDownLookLine.visible = true;
    scene.fog = null;
    renderer.render(scene, topDownCamera);
    if (roofMesh) {
      roofMesh.visible = true;
    }
    flashlightModelAnchor.visible = true;
    topDownFillLight.intensity = 0;
    topDownPlayerMarker.visible = false;
    topDownLookLine.visible = false;
    scene.fog = mazeFog;
    return;
  }
  flashlightModelAnchor.visible = flashlightModelVisibleInFirstPerson;
  inventoryLeftHandRig.visible = true;
  topDownFillLight.intensity = 0;
  topDownPlayerMarker.visible = false;
  topDownLookLine.visible = false;
  scene.fog = mazeFog;
  composer.render();
}

function updateFlashlightFlicker(deltaSeconds) {
  if (!isFlashlightEmissionActive() || isTopDownView) {
    flashlight.intensity = 0;
    flashlight.distance = FLASHLIGHT_BASE_DISTANCE;
    flashlightFlickerTarget = 1;
    flashlightFlickerValue = 1;
    flashlightFlickerTimer = 0;
    return;
  }

  flashlightFlickerTimer -= deltaSeconds;
  if (flashlightFlickerTimer <= 0) {
    flashlightFlickerTarget =
      Math.random() < FLASHLIGHT_FLICKER_DROP_CHANCE
        ? FLASHLIGHT_FLICKER_MIN_INTENSITY + Math.random() * 0.35
        : 0.7 + Math.random() * (FLASHLIGHT_FLICKER_MAX_INTENSITY - 0.7);
    flashlightFlickerTimer =
      FLASHLIGHT_FLICKER_MIN_HOLD +
      Math.random() * (FLASHLIGHT_FLICKER_MAX_HOLD - FLASHLIGHT_FLICKER_MIN_HOLD);
  }

  flashlightFlickerValue +=
    (flashlightFlickerTarget - flashlightFlickerValue) *
    Math.min(1, deltaSeconds * FLASHLIGHT_FLICKER_RATE);
  flashlight.intensity = FLASHLIGHT_BASE_INTENSITY * flashlightFlickerValue;
  flashlight.distance = FLASHLIGHT_BASE_DISTANCE * (0.85 + flashlightFlickerValue * 0.15);
}

function hideFlashlightBounceLight() {
  flashlightBounceLight.intensity = 0;
  syncBounceLightDebugMarker();
}

function computeSpotAttenuation(angleCos, spotLight) {
  const penumbra = THREE.MathUtils.clamp(spotLight.penumbra ?? 0, 0, 1);
  const outerCos = Math.cos(spotLight.angle);
  const innerCos = Math.cos(spotLight.angle * (1 - penumbra));

  if (angleCos <= outerCos) {
    return 0;
  }
  if (angleCos >= innerCos) {
    return 1;
  }

  const t = (angleCos - outerCos) / Math.max(innerCos - outerCos, 0.00001);
  return t * t * (3 - 2 * t);
}

function computeRangeAttenuation(lightDistance, cutoffDistance) {
  if (!(cutoffDistance > 0)) {
    return 1;
  }

  const distanceRatio = lightDistance / cutoffDistance;
  const distanceRatioPow4 = distanceRatio * distanceRatio * distanceRatio * distanceRatio;
  const softEdge = Math.max(1 - distanceRatioPow4, 0);
  return softEdge * softEdge;
}

function computeEmaBlend(deltaSeconds, halfLifeSeconds) {
  const dt = Math.max(0, deltaSeconds || 0);
  const clampedHalfLife = Math.max(0.00001, halfLifeSeconds || 0);
  return 1 - Math.exp((-Math.LN2 * dt) / clampedHalfLife);
}

function updateFlashlightBounceEma(targetColor, targetIntensity, targetPosition, deltaSeconds) {
  if (!flashlightBounceEmaInitialized) {
    flashlightBounceSmoothedColor.copy(targetColor);
    flashlightBounceSmoothedIntensity = targetIntensity;
    if (targetPosition) {
      flashlightBounceSmoothedPosition.copy(targetPosition);
    } else {
      flashlightBounceSmoothedPosition.copy(flashlightBounceLight.position);
    }
    flashlightBounceEmaInitialized = true;
    return;
  }

  const blend = computeEmaBlend(deltaSeconds, FLASHLIGHT_BOUNCE_EMA_HALF_LIFE);
  flashlightBounceSmoothedColor.lerp(targetColor, blend);
  flashlightBounceSmoothedIntensity +=
    (targetIntensity - flashlightBounceSmoothedIntensity) * blend;
  if (targetPosition) {
    const positionBlend = computeEmaBlend(
      deltaSeconds,
      FLASHLIGHT_BOUNCE_POSITION_EMA_HALF_LIFE,
    );
    flashlightBounceSmoothedPosition.lerp(targetPosition, positionBlend);
  }
}

function updateFlashlightBounceLight(deltaSeconds) {
  if (!isFlashlightEmissionActive() || isTopDownView || hasWon) {
    bounceLightDebugHasHit = false;
    hideFlashlightBounceLight();
    flashlightBounceEmaInitialized = false;
    flashlightBounceSmoothedIntensity = 0;
    return;
  }

  flashlight.getWorldPosition(flashlightBounceOrigin);
  flashlightTarget.getWorldPosition(flashlightTargetWorld);

  flashlightBounceDirection.subVectors(flashlightTargetWorld, flashlightBounceOrigin);
  if (flashlightBounceDirection.lengthSq() < 0.000001) {
    bounceLightDebugHasHit = false;
    hideFlashlightBounceLight();
    return;
  }
  flashlightBounceDirection.normalize();
  flashlightRaycaster.set(flashlightBounceOrigin, flashlightBounceDirection);
  flashlightRaycaster.far = flashlight.distance > 0 ? flashlight.distance : Infinity;

  const bounceTargets = [wallMesh, floorMesh, roofMesh].filter(Boolean);
  if (propScatter.root?.children?.length) {
    bounceTargets.push(...propScatter.root.children);
  }
  const intersections = flashlightRaycaster.intersectObjects(bounceTargets, false);

  if (!intersections.length) {
    bounceLightDebugHasHit = false;
    syncBounceLightDebugMarker();
    updateFlashlightBounceEma(flashlightBounceSmoothedColor, 0, null, deltaSeconds);
    if (flashlightBounceSmoothedIntensity <= 0.0005) {
      hideFlashlightBounceLight();
      return;
    }
    flashlightBounceLight.color.copy(flashlightBounceSmoothedColor);
    flashlightBounceLight.intensity = flashlightBounceSmoothedIntensity;
    syncBounceLightDebugMarker();
    return;
  }

  const hit = intersections[0];
  flashlightHitDirection.subVectors(hit.point, flashlightBounceOrigin);
  const hitDistance = flashlightHitDirection.length();
  if (hitDistance > 0.00001) {
    flashlightHitDirection.multiplyScalar(1 / hitDistance);
    bounceLightDebugHasHit = true;
    bounceLightDebugPosition.copy(hit.point).addScaledVector(flashlightHitDirection, -0.06);
  } else {
    bounceLightDebugHasHit = false;
  }
  syncBounceLightDebugMarker();

  if (!hit.face) {
    updateFlashlightBounceEma(flashlightBounceSmoothedColor, 0, null, deltaSeconds);
    if (flashlightBounceSmoothedIntensity <= 0.0005) {
      hideFlashlightBounceLight();
      return;
    }
    flashlightBounceLight.color.copy(flashlightBounceSmoothedColor);
    flashlightBounceLight.intensity = flashlightBounceSmoothedIntensity;
    syncBounceLightDebugMarker();
    return;
  }

  flashlightBounceNormal.copy(hit.normal).transformDirection(hit.object.matrixWorld).normalize();
  if (hitDistance <= 0.00001) {
    hideFlashlightBounceLight();
    return;
  }

  const incidenceCos = Math.max(-flashlightBounceNormal.dot(flashlightHitDirection), 0);
  if (incidenceCos <= 0) {
    updateFlashlightBounceEma(flashlightBounceSmoothedColor, 0, null, deltaSeconds);
    if (flashlightBounceSmoothedIntensity <= 0.0005) {
      hideFlashlightBounceLight();
      return;
    }
    flashlightBounceLight.color.copy(flashlightBounceSmoothedColor);
    flashlightBounceLight.intensity = flashlightBounceSmoothedIntensity;
    syncBounceLightDebugMarker();
    return;
  }

  const angleCos = THREE.MathUtils.clamp(
    flashlightBounceDirection.dot(flashlightHitDirection),
    -1,
    1,
  );
  const spotAttenuation = computeSpotAttenuation(angleCos, flashlight);
  if (spotAttenuation <= 0) {
    updateFlashlightBounceEma(flashlightBounceSmoothedColor, 0, null, deltaSeconds);
    if (flashlightBounceSmoothedIntensity <= 0.0005) {
      hideFlashlightBounceLight();
      return;
    }
    flashlightBounceLight.color.copy(flashlightBounceSmoothedColor);
    flashlightBounceLight.intensity = flashlightBounceSmoothedIntensity;
    syncBounceLightDebugMarker();
    return;
  }

  const rangeAttenuation = computeRangeAttenuation(hitDistance, flashlight.distance);
  const coneSolidAngle = TWO_PI * (1 - Math.cos(flashlight.angle));
  const incidentFlux =
    flashlight.intensity * coneSolidAngle * spotAttenuation * rangeAttenuation;
  const bounceIntensity = (incidentFlux * incidenceCos) / TWO_PI;
  flashlightBounceTargetColor.copy(
    resolveMaterialBounceReflectance(
      Array.isArray(hit.object.material)
        ? hit.object.material[hit.face?.materialIndex ?? 0]
        : hit.object.material,
    ),
  );
  flashlightBounceTargetPosition.copy(hit.point).addScaledVector(flashlightBounceNormal, 0.08);
  updateFlashlightBounceEma(
    flashlightBounceTargetColor,
    bounceIntensity,
    flashlightBounceTargetPosition,
    deltaSeconds,
  );

  flashlightBounceLight.position.copy(flashlightBounceSmoothedPosition);
  flashlightBounceLight.color.copy(flashlightBounceSmoothedColor);
  flashlightBounceLight.intensity = flashlightBounceSmoothedIntensity;
  bounceLightDebugHasHit = true;
  bounceLightDebugPosition.copy(flashlightBounceLight.position);
  syncBounceLightDebugMarker();
}

function setStatus(text) {
  status.textContent = text;
}

function clampPlayerHealth(value) {
  if (!Number.isFinite(value)) {
    return playerHealth;
  }
  return Math.max(0, Math.min(PLAYER_MAX_HEALTH, value));
}

function updateHealthHud() {
  const healthRatio = PLAYER_MAX_HEALTH > 0 ? playerHealth / PLAYER_MAX_HEALTH : 0;
  const healthPercent = Math.max(0, Math.min(100, healthRatio * 100));
  const healthTrailRatio =
    PLAYER_MAX_HEALTH > 0 ? playerHealthDamageTrail / PLAYER_MAX_HEALTH : 0;
  const healthTrailPercent = Math.max(
    healthPercent,
    Math.max(0, Math.min(100, healthTrailRatio * 100)),
  );

  if (healthRingFill) {
    healthRingFill.style.setProperty("--health-progress", healthPercent.toFixed(3));
  }
  if (healthRingLoss) {
    healthRingLoss.style.setProperty("--health-progress", healthPercent.toFixed(3));
    healthRingLoss.style.setProperty("--health-loss-progress", healthTrailPercent.toFixed(3));
  }
}

function setPlayerHealth(nextHealth) {
  const previousHealth = playerHealth;
  const clampedHealth = clampPlayerHealth(nextHealth);
  if (clampedHealth < previousHealth) {
    playerHealthDamageTrail = Math.max(playerHealthDamageTrail, previousHealth);
    playerHealthDamageTrailHoldRemaining = HEALTH_DAMAGE_TRAIL_HOLD_SECONDS;
  } else if (clampedHealth >= previousHealth) {
    playerHealthDamageTrail = clampedHealth;
    playerHealthDamageTrailHoldRemaining = 0;
  }
  playerHealth = clampedHealth;
  updateHealthHud();
}

function updateHealthDamageTrail(deltaSeconds) {
  if (playerHealthDamageTrail <= playerHealth) {
    playerHealthDamageTrail = playerHealth;
    return;
  }
  if (playerHealthDamageTrailHoldRemaining > 0) {
    playerHealthDamageTrailHoldRemaining = Math.max(
      0,
      playerHealthDamageTrailHoldRemaining - deltaSeconds,
    );
    return;
  }
  const clampedDeltaSeconds = Math.max(0, deltaSeconds);
  const trailDelta = playerHealthDamageTrail - playerHealth;
  const decayFactor = Math.exp(-HEALTH_DAMAGE_TRAIL_DECAY_RATE * clampedDeltaSeconds);
  const nextTrail = playerHealth + trailDelta * decayFactor;
  playerHealthDamageTrail =
    nextTrail - playerHealth <= HEALTH_DAMAGE_TRAIL_MIN_DELTA ? playerHealth : nextTrail;
  updateHealthHud();
}

function getActiveConsumableUseProgress() {
  if (!jerkyConsumeActive || consumableUseDuration <= 0) {
    return 0;
  }
  return THREE.MathUtils.clamp(jerkyConsumeElapsed / consumableUseDuration, 0, 1);
}

function getJerkyConsumeProgress() {
  if (!jerkyConsumeActive || consumableUseItemId !== JERKY_ITEM_ID) {
    return 0;
  }
  return getActiveConsumableUseProgress();
}

function updateJerkyConsumeHud() {
  const progress = getActiveConsumableUseProgress();
  if (consumeProgress) {
    consumeProgress.classList.toggle("active", jerkyConsumeActive);
  }
  if (consumeProgressFill) {
    consumeProgressFill.style.width = `${(progress * 100).toFixed(2)}%`;
  }
  if (consumeProgressLabel) {
    consumeProgressLabel.textContent = jerkyConsumeActive ? consumableUseLabel : "";
  }
}

function removeInventoryItemById(itemId) {
  const selectedSlotIndex = getSelectedInventorySlotIndex();
  if (
    selectedSlotIndex >= 0 &&
    selectedSlotIndex < INVENTORY_MAX_ITEMS &&
    inventory[selectedSlotIndex]?.id === itemId
  ) {
    inventory[selectedSlotIndex] = null;
    return true;
  }
  for (let i = INVENTORY_MAX_ITEMS - 1; i >= 0; i -= 1) {
    if (inventory[i]?.id !== itemId) {
      continue;
    }
    inventory[i] = null;
    return true;
  }
  return false;
}

function getPlayerSpeedMultiplier() {
  return sodaSpeedBoostRemaining > 0 ? SODA_SPEED_MULTIPLIER : 1;
}

function updateTimedBuffIndicator(indicator, timerNode, active, remainingSeconds) {
  if (!indicator) {
    return;
  }
  indicator.classList.toggle("active", active);
  if (!timerNode) {
    return;
  }
  timerNode.textContent = active ? `${Math.ceil(remainingSeconds)}s` : "";
}

function updateBuffHud() {
  updateTimedBuffIndicator(
    sodaBoostIndicator,
    sodaBoostTimer,
    sodaSpeedBoostRemaining > 0,
    sodaSpeedBoostRemaining,
  );
  updateTimedBuffIndicator(
    regenIndicator,
    regenTimer,
    firstAidRegenRemaining > 0,
    firstAidRegenRemaining,
  );
}

function useFirstAidKit() {
  if (!removeInventoryItemById(FIRST_AID_KIT_ITEM_ID)) {
    setStatus("First aid kit unavailable.");
    return false;
  }
  const previousHealth = playerHealth;
  setPlayerHealth(playerHealth + FIRST_AID_KIT_HEAL_AMOUNT);
  firstAidRegenRemaining = FIRST_AID_REGEN_DURATION_SECONDS;
  const healedAmount = Math.max(0, Math.round(playerHealth - previousHealth));
  updateInventoryHud();
  updatePickupPrompt();
  setStatus(
    `Used first aid kit. +${healedAmount} health. Regen active (${FIRST_AID_REGEN_PER_SECOND}/s for ${FIRST_AID_REGEN_DURATION_SECONDS}s).`,
  );
  return true;
}

function useSodaCan() {
  if (!removeInventoryItemById(SODA_CAN_ITEM_ID)) {
    setStatus("Soda can unavailable.");
    return false;
  }
  sodaSpeedBoostRemaining = SODA_SPEED_DURATION_SECONDS;
  updateInventoryHud();
  updatePickupPrompt();
  updateBuffHud();
  setStatus(
    `Drank soda. Speed boost active (+50% for ${SODA_SPEED_DURATION_SECONDS}s).`,
  );
  return true;
}

function consumeJerkyAndHeal() {
  if (!removeInventoryItemById(JERKY_ITEM_ID)) {
    setStatus("Jerky use canceled (item missing).");
    updateInventoryHud();
    updatePickupPrompt();
    return false;
  }

  const previousHealth = playerHealth;
  setPlayerHealth(playerHealth + JERKY_HEAL_AMOUNT);
  const healedAmount = Math.max(0, Math.round(playerHealth - previousHealth));
  updateInventoryHud();
  updatePickupPrompt();
  setStatus(`Ate jerky. +${healedAmount} health.`);
  return true;
}

function getConsumableUseConfig(itemId) {
  if (itemId === JERKY_ITEM_ID) {
    return {
      itemId,
      durationSeconds: JERKY_CONSUME_DURATION_SECONDS,
      label: "Eating jerky...",
      cancelStatus: "Jerky use canceled.",
      onComplete: consumeJerkyAndHeal,
    };
  }
  if (itemId === FIRST_AID_KIT_ITEM_ID) {
    return {
      itemId,
      durationSeconds: FIRST_AID_USE_DURATION_SECONDS,
      label: "Using first aid kit...",
      cancelStatus: "First aid use canceled.",
      onComplete: useFirstAidKit,
    };
  }
  if (itemId === SODA_CAN_ITEM_ID) {
    return {
      itemId,
      durationSeconds: SODA_USE_DURATION_SECONDS,
      label: "Drinking soda...",
      cancelStatus: "Soda use canceled.",
      onComplete: useSodaCan,
    };
  }
  return null;
}

function getActiveConsumableCancelStatus() {
  const config = getConsumableUseConfig(consumableUseItemId);
  return config?.cancelStatus || "Consumable use canceled.";
}

function cancelJerkyConsume(statusText = null) {
  if (!jerkyConsumeActive && jerkyConsumeElapsed <= 0 && !consumableUseItemId) {
    return;
  }
  jerkyConsumeActive = false;
  jerkyConsumeElapsed = 0;
  consumableUseItemId = null;
  consumableUseDuration = 0;
  consumableUseLabel = "";
  updateJerkyConsumeHud();
  if (statusText) {
    setStatus(statusText);
  }
}

function tryStartJerkyConsume() {
  const selectedItem = getSelectedInventoryItem();
  const config = getConsumableUseConfig(selectedItem?.id);
  if (!config) {
    return false;
  }
  if (jerkyConsumeActive) {
    return consumableUseItemId === config.itemId;
  }
  jerkyConsumeActive = true;
  jerkyConsumeElapsed = 0;
  consumableUseItemId = config.itemId;
  consumableUseDuration = config.durationSeconds;
  consumableUseLabel = config.label;
  updateJerkyConsumeHud();
  setStatus(`${config.label} Keep holding left click.`);
  return true;
}

function updateJerkyConsume(deltaSeconds) {
  if (!jerkyConsumeActive) {
    return;
  }

  if (
    !gameActive ||
    hasWon ||
    isTopDownView ||
    (canUsePointerLock && !controls.isLocked) ||
    getSelectedInventoryItem()?.id !== consumableUseItemId
  ) {
    cancelJerkyConsume();
    return;
  }

  const config = getConsumableUseConfig(consumableUseItemId);
  if (!config) {
    cancelJerkyConsume();
    return;
  }

  jerkyConsumeElapsed += Math.max(0, deltaSeconds);
  if (jerkyConsumeElapsed >= consumableUseDuration) {
    jerkyConsumeActive = false;
    jerkyConsumeElapsed = consumableUseDuration;
    updateJerkyConsumeHud();
    consumableUseItemId = null;
    consumableUseDuration = 0;
    consumableUseLabel = "";
    config.onComplete();
    jerkyConsumeElapsed = 0;
    updateJerkyConsumeHud();
    return;
  }

  updateJerkyConsumeHud();
}

function updateConsumableEffects(deltaSeconds) {
  if (gameActive && !hasWon) {
    if (sodaSpeedBoostRemaining > 0) {
      sodaSpeedBoostRemaining = Math.max(0, sodaSpeedBoostRemaining - deltaSeconds);
    }
    if (firstAidRegenRemaining > 0) {
      firstAidRegenRemaining = Math.max(0, firstAidRegenRemaining - deltaSeconds);
      if (playerHealth < PLAYER_MAX_HEALTH) {
        setPlayerHealth(playerHealth + FIRST_AID_REGEN_PER_SECOND * deltaSeconds);
      }
    }
  }
  updateBuffHud();
}

function updateConsumableUseVisuals() {
  if (jerkyConsumeActive && getSelectedInventoryItem()?.id === consumableUseItemId) {
    const phase = elapsed * JERKY_EAT_BOB_FREQUENCY * TWO_PI;
    inventoryLeftHandItemAnchor.position.y = Math.sin(phase) * JERKY_EAT_BOB_AMPLITUDE;
    inventoryLeftHandItemAnchor.position.z = Math.sin(phase * 0.5) * JERKY_EAT_BOB_DEPTH;
    return;
  }
  inventoryLeftHandItemAnchor.position.set(0, 0, 0);
}

function evaluateHeartbeatPulse(phase, pulseCenter, amplitude) {
  const distance = phase - pulseCenter;
  const sigma = HEALTH_HEARTBEAT_WIDTH;
  const gaussian = Math.exp(-(distance * distance) / (2 * sigma * sigma));
  return amplitude * gaussian;
}

function updateHealthHeartBeatVisual() {
  if (!healthHeartImage) {
    return;
  }
  const phase = (elapsed % HEALTH_HEARTBEAT_CYCLE_SECONDS) / HEALTH_HEARTBEAT_CYCLE_SECONDS;
  const beatScale =
    1 +
    evaluateHeartbeatPulse(
      phase,
      HEALTH_HEARTBEAT_PRIMARY_TIME,
      HEALTH_HEARTBEAT_PRIMARY_AMPLITUDE,
    ) +
    evaluateHeartbeatPulse(
      phase,
      HEALTH_HEARTBEAT_SECONDARY_TIME,
      HEALTH_HEARTBEAT_SECONDARY_AMPLITUDE,
    );
  healthHeartImage.style.transform = `scale(${beatScale.toFixed(4)})`;
}

function applyPlayerDamage(amount, sourceLabel = "damage") {
  const damageAmount = Number(amount);
  if (!Number.isFinite(damageAmount) || damageAmount <= 0) {
    return;
  }
  const previousHealth = playerHealth;
  setPlayerHealth(playerHealth - damageAmount);
  const appliedDamage = Math.max(0, previousHealth - playerHealth);
  if (appliedDamage <= 0) {
    setStatus("Health is already at minimum.");
    return;
  }
  setStatus(
    `Health -${Math.round(appliedDamage)} (${sourceLabel}). ${Math.round(playerHealth)}/${PLAYER_MAX_HEALTH}`,
  );
}

function normalizeInventorySlotIndex(index) {
  return ((index % INVENTORY_MAX_ITEMS) + INVENTORY_MAX_ITEMS) % INVENTORY_MAX_ITEMS;
}

function getSelectedInventorySlotIndex() {
  return normalizeInventorySlotIndex(-inventoryWheelRotationSteps);
}

function getSelectedInventoryItem() {
  return inventory[getSelectedInventorySlotIndex()] || null;
}

function getInventoryOccupiedCount() {
  let count = 0;
  for (let i = 0; i < INVENTORY_MAX_ITEMS; i += 1) {
    if (inventory[i]) {
      count += 1;
    }
  }
  return count;
}

function findFirstEmptyInventorySlotIndex() {
  for (let i = 0; i < INVENTORY_MAX_ITEMS; i += 1) {
    if (!inventory[i]) {
      return i;
    }
  }
  return -1;
}

function isFlashlightSuppressedByTwoHandedBat() {
  return getSelectedInventoryItem()?.id === BASEBALL_BAT_ITEM_ID;
}

function isFlashlightEmissionActive() {
  return flashlightEnabled && !isFlashlightSuppressedByTwoHandedBat();
}

function clearBulletDecals() {
  while (bulletDecals.length > 0) {
    const decal = bulletDecals.pop();
    if (!decal) {
      continue;
    }
    scene.remove(decal);
    decal.geometry?.dispose?.();
  }
}

function syncBulletDecalMaterials() {
  const nextMaterial = pistolImpactDebugEnabled ? bulletDecalDebugMaterial : bulletDecalLitMaterial;
  for (const decal of bulletDecals) {
    decal.material = nextMaterial;
  }
}

function setPistolImpactDebugEnabled(enabled) {
  pistolImpactDebugEnabled = Boolean(enabled);
  syncBulletDecalMaterials();
  if (!pistolImpactDebugEnabled) {
    pistolHitDebugMarker.visible = false;
    pistolPropDebugMarkerRemaining = 0;
  }
}

function togglePistolImpactDebug() {
  setPistolImpactDebugEnabled(!pistolImpactDebugEnabled);
  setStatus(
    pistolImpactDebugEnabled
      ? "Pistol impact debug on. Decals/emphasis visible and prop hits are reported."
      : "Pistol impact debug off. Decals use dark-lit material.",
  );
}

function updatePistolPropDebugMarker(deltaSeconds) {
  if (!pistolImpactDebugEnabled) {
    pistolHitDebugMarker.visible = false;
    pistolPropDebugMarkerRemaining = 0;
    return;
  }

  if (pistolPropDebugMarkerRemaining <= 0) {
    pistolHitDebugMarker.visible = false;
    return;
  }

  pistolPropDebugMarkerRemaining = Math.max(0, pistolPropDebugMarkerRemaining - deltaSeconds);
  const t = THREE.MathUtils.clamp(
    pistolPropDebugMarkerRemaining / PISTOL_PROP_DEBUG_MARKER_LIFETIME,
    0,
    1,
  );
  const pulse = 1 + Math.sin(elapsed * 35) * 0.12;
  const scale = (0.8 + t * 0.45) * pulse;
  pistolHitDebugMarker.scale.set(scale, scale, scale);
  pistolHitDebugMarker.visible = pistolPropDebugMarkerRemaining > 0;
}

function resolvePistolMuzzleWorldPosition() {
  const fallback = () => {
    pistolMuzzleFallbackWorldPosition.copy(PISTOL_MUZZLE_FLASH_FALLBACK_LOCAL_POSITION);
    inventoryLeftHandRig.localToWorld(pistolMuzzleFallbackWorldPosition);
    return pistolMuzzleFallbackWorldPosition;
  };

  if (heldInventoryItemId !== PISTOL_ITEM_ID) {
    return fallback();
  }

  const pistolModel = heldInventoryModelById.get(PISTOL_ITEM_ID);
  if (!pistolModel || pistolModel.parent !== inventoryLeftHandItemAnchor) {
    return fallback();
  }

  const localBounds = pistolModel.userData.localBounds;
  if (!localBounds || localBounds.isEmpty()) {
    return fallback();
  }

  pistolMuzzleDirectionWorld.set(-0.15, 0.02, -1).applyQuaternion(camera.quaternion).normalize();
  pistolModel.getWorldQuaternion(pistolMuzzleModelWorldQuaternion);
  pistolMuzzleDirectionLocal
    .copy(pistolMuzzleDirectionWorld)
    .applyQuaternion(pistolMuzzleModelWorldQuaternion.invert())
    .normalize();
  if (pistolMuzzleDirectionLocal.lengthSq() < 0.000001) {
    pistolMuzzleDirectionLocal.set(0, 0, -1);
  }
  // The pistol import points opposite the gameplay-forward barrel direction.
  // Flip once so muzzle flash resolves to the actual barrel end.
  pistolMuzzleDirectionLocal.negate();

  localBounds.getCenter(pistolMuzzleBoundsCenter);
  localBounds.getSize(pistolMuzzleBoundsSize);
  pistolMuzzleSupportLocalPoint.copy(pistolMuzzleBoundsCenter);

  const ax = Math.abs(pistolMuzzleDirectionLocal.x);
  const ay = Math.abs(pistolMuzzleDirectionLocal.y);
  const az = Math.abs(pistolMuzzleDirectionLocal.z);
  if (ax >= ay && ax >= az) {
    pistolMuzzleSupportLocalPoint.x =
      pistolMuzzleDirectionLocal.x >= 0 ? localBounds.max.x : localBounds.min.x;
  } else if (ay >= az) {
    pistolMuzzleSupportLocalPoint.y =
      pistolMuzzleDirectionLocal.y >= 0 ? localBounds.max.y : localBounds.min.y;
  } else {
    pistolMuzzleSupportLocalPoint.z =
      pistolMuzzleDirectionLocal.z >= 0 ? localBounds.max.z : localBounds.min.z;
  }

  pistolMuzzleSupportLocalPoint.addScaledVector(pistolMuzzleDirectionLocal, -4);
  // Add a small amount of camera right to the left
  // to prevent the muzzle flash from being exactly flush with geometry when looking straight at it.

  pistolMuzzleWorldPosition.copy(pistolMuzzleSupportLocalPoint);
  pistolModel.localToWorld(pistolMuzzleWorldPosition);
  pistolMuzzleWorldPosition.addScaledVector(
    pistolMuzzleDirectionWorld,
    PISTOL_MUZZLE_FORWARD_WORLD_OFFSET,
  );
  return pistolMuzzleWorldPosition;
}

function randomizePistolMuzzleFlashFrame() {
  const frameIndex = Math.floor(Math.random() * PISTOL_MUZZLE_FLASH_FRAME_COUNT);
  muzzleFlashTexture.offset.x = frameIndex * PISTOL_MUZZLE_FLASH_FRAME_WIDTH;
}

function updatePistolMuzzleFlashTransform() {
  const muzzleWorldPosition = resolvePistolMuzzleWorldPosition();
  pistolMuzzleFlashSprite.position.copy(muzzleWorldPosition);
  pistolMuzzleFlashLight.position.copy(muzzleWorldPosition);
}

function updatePistolVisualEffects(deltaSeconds) {
  pistolRecoilAmount +=
    (0 - pistolRecoilAmount) * Math.min(1, deltaSeconds * PISTOL_RECOIL_RETURN_RATE);

  const selectedIsPistol = getSelectedInventoryItem()?.id === PISTOL_ITEM_ID;
  if (selectedIsPistol || pistolRecoilAmount > 0.0004) {
    inventoryLeftHandRig.position.x += PISTOL_RECOIL_POSITION_KICK.x * pistolRecoilAmount;
    inventoryLeftHandRig.position.y += PISTOL_RECOIL_POSITION_KICK.y * pistolRecoilAmount;
    inventoryLeftHandRig.position.z += PISTOL_RECOIL_POSITION_KICK.z * pistolRecoilAmount;
    inventoryLeftHandRig.rotation.x += PISTOL_RECOIL_ROTATION_KICK.x * pistolRecoilAmount;
    inventoryLeftHandRig.rotation.y += PISTOL_RECOIL_ROTATION_KICK.y * pistolRecoilAmount;
    inventoryLeftHandRig.rotation.z += PISTOL_RECOIL_ROTATION_KICK.z * pistolRecoilAmount;
  }

  updatePistolMuzzleFlashTransform();

  const flashVisible = pistolMuzzleFlashRemaining > 0 && gameActive && !isTopDownView;
  if (!flashVisible) {
    pistolMuzzleFlashMaterial.opacity = 0;
    pistolMuzzleFlashSprite.visible = false;
    pistolMuzzleFlashLight.intensity = 0;
    pistolMuzzleFlashRemaining = Math.max(0, pistolMuzzleFlashRemaining - deltaSeconds);
    return;
  }

  const normalizedLife = THREE.MathUtils.clamp(
    pistolMuzzleFlashRemaining / PISTOL_MUZZLE_FLASH_DURATION,
    0,
    1,
  );
  const strength = Math.max(0, Math.pow(normalizedLife, 0.38));
  const flashSize = 0.5 + strength * 0.5;

  pistolMuzzleFlashMaterial.opacity = 0.35 + strength * 0.5;
  pistolMuzzleFlashSprite.visible = true;
  pistolMuzzleFlashSprite.scale.set(flashSize, flashSize, flashSize);
  pistolMuzzleFlashLight.intensity = 1.2 + strength * 2.2;
  pistolMuzzleFlashLight.distance = 3.2 + strength * 2.8;
  pistolMuzzleFlashRemaining = Math.max(0, pistolMuzzleFlashRemaining - deltaSeconds);
}

function getBulletAmmoCount() {
  let count = 0;
  for (const item of inventory) {
    if (item?.id === BULLET_ITEM_ID) {
      count += 1;
    }
  }
  return count;
}

function consumeBulletAmmo() {
  for (let i = INVENTORY_MAX_ITEMS - 1; i >= 0; i -= 1) {
    if (inventory[i]?.id !== BULLET_ITEM_ID) {
      continue;
    }
    inventory[i] = null;
    return true;
  }
  return false;
}

function isDescendantOf(node, rootNode) {
  let current = node;
  while (current) {
    if (current === rootNode) {
      return true;
    }
    current = current.parent;
  }
  return false;
}

function getPropHitLabel(object) {
  let current = object;
  while (current && current !== propScatter.root) {
    const candidate = `${current.name || ""}`.trim();
    if (candidate && candidate.toLowerCase() !== "scene") {
      return candidate;
    }
    current = current.parent;
  }
  return "prop";
}

function describePistolHit(hit) {
  if (!hit?.object) {
    return null;
  }

  const target = hit.object;
  if (target === wallMesh) {
    return { type: "wall", label: "wall", distance: hit.distance };
  }
  if (target === floorMesh) {
    return { type: "floor", label: "floor", distance: hit.distance };
  }
  if (target === roofMesh) {
    return { type: "ceiling", label: "ceiling", distance: hit.distance };
  }
  if (isDescendantOf(target, propScatter.root)) {
    return { type: "prop", label: getPropHitLabel(target), distance: hit.distance };
  }
  return { type: "surface", label: target.name || "surface", distance: hit.distance };
}

function resolvePistolShotDirection(directionOverride) {
  if (directionOverride?.isVector3) {
    pistolShotDirection.copy(directionOverride);
  } else {
    pistolShotDirection.set(0, 0, -1).applyQuaternion(camera.quaternion);
  }
  if (pistolShotDirection.lengthSq() < 0.000001) {
    pistolShotDirection.set(0, 0, -1);
  }
  pistolShotDirection.normalize();
  return pistolShotDirection;
}

function performPistolHitScan(directionOverride = null, targetsOverride = null, maxRangeOverride = null) {
  resolvePistolShotDirection(directionOverride);

  pistolRaycaster.set(camera.position, pistolShotDirection);
  pistolRaycaster.near = 0.05;
  const hasRangeOverride =
    maxRangeOverride === Infinity ||
    (Number.isFinite(maxRangeOverride) && maxRangeOverride > 0);
  pistolRaycaster.far = hasRangeOverride ? maxRangeOverride : PISTOL_FIRE_RANGE;

  const targets = Array.isArray(targetsOverride)
    ? targetsOverride.filter(Boolean)
    : [wallMesh, floorMesh, roofMesh, ...(propScatter.root?.children || [])].filter(Boolean);
  if (!targets.length) {
    return null;
  }
  const intersections = pistolRaycaster.intersectObjects(targets, true);
  return intersections[0] || null;
}

function pushBulletDecalMesh(decalMesh) {
  scene.add(decalMesh);
  bulletDecals.push(decalMesh);

  while (bulletDecals.length > BULLET_DECAL_MAX_COUNT) {
    const oldest = bulletDecals.shift();
    if (!oldest) {
      continue;
    }
    scene.remove(oldest);
    oldest.geometry?.dispose?.();
  }
}

function resolveBulletDecalSurfaceNormal(hit, outNormal) {
  if (!hit?.face || !hit?.object) {
    return false;
  }

  outNormal.copy(hit.face.normal);
  if (hit.object.isInstancedMesh && hit.instanceId !== undefined) {
    hit.object.getMatrixAt(hit.instanceId, bulletDecalInstanceMatrix);
    bulletDecalInstanceWorldMatrix.multiplyMatrices(
      hit.object.matrixWorld,
      bulletDecalInstanceMatrix,
    );
    bulletDecalNormalMatrix.getNormalMatrix(bulletDecalInstanceWorldMatrix);
    outNormal.applyNormalMatrix(bulletDecalNormalMatrix);
  } else {
    bulletDecalNormalMatrix.getNormalMatrix(hit.object.matrixWorld);
    outNormal.applyNormalMatrix(bulletDecalNormalMatrix);
  }
  outNormal.normalize();

  bulletDecalRayDirection.copy(pistolRaycaster.ray.direction);
  if (bulletDecalRayDirection.lengthSq() > 0.000001 && outNormal.dot(bulletDecalRayDirection) > 0) {
    outNormal.negate();
  }

  return true;
}

function resolveBulletDecalTransformFromHit(hit) {
  if (!resolveBulletDecalSurfaceNormal(hit, bulletDecalNormal)) {
    return false;
  }

  bulletDecalPosition.copy(hit.point).addScaledVector(bulletDecalNormal, 0.006);
  bulletDecalLookTarget.copy(bulletDecalPosition).add(bulletDecalNormal);

  // Match the official three.js decals example flow:
  // position a helper and orient it by looking along the hit normal.
  bulletDecalProjector.position.copy(bulletDecalPosition);
  bulletDecalProjector.lookAt(bulletDecalLookTarget);
  bulletDecalRotation.copy(bulletDecalProjector.rotation);
  bulletDecalRotation.z = Math.random() * Math.PI * 2;
  return true;
}

function spawnFallbackBulletDecalPlane(hit, size) {
  if (!resolveBulletDecalTransformFromHit(hit)) {
    return false;
  }

  const plane = new THREE.Mesh(
    new THREE.PlaneGeometry(size, size),
    pistolImpactDebugEnabled ? bulletDecalDebugMaterial : bulletDecalLitMaterial,
  );
  plane.quaternion.copy(bulletDecalProjector.quaternion);
  plane.rotateZ(bulletDecalRotation.z);
  plane.position.copy(bulletDecalPosition);
  plane.renderOrder = 12;
  pushBulletDecalMesh(plane);
  return true;
}

function spawnBulletDecal(hit) {
  const targetMesh = hit?.object?.isMesh ? hit.object : null;
  if (!targetMesh || !resolveBulletDecalTransformFromHit(hit)) {
    return false;
  }

  const randomizedSize =
    BULLET_DECAL_SIZE + (Math.random() * 2 - 1) * BULLET_DECAL_SIZE_VARIANCE;
  const finalSize = Math.max(0.18, randomizedSize);
  bulletDecalSize.set(finalSize, finalSize, finalSize);

  if (hit.instanceId !== undefined) {
    return spawnFallbackBulletDecalPlane(hit, finalSize);
  }

  let decalGeometry = null;
  try {
    decalGeometry = new DecalGeometry(
      targetMesh,
      bulletDecalPosition,
      bulletDecalRotation,
      bulletDecalSize,
    );
  } catch {
    decalGeometry = null;
  }

  if (!decalGeometry?.attributes?.position?.count) {
    decalGeometry?.dispose?.();
    return spawnFallbackBulletDecalPlane(hit, finalSize);
  }

  const decalMesh = new THREE.Mesh(
    decalGeometry,
    pistolImpactDebugEnabled ? bulletDecalDebugMaterial : bulletDecalLitMaterial,
  );
  decalMesh.renderOrder = 12;
  pushBulletDecalMesh(decalMesh);
  return true;
}

function recordPistolDebugMarker(hit) {
  if (!pistolImpactDebugEnabled || !hit?.face || !hit?.object) {
    return;
  }

  if (!resolveBulletDecalSurfaceNormal(hit, pistolHitDebugNormal)) {
    return;
  }
  pistolDebugHitPoint.copy(hit.point).addScaledVector(pistolHitDebugNormal, 0.03);
  pistolHitDebugMarker.position.copy(pistolDebugHitPoint);
  pistolHitDebugMarker.visible = true;
  pistolPropDebugMarkerRemaining = PISTOL_PROP_DEBUG_MARKER_LIFETIME;
}

function tryShootPistol(options = null) {
  const selectedItem = getSelectedInventoryItem();
  if (selectedItem?.id !== PISTOL_ITEM_ID) {
    return false;
  }
  const bypassCooldown = Boolean(options?.bypassCooldown);
  if (!bypassCooldown && pistolFireCooldownRemaining > 0) {
    return true;
  }

  if (!pistolInfiniteAmmo && !consumeBulletAmmo()) {
    if (pistolImpactDebugEnabled) {
      setStatus("Pistol empty (debug). Add bullets or press I for infinite ammo.");
    } else {
      setStatus("Pistol empty. Pick up bullets or press I for debug infinite ammo.");
    }
    return true;
  }

  pistolFireCooldownRemaining = PISTOL_FIRE_COOLDOWN_SECONDS;
  pistolRecoilAmount = Math.min(1, pistolRecoilAmount + 1);
  randomizePistolMuzzleFlashFrame();
  pistolMuzzleFlashRemaining = PISTOL_MUZZLE_FLASH_DURATION;

  const hit = performPistolHitScan(
    options?.direction || null,
    options?.targetsOverride || null,
    options?.maxRangeOverride ?? null,
  );
  let decalSpawned = false;
  if (hit) {
    decalSpawned = spawnBulletDecal(hit);
    recordPistolDebugMarker(hit);
  }
  const hitInfo = describePistolHit(hit);

  lastPistolHitInfo = hitInfo
    ? {
        ...hitInfo,
        decalSpawned,
        infiniteAmmo: pistolInfiniteAmmo,
      }
    : {
        type: "miss",
        label: "none",
        distance: PISTOL_FIRE_RANGE,
        decalSpawned: false,
        infiniteAmmo: pistolInfiniteAmmo,
      };

  if (!pistolInfiniteAmmo) {
    updateInventoryHud();
    updatePickupPrompt();
  }

  if (pistolImpactDebugEnabled) {
    const ammoText = pistolInfiniteAmmo ? "inf" : `${getBulletAmmoCount()}`;
    if (hitInfo) {
      setStatus(
        `Pistol hit ${hitInfo.type} (${hitInfo.label}) @ ${hitInfo.distance.toFixed(2)}m | ammo: ${ammoText}`,
      );
    } else {
      setStatus(`Pistol missed | ammo: ${ammoText}`);
    }
    return true;
  }

  if (pistolInfiniteAmmo) {
    setStatus("Pistol fired (infinite debug ammo).");
    return true;
  }

  setStatus(`Pistol fired. Ammo left: ${getBulletAmmoCount()}.`);
  return true;
}

function tryShootPistolAtNearestProp() {
  const selectedItem = getSelectedInventoryItem();
  if (selectedItem?.id !== PISTOL_ITEM_ID) {
    return false;
  }

  let bestHitDistance = Infinity;
  let hasPropHit = false;
  const propTargets = propScatter.root?.children || [];

  for (const rootNode of propTargets) {
    pistolPropBounds.setFromObject(rootNode);
    if (pistolPropBounds.isEmpty()) {
      continue;
    }
    pistolPropBounds.getCenter(pistolPropCenter);
    pistolNearestPropWorld.copy(pistolPropCenter);
    pistolNearestPropDirection.subVectors(pistolNearestPropWorld, camera.position);
    const distSq = pistolNearestPropDirection.lengthSq();
    if (distSq <= 0.0001) {
      continue;
    }

    pistolNearestPropDirection.normalize();
    pistolRaycaster.set(camera.position, pistolNearestPropDirection);
    pistolRaycaster.near = 0.05;
    pistolRaycaster.far = Infinity;
    const propHits = pistolRaycaster.intersectObjects(propTargets, true);
    if (propHits.length && propHits[0].distance < bestHitDistance) {
      bestHitDistance = propHits[0].distance;
      hasPropHit = true;
      pistolNearestPropWorld.copy(propHits[0].point);
    }
  }

  if (!hasPropHit) {
    return false;
  }
  pistolNearestPropDirection.subVectors(pistolNearestPropWorld, camera.position).normalize();

  return tryShootPistol({
    direction: pistolNearestPropDirection,
    bypassCooldown: true,
    targetsOverride: propTargets,
    maxRangeOverride: Infinity,
  });
}

function getMeleeWeaponConfig(itemId) {
  if (!itemId) {
    return null;
  }
  return MELEE_WEAPON_CONFIG[itemId] || null;
}

function getMeleeHitLabel(object) {
  let current = object;
  while (current) {
    if (current.userData?.pickupName) {
      return current.userData.pickupName;
    }
    if (current === exitMarker) {
      return "exit marker";
    }
    current = current.parent;
  }

  if (object === wallMesh) {
    return "wall";
  }
  if (object?.name) {
    return object.name;
  }
  return "target";
}

function performMeleeHitScan(weaponConfig) {
  meleeAttackForward.set(0, 0, -1).applyQuaternion(camera.quaternion);
  if (meleeAttackForward.lengthSq() < 0.000001) {
    meleeAttackForward.set(0, 0, -1);
  }
  meleeAttackForward.normalize();

  meleeRaycaster.set(camera.position, meleeAttackForward);
  meleeRaycaster.near = 0.05;
  meleeRaycaster.far = weaponConfig.range;

  const targets = [wallMesh, exitMarker].filter(Boolean);
  if (propScatter.root?.children?.length) {
    targets.push(...propScatter.root.children);
  }
  if (pickupSystem.root?.children?.length) {
    targets.push(...pickupSystem.root.children);
  }
  if (!targets.length) {
    return null;
  }

  const intersections = meleeRaycaster.intersectObjects(targets, true);
  return intersections[0] || null;
}

function tryMeleeAttack() {
  const selectedItem = getSelectedInventoryItem();
  const weaponConfig = getMeleeWeaponConfig(selectedItem?.id);
  if (!weaponConfig) {
    return false;
  }
  if (meleeCooldownRemaining > 0) {
    return false;
  }

  meleeCooldownRemaining = weaponConfig.cooldownSeconds;
  meleeSwingDuration = weaponConfig.swingDurationSeconds;
  meleeSwingElapsed = 0;
  meleeSwingActive = true;
  meleeSwingWeaponId = selectedItem.id;

  const hit = performMeleeHitScan(weaponConfig);
  if (!hit) {
    setStatus(`${weaponConfig.displayName} missed.`);
    return true;
  }

  setStatus(`${weaponConfig.displayName} hit ${getMeleeHitLabel(hit.object)}.`);
  return true;
}

function updateMeleeAttack(deltaSeconds) {
  meleeCooldownRemaining = Math.max(0, meleeCooldownRemaining - deltaSeconds);

  if (!meleeSwingActive) {
    return;
  }

  const weaponConfig = getMeleeWeaponConfig(meleeSwingWeaponId);
  if (!weaponConfig) {
    meleeSwingActive = false;
    meleeSwingElapsed = 0;
    meleeSwingDuration = 0;
    meleeSwingWeaponId = null;
    return;
  }

  meleeSwingElapsed += deltaSeconds;
  const duration = Math.max(meleeSwingDuration, 0.00001);
  const progress = THREE.MathUtils.clamp(meleeSwingElapsed / duration, 0, 1);
  const swingBlend = Math.sin(progress * Math.PI);
  const windupBlend = THREE.MathUtils.clamp((0.22 - progress) / 0.22, 0, 1);
  const animationBlend = swingBlend - windupBlend * 0.28;
  const positionOffset = weaponConfig.swingPositionOffset;
  const rotationOffset = weaponConfig.swingRotationOffset;

  inventoryLeftHandRig.position.x += positionOffset[0] * animationBlend;
  inventoryLeftHandRig.position.y += positionOffset[1] * animationBlend;
  inventoryLeftHandRig.position.z += positionOffset[2] * animationBlend;
  inventoryLeftHandRig.rotation.x += rotationOffset[0] * animationBlend;
  inventoryLeftHandRig.rotation.y += rotationOffset[1] * animationBlend;
  inventoryLeftHandRig.rotation.z += rotationOffset[2] * animationBlend;

  if (progress >= 1) {
    meleeSwingActive = false;
    meleeSwingElapsed = 0;
    meleeSwingDuration = 0;
    meleeSwingWeaponId = null;
  }
}

function getOrCreateHeldItemTuning(itemId) {
  if (!HELD_ITEM_DISPLAY_TUNING[itemId]) {
    HELD_ITEM_DISPLAY_TUNING[itemId] = {
      targetSize: LEFT_HAND_ITEM_TARGET_SIZE,
      offset: [0, 0, 0],
      rotation: [0, 0, 0],
    };
  }
  const tuning = HELD_ITEM_DISPLAY_TUNING[itemId];
  if (!Array.isArray(tuning.offset) || tuning.offset.length !== 3) {
    tuning.offset = [0, 0, 0];
  }
  if (!Array.isArray(tuning.rotation) || tuning.rotation.length !== 3) {
    tuning.rotation = [0, 0, 0];
  }
  if (typeof tuning.targetSize !== "number" || !Number.isFinite(tuning.targetSize)) {
    tuning.targetSize = LEFT_HAND_ITEM_TARGET_SIZE;
  }
  return tuning;
}

function getHeldItemTuningValue(tuning, key) {
  switch (key) {
    case "targetSize":
      return tuning.targetSize;
    case "offsetX":
      return tuning.offset[0];
    case "offsetY":
      return tuning.offset[1];
    case "offsetZ":
      return tuning.offset[2];
    case "rotX":
      return tuning.rotation[0];
    case "rotY":
      return tuning.rotation[1];
    case "rotZ":
      return tuning.rotation[2];
    default:
      return 0;
  }
}

function setHeldItemTuningValue(tuning, key, value) {
  switch (key) {
    case "targetSize":
      tuning.targetSize = value;
      break;
    case "offsetX":
      tuning.offset[0] = value;
      break;
    case "offsetY":
      tuning.offset[1] = value;
      break;
    case "offsetZ":
      tuning.offset[2] = value;
      break;
    case "rotX":
      tuning.rotation[0] = value;
      break;
    case "rotY":
      tuning.rotation[1] = value;
      break;
    case "rotZ":
      tuning.rotation[2] = value;
      break;
    default:
      break;
  }
}

function retuneHeldInventoryModel(itemId) {
  const model = heldInventoryModelById.get(itemId);
  if (!model) {
    return;
  }
  const parent = model.parent || null;
  if (parent) {
    parent.remove(model);
  }
  normalizeHeldInventoryModel(model, itemId);
  if (parent) {
    parent.add(model);
  }
  model.updateMatrixWorld(true);
}

function updateHeldItemTuningExportText(itemId, tuning) {
  if (!heldItemTuningUi.exportBox) {
    return;
  }
  if (!itemId || !tuning) {
    heldItemTuningUi.exportBox.value = "";
    return;
  }
  heldItemTuningUi.exportBox.value =
    `"${itemId}": ${JSON.stringify(tuning, null, 2)}`;
}

function syncHeldItemTuningPanel() {
  if (!heldItemTuningUi.panel) {
    return;
  }

  const selected = getSelectedInventoryItem();
  if (!selected) {
    heldItemTuningUi.selectedLabel.textContent = "selected: none";
    for (const [key, row] of heldItemTuningUi.rows) {
      row.input.disabled = true;
      row.value.textContent = "--";
      row.input.value = "0";
    }
    updateHeldItemTuningExportText(null, null);
    return;
  }

  const tuning = getOrCreateHeldItemTuning(selected.id);
  heldItemTuningUi.selectedLabel.textContent = `selected: ${selected.name} (${selected.id})`;

  for (const [key, row] of heldItemTuningUi.rows) {
    const value = getHeldItemTuningValue(tuning, key);
    row.input.disabled = false;
    row.input.value = `${value}`;
    row.value.textContent = value.toFixed(3);
  }

  updateHeldItemTuningExportText(selected.id, tuning);
}

function onHeldItemTuningSliderInput(key, value) {
  const selected = getSelectedInventoryItem();
  if (!selected) {
    return;
  }
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return;
  }
  const tuning = getOrCreateHeldItemTuning(selected.id);
  setHeldItemTuningValue(tuning, key, numeric);
  retuneHeldInventoryModel(selected.id);
  syncHeldItemTuningPanel();
}

function createHeldItemTuningRow(def) {
  const row = document.createElement("div");
  row.style.display = "grid";
  row.style.gridTemplateColumns = "40px 1fr 54px";
  row.style.gap = "6px";
  row.style.alignItems = "center";
  row.style.marginBottom = "4px";

  const label = document.createElement("span");
  label.textContent = def.label;
  label.style.fontSize = "11px";
  label.style.color = "#d7e7ff";

  const input = document.createElement("input");
  input.type = "range";
  input.min = `${def.min}`;
  input.max = `${def.max}`;
  input.step = `${def.step}`;
  input.value = "0";
  input.addEventListener("input", () => {
    onHeldItemTuningSliderInput(def.key, input.value);
  });

  const value = document.createElement("span");
  value.textContent = "0.000";
  value.style.fontSize = "11px";
  value.style.color = "#c6d7ee";
  value.style.fontFamily = "monospace";
  value.style.textAlign = "right";

  row.append(label, input, value);
  return { row, input, value };
}

function initHeldItemTuningPanel() {
  if (heldItemTuningUi.panel) {
    return;
  }

  const panel = document.createElement("div");
  panel.style.position = "fixed";
  panel.style.left = "10px";
  panel.style.bottom = "10px";
  panel.style.width = "320px";
  panel.style.maxHeight = "46vh";
  panel.style.overflow = "auto";
  panel.style.zIndex = "8";
  panel.style.padding = "10px";
  panel.style.border = "1px solid #5f7c95aa";
  panel.style.borderRadius = "10px";
  panel.style.background = "#0b1119e6";
  panel.style.backdropFilter = "blur(3px)";
  panel.style.boxShadow = "0 6px 20px #0009";
  panel.style.pointerEvents = "auto";

  const title = document.createElement("div");
  title.textContent = "Held Item Tuning";
  title.style.fontSize = "13px";
  title.style.fontWeight = "700";
  title.style.color = "#eaf2ff";
  title.style.marginBottom = "6px";

  const selectedLabel = document.createElement("div");
  selectedLabel.style.fontSize = "11px";
  selectedLabel.style.color = "#b8cbe4";
  selectedLabel.style.marginBottom = "8px";
  selectedLabel.textContent = "selected: none";

  panel.append(title, selectedLabel);

  for (const def of HELD_ITEM_TUNING_SLIDER_DEFS) {
    const row = createHeldItemTuningRow(def);
    panel.append(row.row);
    heldItemTuningUi.rows.set(def.key, row);
  }

  const copyButton = document.createElement("button");
  copyButton.type = "button";
  copyButton.textContent = "Copy Selected Tuning";
  copyButton.style.marginTop = "6px";
  copyButton.style.marginBottom = "6px";
  copyButton.style.width = "100%";
  copyButton.style.padding = "6px 8px";
  copyButton.style.border = "1px solid #8db6da66";
  copyButton.style.borderRadius = "7px";
  copyButton.style.background = "#1a3148";
  copyButton.style.color = "#eaf2ff";
  copyButton.style.cursor = "pointer";
  copyButton.addEventListener("click", async () => {
    const text = heldItemTuningUi.exportBox?.value || "";
    if (!text) {
      return;
    }
    try {
      await navigator.clipboard.writeText(text);
      setStatus("Copied selected tuning JSON.");
    } catch {
      setStatus("Could not copy tuning JSON (clipboard unavailable).");
    }
  });

  const exportBox = document.createElement("textarea");
  exportBox.readOnly = true;
  exportBox.spellcheck = false;
  exportBox.style.width = "100%";
  exportBox.style.height = "118px";
  exportBox.style.resize = "vertical";
  exportBox.style.fontFamily = "monospace";
  exportBox.style.fontSize = "11px";
  exportBox.style.color = "#d8e8ff";
  exportBox.style.background = "#060b10";
  exportBox.style.border = "1px solid #355271";
  exportBox.style.borderRadius = "7px";
  exportBox.style.padding = "6px";

  panel.append(copyButton, exportBox);
  document.body.append(panel);

  heldItemTuningUi.panel = panel;
  heldItemTuningUi.selectedLabel = selectedLabel;
  heldItemTuningUi.exportBox = exportBox;

  syncHeldItemTuningPanel();
}

function updateInventoryWheelSlotPositions() {
  const stepRadians = (Math.PI * 2) / INVENTORY_MAX_ITEMS;
  for (let i = 0; i < inventorySlots.length; i++) {
    const angle = -Math.PI / 2 + (i + inventoryWheelRotationSteps) * stepRadians;
    const x = Math.cos(angle) * INVENTORY_SLOT_RADIUS_PX;
    const y = Math.sin(angle) * INVENTORY_SLOT_RADIUS_PX;
    inventorySlots[i].slot.style.left = `calc(50% + ${x.toFixed(3)}px)`;
    inventorySlots[i].slot.style.top = `calc(50% + ${y.toFixed(3)}px)`;
  }
}

function setInventoryWheelRotationSteps(steps) {
  inventoryWheelRotationSteps = Math.trunc(steps || 0);
  updateInventoryWheelSlotPositions();
}

function rotateInventoryWheel(stepDirection) {
  if (!gameActive || isTopDownView) {
    return;
  }
  const step = stepDirection > 0 ? 1 : -1;
  setInventoryWheelRotationSteps(inventoryWheelRotationSteps + step);
  updateInventoryHud();
}

function normalizeHeldInventoryModel(model, itemId) {
  model.position.set(0, 0, 0);
  model.rotation.set(0, 0, 0);
  model.scale.set(1, 1, 1);
  model.updateMatrixWorld(true);

  heldItemBounds.setFromObject(model);
  if (heldItemBounds.isEmpty()) {
    return;
  }

  const tuning = HELD_ITEM_DISPLAY_TUNING[itemId];
  heldItemBounds.getCenter(heldItemCenter);
  model.position.sub(heldItemCenter);
  model.updateMatrixWorld(true);

  heldItemBounds.setFromObject(model);
  heldItemBounds.getSize(heldItemSize);
  const maxDimension = Math.max(heldItemSize.x, heldItemSize.y, heldItemSize.z, 0.001);
  const targetSize = tuning?.targetSize ?? LEFT_HAND_ITEM_TARGET_SIZE;
  const scale = targetSize / maxDimension;
  model.scale.multiplyScalar(scale);
  model.position.y -= targetSize * 0.12;
  if (tuning?.offset) {
    model.position.x += tuning.offset[0];
    model.position.y += tuning.offset[1];
    model.position.z += tuning.offset[2];
  }
  if (tuning?.rotation) {
    model.rotation.set(tuning.rotation[0], tuning.rotation[1], tuning.rotation[2]);
  }
  model.updateMatrixWorld(true);
  heldItemLocalBoundsScratch.setFromObject(model);
  if (!heldItemLocalBoundsScratch.isEmpty()) {
    model.userData.localBounds = heldItemLocalBoundsScratch.clone();
  }
}

function ensureHeldInventoryModel(itemId) {
  if (heldInventoryModelById.has(itemId)) {
    return Promise.resolve(heldInventoryModelById.get(itemId));
  }
  if (heldInventoryModelPromiseById.has(itemId)) {
    return heldInventoryModelPromiseById.get(itemId);
  }

  const promise = pickupSystem
    .createDisplayModelForItemId(itemId)
    .then((model) => {
      if (!model) {
        return null;
      }
      normalizeHeldInventoryModel(model, itemId);
      heldInventoryModelById.set(itemId, model);
      return model;
    })
    .catch(() => null);

  heldInventoryModelPromiseById.set(itemId, promise);
  return promise;
}

function updateHeldInventoryItem() {
  const selectedItem = getSelectedInventoryItem();
  const nextItemId = selectedItem?.id || null;
  if (nextItemId === heldInventoryItemId) {
    return;
  }

  heldInventoryItemId = nextItemId;
  heldInventoryLoadToken += 1;
  const loadToken = heldInventoryLoadToken;
  inventoryLeftHandItemAnchor.clear();

  if (!nextItemId) {
    return;
  }

  void ensureHeldInventoryModel(nextItemId).then((model) => {
    if (loadToken !== heldInventoryLoadToken || heldInventoryItemId !== nextItemId || !model) {
      return;
    }
    inventoryLeftHandItemAnchor.clear();
    inventoryLeftHandItemAnchor.add(model);
  });
}

function initInventoryRadial() {
  if (!inventoryRadial || inventorySlots.length > 0) {
    return;
  }

  for (let i = 0; i < INVENTORY_MAX_ITEMS; i++) {
    const slot = document.createElement("div");
    slot.className = "inventory-slot empty";
    slot.style.left = "50%";
    slot.style.top = "50%";
    slot.style.zIndex = "1";
    slot.style.transition =
      "left 160ms ease, top 160ms ease, border-color 120ms ease, box-shadow 120ms ease, background-color 120ms ease";

    const icon = document.createElement("span");
    icon.className = "inventory-slot-icon";
    icon.textContent = "";

    const image = document.createElement("img");
    image.className = "inventory-slot-image";
    image.alt = "";
    image.decoding = "async";
    image.loading = "lazy";
    image.style.display = "none";

    slot.append(image);
    slot.append(icon);

    inventoryRadial.append(slot);
    inventorySlots.push({ slot, icon, image });
  }

  const selectionOutline = document.createElement("div");
  selectionOutline.className = "inventory-slot";
  selectionOutline.style.left = "50%";
  selectionOutline.style.top = `calc(50% - ${INVENTORY_SLOT_RADIUS_PX}px)`;
  selectionOutline.style.zIndex = "3";
  selectionOutline.style.pointerEvents = "none";
  selectionOutline.style.background = "transparent";
  selectionOutline.style.borderColor = "#f5d58fd6";
  selectionOutline.style.boxShadow =
    "0 0 0 1px #f5d58f66, 0 0 14px #f5d58f36, inset 0 1px 5px #0007";
  inventoryRadial.append(selectionOutline);
  inventorySelectionOutline = selectionOutline;

  setInventoryWheelRotationSteps(inventoryWheelRotationSteps);
}

function updateInventoryHud() {
  if (!inventoryRadial) {
    return;
  }

  setInventoryWheelRotationSteps(inventoryWheelRotationSteps);

  if (inventoryCount) {
    inventoryCount.textContent = `${getInventoryOccupiedCount()}/${INVENTORY_MAX_ITEMS}`;
  }
  if (inventorySelectionOutline) {
    inventorySelectionOutline.style.display = "grid";
  }

  for (let i = 0; i < inventorySlots.length; i++) {
    const slotRef = inventorySlots[i];
    const item = inventory[i];
    slotRef.slot.style.borderColor = "#96b8d154";
    slotRef.slot.style.background = "#102030c7";
    slotRef.slot.style.boxShadow = "inset 0 1px 5px #0007";

    if (!item) {
      slotRef.slot.classList.add("empty");
      slotRef.slot.removeAttribute("title");
      slotRef.icon.textContent = "";
      slotRef.image.style.display = "none";
      slotRef.image.removeAttribute("src");
      continue;
    }

    slotRef.slot.classList.remove("empty");
    slotRef.slot.title = item.name;
    const iconDataUrl = pickupSystem.getIconDataUrlByItemId(item.id);
    if (iconDataUrl) {
      if (slotRef.image.src !== iconDataUrl) {
        slotRef.image.src = iconDataUrl;
      }
      slotRef.image.style.display = "block";
      slotRef.icon.textContent = "";
    } else {
      slotRef.image.style.display = "none";
      slotRef.image.removeAttribute("src");
      slotRef.icon.textContent = "◆";
      void pickupSystem.ensureIconForItemId(item.id).then(() => {
        updateInventoryHud();
      });
    }
  }

  updateHeldInventoryItem();
  syncHeldItemTuningPanel();
}

function updatePickupPrompt() {
  if (!interactionHint) {
    return;
  }
  if (!gameActive || isTopDownView) {
    interactionHint.textContent = "";
    return;
  }

  const nearest = pickupSystem.findNearestPickup(
    camera.position,
    PICKUP_INTERACT_DISTANCE,
  );
  if (!nearest) {
    interactionHint.textContent = "";
    return;
  }

  const occupiedCount = getInventoryOccupiedCount();
  if (occupiedCount >= INVENTORY_MAX_ITEMS) {
    interactionHint.textContent = `Inventory full (${INVENTORY_MAX_ITEMS}/${INVENTORY_MAX_ITEMS})`;
    return;
  }

  interactionHint.textContent = `Press E to pick up ${nearest.name}`;
}

function tryPickupNearest() {
  if (!gameActive || isTopDownView) {
    return;
  }
  if (getInventoryOccupiedCount() >= INVENTORY_MAX_ITEMS) {
    setStatus(`Inventory full (${INVENTORY_MAX_ITEMS} items max).`);
    updatePickupPrompt();
    return;
  }

  const picked = pickupSystem.pickupNearest(
    camera.position,
    PICKUP_INTERACT_DISTANCE,
  );
  if (!picked) {
    return;
  }

  const emptySlotIndex = findFirstEmptyInventorySlotIndex();
  if (emptySlotIndex < 0) {
    setStatus(`Inventory full (${INVENTORY_MAX_ITEMS} items max).`);
    updatePickupPrompt();
    return;
  }
  inventory[emptySlotIndex] = { id: picked.id, name: picked.name };
  updateInventoryHud();
  updatePickupPrompt();
  setStatus(`Picked up ${picked.name}.`);
}

function grantDebugInventory() {
  inventory.length = 0;
  for (const item of DEBUG_INVENTORY_ITEMS) {
    const emptySlotIndex = findFirstEmptyInventorySlotIndex();
    if (emptySlotIndex < 0) {
      break;
    }
    inventory[emptySlotIndex] = { id: item.id, name: item.name };
  }
  setInventoryWheelRotationSteps(0);
  pistolInfiniteAmmo = true;
  pistolFireCooldownRemaining = 0;
  updateInventoryHud();
  updatePickupPrompt();
  setStatus("Debug inventory loaded (one of each item). Infinite pistol ammo enabled.");
}

function resizeRenderer() {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  topDownCamera.aspect = window.innerWidth / window.innerHeight;
  topDownCamera.updateProjectionMatrix();

  const pixelRatio = 1;
  renderer.setPixelRatio(pixelRatio);
  renderer.setSize(window.innerWidth, window.innerHeight, false);
  composer.setPixelRatio(pixelRatio);
  composer.setSize(window.innerWidth, window.innerHeight);
  smaaPass.setSize(
    Math.floor(window.innerWidth * pixelRatio),
    Math.floor(window.innerHeight * pixelRatio),
  );
  if (typeof n8aoPass.setSize === "function") {
    n8aoPass.setSize(window.innerWidth, window.innerHeight);
  }
}

async function toggleFullscreen() {
  try {
    if (document.fullscreenElement) {
      await document.exitFullscreen();
    } else {
      await document.documentElement.requestFullscreen();
    }
  } catch (error) {
    console.error("Fullscreen toggle failed:", error);
  }
}

function round(value) {
  return Math.round(value * 1000) / 1000;
}

function toggleFlashlight() {
  flashlightEnabled = !flashlightEnabled;
  if (!flashlightEnabled) {
    setStatus("Flashlight off. Press L to toggle.");
    return;
  }
  if (isFlashlightSuppressedByTwoHandedBat()) {
    setStatus("Flashlight on, but stowed while using the baseball bat.");
    return;
  }
  setStatus("Flashlight on. Press L to toggle.");
}

function updateTopDownCamera() {
  const vFov = THREE.MathUtils.degToRad(topDownCamera.fov);
  const tanHalf = Math.tan(vFov * 0.5);
  const margin = CELL_SIZE * 0.75;
  const halfDepth = worldDepth * 0.5 + margin;
  const halfWidth = worldWidth * 0.5 + margin;
  const byDepth = halfDepth / tanHalf;
  const byWidth = halfWidth / (tanHalf * topDownCamera.aspect);
  const height = Math.max(byDepth, byWidth);

  topDownCamera.position.set(0, height, 0);
  topDownCamera.up.set(0, 0, -1);
  topDownCamera.lookAt(0, 0, 0);
}

function updateTopDownPlayerDebug() {
  const markerY = PLAYER_HEIGHT * 0.5;
  topDownPlayerMarker.position.set(camera.position.x, markerY, camera.position.z);

  topDownLookDirection.set(0, 0, -1).applyQuaternion(camera.quaternion);
  topDownLookDirection.y = 0;
  if (topDownLookDirection.lengthSq() < 0.000001) {
    topDownLookDirection.set(0, 0, -1);
  }
  topDownLookDirection.normalize();

  const linePositions = topDownLookLine.geometry.attributes.position.array;
  linePositions[0] = camera.position.x;
  linePositions[1] = markerY;
  linePositions[2] = camera.position.z;
  linePositions[3] = camera.position.x + topDownLookDirection.x * TOP_DOWN_PLAYER_LOOK_LENGTH;
  linePositions[4] = markerY;
  linePositions[5] = camera.position.z + topDownLookDirection.z * TOP_DOWN_PLAYER_LOOK_LENGTH;
  topDownLookLine.geometry.attributes.position.needsUpdate = true;
}

function toggleTopDownView() {
  if (!gameActive || hasWon) {
    return;
  }

  if (isTopDownView) {
    isTopDownView = false;
    crosshair.style.opacity = "1";
    setStatus("First-person view. Press V for top-down view.");
    if (canUsePointerLock && !controls.isLocked) {
      controls.lock();
    }
    return;
  }

  isTopDownView = true;
  crosshair.style.opacity = "0";
  setStatus("Top-down view. Press V to return to first-person.");
  if (canUsePointerLock && controls.isLocked) {
    suppressUnlockPause = true;
    controls.unlock();
  }
  updateTopDownCamera();
}

function toggleN8AODebugView() {
  n8aoSplitDebug = !n8aoSplitDebug;
  n8aoPass.setDisplayMode(n8aoSplitDebug ? "Split" : "Combined");
  setStatus(
    n8aoSplitDebug
      ? "N8AO split debug view on. Press O to return to combined view."
      : "N8AO split debug view off. Press O to enable.",
  );
}

function syncBounceLightDebugMarker() {
  if (!bounceLightDebugEnabled || !bounceLightDebugHasHit) {
    bounceLightDebugMarker.visible = false;
    return;
  }
  bounceLightDebugMarker.visible = true;
  bounceLightDebugMarker.position.copy(bounceLightDebugPosition);
}

function toggleBounceLightDebugMarker() {
  bounceLightDebugEnabled = !bounceLightDebugEnabled;
  syncBounceLightDebugMarker();
  setStatus(
    bounceLightDebugEnabled
      ? "Bounce-light debug marker on. Press B to hide."
      : "Bounce-light debug marker off. Press B to show.",
  );
}

function renderGameToText() {
  const rotation = new THREE.Euler().setFromQuaternion(camera.quaternion, "YXZ");
  const playerCell = worldToCell(camera.position.x, camera.position.z);
  const selectedInventoryItem = getSelectedInventoryItem();
  const selectedMeleeWeaponConfig = getMeleeWeaponConfig(selectedInventoryItem?.id);
  const bulletAmmoCount = getBulletAmmoCount();
  const selectedIsPistol = selectedInventoryItem?.id === PISTOL_ITEM_ID;
  const selectedIsJerky = selectedInventoryItem?.id === JERKY_ITEM_ID;
  const selectedIsFirstAidKit = selectedInventoryItem?.id === FIRST_AID_KIT_ITEM_ID;
  const selectedIsSodaCan = selectedInventoryItem?.id === SODA_CAN_ITEM_ID;
  const jerkyConsumeProgress = getJerkyConsumeProgress();
  const consumableUseProgress = getActiveConsumableUseProgress();
  const activeJerkyConsume = jerkyConsumeActive && consumableUseItemId === JERKY_ITEM_ID;
  const healthRatio = PLAYER_MAX_HEALTH > 0 ? playerHealth / PLAYER_MAX_HEALTH : 0;
  const lastPistolHitPayload = lastPistolHitInfo
    ? {
        ...lastPistolHitInfo,
        distance: round(lastPistolHitInfo.distance),
      }
    : null;

  return JSON.stringify({
    mode: hasWon ? "cleared" : gameActive ? "playing" : "paused",
    coordinateSystem:
      "Maze origin is at center of world. +x moves east (right), +z moves south (toward larger row), +y is up.",
    maze: {
      cols: MAZE_COLS,
      rows: MAZE_ROWS,
      cellSize: CELL_SIZE,
      start: startCell,
      exit: exitCell,
    },
    player: {
      x: round(camera.position.x),
      y: round(camera.position.y),
      z: round(camera.position.z),
      col: playerCell.col,
      row: playerCell.row,
      yaw: round(rotation.y),
      pitch: round(rotation.x),
    },
    flags: {
      pointerLocked: controls.isLocked,
      won: hasWon,
      gameActive,
      topDownView: isTopDownView,
      flashlightOn: isFlashlightEmissionActive(),
      flashlightSuppressedByTwoHandedBat: isFlashlightSuppressedByTwoHandedBat(),
      flashlightModelLoaded,
      sprinting: keyState.sprint,
      meleeSwinging: meleeSwingActive,
      meleeCooldownSeconds: round(meleeCooldownRemaining),
      playerDead: playerHealth <= 0,
      pistolInfiniteAmmo,
      pistolCooldownSeconds: round(pistolFireCooldownRemaining),
      pistolImpactDebug: pistolImpactDebugEnabled,
      pistolRecoil: round(pistolRecoilAmount),
      pistolMuzzleFlash: round(pistolMuzzleFlashRemaining),
      jerkyConsumeActive: activeJerkyConsume,
      jerkyConsumeProgress: round(jerkyConsumeProgress),
      consumableUseActive: jerkyConsumeActive,
      consumableUseItemId,
      consumableUseProgress: round(consumableUseProgress),
      sodaBoostSeconds: round(sodaSpeedBoostRemaining),
      firstAidRegenSeconds: round(firstAidRegenRemaining),
      speedMultiplier: round(getPlayerSpeedMultiplier()),
    },
    health: {
      current: round(playerHealth),
      trail: round(playerHealthDamageTrail),
      max: PLAYER_MAX_HEALTH,
      ratio: round(healthRatio),
      percent: round(healthRatio * 100),
      trailPercent: round(
        (PLAYER_MAX_HEALTH > 0 ? playerHealthDamageTrail / PLAYER_MAX_HEALTH : 0) * 100,
      ),
    },
    ammo: {
      bulletCount: bulletAmmoCount,
      pistolInfinite: pistolInfiniteAmmo,
    },
    decals: {
      bulletCount: bulletDecals.length,
    },
    pistol: {
      lastHit: lastPistolHitPayload,
    },
    inventory: inventory.flatMap((item, index) =>
      item
        ? [
            {
              slot: index + 1,
              id: item.id,
              name: item.name,
            },
          ]
        : [],
    ),
    selectedInventory: selectedInventoryItem
      ? {
          slot: getSelectedInventorySlotIndex() + 1,
          id: selectedInventoryItem.id,
          name: selectedInventoryItem.name,
          meleeAttack:
            selectedMeleeWeaponConfig
              ? {
                  range: selectedMeleeWeaponConfig.range,
                  cooldownSeconds: selectedMeleeWeaponConfig.cooldownSeconds,
                }
              : null,
          pistol:
            selectedIsPistol
              ? {
                  range: PISTOL_FIRE_RANGE,
                  infiniteAmmo: pistolInfiniteAmmo,
                  ammo: bulletAmmoCount,
                }
              : null,
          consumable:
            selectedIsJerky
              ? {
                  type: "jerky",
                  holdDurationSeconds: JERKY_CONSUME_DURATION_SECONDS,
                  healAmount: JERKY_HEAL_AMOUNT,
                  holdProgress: round(jerkyConsumeProgress),
                  active: activeJerkyConsume,
                }
              : selectedIsFirstAidKit
                ? {
                    type: "first_aid_kit",
                    consumeDurationSeconds: FIRST_AID_USE_DURATION_SECONDS,
                    instantHealAmount: FIRST_AID_KIT_HEAL_AMOUNT,
                    regenPerSecond: FIRST_AID_REGEN_PER_SECOND,
                    regenDurationSeconds: FIRST_AID_REGEN_DURATION_SECONDS,
                    activeRegenSeconds: round(firstAidRegenRemaining),
                    holdProgress:
                      jerkyConsumeActive && consumableUseItemId === FIRST_AID_KIT_ITEM_ID
                        ? round(consumableUseProgress)
                        : 0,
                    activeUse:
                      jerkyConsumeActive && consumableUseItemId === FIRST_AID_KIT_ITEM_ID,
                  }
                : selectedIsSodaCan
                  ? {
                      type: "soda_can",
                      consumeDurationSeconds: SODA_USE_DURATION_SECONDS,
                      speedMultiplier: SODA_SPEED_MULTIPLIER,
                      durationSeconds: SODA_SPEED_DURATION_SECONDS,
                      activeSpeedBoostSeconds: round(sodaSpeedBoostRemaining),
                      holdProgress:
                        jerkyConsumeActive && consumableUseItemId === SODA_CAN_ITEM_ID
                          ? round(consumableUseProgress)
                          : 0,
                      activeUse:
                        jerkyConsumeActive && consumableUseItemId === SODA_CAN_ITEM_ID,
                    }
              : null,
          wheelRotationDegrees: round(
            normalizeInventorySlotIndex(inventoryWheelRotationSteps) *
              INVENTORY_ROTATION_STEP_DEGREES,
          ),
        }
      : null,
    nearby: collectNearbyCells({
      maze,
      exitCell,
      cols: MAZE_COLS,
      rows: MAZE_ROWS,
      centerCol: playerCell.col,
      centerRow: playerCell.row,
      radius: 2,
    }),
  });
}
