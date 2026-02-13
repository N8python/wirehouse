import * as THREE from "three";
import { PointerLockControls } from "three/addons/controls/PointerLockControls.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import Stats from "three/addons/libs/stats.module.js";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { SMAAPass } from "three/addons/postprocessing/SMAAPass.js";
import { MeshBVH, acceleratedRaycast } from "three-mesh-bvh";
import { N8AOPass } from "n8ao";

THREE.Mesh.prototype.raycast = acceleratedRaycast;

const MAZE_COLS = 21;
const MAZE_ROWS = 21;
const CELL_SIZE = 4;
const WALL_HEIGHT = 3.2;
const PLAYER_HEIGHT = 1.65;
const PLAYER_RADIUS = 0.35;
const PLAYER_SPEED = 6;
const SPRINT_MULTIPLIER = 1.5;
const WALL_POM_HEIGHT_SCALE_DEFAULT = 0.045;
const WALL_POM_HEIGHT_SCALE_MIN = 0;
const WALL_POM_HEIGHT_SCALE_MAX = 1.0;
const WALL_POM_MIN_LAYERS = 4;
const WALL_POM_MAX_LAYERS = 12;
const FLOOR_POM_HEIGHT_SCALE = 0.01;
const ROOF_POM_HEIGHT_SCALE = 0.01;
const FLOOR_POM_MIN_LAYERS = 2;
const FLOOR_POM_MAX_LAYERS = 6;
const ROOF_POM_MIN_LAYERS = 2;
const ROOF_POM_MAX_LAYERS = 6;
const TARGET_VSYNC_FPS = 60;
const TARGET_FRAME_INTERVAL_MS = 1000 / TARGET_VSYNC_FPS;
const GAMEPLAY_HINT =
  "Use WASD to move. Press V for top-down view, L for flashlight. Reach the red marker.";

const app = document.querySelector("#app");
const overlay = document.querySelector("#overlay");
const startButton = document.querySelector("#start-btn");
const status = document.querySelector("#status");
const crosshair = document.querySelector("#crosshair");

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
  // Keep AO local and subtle for maze-scale geometry.
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
const flashlightPatternTexture = loadSpotlightMapTexture(
  "./assets/textures/light/flashlight-pattern-incandescent.png",
);

const controls = new PointerLockControls(camera, renderer.domElement);
const clock = new THREE.Clock();
const worldUp = new THREE.Vector3(0, 1, 0);
const forward = new THREE.Vector3();
const right = new THREE.Vector3();
const move = new THREE.Vector3();
const flashlightRig = new THREE.Group();
const flashlightModelAnchor = new THREE.Group();
const flashlightTarget = new THREE.Object3D();
const FLASHLIGHT_BASE_INTENSITY = 62.0;
const FLASHLIGHT_BASE_DISTANCE = 56;
const FLASHLIGHT_FLICKER_RATE = 35;
const FLASHLIGHT_FLICKER_MIN_HOLD = 0.04;
const FLASHLIGHT_FLICKER_MAX_HOLD = 0.12;
const FLASHLIGHT_FLICKER_MIN_INTENSITY = 0.18;
const FLASHLIGHT_FLICKER_MAX_INTENSITY = 1.0;
const FLASHLIGHT_FLICKER_DROP_CHANCE = 0.22;
const TWO_PI = Math.PI * 2;
const FLASHLIGHT_BOUNCE_EMA_HALF_LIFE = 0.05;
const FLASHLIGHT_BOUNCE_DEFAULT_REFLECTANCE = new THREE.Color(0.6, 0.6, 0.6);
const flashlight = new THREE.SpotLight(
  0xdce8ff,
  FLASHLIGHT_BASE_INTENSITY,
  FLASHLIGHT_BASE_DISTANCE,
  Math.PI / 5.4,
  0.58,
  1.1,
);
const flashlightBounceLight = new THREE.PointLight(0xffffff, 0, 0, 2);
flashlightBounceLight.castShadow = false;
flashlightBounceLight.visible = false;
flashlight.map = flashlightPatternTexture;
flashlight.shadow.camera.near = 0.01;
flashlight.shadow.camera.far = FLASHLIGHT_BASE_DISTANCE;
flashlight.shadow.camera.updateProjectionMatrix();
const flashlightRaycaster = new THREE.Raycaster();
const flashlightBounceOrigin = new THREE.Vector3();
const flashlightBounceDirection = new THREE.Vector3();
const flashlightHitDirection = new THREE.Vector3();
const flashlightTargetWorld = new THREE.Vector3();
const flashlightBounceNormal = new THREE.Vector3();
const flashlightBounceColor = new THREE.Color();
const flashlightBounceTargetColor = new THREE.Color();
const flashlightBounceSmoothedColor = new THREE.Color();
let flashlightBounceSmoothedIntensity = 0;
let flashlightBounceEmaInitialized = false;

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

flashlightRig.position.set(0.24, -0.22, -0.38);
flashlightRig.rotation.set(0.03, -0.1, 0.02);
flashlight.position.set(0, 0.025, -0.22);
flashlightTarget.position.set(0, 0.02, -6.5);
flashlightModelAnchor.position.set(0, 0, 0);
camera.add(flashlightRig);
flashlightRig.add(flashlightModelAnchor);
flashlightRig.add(flashlight);
flashlightRig.add(flashlightTarget);
flashlight.target = flashlightTarget;

scene.add(new THREE.HemisphereLight(0x5d6f8a, 0x1a1714, 0.22));
scene.add(new THREE.AmbientLight(0x1d2430, 0.1));
scene.add(flashlightBounceLight);
const topDownFillLight = new THREE.AmbientLight(0xe4edf9, 0.92);
topDownFillLight.visible = false;
scene.add(topDownFillLight);

