const PICKUP_LIBRARY = [
  {
    id: "knife_01",
    name: "Knife",
    path: "./assets/models/polyhaven_pickups/knife_01/knife_01.glb",
    desiredSizeMin: 0.52,
    desiredSizeMax: 0.76,
  },
  {
    id: "pistol_01",
    name: "Pistol",
    path: "./assets/models/polyhaven_pickups/pistol_01/pistol_01.glb",
    desiredSizeMin: 0.46,
    desiredSizeMax: 0.66,
  },
  {
    id: "bullet_01",
    name: "Bullet",
    path: "./assets/models/polyhaven_pickups/bullet_01/bullet_02.glb",
    desiredSizeMin: 0.3,
    desiredSizeMax: 0.44,
  },
  {
    id: "meat_jerky_01",
    name: "Jerky",
    path: "./assets/models/polyhaven_pickups/meat_jerky_01/meat_jerky_01.glb",
    desiredSizeMin: 0.34,
    desiredSizeMax: 0.56,
  },
  {
    id: "first_aid_kit_01",
    name: "First Aid Kit",
    path: "./assets/models/polyhaven_pickups/first_aid_kit_01/first_aid_kit_01.glb",
    desiredSizeMin: 0.48,
    desiredSizeMax: 0.7,
  },
  {
    id: "skull_01",
    name: "Skull",
    path: "./assets/models/polyhaven_pickups/skull_01/skull_01.glb",
    desiredSizeMin: 0.36,
    desiredSizeMax: 0.56,
  },
  {
    id: "soda_can_01",
    name: "Soda Can",
    path: "./assets/models/polyhaven_pickups/soda_can_01/soda_can_01.glb",
    desiredSizeMin: 0.34,
    desiredSizeMax: 0.5,
  },
  {
    id: "baseball_bat_01",
    name: "Baseball Bat",
    path: "./assets/models/polyhaven_pickups/baseball_bat_01/baseball_bat_01.glb",
    desiredSizeMin: 0.92,
    desiredSizeMax: 1.26,
  },
];

const PICKUP_SPAWN_COUNTS = [
  { id: "knife_01", count: 1 },
  { id: "pistol_01", count: 1 },
  { id: "bullet_01", count: 7 },
  { id: "meat_jerky_01", count: 2 },
  { id: "first_aid_kit_01", count: 1 },
  { id: "skull_01", count: 3 },
  { id: "soda_can_01", count: 2 },
  { id: "baseball_bat_01", count: 1 },
];

function randomBetween(min, max) {
  return min + Math.random() * (max - min);
}

function shuffleInPlace(array) {
  for (let i = array.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const tmp = array[i];
    array[i] = array[j];
    array[j] = tmp;
  }
  return array;
}

function buildPickupSpawnPlan(entryById) {
  const plan = [];
  for (const rule of PICKUP_SPAWN_COUNTS) {
    const entry = entryById.get(rule.id);
    if (!entry) {
      continue;
    }
    for (let i = 0; i < rule.count; i++) {
      plan.push(entry);
    }
  }
  return shuffleInPlace(plan);
}

function normalizeModelToGroundCenter(THREE, root) {
  root.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(root);
  if (!box.isEmpty()) {
    const center = new THREE.Vector3();
    box.getCenter(center);
    root.position.x -= center.x;
    root.position.z -= center.z;
    root.position.y -= box.min.y;
    root.updateMatrixWorld(true);
    const size = new THREE.Vector3();
    box.getSize(size);
    root.userData.baseSize = Math.max(size.x, size.y, size.z, 0.001);
  } else {
    root.userData.baseSize = 1;
  }
}

