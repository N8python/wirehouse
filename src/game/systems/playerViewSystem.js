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
    TOP_DOWN_PLAYER_LOOK_LENGTH,
    FLASHLIGHT_RIG_BASE_POSITION,
    FLASHLIGHT_RIG_BASE_ROTATION,
    LEFT_HAND_RIG_BASE_POSITION,
    LEFT_HAND_RIG_BASE_ROTATION,
  } = constants;
  const { PLAYER_HEIGHT, PLAYER_SPEED, SPRINT_MULTIPLIER } = config;

  const worldUp = new THREE.Vector3(0, 1, 0);
  const forward = new THREE.Vector3();
  const right = new THREE.Vector3();
  const move = new THREE.Vector3();
  const topDownLookDirection = new THREE.Vector3();

  let viewBobPhase = 0;
  let viewBobBlend = 0;
  let movementBobSignal = 0;

  function resetPose() {
    viewBobPhase = 0;
    viewBobBlend = 0;
    movementBobSignal = 0;
    camera.position.y = PLAYER_HEIGHT;
    flashlightRig.position.copy(FLASHLIGHT_RIG_BASE_POSITION);
    flashlightRig.rotation.copy(FLASHLIGHT_RIG_BASE_ROTATION);
    inventoryLeftHandRig.position.copy(LEFT_HAND_RIG_BASE_POSITION);
    inventoryLeftHandRig.rotation.copy(LEFT_HAND_RIG_BASE_ROTATION);
  }

  function updatePlayerMovement(deltaSeconds, { gameActive, keyState, getPlayerSpeedMultiplier }) {
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

    const speed =
      PLAYER_SPEED * (keyState.sprint ? SPRINT_MULTIPLIER : 1) * getPlayerSpeedMultiplier();
    const stepX = move.x * speed * deltaSeconds;
    const stepZ = move.z * speed * deltaSeconds;
    const current = camera.position;
    const previousX = current.x;
    const previousZ = current.z;
    const nextX = current.x + stepX;
    const nextZ = current.z + stepZ;
    const resolvedFromWorld = world.resolveWorldCollision(nextX, nextZ);
    current.x = resolvedFromWorld.x;
    current.z = resolvedFromWorld.z;

    const maxDisplacement = Math.max(speed * deltaSeconds, 0.00001);
    const movedDistance = Math.hypot(current.x - previousX, current.z - previousZ);
    movementBobSignal = THREE.MathUtils.clamp(movedDistance / maxDisplacement, 0, 1);
  }

  function updateViewBobbing(deltaSeconds, { gameActive, hasWon, isTopDownView, keyState }) {
    const bobAllowed = gameActive && !hasWon && !isTopDownView;
    if (!bobAllowed) {
      viewBobBlend = 0;
    } else {
      viewBobBlend +=
        (movementBobSignal - viewBobBlend) * Math.min(1, deltaSeconds * VIEW_BOB_SMOOTHING);

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
  };
}