const worldWidth = MAZE_COLS * CELL_SIZE;
const worldDepth = MAZE_ROWS * CELL_SIZE;
const worldHalfWidth = worldWidth * 0.5;
const worldHalfDepth = worldDepth * 0.5;
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
const wallHeightTexture = inferWallHeightTexture(wallTextures);
if (wallHeightTexture) {
  wallHeightTexture.generateMipmaps = false;
  wallHeightTexture.minFilter = THREE.LinearFilter;
  wallHeightTexture.needsUpdate = true;
}
const roofTextures = loadTextureSet({
  colorPath: "./assets/textures/roof/rusty_metal_05_diff_1k.jpg",
  normalPath: "./assets/textures/roof/rusty_metal_05_nor_gl_1k.jpg",
  roughnessPath: "./assets/textures/roof/rusty_metal_05_rough_1k.jpg",
  heightPath: "./assets/textures/roof/rusty_metal_05_height_1k.png",
  repeatX: MAZE_COLS * 0.5,
  repeatY: MAZE_ROWS * 0.5,
});
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

const keyState = {
  forward: false,
  backward: false,
  left: false,
  right: false,
  sprint: false,
};

applyParallaxOcclusionToWallMaterial(wallMaterial, wallHeightTexture, wallPomUniforms);
applyParallaxOcclusionToWallMaterial(floorMaterial, floorTextures.height, floorPomUniforms);
applyParallaxOcclusionToWallMaterial(roofMaterial, roofTextures.height, roofPomUniforms);
createFloorAndCeiling();
regenerateMaze();
setupInteractions();
loadFlashlightModel();
setStatus("Click Enter Maze and reach the red marker.");
render();
renderer.setAnimationLoop(animationFrame);

function createFloorAndCeiling() {
  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(worldWidth, worldDepth),
    floorMaterial,
  );
  floorMesh = floor;
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = 0;
  scene.add(floor);
  buildMeshBVH(floor);

  const ceiling = new THREE.Mesh(
    new THREE.PlaneGeometry(worldWidth, worldDepth),
    roofMaterial,
  );
  ceiling.rotation.x = -Math.PI / 2;
  ceiling.position.y = WALL_HEIGHT;
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

function loadTexture(path, { repeatX, repeatY, isColor }) {
  const texture = textureLoader.load(
    path,
    (loadedTexture) => {
      if (isColor) {
        loadedTexture.userData.averageAlbedoColor = computeAverageTextureAlbedo(loadedTexture);
      }
    },
    undefined,
    () => {
      texture.userData.averageAlbedoColor = FLASHLIGHT_BOUNCE_DEFAULT_REFLECTANCE;
    },
  );
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(repeatX, repeatY);
  texture.anisotropy = maxAnisotropy;
  texture.colorSpace = isColor ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  return texture;
}

function computeAverageTextureAlbedo(texture) {
  if (!texture?.image) {
    return FLASHLIGHT_BOUNCE_DEFAULT_REFLECTANCE;
  }

  const image = texture.image;
  const width = image.width || image.naturalWidth || 0;
  const height = image.height || image.naturalHeight || 0;
  if (!width || !height) {
    return FLASHLIGHT_BOUNCE_DEFAULT_REFLECTANCE;
  }

  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d");
  if (!context) {
    return FLASHLIGHT_BOUNCE_DEFAULT_REFLECTANCE;
  }
  canvas.width = width;
  canvas.height = height;
  context.drawImage(image, 0, 0, width, height);

  const data = context.getImageData(0, 0, width, height).data;
  let totalR = 0;
  let totalG = 0;
  let totalB = 0;
  for (let i = 0; i < data.length; i += 4) {
    totalR += data[i];
    totalG += data[i + 1];
    totalB += data[i + 2];
  }

  const pixelCount = data.length / 4;
  const color = new THREE.Color(
    totalR / (255 * pixelCount),
    totalG / (255 * pixelCount),
    totalB / (255 * pixelCount),
  );
  color.convertSRGBToLinear();
  return color;
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

  // Metals contribute almost entirely through specular reflection, not diffuse GI.
  const metalness = THREE.MathUtils.clamp(sourceMaterial.metalness ?? 0, 0, 1);
  flashlightBounceColor.multiplyScalar(1 - metalness);

  flashlightBounceColor.r = THREE.MathUtils.clamp(flashlightBounceColor.r, 0, 1);
  flashlightBounceColor.g = THREE.MathUtils.clamp(flashlightBounceColor.g, 0, 1);
  flashlightBounceColor.b = THREE.MathUtils.clamp(flashlightBounceColor.b, 0, 1);

  return flashlightBounceColor;
}

function inferWallHeightTexture(textureSet) {
  if (textureSet?.height) {
    return textureSet.height;
  }

  // No dedicated wall height map exists in assets, so infer relief primarily from diffuse
  // (higher texture contrast) and enrich with normal-map slope in shader.
  if (textureSet?.color) {
    textureSet.color.userData.inferredHeight = "luma+normal-slope";
    return textureSet.color;
  }

  if (textureSet?.roughness) {
    textureSet.roughness.userData.inferredHeight = "invert-roughness";
    return textureSet.roughness;
  }

  return null;
}

