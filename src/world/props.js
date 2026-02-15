import { computeAverageTextureAlbedo } from "../graphics/textures.js";
import { MeshBVH, StaticGeometryGenerator } from "three-mesh-bvh";

const PROP_LIBRARY = [
  /*{
    id: "dumpster",
    path: "./assets/models/props/dumpster.glb",
    weight: 1.0,
    desiredSizeMin: 2.1,
    desiredSizeMax: 2.8,
  },
  {
    id: "pallet",
    path: "./assets/models/props/pallet.glb",
    weight: 1.8,
    desiredSizeMin: 1.3,
    desiredSizeMax: 2.0,
  },
  {
    id: "crate",
    path: "./assets/models/props/crate.glb",
    weight: 2.2,
    desiredSizeMin: 0.9,
    desiredSizeMax: 1.5,
  },
  {
    id: "barrel",
    path: "./assets/models/props/barrel.glb",
    weight: 2.0,
    desiredSizeMin: 0.75,
    desiredSizeMax: 1.2,
  },
  {
    id: "traffic_cone",
    path: "./assets/models/props/traffic_cone.glb",
    weight: 1.8,
    desiredSizeMin: 0.45,
    desiredSizeMax: 0.85,
  },
  {
    id: "traffic_barrier",
    path: "./assets/models/props/traffic_barrier.glb",
    weight: 1.2,
    desiredSizeMin: 1.3,
    desiredSizeMax: 2.2,
  },
  {
    id: "bottle_crate",
    path: "./assets/models/props/bottle_crate.glb",
    weight: 1.5,
    desiredSizeMin: 0.8,
    desiredSizeMax: 1.2,
  },
  {
    id: "package_box",
    path: "./assets/models/props/package_box.glb",
    weight: 2.0,
    desiredSizeMin: 0.6,
    desiredSizeMax: 1.2,
  },*/
  {
    id: "pallet",
    path: "./assets/models/props/pallet.glb",
    weight: 1.8,
    desiredSizeMin: 1.3,
    desiredSizeMax: 2.0,
  },
  {
    id: "package_box",
    path: "./assets/models/props/package_box.glb",
    weight: 2.0,
    desiredSizeMin: 0.6,
    desiredSizeMax: 1.2,
  }
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

function weightedPick(items) {
  const total = items.reduce((sum, item) => sum + item.weight, 0);
  let r = Math.random() * total;
  for (const item of items) {
    r -= item.weight;
    if (r <= 0) {
      return item;
    }
  }
  return items[items.length - 1];
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

function ensureTextureAverageAlbedo(texture, fallbackReflectance) {
  if (!texture) {
    return;
  }
  if (texture.userData?.averageAlbedoColor) {
    return;
  }

  const writeAverage = () => {
    const avg = computeAverageTextureAlbedo(texture, fallbackReflectance);
    texture.userData.averageAlbedoColor = avg?.clone ? avg.clone() : avg;
  };

  writeAverage();

  const image = texture.image || texture.source?.data;
  if (image?.addEventListener && image.complete === false) {
    image.addEventListener(
      "load",
      () => {
        writeAverage();
      },
      { once: true },
    );
  }
}

function populateModelAverageAlbedo(THREE, root) {
  const fallbackReflectance = new THREE.Color(0.6, 0.6, 0.6);
  root.traverse((obj) => {
    if (!obj.isMesh || !obj.material) {
      return;
    }
    const materials = Array.isArray(obj.material) ? obj.material : [obj.material];
    for (const material of materials) {
      if (!material?.map) {
        continue;
      }
      ensureTextureAverageAlbedo(material.map, fallbackReflectance);
    }
  });
}

function extractTemplateMeshParts(THREE, root) {
  root.updateMatrixWorld(true);
  const parts = [];
  root.traverse((obj) => {
    if (!obj.isMesh || !obj.geometry || !obj.material) {
      return;
    }
    const geometry = obj.geometry;
    if (!geometry.boundsTree && typeof geometry.computeBoundsTree === "function") {
      geometry.computeBoundsTree();
    }
    parts.push({
      geometry,
      material: obj.material,
      matrix: new THREE.Matrix4().copy(obj.matrixWorld),
    });
  });
  return parts;
}

function choosePlacements({
  maze,
  cols,
  rows,
  startCell,
  exitCell,
  desiredCount,
}) {
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
      if (distFromStart < 3 || distFromExit < 3) {
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

export function createWarehousePropScatter({
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
  root.name = "WarehouseProps";
  scene.add(root);
  const collider = new THREE.Mesh(
    new THREE.BufferGeometry(),
    new THREE.MeshBasicMaterial({ visible: false }),
  );
  collider.name = "WarehousePropsCollider";
  collider.visible = false;
  collider.matrixAutoUpdate = false;
  scene.add(collider);

  const templatePromiseByPath = new Map();
  let generationToken = 0;

  function loadTemplate(path) {
    if (!templatePromiseByPath.has(path)) {
      const promise = new Promise((resolve, reject) => {
        modelLoader.load(
          path,
          (gltf) => {
            const templateRoot = gltf.scene;
            templateRoot.traverse((obj) => {
              if (!obj.isMesh) return;
              obj.castShadow = false;
              obj.receiveShadow = true;
            });
            populateModelAverageAlbedo(THREE, templateRoot);
            normalizeModelToGroundCenter(THREE, templateRoot);
            resolve(templateRoot);
          },
          undefined,
          reject,
        );
      });
      templatePromiseByPath.set(path, promise);
    }
    return templatePromiseByPath.get(path);
  }

  function clearRoot() {
    root.clear();
    if (collider.geometry?.boundsTree?.dispose) {
      collider.geometry.boundsTree.dispose();
    }
    if (collider.geometry) {
      collider.geometry.dispose();
    }
    collider.geometry = new THREE.BufferGeometry();
  }

  async function regenerate({ maze, startCell, exitCell }) {
    generationToken += 1;
    const token = generationToken;
    clearRoot();

    let openCount = 0;
    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < cols; col++) {
        if (maze[row][col] === 0) {
          openCount += 1;
        }
      }
    }

    const desiredCount = Math.min(
      42,
      Math.max(20, Math.floor(openCount * 0.15)),
    );
    const anchors = choosePlacements({
      maze,
      cols,
      rows,
      startCell,
      exitCell,
      desiredCount,
    });

    if (!anchors.length) {
      return;
    }

    const propChoices = anchors.map(() => weightedPick(PROP_LIBRARY));
    const uniquePaths = [...new Set(propChoices.map((choice) => choice.path))];
    const templates = await Promise.all(
      uniquePaths.map(async (path) => [path, await loadTemplate(path)]),
    );
    if (token !== generationToken) {
      return;
    }
    const templateByPath = new Map(templates);

    const placementsByPath = new Map();
    for (let i = 0; i < anchors.length; i++) {
      const anchor = anchors[i];
      const choice = propChoices[i];
      if (!placementsByPath.has(choice.path)) {
        placementsByPath.set(choice.path, []);
      }
      placementsByPath.get(choice.path).push({ anchor, choice });
    }

    const upAxis = new THREE.Vector3(0, 1, 0);
    const quaternion = new THREE.Quaternion();
    const position = new THREE.Vector3();
    const scale = new THREE.Vector3();
    const baseMatrix = new THREE.Matrix4();
    const finalMatrix = new THREE.Matrix4();
    const collisionBakeRoot = new THREE.Group();

    for (const [path, placements] of placementsByPath.entries()) {
      const template = templateByPath.get(path);
      if (!template || placements.length === 0) {
        continue;
      }
      if (!template.userData.meshParts) {
        template.userData.meshParts = extractTemplateMeshParts(THREE, template);
      }
      const meshParts = template.userData.meshParts;
      if (!meshParts?.length) {
        continue;
      }

      const batchedMeshes = meshParts.map((part) => {
        const instanced = new THREE.InstancedMesh(
          part.geometry,
          part.material,
          placements.length,
        );
        instanced.castShadow = true;
        instanced.receiveShadow = true;
        instanced.frustumCulled = false;
        root.add(instanced);
        return instanced;
      });

      for (let i = 0; i < placements.length; i++) {
        const { anchor, choice } = placements[i];
        const baseSize = template.userData.baseSize || 1;
        const desiredSize = randomBetween(choice.desiredSizeMin, choice.desiredSizeMax);
        const uniformScale = desiredSize / baseSize;
        const jitter = cellSize * 0.28;
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
        const yaw = randomBetween(0, Math.PI * 2);

        position.set(x, 0, z);
        quaternion.setFromAxisAngle(upAxis, yaw);
        scale.setScalar(uniformScale);
        baseMatrix.compose(position, quaternion, scale);

        for (let partIndex = 0; partIndex < meshParts.length; partIndex++) {
          finalMatrix.multiplyMatrices(baseMatrix, meshParts[partIndex].matrix);
          batchedMeshes[partIndex].setMatrixAt(i, finalMatrix);

          const collisionMesh = new THREE.Mesh(meshParts[partIndex].geometry);
          collisionMesh.matrixAutoUpdate = false;
          collisionMesh.matrix.copy(finalMatrix);
          collisionBakeRoot.add(collisionMesh);
        }
      }

      for (const instanced of batchedMeshes) {
        instanced.instanceMatrix.needsUpdate = true;
        instanced.computeBoundingBox();
        instanced.computeBoundingSphere();
      }
    }

    if (collisionBakeRoot.children.length > 0) {
      collisionBakeRoot.updateMatrixWorld(true);
      const collisionGenerator = new StaticGeometryGenerator([collisionBakeRoot]);
      collisionGenerator.attributes = ["position"];
      const mergedCollisionGeometry = collisionGenerator.generate();
      mergedCollisionGeometry.boundsTree = new MeshBVH(mergedCollisionGeometry);
      if (collider.geometry?.boundsTree?.dispose) {
        collider.geometry.boundsTree.dispose();
      }
      if (collider.geometry) {
        collider.geometry.dispose();
      }
      collider.geometry = mergedCollisionGeometry;
    }
  }

  async function preloadAllTemplates() {
    const uniquePaths = [...new Set(PROP_LIBRARY.map((entry) => entry.path))];
    await Promise.all(
      uniquePaths.map((path) =>
        loadTemplate(path).catch((error) => {
          console.error(`Failed to preload prop template: ${path}`, error);
          return null;
        }),
      ),
    );
  }

  return {
    root,
    collider,
    regenerate,
    preloadAllTemplates,
    clear: clearRoot,
  };
}
