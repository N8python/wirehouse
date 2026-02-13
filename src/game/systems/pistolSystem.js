import { createPistolDecalSystem } from "./pistolDecalSystem.js";

export function createPistolSystem({
  THREE,
  DecalGeometry,
  constants,
  camera,
  scene,
  inventoryLeftHandRig,
  inventoryLeftHandItemAnchor,
  heldItemDisplay,
  getWorldSurfaces,
  propScatter,
  getSelectedInventoryItem,
  getInventory,
  updateInventoryHud,
  updatePickupPrompt,
  setStatus,
  bulletDecalLitMaterial,
  bulletDecalDebugMaterial,
  muzzleFlashTexture,
  pistolMuzzleFlashMaterial,
  pistolMuzzleFlashSprite,
  pistolMuzzleFlashLight,
  pistolHitDebugMarker,
}) {
  const {
    INVENTORY_MAX_ITEMS,
    PISTOL_ITEM_ID,
    BULLET_ITEM_ID,
    PISTOL_FIRE_RANGE,
    PISTOL_FIRE_COOLDOWN_SECONDS,
    PISTOL_RECOIL_RETURN_RATE,
    PISTOL_RECOIL_POSITION_KICK,
    PISTOL_RECOIL_ROTATION_KICK,
    PISTOL_MUZZLE_FLASH_FRAME_COUNT,
    PISTOL_MUZZLE_FLASH_FRAME_WIDTH,
    PISTOL_MUZZLE_FLASH_FALLBACK_LOCAL_POSITION,
    PISTOL_MUZZLE_FORWARD_WORLD_OFFSET,
    PISTOL_MUZZLE_FLASH_DURATION,
    PISTOL_PROP_DEBUG_MARKER_LIFETIME,
  } = constants;

  const pistolRaycaster = new THREE.Raycaster();
  const pistolMuzzleWorldPosition = new THREE.Vector3();
  const pistolMuzzleFallbackWorldPosition = new THREE.Vector3();
  const pistolMuzzleDirectionWorld = new THREE.Vector3();
  const pistolMuzzleDirectionLocal = new THREE.Vector3();
  const pistolMuzzleSupportLocalPoint = new THREE.Vector3();
  const pistolMuzzleBoundsCenter = new THREE.Vector3();
  const pistolMuzzleBoundsSize = new THREE.Vector3();
  const pistolMuzzleModelWorldQuaternion = new THREE.Quaternion();
  const pistolShotDirection = new THREE.Vector3();
  const pistolNearestPropDirection = new THREE.Vector3();
  const pistolNearestPropWorld = new THREE.Vector3();
  const pistolPropBounds = new THREE.Box3();
  const pistolPropCenter = new THREE.Vector3();

  const decalSystem = createPistolDecalSystem({
    THREE,
    DecalGeometry,
    constants,
    scene,
    pistolRaycaster,
    pistolHitDebugMarker,
    bulletDecalLitMaterial,
    bulletDecalDebugMaterial,
  });
  let pistolInfiniteAmmo = false;
  let pistolFireCooldownRemaining = 0;
  let pistolRecoilAmount = 0;
  let pistolMuzzleFlashRemaining = 0;
  let pistolImpactDebugEnabled = false;
  let pistolPropDebugMarkerRemaining = 0;
  let lastPistolHitInfo = null;

  function reset() {
    pistolInfiniteAmmo = false;
    pistolFireCooldownRemaining = 0;
    pistolRecoilAmount = 0;
    pistolMuzzleFlashRemaining = 0;
    pistolImpactDebugEnabled = false;
    pistolPropDebugMarkerRemaining = 0;
    lastPistolHitInfo = null;
    pistolHitDebugMarker.visible = false;
    pistolMuzzleFlashSprite.visible = false;
    pistolMuzzleFlashLight.visible = true;
    pistolMuzzleFlashLight.intensity = 0;
    pistolMuzzleFlashMaterial.opacity = 0;
    decalSystem.syncMaterials(pistolImpactDebugEnabled);
    decalSystem.clear();
  }

  function getBulletAmmoCount() {
    let count = 0;
    for (const item of getInventory()) {
      if (item?.id === BULLET_ITEM_ID) {
        count += 1;
      }
    }
    return count;
  }

  function consumeBulletAmmo() {
    const inventory = getInventory();
    for (let i = INVENTORY_MAX_ITEMS - 1; i >= 0; i -= 1) {
      if (inventory[i]?.id !== BULLET_ITEM_ID) {
        continue;
      }
      inventory[i] = null;
      return true;
    }
    return false;
  }

  function setPistolImpactDebugEnabled(enabled) {
    pistolImpactDebugEnabled = Boolean(enabled);
    decalSystem.syncMaterials(pistolImpactDebugEnabled);
    if (!pistolImpactDebugEnabled) {
      pistolHitDebugMarker.visible = false;
      pistolPropDebugMarkerRemaining = 0;
    }
  }

  function togglePistolImpactDebug() {
    setPistolImpactDebugEnabled(!pistolImpactDebugEnabled);
    setStatus(
      pistolImpactDebugEnabled
        ? "Pistol impact debug on. Decals/emphasis visible and prop hits are reported."
        : "Pistol impact debug off. Decals use dark-lit material.",
    );
  }

  function updatePistolPropDebugMarker(deltaSeconds, elapsed) {
    if (!pistolImpactDebugEnabled) {
      pistolHitDebugMarker.visible = false;
      pistolPropDebugMarkerRemaining = 0;
      return;
    }

    if (pistolPropDebugMarkerRemaining <= 0) {
      pistolHitDebugMarker.visible = false;
      return;
    }

    pistolPropDebugMarkerRemaining = Math.max(0, pistolPropDebugMarkerRemaining - deltaSeconds);
    const t = THREE.MathUtils.clamp(
      pistolPropDebugMarkerRemaining / PISTOL_PROP_DEBUG_MARKER_LIFETIME,
      0,
      1,
    );
    const pulse = 1 + Math.sin(elapsed * 35) * 0.12;
    const scale = (0.8 + t * 0.45) * pulse;
    pistolHitDebugMarker.scale.set(scale, scale, scale);
    pistolHitDebugMarker.visible = pistolPropDebugMarkerRemaining > 0;
  }

  function resolvePistolMuzzleWorldPosition() {
    const fallback = () => {
      pistolMuzzleFallbackWorldPosition.copy(PISTOL_MUZZLE_FLASH_FALLBACK_LOCAL_POSITION);
      inventoryLeftHandRig.localToWorld(pistolMuzzleFallbackWorldPosition);
      return pistolMuzzleFallbackWorldPosition;
    };

    if (heldItemDisplay.getHeldInventoryItemId() !== PISTOL_ITEM_ID) {
      return fallback();
    }

    const pistolModel = heldItemDisplay.getHeldInventoryModelById().get(PISTOL_ITEM_ID);
    if (!pistolModel || pistolModel.parent !== inventoryLeftHandItemAnchor) {
      return fallback();
    }

    const localBounds = pistolModel.userData.localBounds;
    if (!localBounds || localBounds.isEmpty()) {
      return fallback();
    }

    pistolMuzzleDirectionWorld.set(-0.15, 0.02, -1).applyQuaternion(camera.quaternion).normalize();
    pistolModel.getWorldQuaternion(pistolMuzzleModelWorldQuaternion);
    pistolMuzzleDirectionLocal
      .copy(pistolMuzzleDirectionWorld)
      .applyQuaternion(pistolMuzzleModelWorldQuaternion.invert())
      .normalize();
    if (pistolMuzzleDirectionLocal.lengthSq() < 0.000001) {
      pistolMuzzleDirectionLocal.set(0, 0, -1);
    }
    pistolMuzzleDirectionLocal.negate();

    localBounds.getCenter(pistolMuzzleBoundsCenter);
    localBounds.getSize(pistolMuzzleBoundsSize);
    pistolMuzzleSupportLocalPoint.copy(pistolMuzzleBoundsCenter);

    const ax = Math.abs(pistolMuzzleDirectionLocal.x);
    const ay = Math.abs(pistolMuzzleDirectionLocal.y);
    const az = Math.abs(pistolMuzzleDirectionLocal.z);
    if (ax >= ay && ax >= az) {
      pistolMuzzleSupportLocalPoint.x =
        pistolMuzzleDirectionLocal.x >= 0 ? localBounds.max.x : localBounds.min.x;
    } else if (ay >= az) {
      pistolMuzzleSupportLocalPoint.y =
        pistolMuzzleDirectionLocal.y >= 0 ? localBounds.max.y : localBounds.min.y;
    } else {
      pistolMuzzleSupportLocalPoint.z =
        pistolMuzzleDirectionLocal.z >= 0 ? localBounds.max.z : localBounds.min.z;
    }

    pistolMuzzleSupportLocalPoint.addScaledVector(pistolMuzzleDirectionLocal, -4);
    pistolMuzzleWorldPosition.copy(pistolMuzzleSupportLocalPoint);
    pistolModel.localToWorld(pistolMuzzleWorldPosition);
    pistolMuzzleWorldPosition.addScaledVector(
      pistolMuzzleDirectionWorld,
      PISTOL_MUZZLE_FORWARD_WORLD_OFFSET,
    );
    return pistolMuzzleWorldPosition;
  }

  function randomizePistolMuzzleFlashFrame() {
    const frameIndex = Math.floor(Math.random() * PISTOL_MUZZLE_FLASH_FRAME_COUNT);
    muzzleFlashTexture.offset.x = frameIndex * PISTOL_MUZZLE_FLASH_FRAME_WIDTH;
  }

  function updatePistolMuzzleFlashTransform() {
    const muzzleWorldPosition = resolvePistolMuzzleWorldPosition();
    pistolMuzzleFlashSprite.position.copy(muzzleWorldPosition);
    pistolMuzzleFlashLight.position.copy(muzzleWorldPosition);
  }

  function updatePistolVisualEffects(deltaSeconds, flags) {
    const { gameActive, isTopDownView } = flags;
    pistolRecoilAmount +=
      (0 - pistolRecoilAmount) * Math.min(1, deltaSeconds * PISTOL_RECOIL_RETURN_RATE);

    const selectedIsPistol = getSelectedInventoryItem()?.id === PISTOL_ITEM_ID;
    if (selectedIsPistol || pistolRecoilAmount > 0.0004) {
      inventoryLeftHandRig.position.x += PISTOL_RECOIL_POSITION_KICK.x * pistolRecoilAmount;
      inventoryLeftHandRig.position.y += PISTOL_RECOIL_POSITION_KICK.y * pistolRecoilAmount;
      inventoryLeftHandRig.position.z += PISTOL_RECOIL_POSITION_KICK.z * pistolRecoilAmount;
      inventoryLeftHandRig.rotation.x += PISTOL_RECOIL_ROTATION_KICK.x * pistolRecoilAmount;
      inventoryLeftHandRig.rotation.y += PISTOL_RECOIL_ROTATION_KICK.y * pistolRecoilAmount;
      inventoryLeftHandRig.rotation.z += PISTOL_RECOIL_ROTATION_KICK.z * pistolRecoilAmount;
    }

    updatePistolMuzzleFlashTransform();

    const flashVisible = pistolMuzzleFlashRemaining > 0 && gameActive && !isTopDownView;
    if (!flashVisible) {
      pistolMuzzleFlashMaterial.opacity = 0;
      pistolMuzzleFlashSprite.visible = false;
      pistolMuzzleFlashLight.intensity = 0;
      pistolMuzzleFlashRemaining = Math.max(0, pistolMuzzleFlashRemaining - deltaSeconds);
      return;
    }

    const normalizedLife = THREE.MathUtils.clamp(
      pistolMuzzleFlashRemaining / PISTOL_MUZZLE_FLASH_DURATION,
      0,
      1,
    );
    const strength = Math.max(0, Math.pow(normalizedLife, 0.38));
    const flashSize = 0.5 + strength * 0.5;

    pistolMuzzleFlashMaterial.opacity = 0.35 + strength * 0.5;
    pistolMuzzleFlashSprite.visible = true;
    pistolMuzzleFlashSprite.scale.set(flashSize, flashSize, flashSize);
    pistolMuzzleFlashLight.intensity = 1.2 + strength * 2.2;
    pistolMuzzleFlashLight.distance = 3.2 + strength * 2.8;
    pistolMuzzleFlashRemaining = Math.max(0, pistolMuzzleFlashRemaining - deltaSeconds);
  }

  function isDescendantOf(node, rootNode) {
    let current = node;
    while (current) {
      if (current === rootNode) {
        return true;
      }
      current = current.parent;
    }
    return false;
  }

  function getPropHitLabel(object) {
    let current = object;
    while (current && current !== propScatter.root) {
      const candidate = `${current.name || ""}`.trim();
      if (candidate && candidate.toLowerCase() !== "scene") {
        return candidate;
      }
      current = current.parent;
    }
    return "prop";
  }

  function describePistolHit(hit) {
    if (!hit?.object) {
      return null;
    }

    const target = hit.object;
    const { wallMesh, floorMesh, roofMesh } = getWorldSurfaces();
    if (target === wallMesh) {
      return { type: "wall", label: "wall", distance: hit.distance };
    }
    if (target === floorMesh) {
      return { type: "floor", label: "floor", distance: hit.distance };
    }
    if (target === roofMesh) {
      return { type: "ceiling", label: "ceiling", distance: hit.distance };
    }
    if (isDescendantOf(target, propScatter.root)) {
      return { type: "prop", label: getPropHitLabel(target), distance: hit.distance };
    }
    return { type: "surface", label: target.name || "surface", distance: hit.distance };
  }

  function resolvePistolShotDirection(directionOverride) {
    if (directionOverride?.isVector3) {
      pistolShotDirection.copy(directionOverride);
    } else {
      pistolShotDirection.set(0, 0, -1).applyQuaternion(camera.quaternion);
    }
    if (pistolShotDirection.lengthSq() < 0.000001) {
      pistolShotDirection.set(0, 0, -1);
    }
    pistolShotDirection.normalize();
    return pistolShotDirection;
  }

  function performPistolHitScan(directionOverride = null, targetsOverride = null, maxRangeOverride = null) {
    resolvePistolShotDirection(directionOverride);

    pistolRaycaster.set(camera.position, pistolShotDirection);
    pistolRaycaster.near = 0.05;
    const hasRangeOverride =
      maxRangeOverride === Infinity ||
      (Number.isFinite(maxRangeOverride) && maxRangeOverride > 0);
    pistolRaycaster.far = hasRangeOverride ? maxRangeOverride : PISTOL_FIRE_RANGE;

    const { wallMesh, floorMesh, roofMesh } = getWorldSurfaces();
    const targets = Array.isArray(targetsOverride)
      ? targetsOverride.filter(Boolean)
      : [wallMesh, floorMesh, roofMesh, ...(propScatter.root?.children || [])].filter(Boolean);
    if (!targets.length) {
      return null;
    }
    const intersections = pistolRaycaster.intersectObjects(targets, true);
    return intersections[0] || null;
  }

  function tryShootPistol(options = null) {
    const selectedItem = getSelectedInventoryItem();
    if (selectedItem?.id !== PISTOL_ITEM_ID) {
      return false;
    }
    const bypassCooldown = Boolean(options?.bypassCooldown);
    if (!bypassCooldown && pistolFireCooldownRemaining > 0) {
      return true;
    }

    if (!pistolInfiniteAmmo && !consumeBulletAmmo()) {
      if (pistolImpactDebugEnabled) {
        setStatus("Pistol empty (debug). Add bullets or press I for infinite ammo.");
      } else {
        setStatus("Pistol empty. Pick up bullets or press I for debug infinite ammo.");
      }
      return true;
    }

    pistolFireCooldownRemaining = PISTOL_FIRE_COOLDOWN_SECONDS;
    pistolRecoilAmount = Math.min(1, pistolRecoilAmount + 1);
    randomizePistolMuzzleFlashFrame();
    pistolMuzzleFlashRemaining = PISTOL_MUZZLE_FLASH_DURATION;

    const hit = performPistolHitScan(
      options?.direction || null,
      options?.targetsOverride || null,
      options?.maxRangeOverride ?? null,
    );
    let decalSpawned = false;
    if (hit) {
      decalSpawned = decalSystem.spawnBulletDecal(hit, pistolImpactDebugEnabled);
      if (decalSystem.recordDebugMarker(hit, pistolImpactDebugEnabled)) {
        pistolPropDebugMarkerRemaining = PISTOL_PROP_DEBUG_MARKER_LIFETIME;
      }
    }
    const hitInfo = describePistolHit(hit);

    lastPistolHitInfo = hitInfo
      ? {
          ...hitInfo,
          decalSpawned,
          infiniteAmmo: pistolInfiniteAmmo,
        }
      : {
          type: "miss",
          label: "none",
          distance: PISTOL_FIRE_RANGE,
          decalSpawned: false,
          infiniteAmmo: pistolInfiniteAmmo,
        };

    if (!pistolInfiniteAmmo) {
      updateInventoryHud();
      updatePickupPrompt();
    }

    if (pistolImpactDebugEnabled) {
      const ammoText = pistolInfiniteAmmo ? "inf" : `${getBulletAmmoCount()}`;
      if (hitInfo) {
        setStatus(
          `Pistol hit ${hitInfo.type} (${hitInfo.label}) @ ${hitInfo.distance.toFixed(2)}m | ammo: ${ammoText}`,
        );
      } else {
        setStatus(`Pistol missed | ammo: ${ammoText}`);
      }
      return true;
    }

    if (pistolInfiniteAmmo) {
      setStatus("Pistol fired (infinite debug ammo).");
      return true;
    }

    setStatus(`Pistol fired. Ammo left: ${getBulletAmmoCount()}.`);
    return true;
  }

  function tryShootPistolAtNearestProp() {
    const selectedItem = getSelectedInventoryItem();
    if (selectedItem?.id !== PISTOL_ITEM_ID) {
      return false;
    }

    let bestHitDistance = Infinity;
    let hasPropHit = false;
    const propTargets = propScatter.root?.children || [];

    for (const rootNode of propTargets) {
      pistolPropBounds.setFromObject(rootNode);
      if (pistolPropBounds.isEmpty()) {
        continue;
      }
      pistolPropBounds.getCenter(pistolPropCenter);
      pistolNearestPropWorld.copy(pistolPropCenter);
      pistolNearestPropDirection.subVectors(pistolNearestPropWorld, camera.position);
      const distSq = pistolNearestPropDirection.lengthSq();
      if (distSq <= 0.0001) {
        continue;
      }

      pistolNearestPropDirection.normalize();
      pistolRaycaster.set(camera.position, pistolNearestPropDirection);
      pistolRaycaster.near = 0.05;
      pistolRaycaster.far = Infinity;
      const propHits = pistolRaycaster.intersectObjects(propTargets, true);
      if (propHits.length && propHits[0].distance < bestHitDistance) {
        bestHitDistance = propHits[0].distance;
        hasPropHit = true;
        pistolNearestPropWorld.copy(propHits[0].point);
      }
    }

    if (!hasPropHit) {
      return false;
    }
    pistolNearestPropDirection.subVectors(pistolNearestPropWorld, camera.position).normalize();

    return tryShootPistol({
      direction: pistolNearestPropDirection,
      bypassCooldown: true,
      targetsOverride: propTargets,
      maxRangeOverride: Infinity,
    });
  }

  function update(deltaSeconds, flags) {
    pistolFireCooldownRemaining = Math.max(0, pistolFireCooldownRemaining - deltaSeconds);
    updatePistolVisualEffects(deltaSeconds, flags);
  }

  function setInfiniteAmmo(enabled) {
    pistolInfiniteAmmo = Boolean(enabled);
    return pistolInfiniteAmmo;
  }

  function getInfiniteAmmo() {
    return pistolInfiniteAmmo;
  }

  function getState() {
    return {
      pistolInfiniteAmmo,
      pistolFireCooldownRemaining,
      pistolImpactDebugEnabled,
      pistolRecoilAmount,
      pistolMuzzleFlashRemaining,
      bulletDecalCount: decalSystem.getCount(),
      lastPistolHitInfo,
    };
  }

  function getBulletDecals() {
    return decalSystem.getDecals();
  }

  return {
    reset,
    update,
    updatePistolPropDebugMarker,
    tryShootPistol,
    tryShootPistolAtNearestProp,
    togglePistolImpactDebug,
    setPistolImpactDebugEnabled,
    getState,
    getBulletAmmoCount,
    setInfiniteAmmo,
    getInfiniteAmmo,
    getBulletDecals,
  };
}