function applyParallaxOcclusionToWallMaterial(material, heightTexture, pomUniforms) {
  if (!material || !heightTexture) {
    return;
  }

  material.onBeforeCompile = (shader) => {
    shader.uniforms.pomHeightMap = { value: heightTexture };
    shader.uniforms.pomHeightScale = pomUniforms.heightScale;
    shader.uniforms.pomMinLayers = pomUniforms.minLayers;
    shader.uniforms.pomMaxLayers = pomUniforms.maxLayers;

    shader.fragmentShader = shader.fragmentShader
      .replace(
        "#include <common>",
        `#include <common>
uniform sampler2D pomHeightMap;
uniform float pomHeightScale;
uniform float pomMinLayers;
uniform float pomMaxLayers;

vec3 pomComputeNormalVS(vec3 positionVS) {
  vec3 dpdx = dFdx(positionVS);
  vec3 dpdy = dFdy(positionVS);
  vec3 normalVS = normalize(cross(dpdx, dpdy));
  return gl_FrontFacing ? normalVS : -normalVS;
}

mat3 pomCotangentFrame(vec3 normalVS, vec3 positionVS, vec2 uv) {
  vec3 dp1 = dFdx(positionVS);
  vec3 dp2 = dFdy(positionVS);
  vec2 duv1 = dFdx(uv);
  vec2 duv2 = dFdy(uv);

  vec3 dp2perp = cross(dp2, normalVS);
  vec3 dp1perp = cross(normalVS, dp1);
  vec3 tangent = dp2perp * duv1.x + dp1perp * duv2.x;
  vec3 bitangent = dp2perp * duv1.y + dp1perp * duv2.y;

  float invmax = inversesqrt(max(dot(tangent, tangent), dot(bitangent, bitangent)));
  return mat3(tangent * invmax, bitangent * invmax, normalVS);
}

float pomSampleHeight(vec2 uv) {
  vec3 sourceColor = texture2D(pomHeightMap, uv).rgb;
  float lumaHeight = dot(sourceColor, vec3(0.2126, 0.7152, 0.0722));
  return clamp(lumaHeight, 0.0, 1.0);
}

vec4 pomTexture2D(sampler2D tex, vec2 uv, vec2 gradX, vec2 gradY, float mipBias) {
#if __VERSION__ >= 300
  return textureGrad(tex, uv, gradX, gradY);
#elif defined(GL_EXT_shader_texture_lod)
  return texture2DGradEXT(tex, uv, gradX, gradY);
#else
  return texture2D(tex, uv, mipBias);
#endif
}

vec2 parallaxOcclusionUV(vec2 uv, out vec2 displacedGradX, out vec2 displacedGradY, out float mipBias) {
  vec3 positionVS = -vViewPosition;
  vec3 normalVS = pomComputeNormalVS(positionVS);
  float heightScale = pomHeightScale;
  vec2 uvGradX = dFdx(uv);
  vec2 uvGradY = dFdy(uv);
  if (heightScale <= 0.00001) {
    displacedGradX = uvGradX;
    displacedGradY = uvGradY;
    mipBias = 0.0;
    return uv;
  }

  vec3 viewDirVS = normalize(vViewPosition);
  mat3 tbn = pomCotangentFrame(normalVS, positionVS, uv);
  vec3 viewDirTS = normalize(
    vec3(dot(viewDirVS, tbn[0]), dot(viewDirVS, tbn[1]), dot(viewDirVS, tbn[2]))
  );

  float viewZ = max(abs(viewDirTS.z), 0.06);
  float grazingFade = smoothstep(0.07, 0.35, viewZ);
  heightScale *= grazingFade;
  if (heightScale <= 0.00001) {
    displacedGradX = uvGradX;
    displacedGradY = uvGradY;
    mipBias = 0.0;
    return uv;
  }
  float invViewZ = 1.0 / viewZ;
  vec2 proj = viewDirTS.xy * invViewZ;
  float projectedParallax = length(proj) * heightScale;
  if (projectedParallax <= 0.0015) {
    displacedGradX = uvGradX;
    displacedGradY = uvGradY;
    mipBias = 0.0;
    return uv;
  }
  float numLayers = mix(pomMaxLayers, pomMinLayers, abs(viewZ));
  float layerDepth = 1.0 / numLayers;
  vec2 deltaUv = proj * (heightScale / numLayers);

  vec2 currentUv = uv;
  vec2 previousUv = uv;
  float currentLayerDepth = 0.0;
  float currentHeight = pomSampleHeight(currentUv);
  float previousHeight = currentHeight;
  float previousLayerDepth = currentLayerDepth;

  for (int i = 0; i < 32; i++) {
    if (float(i) >= numLayers || currentLayerDepth >= currentHeight) {
      break;
    }

    previousUv = currentUv;
    previousHeight = currentHeight;
    previousLayerDepth = currentLayerDepth;

    currentUv -= deltaUv;
    currentLayerDepth += layerDepth;
    currentHeight = pomSampleHeight(currentUv);
  }

  float finalTravel;
  if (currentLayerDepth >= currentHeight) {
    float lowerTravel = previousLayerDepth;
    float upperTravel = currentLayerDepth;
    for (int i = 0; i < 3; i++) {
      float midTravel = 0.5 * (lowerTravel + upperTravel);
      vec2 midUv = uv - proj * (heightScale * midTravel);
      float midHeight = pomSampleHeight(midUv);
      if (midTravel < midHeight) {
        lowerTravel = midTravel;
      } else {
        upperTravel = midTravel;
      }
    }
    finalTravel = 0.5 * (lowerTravel + upperTravel);
  } else {
    // Fallback when layer march exits without a guaranteed bracket.
    float after = currentHeight - currentLayerDepth;
    float before = previousHeight - previousLayerDepth;
    float denom = after - before;
    float weight = abs(denom) > 0.00001 ? clamp(after / denom, 0.0, 1.0) : 0.0;
    finalTravel = mix(currentLayerDepth, previousLayerDepth, weight);
  }
  vec2 finalUv = uv - proj * (heightScale * finalTravel);

  // Derivative-aware gradients for displaced UV:
  // uv' = uv - (V.xy / V.z) * (heightScale * travel)
  vec3 dViewDirTSdx = dFdx(viewDirTS);
  vec3 dViewDirTSdy = dFdy(viewDirTS);
  float viewZSign = sign(viewDirTS.z);
  float dViewZdx = viewZSign * dViewDirTSdx.z;
  float dViewZdy = viewZSign * dViewDirTSdy.z;
  vec2 dProjDx =
    (dViewDirTSdx.xy * viewZ - viewDirTS.xy * dViewZdx) / max(viewZ * viewZ, 0.00001);
  vec2 dProjDy =
    (dViewDirTSdy.xy * viewZ - viewDirTS.xy * dViewZdy) / max(viewZ * viewZ, 0.00001);
  float scaleTravel = heightScale * finalTravel;
  vec2 dOffsetDx = dProjDx * scaleTravel;
  vec2 dOffsetDy = dProjDy * scaleTravel;
  displacedGradX = uvGradX - dOffsetDx;
  displacedGradY = uvGradY - dOffsetDy;

  // Stabilize mip selection when displaced UV derivatives become discontinuous.
  float normalizedDelta = length(finalUv - uv) / max(heightScale, 0.0001);
  mipBias = -clamp(normalizedDelta * 0.7 + (1.0 - viewZ) * 0.85, 0.0, 2.0);
  return finalUv;
}
`,
      )
      .replace(
        "void main() {",
        `void main() {
	vec2 pomGradX;
	vec2 pomGradY;
	float pomMipBias;
	vec2 pomSharedUv = parallaxOcclusionUV( vMapUv, pomGradX, pomGradY, pomMipBias );`,
      )
      .replace(
        "#include <map_fragment>",
        `#ifdef USE_MAP
	vec4 sampledDiffuseColor = pomTexture2D( map, pomSharedUv, pomGradX, pomGradY, pomMipBias );

	#ifdef DECODE_VIDEO_TEXTURE

		sampledDiffuseColor = sRGBTransferEOTF( sampledDiffuseColor );

	#endif

	diffuseColor *= sampledDiffuseColor;

#endif`,
      )
      .replace(
        "#include <normal_fragment_maps>",
        `#ifdef USE_NORMALMAP_OBJECTSPACE

	normal = pomTexture2D( normalMap, pomSharedUv, pomGradX, pomGradY, pomMipBias ).xyz * 2.0 - 1.0;

	#ifdef FLIP_SIDED

		normal = - normal;

	#endif

	#ifdef DOUBLE_SIDED

		normal = normal * faceDirection;

	#endif

	normal = normalize( normalMatrix * normal );

#elif defined( USE_NORMALMAP_TANGENTSPACE )

	vec3 mapN = pomTexture2D( normalMap, pomSharedUv, pomGradX, pomGradY, pomMipBias ).xyz * 2.0 - 1.0;
	mapN.xy *= normalScale;

	normal = normalize( tbn * mapN );

#elif defined( USE_BUMPMAP )

	normal = perturbNormalArb( - vViewPosition, normal, dHdxy_fwd(), faceDirection );

#endif`,
      )
      .replace(
        "#include <roughnessmap_fragment>",
        `float roughnessFactor = roughness;

#ifdef USE_ROUGHNESSMAP

	vec4 texelRoughness = pomTexture2D( roughnessMap, pomSharedUv, pomGradX, pomGradY, pomMipBias );
	roughnessFactor *= texelRoughness.g;

#endif`,
      );
  };

  material.customProgramCacheKey = () => "wall-pom-v1";
  material.needsUpdate = true;
}

