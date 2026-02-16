function makeCellKey(col, row) {
  return `${col},${row}`;
}

function heuristicManhattan(a, b) {
  return Math.abs(a.col - b.col) + Math.abs(a.row - b.row);
}

function cloneCell(cell) {
  if (!cell) {
    return null;
  }
  return { col: cell.col, row: cell.row };
}

export function createWiremanSystem({
  THREE,
  GLTFLoader,
  scene,
  camera,
  world,
  config,
  constants,
  applyPlayerDamage,
  playWiremanAttackSound,
}) {
  const {
    WIREMAN_MODEL_PATH,
    WIREMAN_WALK_SPEED,
    WIREMAN_SPRINT_MULTIPLIER,
    WIREMAN_REPATH_INTERVAL_SECONDS,
    WIREMAN_FOLLOW_STOP_DISTANCE,
    WIREMAN_WAYPOINT_REACHED_DISTANCE,
    WIREMAN_TARGET_SEARCH_RADIUS_CELLS,
    WIREMAN_COLLISION_RADIUS,
    WIREMAN_CLOSE_DETECTION_DISTANCE,
    WIREMAN_MAX_HEALTH,
    WIREMAN_ATTACK_START_RANGE,
    WIREMAN_ATTACK_RANGE,
    WIREMAN_ATTACK_DAMAGE,
    WIREMAN_ATTACK_COOLDOWN_SECONDS,
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
  const wiremanCapsuleSegmentStart = new THREE.Vector3();
  const wiremanCapsuleSegmentEnd = new THREE.Vector3();
  const wiremanRayOrigin = new THREE.Vector3();
  const wiremanRayDirection = new THREE.Vector3();
  const wiremanRayClosestPoint = new THREE.Vector3();
  const wiremanCapsuleClosestPoint = new THREE.Vector3();
  const wiremanRayOffset = new THREE.Vector3();
  const wiremanRayHitPoint = new THREE.Vector3();
  const wiremanCapsuleRay = new THREE.Ray();

  const NEIGHBOR_OFFSETS = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ];
  const BELIEF_NEGATIVE_EVIDENCE_EPSILON = 1e-3;
  const BELIEF_MIN_TOTAL = 1e-9;
  const VIEWPOINT_UTILITY_PATH_BIAS = 1;
  const VIEWPOINT_STAY_PENALTY = 0.85;
  const ATTACK_ARC_RADIANS = Math.PI * 0.5;
  const ATTACK_HALF_ARC_COSINE = Math.cos(ATTACK_ARC_RADIANS * 0.5);
  const ATTACK_START_ALIGNMENT_RADIANS = Math.PI / 18;
  const ATTACK_ANIMATION_SPEED_MULTIPLIER = 2;
  const MIN_ATTACK_DURATION_SECONDS = 0.35;

  let wiremanModel = null;
  let wiremanMixer = null;
  let wiremanLoaded = false;
  let wiremanLoadFailed = false;
  let wiremanPathCells = [];
  let wiremanPathIndex = 0;
  let wiremanGoalCell = null;
  let wiremanGoalKey = "";
  let wiremanRepathRemaining = 0;
  let wiremanAttackCooldownRemaining = 0;
  let wiremanAttackActive = false;
  let wiremanAttackElapsed = 0;
  let wiremanAttackDuration = 0;
  let wiremanAttackHitMomentSeconds = 0;
  let wiremanAttackHitApplied = false;
  let wiremanHealth = WIREMAN_MAX_HEALTH;
  let wiremanDead = false;
  let wiremanIsMoving = false;
  let wiremanIsSprinting = false;
  let wiremanHasLineOfSight = false;
  let wiremanDistanceToPlayer = 0;
  let wiremanDistanceToGoal = 0;
  let wiremanAnimationLabel = "idle";
  let wiremanHuntMode = "investigate";
  let wiremanHuntTargetCell = null;
  let wiremanHuntTargetKey = "";
  let wiremanMostLikelyPlayerCell = null;
  let wiremanMostLikelyPlayerProbability = 0;
  const wiremanBeliefByKey = new Map();
  const wiremanNeighborKeysByCellKey = new Map();
  let wiremanWalkableBeliefCells = [];
  let currentAnimationAction = null;
  let currentAnimationRole = "";
  const actionByRole = {
    idle: null,
    walk: null,
    run: null,
    sprint: null,
    attack: null,
    death: null,
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
    const deathClip = findClipByKeyword(animations, "death") || null;

    const roleClipPairs = [
      ["idle", idleClip],
      ["walk", walkClip],
      ["run", runClip],
      ["sprint", sprintClip],
      ["attack", attackClip],
      ["death", deathClip],
    ];

    for (const [role, clip] of roleClipPairs) {
      if (!clip) {
        continue;
      }
      const action = wiremanMixer.clipAction(clip);
      if (role === "attack" || role === "death") {
        action.loop = THREE.LoopOnce;
        action.clampWhenFinished = true;
        action.timeScale = role === "attack" ? ATTACK_ANIMATION_SPEED_MULTIPLIER : 1;
      } else {
        action.loop = THREE.LoopRepeat;
        action.clampWhenFinished = false;
        action.timeScale = 1;
      }
      action.enabled = true;
      actionByRole[role] = action;
    }
  }

  function setAnimation(role) {
    const isDeathRole = role === "death";
    const nextAction =
      (isDeathRole
        ? actionByRole.death ||
          actionByRole.idle ||
          actionByRole.walk ||
          actionByRole.run ||
          actionByRole.sprint ||
          actionByRole.attack
        : actionByRole[role] ||
          actionByRole.walk ||
          actionByRole.idle ||
          actionByRole.run ||
          actionByRole.sprint ||
          actionByRole.attack ||
          actionByRole.death) ||
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

  function isWiremanObject(object) {
    let current = object;
    while (current) {
      if (current === wiremanRig) {
        return true;
      }
      current = current.parent;
    }
    return false;
  }

  function getWiremanCapsuleSegmentWorld(outStart, outEnd, radius = WIREMAN_COLLISION_RADIUS) {
    const capsuleRadius = Math.max(0.001, Number(radius) || 0.001);
    outStart.set(
      wiremanRig.position.x,
      config.PLAYER_HEIGHT - capsuleRadius,
      wiremanRig.position.z,
    );
    outEnd.set(
      wiremanRig.position.x,
      capsuleRadius,
      wiremanRig.position.z,
    );
  }

  function resetHealthState() {
    wiremanHealth = WIREMAN_MAX_HEALTH;
    wiremanDead = false;
  }

  function enterDeathState() {
    if (wiremanDead) {
      return;
    }
    wiremanDead = true;
    wiremanHealth = 0;
    resetAttackState({ resetCooldown: true });
    wiremanPathCells = [];
    wiremanPathIndex = 0;
    wiremanGoalCell = null;
    wiremanGoalKey = "";
    wiremanRepathRemaining = 0;
    wiremanDistanceToGoal = 0;
    wiremanHuntMode = "dead";
    resetHuntTarget();
    wiremanMostLikelyPlayerCell = null;
    wiremanMostLikelyPlayerProbability = 0;
    wiremanHasLineOfSight = false;
    wiremanIsMoving = false;
    wiremanIsSprinting = false;
    setAnimation("death");
  }

  function getRaycastTarget() {
    if (!wiremanLoaded || !wiremanModel || !wiremanRig.visible || wiremanDead) {
      return null;
    }
    return wiremanRig;
  }

  function raycastCapsule({ origin, direction, maxDistance = Infinity } = {}) {
    if (!wiremanLoaded || !wiremanModel || !wiremanRig.visible || wiremanDead) {
      return null;
    }
    if (!origin || !direction) {
      return null;
    }

    wiremanRayOrigin.set(
      Number(origin.x) || 0,
      Number(origin.y) || 0,
      Number(origin.z) || 0,
    );
    wiremanRayDirection.set(
      Number(direction.x) || 0,
      Number(direction.y) || 0,
      Number(direction.z) || 0,
    );
    if (wiremanRayDirection.lengthSq() <= 1e-10) {
      return null;
    }
    wiremanRayDirection.normalize();

    const wiremanRadius = Math.max(0.001, Number(WIREMAN_COLLISION_RADIUS) || 0.001);
    getWiremanCapsuleSegmentWorld(wiremanCapsuleSegmentStart, wiremanCapsuleSegmentEnd, wiremanRadius);

    const resolvedMaxDistance =
      maxDistance === Infinity ? Infinity : Math.max(0, Number(maxDistance) || 0);
    wiremanCapsuleRay.set(wiremanRayOrigin, wiremanRayDirection);
    const distanceSq = wiremanCapsuleRay.distanceSqToSegment(
      wiremanCapsuleSegmentStart,
      wiremanCapsuleSegmentEnd,
      wiremanRayClosestPoint,
      wiremanCapsuleClosestPoint,
    );
    if (distanceSq > wiremanRadius * wiremanRadius) {
      return null;
    }

    wiremanRayOffset.subVectors(wiremanRayClosestPoint, wiremanRayOrigin);
    const closestDistanceAlongRay = wiremanRayOffset.dot(wiremanRayDirection);
    if (closestDistanceAlongRay < -0.0001) {
      return null;
    }

    const surfaceInset = Math.sqrt(Math.max(0, wiremanRadius * wiremanRadius - distanceSq));
    const hitDistance = Math.max(0, closestDistanceAlongRay - surfaceInset);
    if (hitDistance > resolvedMaxDistance + 0.0001) {
      return null;
    }

    wiremanRayHitPoint.copy(wiremanRayDirection).multiplyScalar(hitDistance).add(wiremanRayOrigin);
    return {
      distance: hitDistance,
      point: {
        x: wiremanRayHitPoint.x,
        y: wiremanRayHitPoint.y,
        z: wiremanRayHitPoint.z,
      },
    };
  }

  function isHitObject(object) {
    if (!object || wiremanDead) {
      return false;
    }
    return isWiremanObject(object);
  }

  function applyDamage(amount, sourceLabel = "unknown") {
    const damageAmount = Math.max(0, Number(amount) || 0);
    if (
      !wiremanLoaded ||
      !wiremanModel ||
      !wiremanRig.visible ||
      wiremanDead ||
      damageAmount <= 0
    ) {
      return {
        applied: false,
        damageApplied: 0,
        source: sourceLabel,
        health: wiremanHealth,
        maxHealth: WIREMAN_MAX_HEALTH,
        dead: wiremanDead,
        diedNow: false,
      };
    }

    const previousHealth = wiremanHealth;
    wiremanHealth = Math.max(0, wiremanHealth - damageAmount);
    const damageApplied = Math.max(0, previousHealth - wiremanHealth);
    let diedNow = false;
    if (wiremanHealth <= 0 && !wiremanDead) {
      diedNow = true;
      enterDeathState();
    }

    return {
      applied: damageApplied > 0,
      damageApplied,
      source: sourceLabel,
      health: wiremanHealth,
      maxHealth: WIREMAN_MAX_HEALTH,
      dead: wiremanDead,
      diedNow,
    };
  }

  function getAttackAnimationDurationSeconds() {
    const clipDuration = actionByRole.attack?.getClip?.()?.duration;
    const effectiveAttackSpeed = Math.max(0.0001, ATTACK_ANIMATION_SPEED_MULTIPLIER);
    const minimumDuration = MIN_ATTACK_DURATION_SECONDS / effectiveAttackSpeed;
    if (!Number.isFinite(clipDuration) || clipDuration <= 0) {
      return minimumDuration;
    }
    return Math.max(minimumDuration, clipDuration / effectiveAttackSpeed);
  }

  function resetAttackState({ resetCooldown = false } = {}) {
    wiremanAttackActive = false;
    wiremanAttackElapsed = 0;
    wiremanAttackDuration = 0;
    wiremanAttackHitMomentSeconds = 0;
    wiremanAttackHitApplied = false;
    if (resetCooldown) {
      wiremanAttackCooldownRemaining = 0;
    }
  }

  function startAttackCommit() {
    wiremanAttackActive = true;
    wiremanAttackElapsed = 0;
    wiremanAttackDuration = getAttackAnimationDurationSeconds();
    wiremanAttackHitMomentSeconds = wiremanAttackDuration * 0.5;
    wiremanAttackHitApplied = false;
    playWiremanAttackSound?.();
    wiremanAttackCooldownRemaining = Math.max(
      wiremanAttackCooldownRemaining,
      WIREMAN_ATTACK_COOLDOWN_SECONDS,
    );
  }

  function isTargetWithinAttackArc(targetX, targetZ) {
    const deltaX = targetX - wiremanRig.position.x;
    const deltaZ = targetZ - wiremanRig.position.z;
    const distance = Math.hypot(deltaX, deltaZ);
    if (distance <= 0.0001) {
      return true;
    }

    const facingX = Math.sin(wiremanRig.rotation.y);
    const facingZ = Math.cos(wiremanRig.rotation.y);
    const normalizedX = deltaX / distance;
    const normalizedZ = deltaZ / distance;
    const forwardDot = normalizedX * facingX + normalizedZ * facingZ;
    return forwardDot >= ATTACK_HALF_ARC_COSINE;
  }

  function getVerticalSegmentGap(aMin, aMax, bMin, bMax) {
    if (aMax < bMin) {
      return bMin - aMax;
    }
    if (bMax < aMin) {
      return aMin - bMax;
    }
    return 0;
  }

  function resolvePlayerCapsuleCollision({
    playerX,
    playerZ,
    playerRadius = config.PLAYER_RADIUS,
    playerHeightOffset = 0,
  } = {}) {
    if (!wiremanLoaded || !wiremanModel || !wiremanRig.visible || wiremanDead) {
      return { x: playerX, z: playerZ, colliding: false };
    }
    const safePlayerRadius = Math.max(0.001, Number(playerRadius) || config.PLAYER_RADIUS || 0.001);
    const safePlayerHeightOffset = Math.max(0, Number(playerHeightOffset) || 0);
    const wiremanRadius = Math.max(0.001, Number(WIREMAN_COLLISION_RADIUS) || 0.001);
    const combinedRadius = safePlayerRadius + wiremanRadius;
    if (!Number.isFinite(playerX) || !Number.isFinite(playerZ) || combinedRadius <= 0.0001) {
      return { x: playerX, z: playerZ, colliding: false };
    }

    const playerCapsuleTopY = config.PLAYER_HEIGHT + safePlayerHeightOffset - safePlayerRadius;
    const playerCapsuleBottomY = safePlayerRadius + safePlayerHeightOffset;
    getWiremanCapsuleSegmentWorld(wiremanCapsuleSegmentStart, wiremanCapsuleSegmentEnd, wiremanRadius);
    const wiremanCapsuleTopY = wiremanCapsuleSegmentStart.y;
    const wiremanCapsuleBottomY = wiremanCapsuleSegmentEnd.y;
    const playerMinY = Math.min(playerCapsuleTopY, playerCapsuleBottomY);
    const playerMaxY = Math.max(playerCapsuleTopY, playerCapsuleBottomY);
    const wiremanMinY = Math.min(wiremanCapsuleTopY, wiremanCapsuleBottomY);
    const wiremanMaxY = Math.max(wiremanCapsuleTopY, wiremanCapsuleBottomY);
    const verticalGap = getVerticalSegmentGap(playerMinY, playerMaxY, wiremanMinY, wiremanMaxY);
    if (verticalGap >= combinedRadius) {
      return { x: playerX, z: playerZ, colliding: false };
    }

    const horizontalTargetDistance = Math.sqrt(
      Math.max(0, combinedRadius * combinedRadius - verticalGap * verticalGap),
    );
    if (horizontalTargetDistance <= 0.0001) {
      return { x: playerX, z: playerZ, colliding: false };
    }

    let deltaX = playerX - wiremanRig.position.x;
    let deltaZ = playerZ - wiremanRig.position.z;
    const horizontalDistance = Math.hypot(deltaX, deltaZ);
    if (horizontalDistance >= horizontalTargetDistance) {
      return { x: playerX, z: playerZ, colliding: false };
    }

    let normalX = 1;
    let normalZ = 0;
    if (horizontalDistance > 0.0001) {
      normalX = deltaX / horizontalDistance;
      normalZ = deltaZ / horizontalDistance;
    } else {
      normalX = Math.sin(wiremanRig.rotation.y);
      normalZ = Math.cos(wiremanRig.rotation.y);
      const normalLength = Math.hypot(normalX, normalZ);
      if (normalLength > 0.0001) {
        normalX /= normalLength;
        normalZ /= normalLength;
      } else {
        normalX = 1;
        normalZ = 0;
      }
    }

    const overlap = horizontalTargetDistance - horizontalDistance;
    const pushPlayerDistance = overlap * 0.5;
    const pushWiremanDistance = overlap - pushPlayerDistance;
    let resolvedPlayerX = playerX + normalX * pushPlayerDistance;
    let resolvedPlayerZ = playerZ + normalZ * pushPlayerDistance;
    let resolvedWiremanX = wiremanRig.position.x - normalX * pushWiremanDistance;
    let resolvedWiremanZ = wiremanRig.position.z - normalZ * pushWiremanDistance;

    if (typeof world.resolveWorldCollision === "function") {
      const worldResolvedPlayer = world.resolveWorldCollision(resolvedPlayerX, resolvedPlayerZ, {
        heightOffset: safePlayerHeightOffset,
        collisionRadius: safePlayerRadius,
      });
      resolvedPlayerX = worldResolvedPlayer.x;
      resolvedPlayerZ = worldResolvedPlayer.z;

      const worldResolvedWireman = world.resolveWorldCollision(resolvedWiremanX, resolvedWiremanZ, {
        includeProps: false,
        collisionRadius: wiremanRadius,
      });
      resolvedWiremanX = worldResolvedWireman.x;
      resolvedWiremanZ = worldResolvedWireman.z;
    }

    wiremanRig.position.x = resolvedWiremanX;
    wiremanRig.position.z = resolvedWiremanZ;

    deltaX = resolvedPlayerX - wiremanRig.position.x;
    deltaZ = resolvedPlayerZ - wiremanRig.position.z;
    const finalHorizontalDistance = Math.hypot(deltaX, deltaZ);
    if (finalHorizontalDistance < horizontalTargetDistance) {
      const finalOverlap = horizontalTargetDistance - finalHorizontalDistance;
      if (finalHorizontalDistance > 0.0001) {
        normalX = deltaX / finalHorizontalDistance;
        normalZ = deltaZ / finalHorizontalDistance;
      }
      resolvedPlayerX += normalX * finalOverlap;
      resolvedPlayerZ += normalZ * finalOverlap;
      if (typeof world.resolveWorldCollision === "function") {
        const finalWorldResolvedPlayer = world.resolveWorldCollision(resolvedPlayerX, resolvedPlayerZ, {
          heightOffset: safePlayerHeightOffset,
          collisionRadius: safePlayerRadius,
        });
        resolvedPlayerX = finalWorldResolvedPlayer.x;
        resolvedPlayerZ = finalWorldResolvedPlayer.z;
      }
    }

    wiremanDistanceToPlayer = Math.hypot(
      wiremanRig.position.x - resolvedPlayerX,
      wiremanRig.position.z - resolvedPlayerZ,
    );
    return { x: resolvedPlayerX, z: resolvedPlayerZ, colliding: true };
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

  function computeSingleSourcePathCosts(fromCellInput) {
    const fromCell = findNearestWalkableCell(fromCellInput, fromCellInput);
    if (!fromCell) {
      return {
        fromCell: null,
        fromKey: "",
        costByKey: new Map(),
      };
    }

    const fromKey = makeCellKey(fromCell.col, fromCell.row);
    const costByKey = new Map([[fromKey, 0]]);
    const keyQueue = [fromKey];
    let queueIndex = 0;

    while (queueIndex < keyQueue.length) {
      const currentKey = keyQueue[queueIndex];
      queueIndex += 1;
      const currentCost = costByKey.get(currentKey) || 0;
      const neighborKeys = wiremanNeighborKeysByCellKey.get(currentKey) || [];
      for (const neighborKey of neighborKeys) {
        if (costByKey.has(neighborKey)) {
          continue;
        }
        costByKey.set(neighborKey, currentCost + 1);
        keyQueue.push(neighborKey);
      }
    }

    return {
      fromCell,
      fromKey,
      costByKey,
    };
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

  function hasDirectLineOfSight(
    fromX,
    fromZ,
    toX,
    toZ,
    { requireFrontHemisphere = false } = {},
  ) {
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

    if (requireFrontHemisphere) {
      const facingX = Math.sin(wiremanRig.rotation.y);
      const facingZ = Math.cos(wiremanRig.rotation.y);
      const forwardDot = (deltaX / distance) * facingX + (deltaZ / distance) * facingZ;
      if (forwardDot < 0) {
        return false;
      }
    }

    if (typeof world.areCellsVisible === "function") {
      return world.areCellsVisible(fromCell.col, fromCell.row, toCell.col, toCell.row);
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

  function resetHuntTarget() {
    wiremanHuntTargetCell = null;
    wiremanHuntTargetKey = "";
  }

  function addBeliefMass(targetMap, key, amount) {
    if (!Number.isFinite(amount) || amount <= 0) {
      return;
    }
    targetMap.set(key, (targetMap.get(key) || 0) + amount);
  }

  function clearBeliefState() {
    wiremanBeliefByKey.clear();
    wiremanNeighborKeysByCellKey.clear();
    wiremanWalkableBeliefCells = [];
    wiremanMostLikelyPlayerCell = null;
    wiremanMostLikelyPlayerProbability = 0;
  }

  function rebuildBeliefNeighbors() {
    wiremanNeighborKeysByCellKey.clear();
    for (const cell of wiremanWalkableBeliefCells) {
      const cellKey = cell.key || makeCellKey(cell.col, cell.row);
      const neighborKeys = [];
      for (const [dc, dr] of NEIGHBOR_OFFSETS) {
        const nextCol = cell.col + dc;
        const nextRow = cell.row + dr;
        if (!world.isWalkableCell(nextCol, nextRow)) {
          continue;
        }
        neighborKeys.push(makeCellKey(nextCol, nextRow));
      }
      wiremanNeighborKeysByCellKey.set(cellKey, neighborKeys);
    }
  }

  function seedUniformBelief() {
    wiremanBeliefByKey.clear();
    if (!wiremanWalkableBeliefCells.length) {
      wiremanMostLikelyPlayerCell = null;
      wiremanMostLikelyPlayerProbability = 0;
      return;
    }
    const probability = 1 / wiremanWalkableBeliefCells.length;
    for (const cell of wiremanWalkableBeliefCells) {
      const cellKey = cell.key || makeCellKey(cell.col, cell.row);
      wiremanBeliefByKey.set(cellKey, probability);
    }
    wiremanMostLikelyPlayerCell = cloneCell(wiremanWalkableBeliefCells[0]);
    wiremanMostLikelyPlayerProbability = probability;
  }

  function updateMostLikelyBeliefCell(fallbackCell = null) {
    let bestKey = "";
    let bestProbability = -1;
    for (const cell of wiremanWalkableBeliefCells) {
      const cellKey = cell.key || makeCellKey(cell.col, cell.row);
      const probability = wiremanBeliefByKey.get(cellKey) || 0;
      if (probability > bestProbability) {
        bestProbability = probability;
        bestKey = cellKey;
      }
    }

    if (bestKey) {
      const [colText, rowText] = bestKey.split(",");
      wiremanMostLikelyPlayerCell = { col: Number(colText), row: Number(rowText) };
      wiremanMostLikelyPlayerProbability = Math.max(0, bestProbability);
      return;
    }

    if (fallbackCell) {
      wiremanMostLikelyPlayerCell = cloneCell(fallbackCell);
      wiremanMostLikelyPlayerProbability = 0;
      return;
    }

    wiremanMostLikelyPlayerCell = null;
    wiremanMostLikelyPlayerProbability = 0;
  }

  function normalizeBelief({ observerCell = null } = {}) {
    let total = 0;
    for (const cell of wiremanWalkableBeliefCells) {
      const cellKey = cell.key || makeCellKey(cell.col, cell.row);
      const probability = Math.max(0, Number(wiremanBeliefByKey.get(cellKey)) || 0);
      wiremanBeliefByKey.set(cellKey, probability);
      total += probability;
    }

    if (total > BELIEF_MIN_TOTAL) {
      for (const cell of wiremanWalkableBeliefCells) {
        const cellKey = cell.key || makeCellKey(cell.col, cell.row);
        wiremanBeliefByKey.set(cellKey, (wiremanBeliefByKey.get(cellKey) || 0) / total);
      }
      return;
    }

    const hiddenCells = [];
    if (observerCell) {
      const visibleCells = world.getVisibleCellsForCell?.(observerCell.col, observerCell.row) || [];
      const visibleCellKeys = new Set(
        visibleCells.map((cell) => cell.key || makeCellKey(cell.col, cell.row)),
      );
      for (const cell of wiremanWalkableBeliefCells) {
        const cellKey = cell.key || makeCellKey(cell.col, cell.row);
        if (!visibleCellKeys.has(cellKey)) {
          hiddenCells.push(cell);
        }
      }
    }
    const fallbackCells = hiddenCells.length ? hiddenCells : wiremanWalkableBeliefCells;
    if (!fallbackCells.length) {
      wiremanBeliefByKey.clear();
      return;
    }

    const probability = 1 / fallbackCells.length;
    for (const cell of wiremanWalkableBeliefCells) {
      const cellKey = cell.key || makeCellKey(cell.col, cell.row);
      wiremanBeliefByKey.set(cellKey, 0);
    }
    for (const cell of fallbackCells) {
      const cellKey = cell.key || makeCellKey(cell.col, cell.row);
      wiremanBeliefByKey.set(cellKey, probability);
    }
  }

  function ensureBeliefModel({ fallbackCell = null } = {}) {
    const visibilityMap = world.getVisibilityMap?.();
    const walkableCells = visibilityMap?.walkableCells || [];
    if (!walkableCells.length) {
      clearBeliefState();
      return;
    }

    const normalizedWalkableCells = walkableCells.map((cell) => ({
      col: cell.col,
      row: cell.row,
      key: cell.key || makeCellKey(cell.col, cell.row),
    }));
    const shouldRebuild =
      wiremanWalkableBeliefCells.length !== normalizedWalkableCells.length ||
      wiremanBeliefByKey.size !== normalizedWalkableCells.length ||
      normalizedWalkableCells.some((cell, index) => {
        const existingCell = wiremanWalkableBeliefCells[index];
        return !existingCell || existingCell.key !== cell.key;
      });

    if (shouldRebuild) {
      wiremanWalkableBeliefCells = normalizedWalkableCells;
      rebuildBeliefNeighbors();
      seedUniformBelief();
      updateMostLikelyBeliefCell(fallbackCell);
      return;
    }

    if (!wiremanWalkableBeliefCells.length) {
      wiremanWalkableBeliefCells = normalizedWalkableCells;
      rebuildBeliefNeighbors();
      seedUniformBelief();
      updateMostLikelyBeliefCell(fallbackCell);
      return;
    }

    for (const cell of wiremanWalkableBeliefCells) {
      const cellKey = cell.key || makeCellKey(cell.col, cell.row);
      if (!wiremanBeliefByKey.has(cellKey)) {
        seedUniformBelief();
        updateMostLikelyBeliefCell(fallbackCell);
        break;
      }
    }
  }

  function collapseBeliefToCell(cell, fallbackCell) {
    const targetCell = findNearestWalkableCell(cell, fallbackCell);
    if (!targetCell) {
      seedUniformBelief();
      updateMostLikelyBeliefCell(fallbackCell);
      return;
    }
    const targetKey = makeCellKey(targetCell.col, targetCell.row);
    for (const beliefCell of wiremanWalkableBeliefCells) {
      const beliefCellKey = beliefCell.key || makeCellKey(beliefCell.col, beliefCell.row);
      wiremanBeliefByKey.set(beliefCellKey, beliefCellKey === targetKey ? 1 : 0);
    }
    wiremanMostLikelyPlayerCell = cloneCell(targetCell);
    wiremanMostLikelyPlayerProbability = 1;
  }

  function predictBelief(deltaSeconds) {
    if (!wiremanWalkableBeliefCells.length) {
      return;
    }
    const dt = Math.max(0, Number(deltaSeconds) || 0);
    if (dt <= 0) {
      return;
    }

    const playerSprintMultiplier = Math.max(Number(config.SPRINT_MULTIPLIER) || 1, 1);
    const assumedPlayerSpeed = Math.max(
      Number(config.PLAYER_SPEED || 0) * playerSprintMultiplier,
      Number(config.PLAYER_SPEED || 0),
      0,
    );
    const cellSize = Math.max(0.001, Number(config.CELL_SIZE) || 0.001);
    const cellTravel = (assumedPlayerSpeed * dt) / cellSize;
    const subSteps = Math.max(1, Math.ceil(cellTravel));
    const alpha = Math.min(1, cellTravel / subSteps);
    if (alpha <= 0) {
      return;
    }

    for (let subStep = 0; subStep < subSteps; subStep += 1) {
      const nextBeliefByKey = new Map();
      for (const cell of wiremanWalkableBeliefCells) {
        const cellKey = cell.key || makeCellKey(cell.col, cell.row);
        const sourceProbability = wiremanBeliefByKey.get(cellKey) || 0;
        if (sourceProbability <= 0) {
          continue;
        }

        const neighborKeys = wiremanNeighborKeysByCellKey.get(cellKey) || [];
        if (!neighborKeys.length) {
          addBeliefMass(nextBeliefByKey, cellKey, sourceProbability);
          continue;
        }

        const stayProbability = sourceProbability * (1 - alpha);
        const moveProbability = sourceProbability - stayProbability;
        addBeliefMass(nextBeliefByKey, cellKey, stayProbability);
        const sharedProbability = moveProbability / neighborKeys.length;
        for (const neighborKey of neighborKeys) {
          addBeliefMass(nextBeliefByKey, neighborKey, sharedProbability);
        }
      }

      wiremanBeliefByKey.clear();
      for (const cell of wiremanWalkableBeliefCells) {
        const cellKey = cell.key || makeCellKey(cell.col, cell.row);
        wiremanBeliefByKey.set(cellKey, nextBeliefByKey.get(cellKey) || 0);
      }
    }
  }

  function applyNegativeBeliefEvidence(observerCell, observedPlayerCell = null) {
    if (!observerCell) {
      return;
    }
    const visibleCells = world.getVisibleCellsForCell?.(observerCell.col, observerCell.row) || [];
    if (!visibleCells.length) {
      return;
    }
    const observedCellKey = observedPlayerCell
      ? makeCellKey(observedPlayerCell.col, observedPlayerCell.row)
      : "";
    for (const visibleCell of visibleCells) {
      const cellKey = visibleCell.key || makeCellKey(visibleCell.col, visibleCell.row);
      if (observedCellKey && cellKey === observedCellKey) {
        continue;
      }
      const probability = wiremanBeliefByKey.get(cellKey) || 0;
      wiremanBeliefByKey.set(cellKey, probability * BELIEF_NEGATIVE_EVIDENCE_EPSILON);
    }
  }

  function computeViewpointInformationGain(viewCell) {
    if (!viewCell) {
      return 0;
    }
    const visibleCells = world.getVisibleCellsForCell?.(viewCell.col, viewCell.row) || [];
    if (!visibleCells.length) {
      return 0;
    }

    let infoGain = 0;
    for (const visibleCell of visibleCells) {
      const cellKey = visibleCell.key || makeCellKey(visibleCell.col, visibleCell.row);
      infoGain += wiremanBeliefByKey.get(cellKey) || 0;
    }
    return infoGain;
  }

  function chooseMostLikelyBeliefCell(fallbackCell) {
    updateMostLikelyBeliefCell(fallbackCell);
    return cloneCell(wiremanMostLikelyPlayerCell || fallbackCell || null);
  }

  function chooseRandomWalkableBeliefCell(excludedCell = null) {
    if (!wiremanWalkableBeliefCells.length) {
      return null;
    }
    if (wiremanWalkableBeliefCells.length === 1) {
      return cloneCell(wiremanWalkableBeliefCells[0]);
    }
    const excludedKey = excludedCell ? makeCellKey(excludedCell.col, excludedCell.row) : "";
    const startIndex = Math.floor(Math.random() * wiremanWalkableBeliefCells.length);
    for (let offset = 0; offset < wiremanWalkableBeliefCells.length; offset += 1) {
      const index = (startIndex + offset) % wiremanWalkableBeliefCells.length;
      const candidateCell = wiremanWalkableBeliefCells[index];
      const candidateCellKey = candidateCell.key || makeCellKey(candidateCell.col, candidateCell.row);
      if (!excludedKey || candidateCellKey !== excludedKey) {
        return cloneCell(candidateCell);
      }
    }
    return cloneCell(wiremanWalkableBeliefCells[startIndex]);
  }

  function chooseInformationGainPath(fromCell, fallbackGoalCell) {
    if (!fromCell) {
      return { targetCell: cloneCell(fallbackGoalCell || null), path: [] };
    }

    const shortestPathData = computeSingleSourcePathCosts(fromCell);
    const normalizedFromCell =
      shortestPathData.fromCell || findNearestWalkableCell(fromCell, fromCell);
    if (!normalizedFromCell) {
      return { targetCell: cloneCell(fallbackGoalCell || null), path: [] };
    }

    let bestCell = null;
    let bestUtility = Number.NEGATIVE_INFINITY;
    for (const candidateCell of wiremanWalkableBeliefCells) {
      const candidateKey = candidateCell.key || makeCellKey(candidateCell.col, candidateCell.row);
      const shortestCost = shortestPathData.costByKey.get(candidateKey);
      const pathCost = Number.isFinite(shortestCost) ? Math.max(0, shortestCost) : 0;
      let utility =
        computeViewpointInformationGain(candidateCell) / (VIEWPOINT_UTILITY_PATH_BIAS + pathCost);
      utility += (wiremanBeliefByKey.get(candidateKey) || 0) * 0.05;
      if (candidateCell.col === normalizedFromCell.col && candidateCell.row === normalizedFromCell.row) {
        utility *= VIEWPOINT_STAY_PENALTY;
      }
      if (utility > bestUtility) {
        bestUtility = utility;
        bestCell = candidateCell;
      }
    }

    if (bestCell) {
      const bestPath = findAStarPath(normalizedFromCell, bestCell);
      if (bestPath.length) {
        return {
          targetCell: cloneCell(bestCell),
          path: bestPath,
        };
      }
    }

    const fallbackTarget = cloneCell(
      fallbackGoalCell ||
        chooseRandomWalkableBeliefCell(normalizedFromCell) ||
        chooseMostLikelyBeliefCell(normalizedFromCell) ||
        normalizedFromCell,
    );
    const fallbackPath = findAStarPath(normalizedFromCell, fallbackTarget);
    return {
      targetCell: cloneCell(fallbackTarget),
      path: fallbackPath.length ? fallbackPath : [cloneCell(normalizedFromCell)],
    };
  }

  function resetPathing() {
    wiremanPathCells = [];
    wiremanPathIndex = 0;
    wiremanGoalCell = null;
    wiremanGoalKey = "";
    wiremanRepathRemaining = 0;
    resetAttackState({ resetCooldown: true });
    wiremanDistanceToGoal = 0;
    wiremanHuntMode = "investigate";
    resetHuntTarget();
    wiremanMostLikelyPlayerCell = null;
    wiremanMostLikelyPlayerProbability = 0;
  }

  function onMazeRegenerated() {
    resetPathing();
    resetHealthState();
    ensureBeliefModel();
    seedUniformBelief();
    updateMostLikelyBeliefCell();
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
          obj.castShadow = false;
          obj.receiveShadow = true;
          obj.material.transparent = false;
          obj.material.side = THREE.DoubleSide;
          obj.frustumCulled = false;
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

    if (wiremanDead) {
      wiremanDistanceToPlayer = Math.hypot(
        wiremanRig.position.x - camera.position.x,
        wiremanRig.position.z - camera.position.z,
      );
      wiremanDistanceToGoal = 0;
      wiremanHasLineOfSight = false;
      wiremanIsMoving = false;
      wiremanIsSprinting = false;
      wiremanHuntMode = "dead";
      setAnimation("death");
      return;
    }

    wiremanAttackCooldownRemaining = Math.max(0, wiremanAttackCooldownRemaining - dt);

    if (!gameActive || hasWon) {
      resetAttackState();
      wiremanIsMoving = false;
      wiremanIsSprinting = false;
      wiremanHasLineOfSight = false;
      wiremanHuntMode = "investigate";
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

    const playerCellRaw = world.worldToCell(desiredTargetPosition.x, desiredTargetPosition.z);
    const playerCell = findNearestWalkableCell(playerCellRaw, wiremanCell);
    if (!playerCell) {
      wiremanIsMoving = false;
      wiremanIsSprinting = false;
      wiremanHasLineOfSight = false;
      setAnimation("idle");
      return;
    }

    ensureBeliefModel({ fallbackCell: wiremanCell });

    wiremanDistanceToPlayer = Math.hypot(
      wiremanRig.position.x - camera.position.x,
      wiremanRig.position.z - camera.position.z,
    );
    const hadLineOfSightLastFrame = wiremanHasLineOfSight;
    const shouldRequireFrontHemisphereLos =
      wiremanDistanceToPlayer > WIREMAN_CLOSE_DETECTION_DISTANCE;
    wiremanHasLineOfSight = hasDirectLineOfSight(
      wiremanRig.position.x,
      wiremanRig.position.z,
      desiredTargetPosition.x,
      desiredTargetPosition.z,
      { requireFrontHemisphere: shouldRequireFrontHemisphereLos },
    );

    if (wiremanHasLineOfSight) {
      collapseBeliefToCell(playerCell, wiremanCell);
    } else {
      predictBelief(dt);
      applyNegativeBeliefEvidence(wiremanCell);
      normalizeBelief({ observerCell: wiremanCell });
      updateMostLikelyBeliefCell(wiremanCell);
      if (hadLineOfSightLastFrame) {
        wiremanRepathRemaining = 0;
      }
    }

    if (wiremanAttackActive) {
      wiremanHuntMode = "attack";
      wiremanGoalCell = cloneCell(playerCell);
      wiremanGoalKey = makeCellKey(playerCell.col, playerCell.row);
      wiremanDistanceToGoal = wiremanDistanceToPlayer;
      wiremanIsMoving = false;
      wiremanIsSprinting = false;
      setAnimation("attack");

      wiremanAttackElapsed += dt;
      if (!wiremanAttackHitApplied && wiremanAttackElapsed >= wiremanAttackHitMomentSeconds) {
        const isInRange = wiremanDistanceToPlayer <= WIREMAN_ATTACK_RANGE;
        const isInAttackArc = isTargetWithinAttackArc(
          desiredTargetPosition.x,
          desiredTargetPosition.z,
        );
        const hasMeleeLineOfSight = hasDirectLineOfSight(
          wiremanRig.position.x,
          wiremanRig.position.z,
          desiredTargetPosition.x,
          desiredTargetPosition.z,
        );
        if (isInRange && isInAttackArc && hasMeleeLineOfSight) {
          applyPlayerDamage?.(WIREMAN_ATTACK_DAMAGE, "wireman attack");
        }
        wiremanAttackHitApplied = true;
      }

      if (wiremanAttackElapsed >= wiremanAttackDuration) {
        resetAttackState();
        setAnimation("idle");
      }
      return;
    }

    let distanceToMovementTarget = 0;
    if (wiremanHasLineOfSight) {
      wiremanHuntMode = "chase";
      wiremanGoalCell = cloneCell(playerCell);
      wiremanGoalKey = makeCellKey(playerCell.col, playerCell.row);
      wiremanDistanceToGoal = wiremanDistanceToPlayer;
      wiremanPathCells = [];
      wiremanPathIndex = 0;
      wiremanRepathRemaining = 0;
      resetHuntTarget();

      if (
        wiremanDistanceToGoal <= WIREMAN_ATTACK_START_RANGE &&
        wiremanAttackCooldownRemaining <= 0
      ) {
        movementDelta.set(
          desiredTargetPosition.x - wiremanRig.position.x,
          0,
          desiredTargetPosition.z - wiremanRig.position.z,
        );
        const facingDistance = movementDelta.length();
        if (facingDistance > 0.0001) {
          const attackTargetYaw = Math.atan2(movementDelta.x, movementDelta.z);
          let attackYawDelta = attackTargetYaw - wiremanRig.rotation.y;
          while (attackYawDelta > Math.PI) attackYawDelta -= Math.PI * 2;
          while (attackYawDelta < -Math.PI) attackYawDelta += Math.PI * 2;
          if (Math.abs(attackYawDelta) > ATTACK_START_ALIGNMENT_RADIANS) {
            const maxAttackYawStep = WIREMAN_ROTATE_SPEED * dt;
            wiremanRig.rotation.y += THREE.MathUtils.clamp(
              attackYawDelta,
              -maxAttackYawStep,
              maxAttackYawStep,
            );
            wiremanIsMoving = false;
            wiremanIsSprinting = false;
            setAnimation("idle");
            return;
          }
        }

        startAttackCommit();
        wiremanHuntMode = "attack";
        wiremanIsMoving = false;
        wiremanIsSprinting = false;
        setAnimation("attack");
        return;
      }

      if (wiremanDistanceToGoal <= WIREMAN_FOLLOW_STOP_DISTANCE) {
        wiremanIsMoving = false;
        wiremanIsSprinting = false;
        setAnimation("idle");
        return;
      }

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
      wiremanHuntMode = "investigate";
      const mostLikelyBeliefCell = chooseMostLikelyBeliefCell(wiremanCell);
      const randomFallbackCell =
        chooseRandomWalkableBeliefCell(wiremanCell) ||
        mostLikelyBeliefCell ||
        cloneCell(wiremanCell);

      wiremanRepathRemaining -= dt;
      const shouldRepath =
        wiremanRepathRemaining <= 0 ||
        !wiremanPathCells.length ||
        wiremanPathIndex >= wiremanPathCells.length;
      if (shouldRepath) {
        const pathSelection = chooseInformationGainPath(
          wiremanCell,
          randomFallbackCell,
        );
        wiremanPathCells = pathSelection.path;
        wiremanPathIndex = wiremanPathCells.length > 1 ? 1 : 0;
        wiremanGoalCell = cloneCell(
          pathSelection.targetCell || randomFallbackCell || mostLikelyBeliefCell || wiremanCell,
        );
        wiremanGoalKey = wiremanGoalCell
          ? makeCellKey(wiremanGoalCell.col, wiremanGoalCell.row)
          : "";
        wiremanHuntTargetCell = cloneCell(wiremanGoalCell);
        wiremanHuntTargetKey = wiremanGoalKey;
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

      if (wiremanGoalCell) {
        const goalWorld = world.cellToWorld(wiremanGoalCell.col, wiremanGoalCell.row);
        wiremanDistanceToGoal = Math.hypot(
          wiremanRig.position.x - goalWorld.x,
          wiremanRig.position.z - goalWorld.z,
        );
      } else {
        wiremanDistanceToGoal = 0;
      }
    }

    movementDelta.normalize();
    const intendedDirectionX = movementDelta.x;
    const intendedDirectionZ = movementDelta.z;
    const speedMultiplier = wiremanHasLineOfSight ? WIREMAN_SPRINT_MULTIPLIER : 1;
    const maxStep = WIREMAN_WALK_SPEED * speedMultiplier * dt;
    const step = Math.min(maxStep, distanceToMovementTarget);
    const previousX = wiremanRig.position.x;
    const previousZ = wiremanRig.position.z;
    const nextX = previousX + movementDelta.x * step;
    const nextZ = previousZ + movementDelta.z * step;
    const resolvedFromWorld =
      typeof world.resolveWorldCollision === "function"
        ? world.resolveWorldCollision(nextX, nextZ, {
            includeProps: false,
            collisionRadius: WIREMAN_COLLISION_RADIUS,
          })
        : { x: nextX, z: nextZ };
    wiremanRig.position.x = resolvedFromWorld.x;
    wiremanRig.position.z = resolvedFromWorld.z;

    const resolvedStepX = wiremanRig.position.x - previousX;
    const resolvedStepZ = wiremanRig.position.z - previousZ;
    const resolvedStepDistance = Math.hypot(resolvedStepX, resolvedStepZ);
    if (resolvedStepDistance > 0.0001) {
      movementDelta.set(
        resolvedStepX / resolvedStepDistance,
        0,
        resolvedStepZ / resolvedStepDistance,
      );
    } else {
      movementDelta.set(0, 0, 0);
    }

    const yawDirectionX = resolvedStepDistance > 0.0001 ? movementDelta.x : intendedDirectionX;
    const yawDirectionZ = resolvedStepDistance > 0.0001 ? movementDelta.z : intendedDirectionZ;
    const targetYaw = Math.atan2(yawDirectionX, yawDirectionZ);
    let yawDelta = targetYaw - wiremanRig.rotation.y;
    while (yawDelta > Math.PI) yawDelta -= Math.PI * 2;
    while (yawDelta < -Math.PI) yawDelta += Math.PI * 2;
    const maxYawStep = WIREMAN_ROTATE_SPEED * dt;
    const appliedYaw = THREE.MathUtils.clamp(yawDelta, -maxYawStep, maxYawStep);
    wiremanRig.rotation.y += appliedYaw;

    wiremanIsMoving = resolvedStepDistance > 0.0001;
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
        huntMode: wiremanHuntMode,
        searchTargetCell: null,
        pathLength: 0,
        pathIndex: 0,
        health: wiremanHealth,
        maxHealth: WIREMAN_MAX_HEALTH,
        dead: wiremanDead,
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
      huntMode: wiremanHuntMode,
      goalCell: wiremanGoalCell ? { ...wiremanGoalCell } : null,
      huntTargetCell: wiremanHuntTargetCell ? { ...wiremanHuntTargetCell } : null,
      searchTargetCell: wiremanMostLikelyPlayerCell ? { ...wiremanMostLikelyPlayerCell } : null,
      huntTargetKey: wiremanHuntTargetKey,
      distanceToPlayer: wiremanDistanceToPlayer,
      distanceToGoal: wiremanDistanceToGoal,
      beliefPeakCell: wiremanMostLikelyPlayerCell ? { ...wiremanMostLikelyPlayerCell } : null,
      beliefPeak: wiremanMostLikelyPlayerProbability,
      health: wiremanHealth,
      maxHealth: WIREMAN_MAX_HEALTH,
      dead: wiremanDead,
    };
  }

  function getHuntScoreForCell(col, row) {
    const key = makeCellKey(col, row);
    return wiremanBeliefByKey.get(key) ?? 0;
  }

  function getPathCells() {
    return wiremanPathCells.map((cell) => ({ col: cell.col, row: cell.row }));
  }

  function getPathIndex() {
    return wiremanPathIndex;
  }

  function getHuntScoreMax() {
    return 1;
  }

  loadWireman();

  return {
    update,
    onMazeRegenerated,
    getRaycastTarget,
    raycastCapsule,
    isHitObject,
    applyDamage,
    resolvePlayerCapsuleCollision,
    getState,
    getHuntScoreForCell,
    getPathCells,
    getPathIndex,
    getHuntScoreMax,
    isLoaded: () => wiremanLoaded,
  };
}
