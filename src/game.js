import * as THREE from "three";
import { PointerLockControls } from "three/addons/controls/PointerLockControls.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
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

const app = document.querySelector("#app");
const overlay = document.querySelector("#overlay");
const startButton = document.querySelector("#start-btn");
const status = document.querySelector("#status");
const crosshair = document.querySelector("#crosshair");
const inventoryRadial = document.querySelector("#inventory-radial");
const inventoryCount = document.querySelector("#inventory-count");
const interactionHint = document.querySelector("#interaction-hint");

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
flashlight.map = flashlightPatternTexture;
flashlight.shadow.camera.near = 0.01;
flashlight.shadow.camera.far = FLASHLIGHT_BASE_DISTANCE;
flashlight.shadow.mapSize.set(1024, 1024);
flashlight.shadow.bias = -0.00008;
flashlight.shadow.normalBias = 0.02;
flashlight.shadow.camera.updateProjectionMatrix();

const flashlightRaycaster = new THREE.Raycaster();
const meleeRaycaster = new THREE.Raycaster();
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
scene.add(flashlightBounceLight);
scene.add(bounceLightDebugMarker);
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
let meleeCooldownRemaining = 0;
let meleeSwingElapsed = 0;
let meleeSwingDuration = 0;
let meleeSwingActive = false;
let meleeSwingWeaponId = null;
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
updatePickupPrompt();
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
  meleeCooldownRemaining = 0;
  meleeSwingElapsed = 0;
  meleeSwingDuration = 0;
  meleeSwingActive = false;
  meleeSwingWeaponId = null;
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

  controls.addEventListener("lock", () => {
    isTopDownView = false;
    overlay.classList.add("hidden");
    crosshair.style.opacity = "1";
    if (!hasWon) {
      setStatus(GAMEPLAY_HINT);
    }
  });

  controls.addEventListener("unlock", () => {
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
}

function activateGameplay() {
  gameActive = true;
  isTopDownView = false;
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
  tryMeleeAttack();
}

function update(deltaSeconds) {
  elapsed += deltaSeconds;
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

  const speed = PLAYER_SPEED * (keyState.sprint ? SPRINT_MULTIPLIER : 1);
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
  flashlightModelAnchor.visible = true;
  inventoryLeftHandRig.visible = true;
  topDownFillLight.intensity = 0;
  topDownPlayerMarker.visible = false;
  topDownLookLine.visible = false;
  scene.fog = mazeFog;
  composer.render();
}

function updateFlashlightFlicker(deltaSeconds) {
  if (!flashlightEnabled || isTopDownView) {
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
  if (!flashlightEnabled || isTopDownView || hasWon) {
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

function normalizeInventorySlotIndex(index) {
  return ((index % INVENTORY_MAX_ITEMS) + INVENTORY_MAX_ITEMS) % INVENTORY_MAX_ITEMS;
}

function getSelectedInventorySlotIndex() {
  return normalizeInventorySlotIndex(-inventoryWheelRotationSteps);
}

function getSelectedInventoryItem() {
  return inventory[getSelectedInventorySlotIndex()] || null;
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
    inventoryCount.textContent = `${inventory.length}/${INVENTORY_MAX_ITEMS}`;
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

  if (inventory.length >= INVENTORY_MAX_ITEMS) {
    interactionHint.textContent = `Inventory full (${INVENTORY_MAX_ITEMS}/${INVENTORY_MAX_ITEMS})`;
    return;
  }

  interactionHint.textContent = `Press E to pick up ${nearest.name}`;
}

function tryPickupNearest() {
  if (!gameActive || isTopDownView) {
    return;
  }
  if (inventory.length >= INVENTORY_MAX_ITEMS) {
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

  inventory.push({ id: picked.id, name: picked.name });
  updateInventoryHud();
  updatePickupPrompt();
  setStatus(`Picked up ${picked.name}.`);
}

function grantDebugInventory() {
  inventory.length = 0;
  for (const item of DEBUG_INVENTORY_ITEMS) {
    if (inventory.length >= INVENTORY_MAX_ITEMS) {
      break;
    }
    inventory.push({ id: item.id, name: item.name });
  }
  setInventoryWheelRotationSteps(0);
  updateInventoryHud();
  updatePickupPrompt();
  setStatus("Debug inventory loaded (one of each item).");
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
  setStatus(
    flashlightEnabled
      ? "Flashlight on. Press L to toggle."
      : "Flashlight off. Press L to toggle.",
  );
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
      flashlightOn: flashlightEnabled,
      flashlightModelLoaded,
      sprinting: keyState.sprint,
      meleeSwinging: meleeSwingActive,
      meleeCooldownSeconds: round(meleeCooldownRemaining),
    },
    inventory: inventory.map((item, index) => ({
      slot: index + 1,
      id: item.id,
      name: item.name,
    })),
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