function loadTextureSet({ colorPath, normalPath, roughnessPath, heightPath, repeatX, repeatY }) {
  return {
    color: loadTexture(colorPath, { repeatX, repeatY, isColor: true }),
    normal: loadTexture(normalPath, { repeatX, repeatY, isColor: false }),
    roughness: loadTexture(roughnessPath, { repeatX, repeatY, isColor: false }),
    height: heightPath ? loadTexture(heightPath, { repeatX, repeatY, isColor: false }) : null,
  };
}

function loadSpotlightMapTexture(path) {
  const texture = textureLoader.load(path);
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.anisotropy = maxAnisotropy;
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

function sampleModelPoints(model) {
  const points = [];
  const vertex = new THREE.Vector3();
  model.updateMatrixWorld(true);
  model.traverse((obj) => {
    if (!obj.isMesh) return;
    const positions = obj.geometry?.attributes?.position;
    if (!positions) return;
    for (let i = 0; i < positions.count; i++) {
      vertex.fromBufferAttribute(positions, i).applyMatrix4(obj.matrixWorld);
      points.push({ x: vertex.x, y: vertex.y, z: vertex.z });
    }
  });
  return points;
}

function computeEndStats(points) {
  if (points.length === 0) {
    return null;
  }

  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const point of points) {
    if (point.z < minZ) minZ = point.z;
    if (point.z > maxZ) maxZ = point.z;
  }

  const sliceDepth = Math.max((maxZ - minZ) * 0.14, 0.005);
  const minEnd = { sumX: 0, sumY: 0, count: 0, radius: 0, z: minZ };
  const maxEnd = { sumX: 0, sumY: 0, count: 0, radius: 0, z: maxZ };

  for (const point of points) {
    if (point.z <= minZ + sliceDepth) {
      minEnd.sumX += point.x;
      minEnd.sumY += point.y;
      minEnd.count += 1;
      minEnd.radius = Math.max(minEnd.radius, Math.hypot(point.x, point.y));
    }
    if (point.z >= maxZ - sliceDepth) {
      maxEnd.sumX += point.x;
      maxEnd.sumY += point.y;
      maxEnd.count += 1;
      maxEnd.radius = Math.max(maxEnd.radius, Math.hypot(point.x, point.y));
    }
  }

  minEnd.cx = minEnd.count > 0 ? minEnd.sumX / minEnd.count : 0;
  minEnd.cy = minEnd.count > 0 ? minEnd.sumY / minEnd.count : 0;
  maxEnd.cx = maxEnd.count > 0 ? maxEnd.sumX / maxEnd.count : 0;
  maxEnd.cy = maxEnd.count > 0 ? maxEnd.sumY / maxEnd.count : 0;

  return { min: minEnd, max: maxEnd };
}

