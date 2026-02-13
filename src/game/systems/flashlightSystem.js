export function createFlashlightSystem({
  THREE,
  constants,
  config,
  flashlight,
  flashlightTarget,
  flashlightBounceLight,
  bounceLightDebugMarker,
  getBounceTargets,
  isFlashlightEmissionActive,
  setStatus,
}) {
  const {
    FLASHLIGHT_BOUNCE_DEFAULT_REFLECTANCE,
  } = constants;
  const {
    FLASHLIGHT_BASE_INTENSITY,
    FLASHLIGHT_BASE_DISTANCE,
    FLASHLIGHT_FLICKER_RATE,
    FLASHLIGHT_FLICKER_MIN_HOLD,
    FLASHLIGHT_FLICKER_MAX_HOLD,
    FLASHLIGHT_FLICKER_MIN_INTENSITY,
    FLASHLIGHT_FLICKER_MAX_INTENSITY,
    FLASHLIGHT_FLICKER_DROP_CHANCE,
    FLASHLIGHT_BOUNCE_EMA_HALF_LIFE,
    FLASHLIGHT_BOUNCE_POSITION_EMA_HALF_LIFE,
    TWO_PI,
  } = config;

  const flashlightRaycaster = new THREE.Raycaster();
  const flashlightBounceOrigin = new THREE.Vector3();
  const flashlightBounceDirection = new THREE.Vector3();
  const flashlightHitDirection = new THREE.Vector3();
  const flashlightTargetWorld = new THREE.Vector3();
  const flashlightBounceNormal = new THREE.Vector3();
  const flashlightBounceColor = new THREE.Color();
  const flashlightBounceTargetColor = new THREE.Color();
  const flashlightBounceTargetPosition = new THREE.Vector3();
  const flashlightBounceSmoothedColor = new THREE.Color();
  const flashlightBounceSmoothedPosition = new THREE.Vector3();
  const bounceLightDebugPosition = new THREE.Vector3();

  let flashlightFlickerTarget = 1;
  let flashlightFlickerValue = 1;
  let flashlightFlickerTimer = 0;
  let flashlightBounceSmoothedIntensity = 0;
  let flashlightBounceEmaInitialized = false;
  let bounceLightDebugHasHit = false;
  let bounceLightDebugEnabled = false;

  function reset() {
    flashlightFlickerTarget = 1;
    flashlightFlickerValue = 1;
    flashlightFlickerTimer = 0;
    flashlightBounceSmoothedIntensity = 0;
    flashlightBounceEmaInitialized = false;
    bounceLightDebugHasHit = false;
    hideFlashlightBounceLight();
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

    const metalness = THREE.MathUtils.clamp(sourceMaterial.metalness ?? 0, 0, 1);
    flashlightBounceColor.multiplyScalar(1 - metalness);
    flashlightBounceColor.r = THREE.MathUtils.clamp(flashlightBounceColor.r, 0, 1);
    flashlightBounceColor.g = THREE.MathUtils.clamp(flashlightBounceColor.g, 0, 1);
    flashlightBounceColor.b = THREE.MathUtils.clamp(flashlightBounceColor.b, 0, 1);
    return flashlightBounceColor;
  }

  function updateFlashlightFlicker(deltaSeconds, { isTopDownView }) {
    if (!isFlashlightEmissionActive() || isTopDownView) {
      flashlight.intensity = 0;
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
      (flashlightFlickerTarget - flashlightFlickerValue) *
      Math.min(1, deltaSeconds * FLASHLIGHT_FLICKER_RATE);
    flashlight.intensity = FLASHLIGHT_BASE_INTENSITY * flashlightFlickerValue;
    flashlight.distance = FLASHLIGHT_BASE_DISTANCE * (0.85 + flashlightFlickerValue * 0.15);
  }

  function hideFlashlightBounceLight() {
    flashlightBounceLight.intensity = 0;
    syncBounceLightDebugMarker();
  }

  function computeSpotAttenuation(angleCos, spotLight) {
    const penumbra = THREE.MathUtils.clamp(spotLight.penumbra ?? 0, 0, 1);
    const outerCos = Math.cos(spotLight.angle);
    const innerCos = Math.cos(spotLight.angle * (1 - penumbra));

    if (angleCos <= outerCos) return 0;
    if (angleCos >= innerCos) return 1;

    const t = (angleCos - outerCos) / Math.max(innerCos - outerCos, 0.00001);
    return t * t * (3 - 2 * t);
  }

  function computeRangeAttenuation(lightDistance, cutoffDistance) {
    if (!(cutoffDistance > 0)) return 1;
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

  function updateFlashlightBounceEma(targetColor, targetIntensity, targetPosition, deltaSeconds) {
    if (!flashlightBounceEmaInitialized) {
      flashlightBounceSmoothedColor.copy(targetColor);
      flashlightBounceSmoothedIntensity = targetIntensity;
      if (targetPosition) {
        flashlightBounceSmoothedPosition.copy(targetPosition);
      } else {
        flashlightBounceSmoothedPosition.copy(flashlightBounceLight.position);
      }
      flashlightBounceEmaInitialized = true;
      return;
    }

    const blend = computeEmaBlend(deltaSeconds, FLASHLIGHT_BOUNCE_EMA_HALF_LIFE);
    flashlightBounceSmoothedColor.lerp(targetColor, blend);
    flashlightBounceSmoothedIntensity +=
      (targetIntensity - flashlightBounceSmoothedIntensity) * blend;
    if (targetPosition) {
      const positionBlend = computeEmaBlend(
        deltaSeconds,
        FLASHLIGHT_BOUNCE_POSITION_EMA_HALF_LIFE,
      );
      flashlightBounceSmoothedPosition.lerp(targetPosition, positionBlend);
    }
  }

  function fadeBounceToOff(deltaSeconds) {
    updateFlashlightBounceEma(flashlightBounceSmoothedColor, 0, null, deltaSeconds);
    if (flashlightBounceSmoothedIntensity <= 0.0005) {
      hideFlashlightBounceLight();
      return;
    }
    flashlightBounceLight.color.copy(flashlightBounceSmoothedColor);
    flashlightBounceLight.intensity = flashlightBounceSmoothedIntensity;
    syncBounceLightDebugMarker();
  }

  function updateFlashlightBounceLight(deltaSeconds, { isTopDownView, hasWon }) {
    if (!isFlashlightEmissionActive() || isTopDownView || hasWon) {
      bounceLightDebugHasHit = false;
      hideFlashlightBounceLight();
      flashlightBounceEmaInitialized = false;
      flashlightBounceSmoothedIntensity = 0;
      return;
    }

    flashlight.getWorldPosition(flashlightBounceOrigin);
    flashlightTarget.getWorldPosition(flashlightTargetWorld);
    flashlightBounceDirection.subVectors(flashlightTargetWorld, flashlightBounceOrigin);
    if (flashlightBounceDirection.lengthSq() < 0.000001) {
      bounceLightDebugHasHit = false;
      hideFlashlightBounceLight();
      return;
    }

    flashlightBounceDirection.normalize();
    flashlightRaycaster.set(flashlightBounceOrigin, flashlightBounceDirection);
    flashlightRaycaster.far = flashlight.distance > 0 ? flashlight.distance : Infinity;

    const intersections = flashlightRaycaster.intersectObjects(getBounceTargets(), false);
    if (!intersections.length) {
      bounceLightDebugHasHit = false;
      syncBounceLightDebugMarker();
      fadeBounceToOff(deltaSeconds);
      return;
    }

    const hit = intersections[0];
    flashlightHitDirection.subVectors(hit.point, flashlightBounceOrigin);
    const hitDistance = flashlightHitDirection.length();
    if (hitDistance > 0.00001) {
      flashlightHitDirection.multiplyScalar(1 / hitDistance);
      bounceLightDebugHasHit = true;
      bounceLightDebugPosition.copy(hit.point).addScaledVector(flashlightHitDirection, -0.06);
    } else {
      bounceLightDebugHasHit = false;
    }
    syncBounceLightDebugMarker();

    if (!hit.face) {
      fadeBounceToOff(deltaSeconds);
      return;
    }

    flashlightBounceNormal.copy(hit.normal).transformDirection(hit.object.matrixWorld).normalize();
    if (hitDistance <= 0.00001) {
      hideFlashlightBounceLight();
      return;
    }

    const incidenceCos = Math.max(-flashlightBounceNormal.dot(flashlightHitDirection), 0);
    if (incidenceCos <= 0) {
      fadeBounceToOff(deltaSeconds);
      return;
    }

    const angleCos = THREE.MathUtils.clamp(
      flashlightBounceDirection.dot(flashlightHitDirection),
      -1,
      1,
    );
    const spotAttenuation = computeSpotAttenuation(angleCos, flashlight);
    if (spotAttenuation <= 0) {
      fadeBounceToOff(deltaSeconds);
      return;
    }

    const rangeAttenuation = computeRangeAttenuation(hitDistance, flashlight.distance);
    const coneSolidAngle = TWO_PI * (1 - Math.cos(flashlight.angle));
    const incidentFlux = flashlight.intensity * coneSolidAngle * spotAttenuation * rangeAttenuation;
    const bounceIntensity = (incidentFlux * incidenceCos) / TWO_PI;
    flashlightBounceTargetColor.copy(
      resolveMaterialBounceReflectance(
        Array.isArray(hit.object.material)
          ? hit.object.material[hit.face?.materialIndex ?? 0]
          : hit.object.material,
      ),
    );
    flashlightBounceTargetPosition.copy(hit.point).addScaledVector(flashlightBounceNormal, 0.08);
    updateFlashlightBounceEma(
      flashlightBounceTargetColor,
      bounceIntensity,
      flashlightBounceTargetPosition,
      deltaSeconds,
    );

    flashlightBounceLight.position.copy(flashlightBounceSmoothedPosition);
    flashlightBounceLight.color.copy(flashlightBounceSmoothedColor);
    flashlightBounceLight.intensity = flashlightBounceSmoothedIntensity;
    bounceLightDebugHasHit = true;
    bounceLightDebugPosition.copy(flashlightBounceLight.position);
    syncBounceLightDebugMarker();
  }

  function syncBounceLightDebugMarker() {
    if (!bounceLightDebugEnabled || !bounceLightDebugHasHit) {
      bounceLightDebugMarker.visible = false;
      return;
    }
    bounceLightDebugMarker.visible = true;
    bounceLightDebugMarker.position.copy(bounceLightDebugPosition);
  }

  function toggleBounceLightDebugMarker() {
    bounceLightDebugEnabled = !bounceLightDebugEnabled;
    syncBounceLightDebugMarker();
    setStatus(
      bounceLightDebugEnabled
        ? "Bounce-light debug marker on. Press B to hide."
        : "Bounce-light debug marker off. Press B to show.",
    );
  }

  return {
    reset,
    updateFlashlightFlicker,
    updateFlashlightBounceLight,
    toggleBounceLightDebugMarker,
  };
}
