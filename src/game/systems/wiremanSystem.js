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
  const searchTargetWorld = new THREE.Vector3();
  const lastSeenPlayerWorld = new THREE.Vector3();
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
  const HUNT_TOP_TILES = 6;
  const HUNT_WEIGHT_POWER = 3;
  const HUNT_SCORE_MAX = 0.1;
  const HUNT_SCORE_REGEN_PER_SECOND = 0.00025;
  const SEARCH_SCAN_FULL_TURN_RADIANS = Math.PI * 2;
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
  let wiremanHuntMode = "hunt";
  let wiremanHuntTargetCell = null;
  let wiremanHuntTargetKey = "";
  let wiremanSearchTargetCell = null;
  let wiremanSearchTargetKey = "";
  let wiremanSearchScanActive = false;
  let wiremanSearchScanRemainingRadians = 0;
  let wiremanSearchScanDirection = 1;
  let wiremanHasLastSeenPlayer = false;
  let wiremanLastSeenPlayerCell = null;
  let wiremanLastScoredCellKey = "";
  const wiremanCellScores = new Map();
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
    resetSearchTarget();
    wiremanHasLastSeenPlayer = false;
    wiremanLastSeenPlayerCell = null;
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

  function reseedHuntScores() {
    wiremanCellScores.clear();
    const visibilityMap = world.getVisibilityMap?.();
    const walkableCells = visibilityMap?.walkableCells || [];
    if (!walkableCells.length) {
      return;
    }

    for (const cell of walkableCells) {
      wiremanCellScores.set(cell.key, HUNT_SCORE_MAX);
    }
  }

  function regenerateHuntScores(deltaSeconds) {
    if (!wiremanCellScores.size) {
      reseedHuntScores();
    }
    if (!wiremanCellScores.size) {
      return;
    }

    const regenAmount = HUNT_SCORE_REGEN_PER_SECOND * Math.max(0, Number(deltaSeconds) || 0);
    if (regenAmount <= 0) {
      return;
    }

    for (const [key, score] of wiremanCellScores.entries()) {
      wiremanCellScores.set(key, Math.min(HUNT_SCORE_MAX, score + regenAmount));
    }
  }

  function computeTileVisibilityScore(tileCell) {
    if (!tileCell) {
      return 0;
    }
    const visibleCells = world.getVisibleCellsForCell?.(tileCell.col, tileCell.row) || [];
    if (!visibleCells.length) {
      return 0;
    }

    let visibilityScore = 0;
    for (const visibleCell of visibleCells) {
      const cellKey = visibleCell.key || makeCellKey(visibleCell.col, visibleCell.row);
      visibilityScore += wiremanCellScores.get(cellKey) ?? HUNT_SCORE_MAX;
    }
    return visibilityScore;
  }

  function resetHuntTarget() {
    wiremanHuntTargetCell = null;
    wiremanHuntTargetKey = "";
  }

  function resetSearchScan() {
    wiremanSearchScanActive = false;
    wiremanSearchScanRemainingRadians = 0;
    wiremanSearchScanDirection = 1;
  }

  function startSearchScan() {
    wiremanSearchScanActive = true;
    wiremanSearchScanRemainingRadians = SEARCH_SCAN_FULL_TURN_RADIANS;
    wiremanSearchScanDirection = Math.random() < 0.5 ? -1 : 1;
  }

  function resetSearchTarget() {
    wiremanSearchTargetCell = null;
    wiremanSearchTargetKey = "";
    resetSearchScan();
  }

  function setSearchTargetFromLastSeen(fallbackCell) {
    resetSearchScan();
    const baseCell = wiremanLastSeenPlayerCell || fallbackCell;
    const searchCell = findNearestWalkableCell(baseCell, fallbackCell);
    if (!searchCell) {
      resetSearchTarget();
      return;
    }
    wiremanSearchTargetCell = cloneCell(searchCell);
    wiremanSearchTargetKey = makeCellKey(searchCell.col, searchCell.row);
    if (wiremanHasLastSeenPlayer) {
      searchTargetWorld.copy(lastSeenPlayerWorld);
    } else {
      const searchWorld = world.cellToWorld(searchCell.col, searchCell.row);
      searchTargetWorld.set(searchWorld.x, 0, searchWorld.z);
    }
  }

  function transitionSearchToHunt({ clearGoal = false } = {}) {
    wiremanHuntMode = "hunt";
    wiremanPathCells = [];
    wiremanPathIndex = 0;
    wiremanRepathRemaining = 0;
    wiremanDistanceToGoal = 0;
    if (clearGoal) {
      wiremanGoalCell = null;
      wiremanGoalKey = "";
    }
    resetSearchTarget();
  }

  function updateVisibleTilesScores(fromCell, directionX = 0, directionZ = 0) {
    if (!fromCell) {
      return;
    }
    if (!wiremanCellScores.size) {
      reseedHuntScores();
    }

    const visibleCells = world.getVisibleCellsForCell?.(fromCell.col, fromCell.row) || [];
    if (!visibleCells.length) {
      return;
    }

    let facingX = directionX;
    let facingZ = directionZ;
    const facingLength = Math.hypot(facingX, facingZ);
    if (facingLength <= 0.0001) {
      facingX = Math.sin(wiremanRig.rotation.y);
      facingZ = Math.cos(wiremanRig.rotation.y);
    } else {
      facingX /= facingLength;
      facingZ /= facingLength;
    }

    wiremanCellScores.set(makeCellKey(fromCell.col, fromCell.row), 0);
    for (const visibleCell of visibleCells) {
      const cellKey = visibleCell.key || makeCellKey(visibleCell.col, visibleCell.row);
      if (cellKey === makeCellKey(fromCell.col, fromCell.row)) {
        continue;
      }
      const visibleCellWorld = world.cellToWorld(visibleCell.col, visibleCell.row);
      const deltaX = visibleCellWorld.x - wiremanRig.position.x;
      const deltaZ = visibleCellWorld.z - wiremanRig.position.z;
      const distance = Math.hypot(deltaX, deltaZ);
      if (distance <= 0.0001) {
        continue;
      }
      const dot = (deltaX / distance) * facingX + (deltaZ / distance) * facingZ;
      if (dot >= 0) {
        wiremanCellScores.set(cellKey, 0);
      }
    }
  }

  function chooseHuntPath(fromCell, fallbackGoalCell) {
    if (!wiremanCellScores.size) {
      reseedHuntScores();
    }

    const visibilityMap = world.getVisibilityMap?.();
    const walkableCells = visibilityMap?.walkableCells || [];
    const rankedTiles = walkableCells
      .map((cell) => ({
        cell,
        score: computeTileVisibilityScore(cell),
      }))
      .filter((entry) => !(entry.cell.col === fromCell.col && entry.cell.row === fromCell.row))
      .sort((a, b) => b.score - a.score)
      .slice(0, HUNT_TOP_TILES);

    const weightedCandidates = [];
    let totalWeight = 0;
    for (const tile of rankedTiles) {
      const path = findAStarPath(fromCell, tile.cell);
      if (!path.length) {
        continue;
      }
      const pathLength = Math.max(path.length, 1);
      const weightedScore = tile.score / pathLength;
      const weight = Math.pow(weightedScore, HUNT_WEIGHT_POWER);
      if (!Number.isFinite(weight) || weight <= 0) {
        continue;
      }
      weightedCandidates.push({
        cell: tile.cell,
        path,
        weight,
      });
      totalWeight += weight;
    }

    if (!weightedCandidates.length) {
      const fallbackTarget = fallbackGoalCell || fromCell;
      const fallbackPath = findAStarPath(fromCell, fallbackTarget);
      return {
        targetCell: cloneCell(fallbackTarget),
        path: fallbackPath.length ? fallbackPath : [cloneCell(fromCell)],
      };
    }

    if (totalWeight <= 0) {
      const firstCandidate = weightedCandidates[0];
      return {
        targetCell: cloneCell(firstCandidate.cell),
        path: firstCandidate.path,
      };
    }

    const randomValue = Math.random() * totalWeight;
    let accumulatedWeight = 0;
    let selected = weightedCandidates[weightedCandidates.length - 1];
    for (const candidate of weightedCandidates) {
      accumulatedWeight += candidate.weight;
      if (randomValue <= accumulatedWeight) {
        selected = candidate;
        break;
      }
    }

    return {
      targetCell: cloneCell(selected.cell),
      path: selected.path,
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
    wiremanHuntMode = "hunt";
    wiremanLastScoredCellKey = "";
    resetHuntTarget();
    resetSearchTarget();
    wiremanHasLastSeenPlayer = false;
    wiremanLastSeenPlayerCell = null;
  }

  function onMazeRegenerated() {
    resetPathing();
    resetHealthState();
    reseedHuntScores();
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
    wiremanLastScoredCellKey = makeCellKey(spawnCell.col, spawnCell.row);
    updateVisibleTilesScores(spawnCell);
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

    regenerateHuntScores(dt);
    wiremanAttackCooldownRemaining = Math.max(0, wiremanAttackCooldownRemaining - dt);

    if (!gameActive || hasWon) {
      resetAttackState();
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

    const playerCellRaw = world.worldToCell(desiredTargetPosition.x, desiredTargetPosition.z);
    const playerCell = findNearestWalkableCell(playerCellRaw, wiremanCell);
    if (!playerCell) {
      wiremanIsMoving = false;
      wiremanIsSprinting = false;
      wiremanHasLineOfSight = false;
      setAnimation("idle");
      return;
    }

    const wiremanCellKey = makeCellKey(wiremanCell.col, wiremanCell.row);
    if (wiremanCellKey !== wiremanLastScoredCellKey) {
      updateVisibleTilesScores(wiremanCell);
      wiremanLastScoredCellKey = wiremanCellKey;
    }

    wiremanDistanceToPlayer = Math.hypot(
      wiremanRig.position.x - camera.position.x,
      wiremanRig.position.z - camera.position.z,
    );
    const shouldRequireFrontHemisphereLos =
      (wiremanHuntMode === "hunt" || wiremanHuntMode === "search") &&
      wiremanDistanceToPlayer > WIREMAN_CLOSE_DETECTION_DISTANCE;
    const hadLineOfSightLastFrame = wiremanHasLineOfSight;
    wiremanHasLineOfSight = hasDirectLineOfSight(
      wiremanRig.position.x,
      wiremanRig.position.z,
      desiredTargetPosition.x,
      desiredTargetPosition.z,
      { requireFrontHemisphere: shouldRequireFrontHemisphereLos },
    );
    if (wiremanHasLineOfSight) {
      wiremanHasLastSeenPlayer = true;
      wiremanLastSeenPlayerCell = cloneCell(playerCell);
      lastSeenPlayerWorld.copy(desiredTargetPosition);
    } else if (hadLineOfSightLastFrame && wiremanHasLastSeenPlayer) {
      wiremanHuntMode = "search";
      setSearchTargetFromLastSeen(playerCell);
      wiremanPathCells = [];
      wiremanPathIndex = 0;
      wiremanRepathRemaining = 0;
      resetHuntTarget();
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
      resetSearchTarget();

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
    } else if (wiremanHuntMode === "search") {
      if (!wiremanSearchTargetCell) {
        setSearchTargetFromLastSeen(playerCell);
      }
      if (!wiremanSearchTargetCell) {
        transitionSearchToHunt({ clearGoal: true });
      } else {
        wiremanGoalCell = cloneCell(wiremanSearchTargetCell);
        wiremanGoalKey = wiremanSearchTargetKey;
        wiremanDistanceToGoal = Math.hypot(
          wiremanRig.position.x - searchTargetWorld.x,
          wiremanRig.position.z - searchTargetWorld.z,
        );

        const atSearchTargetCell =
          wiremanCell.col === wiremanSearchTargetCell.col &&
          wiremanCell.row === wiremanSearchTargetCell.row;

        if (atSearchTargetCell) {
          movementDelta.set(
            searchTargetWorld.x - wiremanRig.position.x,
            0,
            searchTargetWorld.z - wiremanRig.position.z,
          );
          distanceToMovementTarget = movementDelta.length();
          if (distanceToMovementTarget <= WIREMAN_FOLLOW_STOP_DISTANCE) {
            if (!wiremanSearchScanActive) {
              startSearchScan();
            }
            const maxScanYawStep = WIREMAN_ROTATE_SPEED * dt;
            const appliedScanYaw = Math.min(maxScanYawStep, wiremanSearchScanRemainingRadians);
            wiremanRig.rotation.y += appliedScanYaw * wiremanSearchScanDirection;
            wiremanSearchScanRemainingRadians = Math.max(
              0,
              wiremanSearchScanRemainingRadians - appliedScanYaw,
            );
            while (wiremanRig.rotation.y > Math.PI) wiremanRig.rotation.y -= Math.PI * 2;
            while (wiremanRig.rotation.y < -Math.PI) wiremanRig.rotation.y += Math.PI * 2;

            wiremanIsMoving = false;
            wiremanIsSprinting = false;
            setAnimation("idle");

            if (wiremanSearchScanRemainingRadians <= 0.0001) {
              updateVisibleTilesScores(wiremanCell);
              transitionSearchToHunt({ clearGoal: true });
            }
            return;
          }
        }

        if (wiremanHuntMode === "search" && !atSearchTargetCell) {
          wiremanRepathRemaining -= dt;
          if (
            wiremanRepathRemaining <= 0 ||
            !wiremanPathCells.length ||
            wiremanPathIndex >= wiremanPathCells.length ||
            wiremanGoalKey !== wiremanSearchTargetKey
          ) {
            wiremanPathCells = findAStarPath(wiremanCell, wiremanSearchTargetCell);
            wiremanPathIndex = wiremanPathCells.length > 1 ? 1 : 0;
            wiremanRepathRemaining = WIREMAN_REPATH_INTERVAL_SECONDS;
          }

          if (!wiremanPathCells.length || wiremanPathIndex >= wiremanPathCells.length) {
            transitionSearchToHunt();
          } else {
            let waypointCell = wiremanPathCells[wiremanPathIndex];
            if (!waypointCell) {
              transitionSearchToHunt();
            } else {
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
            }
          }
        }
      }
    }

    if (!wiremanHasLineOfSight && wiremanHuntMode !== "search") {
      wiremanHuntMode = "hunt";
      const atHuntTarget =
        wiremanHuntTargetCell &&
        wiremanCell.col === wiremanHuntTargetCell.col &&
        wiremanCell.row === wiremanHuntTargetCell.row;
      if (atHuntTarget) {
        updateVisibleTilesScores(wiremanCell);
        resetHuntTarget();
      }

      wiremanRepathRemaining -= dt;
      if (
        wiremanRepathRemaining <= 0 ||
        !wiremanPathCells.length ||
        wiremanPathIndex >= wiremanPathCells.length ||
        !wiremanHuntTargetCell
      ) {
        const huntSelection = chooseHuntPath(wiremanCell, playerCell);
        wiremanPathCells = huntSelection.path;
        wiremanPathIndex = wiremanPathCells.length > 1 ? 1 : 0;
        wiremanHuntTargetCell = cloneCell(huntSelection.targetCell);
        wiremanHuntTargetKey = wiremanHuntTargetCell
          ? makeCellKey(wiremanHuntTargetCell.col, wiremanHuntTargetCell.row)
          : "";
        wiremanGoalCell = cloneCell(wiremanHuntTargetCell || playerCell);
        wiremanGoalKey = wiremanGoalCell
          ? makeCellKey(wiremanGoalCell.col, wiremanGoalCell.row)
          : "";
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

    if (wiremanIsMoving) {
      const movedCellRaw = world.worldToCell(wiremanRig.position.x, wiremanRig.position.z);
      const movedCell = findNearestWalkableCell(movedCellRaw, wiremanCell);
      if (movedCell) {
        const movedCellKey = makeCellKey(movedCell.col, movedCell.row);
        if (movedCellKey !== wiremanLastScoredCellKey) {
          updateVisibleTilesScores(movedCell, movementDelta.x, movementDelta.z);
          wiremanLastScoredCellKey = movedCellKey;
        }
      }
    }
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
      searchTargetCell: wiremanSearchTargetCell ? { ...wiremanSearchTargetCell } : null,
      huntTargetKey: wiremanHuntTargetKey,
      distanceToPlayer: wiremanDistanceToPlayer,
      distanceToGoal: wiremanDistanceToGoal,
      health: wiremanHealth,
      maxHealth: WIREMAN_MAX_HEALTH,
      dead: wiremanDead,
    };
  }

  function getHuntScoreForCell(col, row) {
    const key = makeCellKey(col, row);
    return wiremanCellScores.get(key) ?? HUNT_SCORE_MAX;
  }

  function getPathCells() {
    return wiremanPathCells.map((cell) => ({ col: cell.col, row: cell.row }));
  }

  function getPathIndex() {
    return wiremanPathIndex;
  }

  function getHuntScoreMax() {
    return HUNT_SCORE_MAX;
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