function loadFlashlightModel() {
  modelLoader.load(
    "./assets/models/old_flashlight.glb",
    (gltf) => {
      const model = gltf.scene;
      model.traverse((obj) => {
        if (!obj.isMesh) return;
        obj.castShadow = false;
        obj.receiveShadow = false;
        if (Array.isArray(obj.material)) {
          for (const material of obj.material) {
            material.side = THREE.FrontSide;
          }
        } else if (obj.material) {
          obj.material.side = THREE.FrontSide;
        }
      });

      const rawBounds = new THREE.Box3().setFromObject(model);
      const rawSize = new THREE.Vector3();
      rawBounds.getSize(rawSize);
      const maxDim = Math.max(rawSize.x, rawSize.y, rawSize.z) || 1;
      const scale = 0.55 / maxDim;
      model.scale.setScalar(scale);

      // Align the longest model axis with local -Z/+Z.
      if (rawSize.x >= rawSize.y && rawSize.x >= rawSize.z) {
        model.rotation.y = -Math.PI / 2;
      } else if (rawSize.y >= rawSize.x && rawSize.y >= rawSize.z) {
        model.rotation.x = -Math.PI / 2;
      }

      const centeredBounds = new THREE.Box3().setFromObject(model);
      const center = new THREE.Vector3();
      centeredBounds.getCenter(center);
      model.position.sub(center);

      // Infer which end is the "head" (usually larger cross-section) and force it forward (-Z).
      let endStats = computeEndStats(sampleModelPoints(model));
      if (endStats && endStats.max.radius > endStats.min.radius * 1.04) {
        model.rotation.y += Math.PI;
        endStats = computeEndStats(sampleModelPoints(model));
      }
      model.rotation.z = Math.PI * 0.03;
      endStats = computeEndStats(sampleModelPoints(model));

      if (endStats) {
        const tip = endStats.min;
        const beamZ = tip.z - 0.02;
        flashlight.position.set(tip.cx, tip.cy, beamZ);
        flashlightTarget.position.set(tip.cx, tip.cy, beamZ - 7.2);
      }

      flashlightModelAnchor.clear();
      flashlightModelAnchor.add(model);
      flashlightModelLoaded = true;
    },
    undefined,
    () => {
      flashlightModelLoaded = false;
      console.warn("Flashlight model failed to load.");
    },
  );
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
  maze = generateMaze(MAZE_COLS, MAZE_ROWS);
  startCell = { col: 1, row: 1 };
  exitCell = findFarthestOpenCell(maze, startCell);
  rebuildWalls();
  rebuildExitMarker();
  resetPlayerToStart();
  setStatus("New maze generated. Reach the red marker.");
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

  const geometry = buildWallSurfaceGeometry();
  wallMesh = new THREE.Mesh(geometry, wallMaterial);
  buildMeshBVH(wallMesh);
  scene.add(wallMesh);
}