function chooseSpawnCells({ maze, cols, rows, startCell, exitCell, desiredCount }) {
  const candidates = [];
  const offsets = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ];

  for (let row = 1; row < rows - 1; row++) {
    for (let col = 1; col < cols - 1; col++) {
      if (maze[row][col] !== 0) {
        continue;
      }

      const distFromStart =
        Math.abs(col - startCell.col) + Math.abs(row - startCell.row);
      const distFromExit =
        Math.abs(col - exitCell.col) + Math.abs(row - exitCell.row);
      if (distFromStart < 3 || distFromExit < 2) {
        continue;
      }

      let wallNeighbors = 0;
      for (const [dc, dr] of offsets) {
        if (maze[row + dr]?.[col + dc] === 1) {
          wallNeighbors += 1;
        }
      }
      if (wallNeighbors === 0) {
        continue;
      }

      candidates.push({ col, row, wallNeighbors });
    }
  }

  shuffleInPlace(candidates);
  candidates.sort((a, b) => b.wallNeighbors - a.wallNeighbors);
  return candidates.slice(0, desiredCount);
}

export function createPickupSystem({
  THREE,
  scene,
  modelLoader,
  cols,
  rows,
  cellSize,
  worldHalfWidth,
  worldHalfDepth,
}) {
  const root = new THREE.Group();
  root.name = "WarehousePickups";
  scene.add(root);

  const entryById = new Map(PICKUP_LIBRARY.map((entry) => [entry.id, entry]));
  const templatePromiseByPath = new Map();
  const iconDataUrlById = new Map();
  const iconPromiseById = new Map();
  const activePickups = [];
  let iconRendererState = null;
  let generationToken = 0;
  let elapsed = 0;

  function getIconRendererState() {
    if (iconRendererState) {
      return iconRendererState;
    }

    const iconCanvas = document.createElement("canvas");
    const iconRenderer = new THREE.WebGLRenderer({
      canvas: iconCanvas,
      antialias: true,
      alpha: true,
      preserveDrawingBuffer: true,
      powerPreference: "high-performance",
    });
    iconRenderer.setPixelRatio(1);
    iconRenderer.setSize(96, 96, false);
    iconRenderer.outputColorSpace = THREE.SRGBColorSpace;
    iconRenderer.setClearColor(0x000000, 0);

    const iconScene = new THREE.Scene();
    const iconRoot = new THREE.Group();
    iconScene.add(iconRoot);

    const fill = new THREE.HemisphereLight(0xc6ddff, 0x4a4032, 0.92);
    const key = new THREE.DirectionalLight(0xffffff, 1.05);
    key.position.set(2.8, 3.2, 2.4);
    const rim = new THREE.DirectionalLight(0xffffff, 0.42);
    rim.position.set(-2.2, 1.4, -2.8);
    iconScene.add(fill);
    iconScene.add(key);
    iconScene.add(rim);

    const iconCamera = new THREE.PerspectiveCamera(34, 1, 0.01, 100);
    iconRendererState = {
      renderer: iconRenderer,
      scene: iconScene,
      root: iconRoot,
      camera: iconCamera,
    };
    return iconRendererState;
  }

  function renderTemplateIcon(template) {
    let state;
    try {
      state = getIconRendererState();
    } catch {
      return null;
    }

    const { renderer, root: iconRoot, camera } = state;
    const iconModel = template.clone(true);
    iconRoot.clear();
    iconRoot.add(iconModel);

    iconModel.traverse((obj) => {
      if (!obj.isMesh) {
        return;
      }
      obj.castShadow = false;
      obj.receiveShadow = false;
    });

    const box = new THREE.Box3().setFromObject(iconModel);
    const center = new THREE.Vector3();
    box.getCenter(center);
    iconModel.position.sub(center);
    iconModel.updateMatrixWorld(true);
    box.setFromObject(iconModel);

    const size = new THREE.Vector3();
    box.getSize(size);
    const maxDim = Math.max(size.x, size.y, size.z, 0.001);
    const distance = maxDim * 2.15;
    camera.position.set(distance * 0.93, distance * 0.86, distance);
    camera.lookAt(0, 0, 0);
    camera.near = Math.max(0.01, maxDim * 0.02);
    camera.far = Math.max(10, maxDim * 12);
    camera.updateProjectionMatrix();

    renderer.clear();
    renderer.render(state.scene, camera);
    return renderer.domElement.toDataURL("image/png");
  }

  function ensureIconForEntry(entry, template) {
    if (iconDataUrlById.has(entry.id)) {
      return Promise.resolve(iconDataUrlById.get(entry.id));
    }
    if (iconPromiseById.has(entry.id)) {
      return iconPromiseById.get(entry.id);
    }

    const promise = Promise.resolve()
      .then(() => {
        const iconDataUrl = renderTemplateIcon(template);
        if (iconDataUrl) {
          iconDataUrlById.set(entry.id, iconDataUrl);
        }
        return iconDataUrl || null;
      })
      .catch(() => null);

    iconPromiseById.set(entry.id, promise);
    return promise;
  }

  function clear() {
    root.clear();
    activePickups.length = 0;
  }

  function loadTemplate(entry) {
    if (!templatePromiseByPath.has(entry.path)) {
      const promise = new Promise((resolve, reject) => {
        modelLoader.load(
          entry.path,
          (gltf) => {
            const templateRoot = gltf.scene;
            templateRoot.traverse((obj) => {
              if (!obj.isMesh) return;
              obj.castShadow = true;
              obj.receiveShadow = true;
            });
            normalizeModelToGroundCenter(THREE, templateRoot);
            void ensureIconForEntry(entry, templateRoot);
            resolve(templateRoot);
          },
          undefined,
          reject,
        );
      });
      templatePromiseByPath.set(entry.path, promise);
    }
    return templatePromiseByPath.get(entry.path);
  }

  function instantiatePickupFromTemplate(entry, template, { x, z, rotationY = null }) {
    const pickup = template.clone(true);
    const baseSize = template.userData.baseSize || 1;
    const desiredSize = randomBetween(entry.desiredSizeMin, entry.desiredSizeMax);
    const uniformScale = desiredSize / baseSize;
    pickup.scale.setScalar(uniformScale);

    pickup.position.set(x, 0, z);
    pickup.rotation.y = Number.isFinite(rotationY) ? rotationY : randomBetween(0, Math.PI * 2);
    pickup.updateMatrixWorld(true);
    const spawnBox = new THREE.Box3().setFromObject(pickup);
    if (!spawnBox.isEmpty()) {
      const pickupHeight = Math.max(spawnBox.max.y - spawnBox.min.y, 0.001);
      const groundClearance = Math.max(0.004, pickupHeight * 0.015);
      pickup.position.y += groundClearance - spawnBox.min.y;
    } else {
      pickup.position.y = Math.max(0.01, desiredSize * 0.02);
    }
    pickup.userData.pickupId = entry.id;
    pickup.userData.pickupName = entry.name;

    const phase = Math.random() * Math.PI * 2;
    const bobAmplitude = randomBetween(0.02, 0.05);
    return {
      object: pickup,
      id: entry.id,
      name: entry.name,
      baseY: pickup.position.y,
      phase,
      bobAmplitude,
    };
  }

  async function regenerate({ maze, startCell, exitCell }) {
    generationToken += 1;
    const token = generationToken;
    clear();

    const spawnPlan = buildPickupSpawnPlan(entryById);
    if (!spawnPlan.length) {
      return;
    }

    const anchors = chooseSpawnCells({
      maze,
      cols,
      rows,
      startCell,
      exitCell,
      desiredCount: spawnPlan.length,
    });
    if (!anchors.length) {
      return;
    }

    const choices = spawnPlan.slice(0, anchors.length);
    const uniqueIds = [...new Set(choices.map((choice) => choice.id))];
    const templates = await Promise.all(
      uniqueIds.map(async (id) => {
        const entry = entryById.get(id);
        return [id, await loadTemplate(entry)];
      }),
    );
    if (token !== generationToken) {
      return;
    }

    const templateById = new Map(templates);
    const jitter = cellSize * 0.22;

    for (let i = 0; i < choices.length; i++) {
      const anchor = anchors[i];
      const choice = choices[i];
      const template = templateById.get(choice.id);
      if (!template) {
        continue;
      }

      const x =
        anchor.col * cellSize -
        worldHalfWidth +
        cellSize * 0.5 +
        randomBetween(-jitter, jitter);
      const z =
        anchor.row * cellSize -
        worldHalfDepth +
        cellSize * 0.5 +
        randomBetween(-jitter, jitter);
      const placedPickup = instantiatePickupFromTemplate(choice, template, { x, z });
      activePickups.push(placedPickup);
      root.add(placedPickup.object);
    }
  }

  function update(deltaSeconds) {
    elapsed += deltaSeconds;
    for (const pickup of activePickups) {
      const bob01 = Math.sin(elapsed * 1.8 + pickup.phase) * 0.5 + 0.5;
      pickup.object.position.y = pickup.baseY + bob01 * pickup.bobAmplitude;
      pickup.object.rotation.y += deltaSeconds * 0.35;
    }
  }

  function findNearestPickup(position, maxDistance) {
    const maxDistSq = maxDistance * maxDistance;
    let nearest = null;
    let nearestIndex = -1;
    let nearestDistSq = maxDistSq;

    for (let i = 0; i < activePickups.length; i++) {
      const pickup = activePickups[i];
      const dx = pickup.object.position.x - position.x;
      const dz = pickup.object.position.z - position.z;
      const distSq = dx * dx + dz * dz;
      if (distSq <= nearestDistSq) {
        nearest = pickup;
        nearestIndex = i;
        nearestDistSq = distSq;
      }
    }

    if (!nearest) {
      return null;
    }

    return {
      id: nearest.id,
      name: nearest.name,
      distance: Math.sqrt(nearestDistSq),
      index: nearestIndex,
    };
  }

  function pickupNearest(position, maxDistance) {
    const nearest = findNearestPickup(position, maxDistance);
    if (!nearest) {
      return null;
    }

    const index = nearest.index;
    if (index < 0) {
      return null;
    }

    const [picked] = activePickups.splice(index, 1);
    root.remove(picked.object);

    return {
      id: picked.id,
      name: picked.name,
    };
  }

  async function dropItemById(id, position = {}) {
    const entry = entryById.get(id);
    if (!entry) {
      return null;
    }

    let template;
    try {
      template = await loadTemplate(entry);
    } catch {
      return null;
    }
    if (!template) {
      return null;
    }

    const margin = Math.max(0.4, cellSize * 0.45);
    const minX = -worldHalfWidth + margin;
    const maxX = worldHalfWidth - margin;
    const minZ = -worldHalfDepth + margin;
    const maxZ = worldHalfDepth - margin;
    const requestedX = Number(position.x);
    const requestedZ = Number(position.z);
    const x = Number.isFinite(requestedX) ? THREE.MathUtils.clamp(requestedX, minX, maxX) : 0;
    const z = Number.isFinite(requestedZ) ? THREE.MathUtils.clamp(requestedZ, minZ, maxZ) : 0;
    const rotationY = Number(position.rotationY);

    const droppedPickup = instantiatePickupFromTemplate(entry, template, { x, z, rotationY });
    activePickups.push(droppedPickup);
    root.add(droppedPickup.object);
    return {
      id: droppedPickup.id,
      name: droppedPickup.name,
    };
  }

  function getIconDataUrlByItemId(id) {
    return iconDataUrlById.get(id) || null;
  }

  function ensureIconForItemId(id) {
    if (iconDataUrlById.has(id)) {
      return Promise.resolve(iconDataUrlById.get(id));
    }
    if (iconPromiseById.has(id)) {
      return iconPromiseById.get(id);
    }
    const entry = entryById.get(id);
    if (!entry) {
      return Promise.resolve(null);
    }
    return loadTemplate(entry).then((template) => ensureIconForEntry(entry, template));
  }

  function createDisplayModelForItemId(id) {
    const entry = entryById.get(id);
    if (!entry) {
      return Promise.resolve(null);
    }

    return loadTemplate(entry)
      .then((template) => {
        const displayModel = template.clone(true);
        displayModel.traverse((obj) => {
          if (!obj.isMesh) {
            return;
          }
          obj.castShadow = false;
          obj.receiveShadow = false;
        });
        return displayModel;
      })
      .catch(() => null);
  }

  return {
    root,
    clear,
    regenerate,
    update,
    findNearestPickup,
    pickupNearest,
    dropItemById,
    getIconDataUrlByItemId,
    ensureIconForItemId,
    createDisplayModelForItemId,
  };
}
