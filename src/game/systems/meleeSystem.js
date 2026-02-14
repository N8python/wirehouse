export function createMeleeSystem({
  THREE,
  constants,
  camera,
  getWorldSurfaces,
  propScatter,
  pickupSystem,
  inventoryLeftHandRig,
  getSelectedInventoryItem,
  getWireman,
  setStatus,
  playMeleeMissSound,
  playMeleeHitWallSound,
  playMeleeHitWiremanSound,
  playKnifeHitWiremanSound,
}) {
  const { MELEE_WEAPON_CONFIG } = constants;
  const MELEE_COOLDOWN_IDLE_DROP_Y = 2;
  const MELEE_COOLDOWN_OFFSET_HALF_LIFE_SECONDS = 0.05;

  const meleeRaycaster = new THREE.Raycaster();
  const meleeAttackForward = new THREE.Vector3();

  let meleeCooldownRemaining = 0;
  let meleeCooldownDuration = 0;
  let meleeCooldownVisualOffsetY = 0;
  let meleeSwingElapsed = 0;
  let meleeSwingDuration = 0;
  let meleeSwingActive = false;
  let meleeSwingWeaponId = null;

  function reset() {
    meleeCooldownRemaining = 0;
    meleeCooldownDuration = 0;
    meleeCooldownVisualOffsetY = 0;
    meleeSwingElapsed = 0;
    meleeSwingDuration = 0;
    meleeSwingActive = false;
    meleeSwingWeaponId = null;
  }

  function emaTowards(current, target, deltaSeconds, halfLifeSeconds) {
    const safeHalfLife = Math.max(0.0001, halfLifeSeconds);
    const blend = 1 - Math.pow(0.5, Math.max(0, deltaSeconds) / safeHalfLife);
    return current + (target - current) * blend;
  }

  function getMeleeWeaponConfig(itemId) {
    if (!itemId) {
      return null;
    }
    return MELEE_WEAPON_CONFIG[itemId] || null;
  }

  function getMeleeHitLabel(object) {
    let current = object;
    const { wallMesh, exitMarker } = getWorldSurfaces();
    while (current) {
      if (current.userData?.pickupName) {
        return current.userData.pickupName;
      }
      if (current === exitMarker) {
        return "exit marker";
      }
      current = current.parent;
    }

    if (object === wallMesh) {
      return "wall";
    }
    if (object?.name) {
      return object.name;
    }
    return "target";
  }

  function isWallHitObject(object) {
    const { wallMesh } = getWorldSurfaces();
    return object === wallMesh;
  }

  function resolveMeleeAttackDirection() {
    meleeAttackForward.set(0, 0, -1).applyQuaternion(camera.quaternion);
    if (meleeAttackForward.lengthSq() < 0.000001) {
      meleeAttackForward.set(0, 0, -1);
    }
    meleeAttackForward.normalize();
    return meleeAttackForward;
  }

  function performMeleeHitScan(weaponConfig, direction) {
    meleeRaycaster.set(camera.position, direction);
    meleeRaycaster.near = 0.05;
    meleeRaycaster.far = weaponConfig.range;

    const { wallMesh, exitMarker } = getWorldSurfaces();
    const targets = [wallMesh, exitMarker].filter(Boolean);
    if (propScatter.root?.children?.length) {
      targets.push(...propScatter.root.children);
    }
    if (pickupSystem.root?.children?.length) {
      targets.push(...pickupSystem.root.children);
    }
    if (!targets.length) {
      return null;
    }

    const intersections = meleeRaycaster.intersectObjects(targets, true);
    return intersections[0] || null;
  }

  function tryMeleeAttack() {
    const selectedItem = getSelectedInventoryItem();
    const weaponConfig = getMeleeWeaponConfig(selectedItem?.id);
    if (!weaponConfig) {
      return false;
    }
    if (meleeCooldownRemaining > 0) {
      return false;
    }

    meleeCooldownRemaining = weaponConfig.cooldownSeconds;
    meleeCooldownDuration = weaponConfig.cooldownSeconds;
    meleeSwingDuration = weaponConfig.swingDurationSeconds;
    meleeSwingElapsed = 0;
    meleeSwingActive = true;
    meleeSwingWeaponId = selectedItem.id;

    const direction = resolveMeleeAttackDirection();
    const hit = performMeleeHitScan(weaponConfig, direction);
    const wireman = getWireman?.();
    const wiremanHit = wireman?.raycastCapsule?.({
      origin: camera.position,
      direction,
      maxDistance: weaponConfig.range,
    });
    const canHitWiremanFirst = Boolean(
      wiremanHit && (!hit || wiremanHit.distance <= hit.distance + 0.0001),
    );
    if (canHitWiremanFirst) {
      const damageResult = wireman.applyDamage?.(weaponConfig.damage || 0, selectedItem.id);
      if (selectedItem?.id === "knife_01") {
        playKnifeHitWiremanSound?.();
      } else {
        playMeleeHitWiremanSound?.();
      }
      if (damageResult?.diedNow) {
        setStatus(`${weaponConfig.displayName} killed wireman.`);
      } else if (damageResult?.applied) {
        setStatus(
          `${weaponConfig.displayName} hit wireman for ${Math.round(
            damageResult.damageApplied,
          )}. (${Math.round(damageResult.health)}/${Math.round(damageResult.maxHealth)})`,
        );
      } else {
        setStatus(`${weaponConfig.displayName} hit wireman.`);
      }
      return true;
    }

    if (!hit) {
      playMeleeMissSound?.();
      setStatus(`${weaponConfig.displayName} missed.`);
      return true;
    }

    if (isWallHitObject(hit.object)) {
      playMeleeHitWallSound?.();
    }
    setStatus(`${weaponConfig.displayName} hit ${getMeleeHitLabel(hit.object)}.`);
    return true;
  }

  function updateMeleeAttack(deltaSeconds) {
    meleeCooldownRemaining = Math.max(0, meleeCooldownRemaining - deltaSeconds);
    if (meleeCooldownRemaining <= 0.0001) {
      meleeCooldownDuration = 0;
    }

    const selectedItem = getSelectedInventoryItem();
    const selectedWeaponConfig = getMeleeWeaponConfig(selectedItem?.id);
    let meleeCooldownTargetOffsetY = 0;
    if (
      selectedWeaponConfig &&
      !meleeSwingActive &&
      meleeCooldownRemaining > 0 &&
      meleeCooldownDuration > 0
    ) {
      const cooldownRatio = THREE.MathUtils.clamp(
        meleeCooldownRemaining / Math.max(0.0001, meleeCooldownDuration),
        0,
        1,
      );
      const cooldownBlend = THREE.MathUtils.smoothstep(cooldownRatio, 0, 1);
      meleeCooldownTargetOffsetY = -MELEE_COOLDOWN_IDLE_DROP_Y * cooldownBlend;
    }
    meleeCooldownVisualOffsetY = emaTowards(
      meleeCooldownVisualOffsetY,
      meleeCooldownTargetOffsetY,
      deltaSeconds,
      MELEE_COOLDOWN_OFFSET_HALF_LIFE_SECONDS,
    );
    if (selectedWeaponConfig) {
      inventoryLeftHandRig.position.y += meleeCooldownVisualOffsetY;
    }

    if (!meleeSwingActive) {
      return;
    }

    const weaponConfig = getMeleeWeaponConfig(meleeSwingWeaponId);
    if (!weaponConfig) {
      meleeSwingActive = false;
      meleeSwingElapsed = 0;
      meleeSwingDuration = 0;
      meleeSwingWeaponId = null;
      return;
    }

    meleeSwingElapsed += deltaSeconds;
    const duration = Math.max(meleeSwingDuration, 0.00001);
    const progress = THREE.MathUtils.clamp(meleeSwingElapsed / duration, 0, 1);
    const swingBlend = Math.sin(progress * Math.PI);
    const windupBlend = THREE.MathUtils.clamp((0.22 - progress) / 0.22, 0, 1);
    const animationBlend = swingBlend - windupBlend * 0.28;
    const positionOffset = weaponConfig.swingPositionOffset;
    const rotationOffset = weaponConfig.swingRotationOffset;

    inventoryLeftHandRig.position.x += positionOffset[0] * animationBlend;
    inventoryLeftHandRig.position.y += positionOffset[1] * animationBlend;
    inventoryLeftHandRig.position.z += positionOffset[2] * animationBlend;
    inventoryLeftHandRig.rotation.x += rotationOffset[0] * animationBlend;
    inventoryLeftHandRig.rotation.y += rotationOffset[1] * animationBlend;
    inventoryLeftHandRig.rotation.z += rotationOffset[2] * animationBlend;

    if (progress >= 1) {
      meleeSwingActive = false;
      meleeSwingElapsed = 0;
      meleeSwingDuration = 0;
      meleeSwingWeaponId = null;
    }
  }

  function getState() {
    return {
      meleeSwingActive,
      meleeCooldownRemaining,
      meleeSwingWeaponId,
    };
  }

  return {
    reset,
    getMeleeWeaponConfig,
    tryMeleeAttack,
    updateMeleeAttack,
    getState,
  };
}