function buildWallSurfaceGeometry() {
  const positions = [];
  const normals = [];
  const uvs = [];
  const indices = [];

  let vertexIndex = 0;
  const verticalVRepeat = WALL_HEIGHT / CELL_SIZE;

  const hasWallAt = (col, row) => {
    if (col < 0 || col >= MAZE_COLS || row < 0 || row >= MAZE_ROWS) {
      return false;
    }
    return maze[row][col] === 1;
  };

  function pushFace(center, u, v, normal, uvU = 1, uvV = 1) {
    const hx = u.x * 0.5;
    const hy = u.y * 0.5;
    const hz = u.z * 0.5;
    const vx = v.x * 0.5;
    const vy = v.y * 0.5;
    const vz = v.z * 0.5;

    const p0 = [center.x - hx - vx, center.y - hy - vy, center.z - hz - vz];
    const p1 = [center.x + hx - vx, center.y + hy - vy, center.z + hz - vz];
    const p2 = [center.x + hx + vx, center.y + hy + vy, center.z + hz + vz];
    const p3 = [center.x - hx + vx, center.y - hy + vy, center.z - hz + vz];

    positions.push(...p0, ...p1, ...p2, ...p3);
    for (let i = 0; i < 4; i++) {
      normals.push(normal.x, normal.y, normal.z);
    }
    uvs.push(0, 0, uvU, 0, uvU, uvV, 0, uvV);
    indices.push(
      vertexIndex,
      vertexIndex + 1,
      vertexIndex + 2,
      vertexIndex,
      vertexIndex + 2,
      vertexIndex + 3,
    );
    vertexIndex += 4;
  }

  for (let row = 0; row < MAZE_ROWS; row++) {
    for (let col = 0; col < MAZE_COLS; col++) {
      if (!hasWallAt(col, row)) {
        continue;
      }

      const minX = col * CELL_SIZE - worldHalfWidth;
      const maxX = minX + CELL_SIZE;
      const minZ = row * CELL_SIZE - worldHalfDepth;
      const maxZ = minZ + CELL_SIZE;
      const midX = minX + CELL_SIZE * 0.5;
      const midZ = minZ + CELL_SIZE * 0.5;

      // Exposed side faces only: this is the voxel-style shell mesh.
      if (!hasWallAt(col - 1, row)) {
        pushFace(
          new THREE.Vector3(minX, WALL_HEIGHT * 0.5, midZ),
          new THREE.Vector3(0, 0, CELL_SIZE),
          new THREE.Vector3(0, WALL_HEIGHT, 0),
          new THREE.Vector3(-1, 0, 0),
          1,
          verticalVRepeat,
        );
      }
      if (!hasWallAt(col + 1, row)) {
        pushFace(
          new THREE.Vector3(maxX, WALL_HEIGHT * 0.5, midZ),
          new THREE.Vector3(0, 0, -CELL_SIZE),
          new THREE.Vector3(0, WALL_HEIGHT, 0),
          new THREE.Vector3(1, 0, 0),
          1,
          verticalVRepeat,
        );
      }
      if (!hasWallAt(col, row - 1)) {
        pushFace(
          new THREE.Vector3(midX, WALL_HEIGHT * 0.5, minZ),
          new THREE.Vector3(-CELL_SIZE, 0, 0),
          new THREE.Vector3(0, WALL_HEIGHT, 0),
          new THREE.Vector3(0, 0, -1),
          1,
          verticalVRepeat,
        );
      }
      if (!hasWallAt(col, row + 1)) {
        pushFace(
          new THREE.Vector3(midX, WALL_HEIGHT * 0.5, maxZ),
          new THREE.Vector3(CELL_SIZE, 0, 0),
          new THREE.Vector3(0, WALL_HEIGHT, 0),
          new THREE.Vector3(0, 0, 1),
          1,
          verticalVRepeat,
        );
      }

      // Top face is exposed because there are no stacked voxels above.
      pushFace(
        new THREE.Vector3(midX, WALL_HEIGHT, midZ),
        new THREE.Vector3(CELL_SIZE, 0, 0),
        new THREE.Vector3(0, 0, -CELL_SIZE),
        new THREE.Vector3(0, 1, 0),
        1,
        1,
      );
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute("normal", new THREE.Float32BufferAttribute(normals, 3));
  geometry.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.computeBoundingSphere();
  geometry.computeBoundingBox();
  return geometry;
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
  scene.add(exitMarker);
}

function generateMaze(cols, rows) {
  const width = cols % 2 === 0 ? cols + 1 : cols;
  const height = rows % 2 === 0 ? rows + 1 : rows;
  const grid = Array.from({ length: height }, () => Array(width).fill(1));

  const directions = [
    [2, 0],
    [-2, 0],
    [0, 2],
    [0, -2],
  ];

  function shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      const temp = arr[i];
      arr[i] = arr[j];
      arr[j] = temp;
    }
  }

  function carve(col, row) {
    grid[row][col] = 0;
    const dirs = directions.slice();
    shuffle(dirs);

    for (const [dx, dy] of dirs) {
      const nextCol = col + dx;
      const nextRow = row + dy;
      if (nextCol <= 0 || nextCol >= width - 1 || nextRow <= 0 || nextRow >= height - 1) {
        continue;
      }
      if (grid[nextRow][nextCol] === 0) {
        continue;
      }

      grid[row + dy / 2][col + dx / 2] = 0;
      carve(nextCol, nextRow);
    }
  }

  carve(1, 1);
  grid[1][1] = 0;
  grid[height - 2][width - 2] = 0;
  return grid;
}

function findFarthestOpenCell(grid, fromCell) {
  const queue = [{ ...fromCell, distance: 0 }];
  const visited = new Set([`${fromCell.col},${fromCell.row}`]);
  let farthest = { col: fromCell.col, row: fromCell.row, distance: 0 };
  const offsets = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ];

  while (queue.length > 0) {
    const current = queue.shift();
    if (current.distance > farthest.distance) {
      farthest = current;
    }

    for (const [dc, dr] of offsets) {
      const nextCol = current.col + dc;
      const nextRow = current.row + dr;
      const key = `${nextCol},${nextRow}`;
      if (visited.has(key)) {
        continue;
      }
      if (!isWalkableCell(nextCol, nextRow)) {
        continue;
      }

      visited.add(key);
      queue.push({
        col: nextCol,
        row: nextRow,
        distance: current.distance + 1,
      });
    }
  }

  return { col: farthest.col, row: farthest.row };
}

function resetPlayerToStart() {
  const spawn = cellToWorld(startCell.col, startCell.row);
  camera.position.set(spawn.x, PLAYER_HEIGHT, spawn.z);
  camera.quaternion.identity();

  const path = findPath(startCell, exitCell);
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

      // ESC should unlock for UI tweaking (e.g. sliders) without forcing the menu back open.
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
  if (
    code === "ArrowUp" ||
    code === "ArrowDown" ||
    code === "ArrowLeft" ||
    code === "ArrowRight" ||
    code === "Space"
  ) {
    event.preventDefault();
  }

  if (code === "KeyW" || code === "ArrowUp") keyState.forward = true;
  if (code === "KeyS" || code === "ArrowDown") keyState.backward = true;
  if (code === "KeyA" || code === "ArrowLeft") keyState.left = true;
  if (code === "KeyD" || code === "ArrowRight") keyState.right = true;
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
}

