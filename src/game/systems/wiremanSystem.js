function makeCellKey(col, row) {
  return `${col},${row}`;
}

function heuristicManhattan(a, b) {
  return Math.abs(a.col - b.col) + Math.abs(a.row - b.row);
}

export function createWiremanSystem({
  THREE,
  GLTFLoader,
  scene,
  camera,
  world,
  config,
  constants,
}) {
  const {
    WIREMAN_MODEL_PATH,
    WIREMAN_WALK_SPEED,
    WIREMAN_SPRINT_MULTIPLIER,
    WIREMAN_REPATH_INTERVAL_SECONDS,
    WIREMAN_FOLLOW_STOP_DISTANCE,
    WIREMAN_WAYPOINT_REACHED_DISTANCE,
    WIREMAN_TARGET_SEARCH_RADIUS_CELLS,
    WIREMAN_ROTATE_SPEED,
    WIREMAN_VISUAL_YAW_OFFSET,
  } = constants;

  const modelLoader = new GLTFLoader();
  const wiremanRig = new THREE.Group();
  wiremanRig.name = "WiremanRig";
  wiremanRig.visible = false;
  scene.add(wiremanRig);

  const desiredTargetPosition = new THREE.Vector3();
  const waypointWorld = new THREE.Vector3();
  const movementDelta = new THREE.Vector3();
  const modelBounds = new THREE.Box3();
  const modelCenter = new THREE.Vector3();
  const modelSize = new THREE.Vector3();

  const NEIGHBOR_OFFSETS = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ];

  let wiremanModel = null;
  let wiremanMixer = null;
  let wiremanLoaded = false;
  let wiremanLoadFailed = false;
  let wiremanPathCells = [];
  let wiremanPathIndex = 0;
  let wiremanGoalCell = null;
  let wiremanGoalKey = "";
  let wiremanRepathRemaining = 0;
  let wiremanIsMoving = false;
  let wiremanIsSprinting = false;
  let wiremanHasLineOfSight = false;
  let wiremanDistanceToPlayer = 0;
  let wiremanDistanceToGoal = 0;
  let wiremanAnimationLabel = "idle";
  let currentAnimationAction = null;
  let currentAnimationRole = "";
  const actionByRole = {
    idle: null,
    walk: null,
    run: null,
    sprint: null,
    attack: null,
  };

  function normalizeWiremanModel(model) {
    model.position.set(0, 0, 0);
    model.rotation.set(0, 0, 0);
    model.scale.set(1, 1, 1);
    model.updateMatrixWorld(true);

    modelBounds.setFromObject(model);
    if (modelBounds.isEmpty()) {
      return;
    }
    modelBounds.getCenter(modelCenter);
    model.position.sub(modelCenter);
    model.updateMatrixWorld(true);

    modelBounds.setFromObject(model);
    modelBounds.getSize(modelSize);
    const sourceHeight = Math.max(modelSize.y, 0.001);
    const targetHeight = Math.max(config.PLAYER_HEIGHT * 1.75, 1.6);
    const scale = targetHeight / sourceHeight;
    model.scale.multiplyScalar(scale);
    model.updateMatrixWorld(true);

    modelBounds.setFromObject(model);
    if (!modelBounds.isEmpty()) {
      model.position.y -= modelBounds.min.y;
      model.position.y += 0.25 * (7 / 8)
    }
    model.updateMatrixWorld(true);
  }

  function findClipByKeyword(clips, keyword) {
    const lowered = keyword.toLowerCase();
    return clips.find((clip) => (clip.name || "").toLowerCase().includes(lowered)) || null;
  }

  function configureAnimations(animations) {
    if (!wiremanMixer || !Array.isArray(animations) || !animations.length) {
      return;
    }

    const firstClip = animations[0] || null;
    const idleClip = findClipByKeyword(animations, "idle") || firstClip;
    const walkClip = findClipByKeyword(animations, "walk") || idleClip || firstClip;
    const runClip = findClipByKeyword(animations, "run") || walkClip || idleClip || firstClip;
    const sprintClip = findClipByKeyword(animations, "sprint") || runClip || walkClip || firstClip;
    const attackClip = findClipByKeyword(animations, "attack") || firstClip;

    const roleClipPairs = [
      ["idle", idleClip],
      ["walk", walkClip],
      ["run", runClip],
      ["sprint", sprintClip],
      ["attack", attackClip],
    ];

    for (const [role, clip] of roleClipPairs) {
      if (!clip) {
        continue;
      }
      const action = wiremanMixer.clipAction(clip);
      action.loop = THREE.LoopRepeat;
      action.clampWhenFinished = false;
      action.enabled = true;
      actionByRole[role] = action;
    }
  }

  function setAnimation(role) {
    const nextAction =
      actionByRole[role] ||
      actionByRole.walk ||
      actionByRole.idle ||
      actionByRole.run ||
      actionByRole.sprint ||
      actionByRole.attack ||
      null;
    if (!nextAction) {
      return;
    }
    if (currentAnimationAction === nextAction) {
      wiremanAnimationLabel = role;
      currentAnimationRole = role;
      return;
    }

    if (currentAnimationAction) {
      currentAnimationAction.fadeOut(0.18);
    }
    nextAction.reset().fadeIn(0.18).play();
    currentAnimationAction = nextAction;
    currentAnimationRole = role;
    wiremanAnimationLabel = role;
  }

  function findNearestWalkableCell(targetCell, fallbackCell, radius = WIREMAN_TARGET_SEARCH_RADIUS_CELLS) {
    if (!targetCell) {
      return fallbackCell || null;
    }
    if (world.isWalkableCell(targetCell.col, targetCell.row)) {
      return { col: targetCell.col, row: targetCell.row };
    }

    let best = null;
    let bestCost = Number.POSITIVE_INFINITY;
    for (let dr = -radius; dr <= radius; dr += 1) {
      for (let dc = -radius; dc <= radius; dc += 1) {
        const col = targetCell.col + dc;
        const row = targetCell.row + dr;
        if (!world.isWalkableCell(col, row)) {
          continue;
        }
        const cost = Math.abs(dc) + Math.abs(dr);
        if (cost < bestCost) {
          best = { col, row };
          bestCost = cost;
        }
      }
    }
    if (best) {
      return best;
    }
    if (fallbackCell && world.isWalkableCell(fallbackCell.col, fallbackCell.row)) {
      return { col: fallbackCell.col, row: fallbackCell.row };
    }
    return null;
  }

  function findAStarPath(fromCellInput, toCellInput) {
    const fromCell = findNearestWalkableCell(fromCellInput, fromCellInput);
    const toCell = findNearestWalkableCell(toCellInput, fromCell);
    if (!fromCell || !toCell) {
      return [];
    }

    const startKey = makeCellKey(fromCell.col, fromCell.row);
    const goalKey = makeCellKey(toCell.col, toCell.row);
    if (startKey === goalKey) {
      return [{ col: fromCell.col, row: fromCell.row }];
    }

    const openNodes = [];
    const openNodeByKey = new Map();
    const cameFromByKey = new Map();
    const gScoreByKey = new Map([[startKey, 0]]);
    const fScoreByKey = new Map([[startKey, heuristicManhattan(fromCell, toCell)]]);
    const closedKeys = new Set();

    const startNode = {
      col: fromCell.col,
      row: fromCell.row,
      key: startKey,
      f: fScoreByKey.get(startKey),
    };
    openNodes.push(startNode);
    openNodeByKey.set(startKey, startNode);

    while (openNodes.length) {
      let currentIndex = 0;
      for (let i = 1; i < openNodes.length; i += 1) {
        if (openNodes[i].f < openNodes[currentIndex].f) {
          currentIndex = i;
        }
      }

      const current = openNodes.splice(currentIndex, 1)[0];
      openNodeByKey.delete(current.key);
      if (current.key === goalKey) {
        const path = [];
        let key = goalKey;
        while (key) {
          const [colText, rowText] = key.split(",");
          path.push({ col: Number(colText), row: Number(rowText) });
          key = cameFromByKey.get(key) || "";
        }
        path.reverse();
        return path;
      }

      closedKeys.add(current.key);
      const currentG = gScoreByKey.get(current.key) ?? Number.POSITIVE_INFINITY;
      for (const [dc, dr] of NEIGHBOR_OFFSETS) {
        const nextCol = current.col + dc;
        const nextRow = current.row + dr;
        if (!world.isWalkableCell(nextCol, nextRow)) {
          continue;
        }
        const nextKey = makeCellKey(nextCol, nextRow);
        if (closedKeys.has(nextKey)) {
          continue;
        }

        const tentativeG = currentG + 1;
        if (tentativeG >= (gScoreByKey.get(nextKey) ?? Number.POSITIVE_INFINITY)) {
          continue;
        }

        cameFromByKey.set(nextKey, current.key);
        gScoreByKey.set(nextKey, tentativeG);
        const h = heuristicManhattan({ col: nextCol, row: nextRow }, toCell);
        const f = tentativeG + h;
        fScoreByKey.set(nextKey, f);
        const existing = openNodeByKey.get(nextKey);
        if (existing) {
          existing.f = f;
        } else {
          const node = { col: nextCol, row: nextRow, key: nextKey, f };
          openNodes.push(node);
          openNodeByKey.set(nextKey, node);
        }
      }
    }

    return [{ col: fromCell.col, row: fromCell.row }];
  }

  function chooseSpawnCell() {
    const exitCell = world.getExitCell?.();
    if (exitCell && world.isWalkableCell(exitCell.col, exitCell.row)) {
      return { col: exitCell.col, row: exitCell.row };
    }

    const startCell = world.getStartCell?.() || { col: 1, row: 1 };
    if (world.isWalkableCell(startCell.col, startCell.row)) {
      return { col: startCell.col, row: startCell.row };
    }

    const maze = world.getMaze?.() || [];
    for (let row = 0; row < maze.length; row += 1) {
      for (let col = 0; col < (maze[row]?.length || 0); col += 1) {
        if (world.isWalkableCell(col, row)) {
          return { col, row };
        }
      }
    }
    return { col: 1, row: 1 };
  }

  function hasDirectLineOfSight(fromX, fromZ, toX, toZ) {
    const fromCell = world.worldToCell(fromX, fromZ);
    const toCell = world.worldToCell(toX, toZ);
    if (!world.isWalkableCell(fromCell.col, fromCell.row) || !world.isWalkableCell(toCell.col, toCell.row)) {
      return false;
    }

    const deltaX = toX - fromX;
    const deltaZ = toZ - fromZ;
    const distance = Math.hypot(deltaX, deltaZ);
    if (distance <= 0.0001) {
      return true;
    }

    const sampleSpacing = Math.max(0.15, config.CELL_SIZE * 0.2);
    const sampleCount = Math.max(1, Math.ceil(distance / sampleSpacing));
    for (let sampleIndex = 1; sampleIndex < sampleCount; sampleIndex += 1) {
      const t = sampleIndex / sampleCount;
      const sampleCell = world.worldToCell(
        fromX + deltaX * t,
        fromZ + deltaZ * t,
      );
      if (!world.isWalkableCell(sampleCell.col, sampleCell.row)) {
        return false;
      }
    }
    return true;
  }

  function resetPathing() {
    wiremanPathCells = [];
    wiremanPathIndex = 0;
    wiremanGoalCell = null;
    wiremanGoalKey = "";
    wiremanRepathRemaining = 0;
    wiremanDistanceToGoal = 0;
  }

  function onMazeRegenerated() {
    resetPathing();
    if (!wiremanModel) {
      return;
    }
    const spawnCell = chooseSpawnCell();
    const spawnWorld = world.cellToWorld(spawnCell.col, spawnCell.row);
    wiremanRig.position.set(spawnWorld.x, 0, spawnWorld.z);
    wiremanRig.rotation.set(0, 0, 0);
    wiremanRig.visible = true;
    wiremanIsMoving = false;
    wiremanIsSprinting = false;
    wiremanHasLineOfSight = false;
    wiremanDistanceToPlayer = 0;
    setAnimation("idle");
  }

  function loadWireman() {
    modelLoader.load(
      WIREMAN_MODEL_PATH,
      (gltf) => {
        const model = gltf?.scene;
        if (!model) {
          wiremanLoadFailed = true;
          return;
        }
        model.traverse((obj) => {
          if (!obj.isMesh) {
            return;
          }
          obj.castShadow = true;
          obj.receiveShadow = true;
          obj.material.transparent = false;
        });
        normalizeWiremanModel(model);

        wiremanRig.clear();
        wiremanRig.add(model);
        wiremanModel = model;
        wiremanMixer = new THREE.AnimationMixer(model);
        configureAnimations(gltf.animations || []);
        wiremanModel.rotation.y = WIREMAN_VISUAL_YAW_OFFSET;
        wiremanLoaded = true;
        wiremanLoadFailed = false;
        onMazeRegenerated();
      },
      undefined,
      () => {
        wiremanLoadFailed = true;
      },
    );
  }

  function update(deltaSeconds, { gameActive, hasWon } = {}) {
    const dt = Math.max(0, Number(deltaSeconds) || 0);
    if (wiremanMixer) {
      wiremanMixer.update(dt);
    }
    if (!wiremanLoaded || !wiremanModel) {
      return;
    }

    if (!gameActive || hasWon) {
      wiremanIsMoving = false;
      wiremanIsSprinting = false;
      wiremanHasLineOfSight = false;
      setAnimation("idle");
      return;
    }

    desiredTargetPosition.set(camera.position.x, 0, camera.position.z);

    const wiremanCellRaw = world.worldToCell(wiremanRig.position.x, wiremanRig.position.z);
    const wiremanCell = findNearestWalkableCell(wiremanCellRaw, world.getStartCell?.());
    if (!wiremanCell) {
      wiremanIsMoving = false;
      wiremanIsSprinting = false;
      wiremanHasLineOfSight = false;
      setAnimation("idle");
      return;
    }

    const goalCellRaw = world.worldToCell(desiredTargetPosition.x, desiredTargetPosition.z);
    const goalCell = findNearestWalkableCell(goalCellRaw, wiremanCell);
    if (!goalCell) {
      wiremanIsMoving = false;
      wiremanIsSprinting = false;
      wiremanHasLineOfSight = false;
      setAnimation("idle");
      return;
    }

    wiremanGoalCell = goalCell;
    wiremanDistanceToPlayer = Math.hypot(
      wiremanRig.position.x - camera.position.x,
      wiremanRig.position.z - camera.position.z,
    );
    wiremanDistanceToGoal = Math.hypot(
      wiremanRig.position.x - desiredTargetPosition.x,
      wiremanRig.position.z - desiredTargetPosition.z,
    );
    wiremanHasLineOfSight = hasDirectLineOfSight(
      wiremanRig.position.x,
      wiremanRig.position.z,
      desiredTargetPosition.x,
      desiredTargetPosition.z,
    );
    if (wiremanDistanceToGoal <= WIREMAN_FOLLOW_STOP_DISTANCE) {
      wiremanIsMoving = false;
      wiremanIsSprinting = false;
      setAnimation("idle");
      return;
    }

    let distanceToMovementTarget = 0;
    if (wiremanHasLineOfSight) {
      movementDelta.set(
        desiredTargetPosition.x - wiremanRig.position.x,
        0,
        desiredTargetPosition.z - wiremanRig.position.z,
      );
      distanceToMovementTarget = movementDelta.length();
      if (distanceToMovementTarget <= 0.0001) {
        wiremanIsMoving = false;
        wiremanIsSprinting = false;
        setAnimation("idle");
        return;
      }
    } else {
      const goalKey = makeCellKey(goalCell.col, goalCell.row);
      wiremanRepathRemaining -= dt;
      if (
        wiremanRepathRemaining <= 0 ||
        !wiremanPathCells.length ||
        wiremanPathIndex >= wiremanPathCells.length ||
        goalKey !== wiremanGoalKey
      ) {
        wiremanPathCells = findAStarPath(wiremanCell, goalCell);
        wiremanPathIndex = wiremanPathCells.length > 1 ? 1 : 0;
        wiremanGoalKey = goalKey;
        wiremanRepathRemaining = WIREMAN_REPATH_INTERVAL_SECONDS;
      }

      if (!wiremanPathCells.length || wiremanPathIndex >= wiremanPathCells.length) {
        wiremanIsMoving = false;
        wiremanIsSprinting = false;
        setAnimation("idle");
        return;
      }

      let waypointCell = wiremanPathCells[wiremanPathIndex];
      if (!waypointCell) {
        wiremanIsMoving = false;
        wiremanIsSprinting = false;
        setAnimation("idle");
        return;
      }

      let guard = 0;
      while (guard < 4) {
        const waypointPosition = world.cellToWorld(waypointCell.col, waypointCell.row);
        movementDelta.set(
          waypointPosition.x - wiremanRig.position.x,
          0,
          waypointPosition.z - wiremanRig.position.z,
        );
        const waypointDistance = movementDelta.length();
        if (
          waypointDistance <= WIREMAN_WAYPOINT_REACHED_DISTANCE &&
          wiremanPathIndex < wiremanPathCells.length - 1
        ) {
          wiremanPathIndex += 1;
          waypointCell = wiremanPathCells[wiremanPathIndex];
          guard += 1;
          continue;
        }
        break;
      }

      const finalWaypoint = world.cellToWorld(waypointCell.col, waypointCell.row);
      waypointWorld.set(finalWaypoint.x, 0, finalWaypoint.z);
      movementDelta.subVectors(waypointWorld, wiremanRig.position);
      distanceToMovementTarget = movementDelta.length();
      if (distanceToMovementTarget <= 0.0001) {
        wiremanIsMoving = false;
        wiremanIsSprinting = false;
        setAnimation("idle");
        return;
      }
    }

    movementDelta.normalize();
    const speedMultiplier = wiremanHasLineOfSight ? WIREMAN_SPRINT_MULTIPLIER : 1;
    const maxStep = WIREMAN_WALK_SPEED * speedMultiplier * dt;
    const step = Math.min(maxStep, distanceToMovementTarget);
    wiremanRig.position.addScaledVector(movementDelta, step);

    const targetYaw = Math.atan2(movementDelta.x, movementDelta.z);
    let yawDelta = targetYaw - wiremanRig.rotation.y;
    while (yawDelta > Math.PI) yawDelta -= Math.PI * 2;
    while (yawDelta < -Math.PI) yawDelta += Math.PI * 2;
    const maxYawStep = WIREMAN_ROTATE_SPEED * dt;
    const appliedYaw = THREE.MathUtils.clamp(yawDelta, -maxYawStep, maxYawStep);
    wiremanRig.rotation.y += appliedYaw;

    wiremanIsMoving = step > 0.0001;
    wiremanIsSprinting = wiremanIsMoving && wiremanHasLineOfSight;
    setAnimation(wiremanIsMoving ? (wiremanIsSprinting ? "sprint" : "walk") : "idle");
  }

  function getState() {
    if (!wiremanLoaded || !wiremanModel) {
      return {
        loaded: false,
        loadFailed: wiremanLoadFailed,
        moving: false,
        sprinting: false,
        lineOfSightToPlayer: false,
        animation: wiremanAnimationLabel,
        pathLength: 0,
        pathIndex: 0,
      };
    }

    const cell = world.worldToCell(wiremanRig.position.x, wiremanRig.position.z);
    return {
      loaded: true,
      loadFailed: wiremanLoadFailed,
      moving: wiremanIsMoving,
      sprinting: wiremanIsSprinting,
      lineOfSightToPlayer: wiremanHasLineOfSight,
      animation: currentAnimationRole || wiremanAnimationLabel,
      position: {
        x: wiremanRig.position.x,
        y: wiremanRig.position.y,
        z: wiremanRig.position.z,
      },
      cell,
      pathLength: wiremanPathCells.length,
      pathIndex: wiremanPathIndex,
      goalCell: wiremanGoalCell ? { ...wiremanGoalCell } : null,
      distanceToPlayer: wiremanDistanceToPlayer,
      distanceToGoal: wiremanDistanceToGoal,
    };
  }

  loadWireman();

  return {
    update,
    onMazeRegenerated,
    getState,
    isLoaded: () => wiremanLoaded,
  };
}
