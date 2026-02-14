export function createWorldSystem({
  THREE,
  MeshBVH,
  scene,
  camera,
  constants,
  floorMaterial,
  wallMaterial,
  roofMaterial,
  worldHalfWidth,
  worldHalfDepth,
  worldWidth,
  worldDepth,
  propScatter,
  pickupSystem,
  generateMaze,
  findFarthestOpenCell,
  findPath,
  buildWallSurfaceGeometry,
  buildWalkableVisibilityMap,
}) {
  const {
    MAZE_COLS,
    MAZE_ROWS,
    CELL_SIZE,
    WALL_HEIGHT,
    PLAYER_HEIGHT,
    PLAYER_RADIUS,
    collisionOffsets,
  } = constants;

  let maze = [];
  let wallMesh = null;
  let roofMesh = null;
  let floorMesh = null;
  let exitMarker = null;
  let startCell = { col: 1, row: 1 };
  let exitCell = { col: MAZE_COLS - 2, row: MAZE_ROWS - 2 };
  let visibilityMap = {
    walkableCells: [],
    cellByKey: new Map(),
    visibleCellsByKey: new Map(),
    visibleCellKeySetByKey: new Map(),
  };

  const worldCollisionCapsule = new THREE.Line3(new THREE.Vector3(), new THREE.Vector3());
  const worldCollisionBounds = new THREE.Box3();
  const worldCollisionInverseMatrix = new THREE.Matrix4();
  const worldCollisionTriPoint = new THREE.Vector3();
  const worldCollisionCapsulePoint = new THREE.Vector3();
  const worldCollisionDelta = new THREE.Vector3();
  const worldCollisionNormal = new THREE.Vector3();
  const worldCollisionResolved = new THREE.Vector3();
  const worldCollisionWorldPoint = new THREE.Vector3();

  function buildMeshBVH(mesh) {
    if (!mesh?.geometry) return;
    if (mesh.geometry.boundsTree?.dispose) {
      mesh.geometry.boundsTree.dispose();
    }
    mesh.geometry.boundsTree = new MeshBVH(mesh.geometry);
  }

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

  function regenerateMaze() {
    maze = generateMaze(MAZE_COLS, MAZE_ROWS);
    startCell = { col: 1, row: 1 };
    exitCell = findFarthestOpenCell(startCell, isWalkableCell);
    visibilityMap = buildWalkableVisibilityMap({
      maze,
      cols: MAZE_COLS,
      rows: MAZE_ROWS,
      isWalkableCell,
    });

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

  function resolveWorldCollision(x, z, options = {}) {
    const includeWalls = options.includeWalls !== false;
    const includeProps = options.includeProps !== false;
    const heightOffset = Math.max(0, Number(options.heightOffset) || 0);
    const capsuleCenterY = PLAYER_HEIGHT + heightOffset;
    worldCollisionResolved.set(x, capsuleCenterY, z);
    const radius = Math.max(0.001, Number(options.collisionRadius) || PLAYER_RADIUS);
    const capsuleTopY = capsuleCenterY - radius;
    const capsuleBottomY = radius + heightOffset;
    const colliders = [];
    if (includeWalls) {
      colliders.push(wallMesh);
    }
    if (includeProps) {
      colliders.push(propScatter.collider);
    }
    const activeColliders = colliders.filter((collider) => collider?.geometry?.boundsTree);
    if (!activeColliders.length) {
      return worldCollisionResolved;
    }

    for (let iteration = 0; iteration < 2; iteration++) {
      let moved = false;

      for (const collider of activeColliders) {
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
            worldCollisionDelta.subVectors(worldCollisionCapsulePoint, worldCollisionTriPoint);
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

    worldCollisionResolved.y = capsuleCenterY;
    return worldCollisionResolved;
  }

  function getMaze() {
    return maze;
  }

  function getStartCell() {
    return startCell;
  }

  function getExitCell() {
    return exitCell;
  }

  function getWallMesh() {
    return wallMesh;
  }

  function getVisibilityMap() {
    return visibilityMap;
  }

  function getVisibleCellsForCell(col, row) {
    const key = `${col},${row}`;
    return visibilityMap.visibleCellsByKey.get(key) || [];
  }

  function areCellsVisible(fromCol, fromRow, toCol, toRow) {
    const sourceKey = `${fromCol},${fromRow}`;
    const targetKey = `${toCol},${toRow}`;
    const visibleSet = visibilityMap.visibleCellKeySetByKey.get(sourceKey);
    return visibleSet ? visibleSet.has(targetKey) : false;
  }

  function getFloorMesh() {
    return floorMesh;
  }

  function getRoofMesh() {
    return roofMesh;
  }

  function getExitMarker() {
    return exitMarker;
  }

  return {
    createFloorAndCeiling,
    rebuildExitMarker,
    regenerateMaze,
    isWalkableCell,
    cellToWorld,
    worldToCell,
    canOccupy,
    resolveWorldCollision,
    resetPlayerToStart,
    getMaze,
    getStartCell,
    getExitCell,
    getWallMesh,
    getVisibilityMap,
    getVisibleCellsForCell,
    areCellsVisible,
    getFloorMesh,
    getRoofMesh,
    getExitMarker,
  };
}