function onKeyUp(event) {
  const code = event.code;
  if (code === "KeyW" || code === "ArrowUp") keyState.forward = false;
  if (code === "KeyS" || code === "ArrowDown") keyState.backward = false;
  if (code === "KeyA" || code === "ArrowLeft") keyState.left = false;
  if (code === "KeyD" || code === "ArrowRight") keyState.right = false;
  if (code === "ShiftLeft" || code === "ShiftRight") keyState.sprint = false;
}

function update(deltaSeconds) {
  elapsed += deltaSeconds;
  updateFlashlightFlicker(deltaSeconds);
  updateFlashlightBounceLight(deltaSeconds);
  if (exitMarker) {
    exitMarker.rotation.y += deltaSeconds * 1.6;
    exitMarker.position.y = 1.2 + Math.sin(elapsed * 2.8) * 0.12;
  }

  if (!hasWon) {
    updatePlayerMovement(deltaSeconds);
    detectWinCondition();
  }
}

function updatePlayerMovement(deltaSeconds) {
  if (!gameActive) {
    return;
  }

  const inputX = Number(keyState.right) - Number(keyState.left);
  const inputZ = Number(keyState.forward) - Number(keyState.backward);
  if (inputX === 0 && inputZ === 0) {
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

  const nextX = current.x + stepX;
  if (canOccupy(nextX, current.z, PLAYER_RADIUS)) {
    current.x = nextX;
  }

  const nextZ = current.z + stepZ;
  if (canOccupy(current.x, nextZ, PLAYER_RADIUS)) {
    current.z = nextZ;
  }
}

function detectWinCondition() {
  const playerCell = worldToCell(camera.position.x, camera.position.z);
  if (playerCell.col === exitCell.col && playerCell.row === exitCell.row) {
    hasWon = true;
    gameActive = false;
    isTopDownView = false;
    if (canUsePointerLock && controls.isLocked) {
      controls.unlock();
    } else {
      overlay.classList.remove("hidden");
      crosshair.style.opacity = "0.25";
    }
    setStatus("Maze cleared. Press Enter Maze for a new one.");
  }
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
    flashlightRig.visible = false;
    flashlight.visible = false;
    topDownFillLight.visible = true;
    updateTopDownCamera();
    scene.fog = null;
    renderer.render(scene, topDownCamera);
    if (roofMesh) {
      roofMesh.visible = true;
    }
    flashlightRig.visible = true;
    flashlight.visible = flashlightEnabled;
    topDownFillLight.visible = false;
    scene.fog = mazeFog;
    return;
  }
  flashlightRig.visible = true;
  flashlight.visible = flashlightEnabled;
  topDownFillLight.visible = false;
  scene.fog = mazeFog;
  composer.render();
}

