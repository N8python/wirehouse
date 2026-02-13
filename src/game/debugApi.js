import * as THREE from "three";
import { round } from "./utils.js";

export function configureDebugApis({
  constants,
  update,
  render,
  renderGameToText,
  inventory,
  pistol,
  health,
  runtime,
}) {
  window.render_game_to_text = renderGameToText;
  window.advanceTime = (ms) => {
    const seconds = Math.max(0, Number(ms) || 0) / 1000;
    const stepCount = Math.max(1, Math.round(seconds / (1 / 60)));
    const fixedStep = seconds / stepCount;
    for (let i = 0; i < stepCount; i++) {
      update(fixedStep);
    }
    render();
  };
  window.__debugGrantInventory = inventory.grantDebugInventory;
  window.__debugRotateInventory = inventory.rotateInventoryWheel;
  window.__debugGetSelectedInventoryId = () => inventory.getSelectedInventoryItem()?.id || null;
  window.__debugSetPistolInfiniteAmmo = (enabled) => pistol.setInfiniteAmmo(enabled);
  window.__debugGetPistolInfiniteAmmo = () => pistol.getInfiniteAmmo();
  window.__debugGetBulletAmmoCount = pistol.getBulletAmmoCount;
  window.__debugGetBulletDecalCount = () => pistol.getState().bulletDecalCount;
  window.__debugGetBulletDecalMaterialType = () => pistol.getBulletDecals()[0]?.material?.type || null;
  window.__debugSetPistolImpactDebug = (enabled) => {
    pistol.setPistolImpactDebugEnabled(Boolean(enabled));
    return pistol.getState().pistolImpactDebugEnabled;
  };
  window.__debugGetPistolImpactDebug = () => pistol.getState().pistolImpactDebugEnabled;
  window.__debugGetLastPistolHit = () => pistol.getState().lastPistolHitInfo || null;
  window.__debugShootPistolDirection = (x, y, z, bypassCooldown = true) => {
    const nx = Number(x);
    const ny = Number(y);
    const nz = Number(z);
    if (!Number.isFinite(nx) || !Number.isFinite(ny) || !Number.isFinite(nz)) {
      return false;
    }
    return pistol.tryShootPistol({
      direction: new THREE.Vector3(nx, ny, nz),
      bypassCooldown: Boolean(bypassCooldown),
    });
  };
  window.__debugShootPistolAtNearestProp = () => pistol.tryShootPistolAtNearestProp();
  window.__debugGetMuzzleFlashLightState = () => ({
    visible: runtime.pistolMuzzleFlashLight.visible,
    intensity: round(runtime.pistolMuzzleFlashLight.intensity),
    distance: round(runtime.pistolMuzzleFlashLight.distance),
    x: round(runtime.pistolMuzzleFlashLight.position.x),
    y: round(runtime.pistolMuzzleFlashLight.position.y),
    z: round(runtime.pistolMuzzleFlashLight.position.z),
  });
  window.__debugGetMuzzleFlashSpriteWorldPosition = () => ({
    visible: runtime.pistolMuzzleFlashSprite.visible,
    opacity: round(runtime.pistolMuzzleFlashMaterial.opacity),
    x: round(runtime.pistolMuzzleFlashSprite.position.x),
    y: round(runtime.pistolMuzzleFlashSprite.position.y),
    z: round(runtime.pistolMuzzleFlashSprite.position.z),
  });
  window.__debugGetMuzzleFlashFrame = () =>
    Math.round(runtime.muzzleFlashTexture.offset.x / constants.PISTOL_MUZZLE_FLASH_FRAME_WIDTH);
  window.__debugGetPlayerHealth = () => {
    const state = health.getState();
    return {
      current: round(state.playerHealth),
      trail: round(state.playerHealthDamageTrail),
      max: constants.PLAYER_MAX_HEALTH,
      ratio: round(state.playerHealth / constants.PLAYER_MAX_HEALTH),
      trailRatio: round(state.playerHealthDamageTrail / constants.PLAYER_MAX_HEALTH),
    };
  };
  window.__debugSetPlayerHealth = (value) => {
    health.setPlayerHealth(Number(value));
    return health.getState().playerHealth;
  };
  window.__debugDamagePlayer = (amount = constants.PLAYER_TEST_DAMAGE_PER_PRESS) => {
    health.applyPlayerDamage(Number(amount), "debug");
    return health.getState().playerHealth;
  };
  window.__debugGetJerkyConsumeState = () => {
    const state = health.getState();
    const jerkyActive = state.jerkyConsumeActive && state.consumableUseItemId === constants.JERKY_ITEM_ID;
    return {
      active: jerkyActive,
      elapsed: round(jerkyActive ? state.jerkyConsumeElapsed : 0),
      progress: round(health.getJerkyConsumeProgress()),
      itemId: state.consumableUseItemId,
    };
  };
  window.__debugGetConsumableEffects = () => {
    const state = health.getState();
    return {
      sodaSpeedBoostRemaining: round(state.sodaSpeedBoostRemaining),
      firstAidRegenRemaining: round(state.firstAidRegenRemaining),
      speedMultiplier: round(health.getPlayerSpeedMultiplier()),
      consumableUseRemaining: round(
        state.jerkyConsumeActive ? Math.max(0, state.consumableUseDuration - state.jerkyConsumeElapsed) : 0,
      ),
    };
  };
  window.__debugGetHeldItemAnchorOffset = () => ({
    x: round(runtime.inventoryLeftHandItemAnchor.position.x),
    y: round(runtime.inventoryLeftHandItemAnchor.position.y),
    z: round(runtime.inventoryLeftHandItemAnchor.position.z),
  });
}
