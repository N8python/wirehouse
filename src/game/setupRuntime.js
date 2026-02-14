export function createRuntime({
  THREE,
  PointerLockControls,
  GLTFLoader,
  EffectComposer,
  SMAAPass,
  ShaderPass,
  N8AOPass,
  dom,
  config,
  constants,
  createTextureHelpers,
  inferWallHeightTexture,
  applyParallaxOcclusionToMaterial,
  loadFlashlightModel,
  createWarehousePropScatter,
  createPickupSystem,
}) {
  const {
    MAZE_COLS,
    MAZE_ROWS,
    CELL_SIZE,
    WALL_HEIGHT,
    PLAYER_HEIGHT,
    WALL_POM_HEIGHT_SCALE_DEFAULT,
    WALL_POM_MIN_LAYERS,
    WALL_POM_MAX_LAYERS,
    FLOOR_POM_HEIGHT_SCALE,
    FLOOR_POM_MIN_LAYERS,
    FLOOR_POM_MAX_LAYERS,
    ROOF_POM_HEIGHT_SCALE,
    ROOF_POM_MIN_LAYERS,
    ROOF_POM_MAX_LAYERS,
    FLASHLIGHT_BASE_INTENSITY,
    FLASHLIGHT_BASE_DISTANCE,
  } = config;
  const {
    PISTOL_MUZZLE_FLASH_FRAME_WIDTH,
    FLASHLIGHT_RIG_BASE_POSITION,
    FLASHLIGHT_RIG_BASE_ROTATION,
    LEFT_HAND_RIG_BASE_POSITION,
    LEFT_HAND_RIG_BASE_ROTATION,
    LEFT_HAND_ITEM_BASE_ROTATION,
    FLASHLIGHT_BOUNCE_DEFAULT_REFLECTANCE,
    FOUND_FOOTAGE_GRAIN_INTENSITY,
    FOUND_FOOTAGE_GRAIN_STATIC_STRENGTH,
  } = constants;

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
  dom.app.append(renderer.domElement);

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
  const foundFootageGrainShader = {
    uniforms: {
      tDiffuse: { value: null },
      time: { value: 0 },
      intensity: { value: FOUND_FOOTAGE_GRAIN_INTENSITY },
      staticStrength: { value: FOUND_FOOTAGE_GRAIN_STATIC_STRENGTH },
    },
    vertexShader: `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      uniform sampler2D tDiffuse;
      uniform float time;
      uniform float intensity;
      uniform float staticStrength;
      varying vec2 vUv;

      // Hash-without-sine PRNG (better distribution than basic dot/fract hashes).
      float prng(vec3 p) {
        p = fract(p * vec3(0.1031, 0.1030, 0.0973));
        p += dot(p, p.yxz + 33.33);
        return fract((p.x + p.y) * p.z);
      }

      void main() {
        vec4 base = texture2D(tDiffuse, vUv);
        float frame = floor(time * 60.0);
        vec2 frag = gl_FragCoord.xy;
        float grain = prng(vec3(frag * 0.77, frame * 0.061)) - 0.5;
        float fine = prng(vec3(frag * 1.91 + frame * 0.73, frame * 0.113)) - 0.5;
        float scan = sin((vUv.y + frame * 0.0035) * 960.0) * 0.5 + 0.5;
        float staticBandSeed = prng(vec3(floor(vUv.y * 180.0), frame * 0.041, 91.7));
        float staticBand = step(0.985, staticBandSeed);
        float bandNoise = (
          prng(vec3(vUv.x * 720.0 + frame * 0.61, floor(vUv.y * 260.0), frame * 0.17)) - 0.5
        ) * staticBand;
        float noise = grain * 0.75 + fine * 0.25;
        float staticPulse = bandNoise * staticStrength + (scan - 0.5) * staticStrength * 0.25;
        vec3 color = base.rgb + vec3(noise * intensity + staticPulse);
        gl_FragColor = vec4(clamp(color, 0.0, 1.0), base.a);
      }
    `,
  };
  const foundFootageGrainPass = new ShaderPass(foundFootageGrainShader);
  composer.addPass(foundFootageGrainPass);
  composer.setPixelRatio(initialPixelRatio);
  composer.setSize(window.innerWidth, window.innerHeight);

  const textureLoader = new THREE.TextureLoader();
  const modelLoader = new GLTFLoader();
  const maxAnisotropy = renderer.capabilities.getMaxAnisotropy();
  const { loadTextureSet, loadSpotlightMapTexture } = createTextureHelpers({
    textureLoader,
    maxAnisotropy,
    fallbackReflectance: FLASHLIGHT_BOUNCE_DEFAULT_REFLECTANCE,
  });
  const flashlightPatternTexture = loadSpotlightMapTexture(
    "./assets/textures/light/flashlight-pattern-incandescent.png",
  );
  const bulletDecalTexture = textureLoader.load("./assets/textures/decals/bullet-hole-impact-cc0.png");
  bulletDecalTexture.colorSpace = THREE.SRGBColorSpace;
  bulletDecalTexture.wrapS = THREE.ClampToEdgeWrapping;
  bulletDecalTexture.wrapT = THREE.ClampToEdgeWrapping;
  const bulletDecalLitMaterial = new THREE.MeshStandardMaterial({
    map: bulletDecalTexture,
    color: 0xa3a3a3,
    transparent: true,
    alphaTest: 0.0,
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
  const muzzleFlashTexture = textureLoader.load("./assets/textures/light/muzzle-flash-sheet-cc0.png");
  muzzleFlashTexture.colorSpace = THREE.SRGBColorSpace;
  muzzleFlashTexture.wrapS = THREE.ClampToEdgeWrapping;
  muzzleFlashTexture.wrapT = THREE.ClampToEdgeWrapping;
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
  const flashlightRig = new THREE.Group();
  const flashlightModelAnchor = new THREE.Group();
  const inventoryLeftHandRig = new THREE.Group();
  const inventoryLeftHandItemAnchor = new THREE.Group();
  const heldItemInspectionLight = new THREE.PointLight(0xffffff, 2.8, 6, 1.7);
  const heldItemAmbientFillLight = new THREE.AmbientLight(0xe9f3ff, 0.0);
  const flashlightTarget = new THREE.Object3D();

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
      config.PLAYER_RADIUS,
      Math.max(0.01, config.PLAYER_HEIGHT - config.PLAYER_RADIUS * 2),
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
  pistolMuzzleFlashSprite.position.copy(constants.PISTOL_MUZZLE_FLASH_FALLBACK_LOCAL_POSITION);
  pistolMuzzleFlashSprite.scale.setScalar(0.35);
  pistolMuzzleFlashSprite.renderOrder = 1003;
  const pistolMuzzleFlashLight = new THREE.PointLight(0xffbd84, 0, 4.4, 1.8);
  pistolMuzzleFlashLight.visible = true;
  pistolMuzzleFlashLight.position.copy(constants.PISTOL_MUZZLE_FLASH_FALLBACK_LOCAL_POSITION);
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

  const flashlightState = { flashlightModelLoaded: false };
  loadFlashlightModel({
    modelLoader,
    modelPath: "./assets/models/old_flashlight.glb",
    flashlightModelAnchor,
    flashlight,
    flashlightTarget,
    onLoaded: (loaded) => {
      flashlightState.flashlightModelLoaded = loaded;
      if (!loaded) {
        console.warn("Flashlight model failed to load.");
      }
    },
  });

  return {
    scene,
    mazeFog,
    camera,
    topDownCamera,
    renderer,
    composer,
    n8aoPass,
    smaaPass,
    foundFootageGrainPass,
    controls,
    clock,
    floorMaterial,
    wallMaterial,
    roofMaterial,
    worldWidth,
    worldDepth,
    worldHalfWidth,
    worldHalfDepth,
    propScatter,
    pickupSystem,
    canUsePointerLock,
    flashlightRig,
    flashlightModelAnchor,
    inventoryLeftHandRig,
    inventoryLeftHandItemAnchor,
    heldItemAmbientFillLight,
    flashlight,
    flashlightTarget,
    flashlightBounceLight,
    bounceLightDebugMarker,
    topDownPlayerMarker,
    topDownLookLine,
    topDownFillLight,
    pistolMuzzleFlashSprite,
    pistolMuzzleFlashLight,
    pistolMuzzleFlashMaterial,
    pistolHitDebugMarker,
    muzzleFlashTexture,
    bulletDecalLitMaterial,
    bulletDecalDebugMaterial,
    flashlightState,
  };
}