function updateFlashlightFlicker(deltaSeconds) {
  if (!flashlightEnabled || isTopDownView) {
    flashlight.intensity = FLASHLIGHT_BASE_INTENSITY;
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
    (flashlightFlickerTarget - flashlightFlickerValue) * Math.min(1, deltaSeconds * FLASHLIGHT_FLICKER_RATE);
  flashlight.intensity = FLASHLIGHT_BASE_INTENSITY * flashlightFlickerValue;
  flashlight.distance = FLASHLIGHT_BASE_DISTANCE * (0.85 + flashlightFlickerValue * 0.15);
}

function hideFlashlightBounceLight() {
  flashlightBounceLight.visible = false;
  flashlightBounceLight.intensity = 0;
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

function updateFlashlightBounceEma(targetColor, targetIntensity, deltaSeconds) {
  if (!flashlightBounceEmaInitialized) {
    flashlightBounceSmoothedColor.copy(targetColor);
    flashlightBounceSmoothedIntensity = targetIntensity;
    flashlightBounceEmaInitialized = true;
    return;
  }

  const blend = computeEmaBlend(deltaSeconds, FLASHLIGHT_BOUNCE_EMA_HALF_LIFE);
  flashlightBounceSmoothedColor.lerp(targetColor, blend);
  flashlightBounceSmoothedIntensity += (targetIntensity - flashlightBounceSmoothedIntensity) * blend;
}

function updateFlashlightBounceLight(deltaSeconds) {
  if (!flashlightEnabled || isTopDownView || hasWon) {
    hideFlashlightBounceLight();
    flashlightBounceEmaInitialized = false;
    flashlightBounceSmoothedIntensity = 0;
    return;
  }

  flashlight.getWorldPosition(flashlightBounceOrigin);
  flashlightTarget.getWorldPosition(flashlightTargetWorld);

  flashlightBounceDirection.subVectors(flashlightTargetWorld, flashlightBounceOrigin);
  if (flashlightBounceDirection.lengthSq() < 0.000001) {
    hideFlashlightBounceLight();
    return;
  }
  flashlightBounceDirection.normalize();
  flashlightRaycaster.set(flashlightBounceOrigin, flashlightBounceDirection);
  flashlightRaycaster.far = flashlight.distance > 0 ? flashlight.distance : Infinity;

  const intersections = flashlightRaycaster.intersectObjects(
    [wallMesh, floorMesh, roofMesh].filter(Boolean),
    false,
  );

  if (!intersections.length) {
    updateFlashlightBounceEma(flashlightBounceSmoothedColor, 0, deltaSeconds);
    if (flashlightBounceSmoothedIntensity <= 0.0005) {
      hideFlashlightBounceLight();
      return;
    }
    flashlightBounceLight.visible = true;
    flashlightBounceLight.color.copy(flashlightBounceSmoothedColor);
    flashlightBounceLight.intensity = flashlightBounceSmoothedIntensity;
    return;
  }

  const hit = intersections[0];
  if (!hit.face) {
    updateFlashlightBounceEma(flashlightBounceSmoothedColor, 0, deltaSeconds);
    if (flashlightBounceSmoothedIntensity <= 0.0005) {
      hideFlashlightBounceLight();
      return;
    }
    flashlightBounceLight.visible = true;
    flashlightBounceLight.color.copy(flashlightBounceSmoothedColor);
    flashlightBounceLight.intensity = flashlightBounceSmoothedIntensity;
    return;
  }

  flashlightBounceNormal.copy(hit.normal).transformDirection(hit.object.matrixWorld).normalize();
  flashlightHitDirection.subVectors(hit.point, flashlightBounceOrigin);
  const hitDistance = flashlightHitDirection.length();
  if (hitDistance <= 0.00001) {
    hideFlashlightBounceLight();
    return;
  }
  flashlightHitDirection.multiplyScalar(1 / hitDistance);

  const incidenceCos = Math.max(-flashlightBounceNormal.dot(flashlightHitDirection), 0);
  if (incidenceCos <= 0) {
    updateFlashlightBounceEma(flashlightBounceSmoothedColor, 0, deltaSeconds);
    if (flashlightBounceSmoothedIntensity <= 0.0005) {
      hideFlashlightBounceLight();
      return;
    }
    flashlightBounceLight.visible = true;
    flashlightBounceLight.color.copy(flashlightBounceSmoothedColor);
    flashlightBounceLight.intensity = flashlightBounceSmoothedIntensity;
    return;
  }

  const angleCos = THREE.MathUtils.clamp(
    flashlightBounceDirection.dot(flashlightHitDirection),
    -1,
    1,
  );
  const spotAttenuation = computeSpotAttenuation(angleCos, flashlight);
  if (spotAttenuation <= 0) {
    updateFlashlightBounceEma(flashlightBounceSmoothedColor, 0, deltaSeconds);
    if (flashlightBounceSmoothedIntensity <= 0.0005) {
      hideFlashlightBounceLight();
      return;
    }
    flashlightBounceLight.visible = true;
    flashlightBounceLight.color.copy(flashlightBounceSmoothedColor);
    flashlightBounceLight.intensity = flashlightBounceSmoothedIntensity;
    return;
  }

  const rangeAttenuation = computeRangeAttenuation(hitDistance, flashlight.distance);
  const coneSolidAngle = TWO_PI * (1 - Math.cos(flashlight.angle));
  // First-bounce GI approximation:
  // 1) convert spotlight candela -> incident cone lumens
  // 2) apply local incidence at the hit
  // 3) map reflected hemisphere flux back to isotropic point-light intensity
  const incidentFlux = flashlight.intensity * coneSolidAngle * spotAttenuation * rangeAttenuation;
  const bounceIntensity = (incidentFlux * incidenceCos) / TWO_PI;
  flashlightBounceTargetColor.copy(
    resolveMaterialBounceReflectance(
      Array.isArray(hit.object.material)
        ? hit.object.material[hit.face?.materialIndex ?? 0]
        : hit.object.material,
    ),
  );
  updateFlashlightBounceEma(flashlightBounceTargetColor, bounceIntensity, deltaSeconds);

  flashlightBounceLight.position
    .copy(hit.point)
    .addScaledVector(flashlightBounceNormal, 0.08);
  flashlightBounceLight.color.copy(flashlightBounceSmoothedColor);
  flashlightBounceLight.visible = true;
  flashlightBounceLight.intensity = flashlightBounceSmoothedIntensity;
}

function setStatus(text) {
  status.textContent = text;
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
  flashlight.visible = flashlightEnabled && !isTopDownView;
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

function collectNearbyCells(centerCol, centerRow, radius) {
  const nearby = [];
  for (let row = centerRow - radius; row <= centerRow + radius; row++) {
    for (let col = centerCol - radius; col <= centerCol + radius; col++) {
      if (row < 0 || row >= MAZE_ROWS || col < 0 || col >= MAZE_COLS) {
        continue;
      }
      if (maze[row][col] === 1) {
        nearby.push({ col, row, type: "wall" });
      } else if (col === exitCell.col && row === exitCell.row) {
        nearby.push({ col, row, type: "exit" });
      }
    }
  }
  return nearby;
}

function findPath(from, to) {
  const queue = [{ col: from.col, row: from.row }];
  const visited = new Set([`${from.col},${from.row}`]);
  const previous = new Map();
  const offsets = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ];

  while (queue.length > 0) {
    const current = queue.shift();
    if (current.col === to.col && current.row === to.row) {
      break;
    }

    for (const [dc, dr] of offsets) {
      const nextCol = current.col + dc;
      const nextRow = current.row + dr;
      const key = `${nextCol},${nextRow}`;
      if (visited.has(key) || !isWalkableCell(nextCol, nextRow)) {
        continue;
      }

      visited.add(key);
      previous.set(key, `${current.col},${current.row}`);
      queue.push({ col: nextCol, row: nextRow });
    }
  }

  const endKey = `${to.col},${to.row}`;
  if (!visited.has(endKey)) {
    return [{ col: from.col, row: from.row }];
  }

  const path = [];
  let currentKey = endKey;
  while (currentKey) {
    const [colText, rowText] = currentKey.split(",");
    path.push({ col: Number(colText), row: Number(rowText) });
    currentKey = previous.get(currentKey);
  }
  path.reverse();
  return path;
}

function renderGameToText() {
  const rotation = new THREE.Euler().setFromQuaternion(camera.quaternion, "YXZ");
  const playerCell = worldToCell(camera.position.x, camera.position.z);

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
    },
    nearby: collectNearbyCells(playerCell.col, playerCell.row, 2),
  });
}
