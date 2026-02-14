export function createPlayerViewSystem({
  THREE,
  camera,
  topDownCamera,
  constants,
  config,
  world,
  flashlightRig,
  inventoryLeftHandRig,
  topDownPlayerMarker,
  topDownLookLine,
  worldWidth,
  worldDepth,
}) {
  const {
    VIEW_BOB_BASE_FREQUENCY,
    VIEW_BOB_BASE_AMPLITUDE,
    VIEW_BOB_SMOOTHING,
    PLAYER_SPRINT_FOV_BOOST_DEGREES,
    PLAYER_SPRINT_FOV_EMA_HALF_LIFE_SECONDS,
    TOP_DOWN_PLAYER_LOOK_LENGTH,
    FLASHLIGHT_RIG_BASE_POSITION,
    FLASHLIGHT_RIG_BASE_ROTATION,
    LEFT_HAND_RIG_BASE_POSITION,
    LEFT_HAND_RIG_BASE_ROTATION,
  } = constants;
  const { PLAYER_HEIGHT, PLAYER_SPEED, SPRINT_MULTIPLIER } = config;
  const PLAYER_JUMP_VELOCITY = 5.2;
  const PLAYER_JUMP_GRAVITY = 14.5;

  const worldUp = new THREE.Vector3(0, 1, 0);
  const forward = new THREE.Vector3();
  const right = new THREE.Vector3();
  const move = new THREE.Vector3();
  const topDownLookDirection = new THREE.Vector3();

  let viewBobPhase = 0;
  let viewBobBlend = 0;
  let movementBobSignal = 0;
  let jumpOffset = 0;
  let jumpVelocity = 0;
  let jumpPressedLastFrame = false;
  const basePlayerFov = camera.fov;
  let smoothedPlayerFov = basePlayerFov;

  function emaTowards(current, target, deltaSeconds, halfLifeSeconds) {
    const safeHalfLife = Math.max(0.0001, halfLifeSeconds);
    const blend = 1 - Math.pow(0.5, Math.max(0, deltaSeconds) / safeHalfLife);
    return current + (target - current) * blend;
  }

  function resetPose() {
    viewBobPhase = 0;
    viewBobBlend = 0;
    movementBobSignal = 0;
    jumpOffset = 0;
    jumpVelocity = 0;
    jumpPressedLastFrame = false;
    smoothedPlayerFov = basePlayerFov;
    if (Math.abs(camera.fov - basePlayerFov) > 0.0001) {
      camera.fov = basePlayerFov;
      camera.updateProjectionMatrix();
    }
    camera.position.y = PLAYER_HEIGHT;
    flashlightRig.position.copy(FLASHLIGHT_RIG_BASE_POSITION);
    flashlightRig.rotation.copy(FLASHLIGHT_RIG_BASE_ROTATION);
    inventoryLeftHandRig.position.copy(LEFT_HAND_RIG_BASE_POSITION);
    inventoryLeftHandRig.rotation.copy(LEFT_HAND_RIG_BASE_ROTATION);
  }

  function updatePlayerMovement(deltaSeconds, {
    gameActive,
    hasWon,
    keyState,
    isSprintActive,
    getPlayerSpeedMultiplier,
  }) {
    updateJump(deltaSeconds, { gameActive, hasWon, keyState });

    if (!gameActive || hasWon) {
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

    const speed = PLAYER_SPEED * (isSprintActive ? SPRINT_MULTIPLIER : 1) * getPlayerSpeedMultiplier();
    const stepX = move.x * speed * deltaSeconds;
    const stepZ = move.z * speed * deltaSeconds;
    const current = camera.position;
    const previousX = current.x;
    const previousZ = current.z;
    const nextX = current.x + stepX;
    const nextZ = current.z + stepZ;
    const resolvedFromWorld = world.resolveWorldCollision(nextX, nextZ, { heightOffset: jumpOffset });
    current.x = resolvedFromWorld.x;
    current.z = resolvedFromWorld.z;

    const maxDisplacement = Math.max(speed * deltaSeconds, 0.00001);
    const movedDistance = Math.hypot(current.x - previousX, current.z - previousZ);
    movementBobSignal = THREE.MathUtils.clamp(movedDistance / maxDisplacement, 0, 1);
  }

  function updateJump(deltaSeconds, { gameActive, hasWon, keyState }) {
    const jumpAllowed = gameActive && !hasWon;
    const jumpPressed = Boolean(keyState.jump);
    const isGrounded = jumpOffset <= 0.0001;

    if (jumpAllowed && jumpPressed && !jumpPressedLastFrame && isGrounded) {
      jumpVelocity = PLAYER_JUMP_VELOCITY;
    }
    jumpPressedLastFrame = jumpPressed;

    if (!jumpAllowed) {
      jumpOffset = 0;
      jumpVelocity = 0;
      return;
    }

    if (isGrounded && jumpVelocity <= 0) {
      jumpOffset = 0;
      jumpVelocity = 0;
      return;
    }

    jumpVelocity -= PLAYER_JUMP_GRAVITY * deltaSeconds;
    jumpOffset += jumpVelocity * deltaSeconds;
    if (jumpOffset <= 0) {
      jumpOffset = 0;
      jumpVelocity = 0;
    }
  }

  function updateViewBobbing(deltaSeconds, {
    gameActive,
    hasWon,
    isTopDownView,
    isSprintActive,
  }) {
    const bobAllowed = gameActive && !hasWon && !isTopDownView;
    const sprintFovTarget =
      basePlayerFov + (isSprintActive && bobAllowed ? PLAYER_SPRINT_FOV_BOOST_DEGREES : 0);
    smoothedPlayerFov = emaTowards(
      smoothedPlayerFov,
      sprintFovTarget,
      deltaSeconds,
      PLAYER_SPRINT_FOV_EMA_HALF_LIFE_SECONDS,
    );
    if (Math.abs(camera.fov - smoothedPlayerFov) > 0.0001) {
      camera.fov = smoothedPlayerFov;
      camera.updateProjectionMatrix();
    }

    if (!bobAllowed) {
      viewBobBlend = 0;
    } else {
      viewBobBlend +=
        (movementBobSignal - viewBobBlend) * Math.min(1, deltaSeconds * VIEW_BOB_SMOOTHING);

      if (viewBobBlend > 0.0005) {
        const sprintScale = isSprintActive ? 1.2 : 1;
        viewBobPhase +=
          deltaSeconds *
          VIEW_BOB_BASE_FREQUENCY *
          sprintScale *
          (0.45 + viewBobBlend * 0.55);
      }
    }

    const sprintAmplitudeScale = isSprintActive && bobAllowed ? 1.2 : 1;
    const amplitude = VIEW_BOB_BASE_AMPLITUDE * viewBobBlend * sprintAmplitudeScale;
    const bobY = Math.sin(viewBobPhase * 2.0) * amplitude;
    const bobX = Math.cos(viewBobPhase) * amplitude * 0.45;
    const bobRoll = Math.sin(viewBobPhase) * amplitude * 0.22;

    camera.position.y = PLAYER_HEIGHT + jumpOffset + bobY;
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

  function updateTopDownCamera() {
    const vFov = THREE.MathUtils.degToRad(topDownCamera.fov);
    const tanHalf = Math.tan(vFov * 0.5);
    const margin = config.CELL_SIZE * 0.75;
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

  return {
    resetPose,
    updatePlayerMovement,
    updateViewBobbing,
    updateTopDownCamera,
    updateTopDownPlayerDebug,
    getJumpState: () => ({
      jumping: jumpOffset > 0.0001 || jumpVelocity > 0,
      grounded: jumpOffset <= 0.0001,
      jumpOffset,
      jumpVelocity,
    }),
  };
}
