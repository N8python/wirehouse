import { collectNearbyCells } from "../world/maze.js";
import { round } from "./utils.js";

export function createRenderGameToText({
  THREE,
  config,
  constants,
  camera,
  controls,
  getFlags,
  world,
  inventory,
  melee,
  pistol,
  health,
  wireman,
  flashlightState,
  isFlashlightEmissionActive,
  isFlashlightSuppressedByTwoHandedBat,
}) {
  const {
    PLAYER_MAX_HEALTH,
    PLAYER_MAX_STAMINA,
    INVENTORY_ROTATION_STEP_DEGREES,
    JERKY_ITEM_ID,
    FIRST_AID_KIT_ITEM_ID,
    SODA_CAN_ITEM_ID,
    JERKY_CONSUME_DURATION_SECONDS,
    JERKY_HEAL_AMOUNT,
    FIRST_AID_USE_DURATION_SECONDS,
    FIRST_AID_KIT_HEAL_AMOUNT,
    FIRST_AID_REGEN_PER_SECOND,
    FIRST_AID_REGEN_DURATION_SECONDS,
    SODA_USE_DURATION_SECONDS,
    SODA_SPEED_MULTIPLIER,
    SODA_SPEED_DURATION_SECONDS,
    PISTOL_FIRE_RANGE,
  } = constants;
  const { MAZE_COLS, MAZE_ROWS, CELL_SIZE } = config;

  return function renderGameToText() {
    const flags = getFlags();
    const rotation = new THREE.Euler().setFromQuaternion(camera.quaternion, "YXZ");
    const playerCell = world.worldToCell(camera.position.x, camera.position.z);
    const selectedInventoryItem = inventory.getSelectedInventoryItem();
    const selectedMeleeWeaponConfig = melee.getMeleeWeaponConfig(selectedInventoryItem?.id);
    const bulletAmmoCount = pistol.getBulletAmmoCount();
    const selectedIsPistol = selectedInventoryItem?.id === constants.PISTOL_ITEM_ID;
    const selectedIsJerky = selectedInventoryItem?.id === JERKY_ITEM_ID;
    const selectedIsFirstAidKit = selectedInventoryItem?.id === FIRST_AID_KIT_ITEM_ID;
    const selectedIsSodaCan = selectedInventoryItem?.id === SODA_CAN_ITEM_ID;
    const jerkyConsumeProgress = health.getJerkyConsumeProgress();
    const consumableUseProgress = health.getActiveConsumableUseProgress();
    const healthState = health.getState();
    const meleeState = melee.getState();
    const pistolState = pistol.getState();
    const activeJerkyConsume =
      healthState.jerkyConsumeActive && healthState.consumableUseItemId === JERKY_ITEM_ID;
    const healthRatio = PLAYER_MAX_HEALTH > 0 ? healthState.playerHealth / PLAYER_MAX_HEALTH : 0;
    const staminaRatio = PLAYER_MAX_STAMINA > 0 ? healthState.playerStamina / PLAYER_MAX_STAMINA : 0;
    const wiremanState = wireman?.getState?.() || null;
    const lastPistolHitPayload = pistolState.lastPistolHitInfo
      ? {
          ...pistolState.lastPistolHitInfo,
          distance: round(pistolState.lastPistolHitInfo.distance),
        }
      : null;

    return JSON.stringify({
      mode: flags.hasWon ? "cleared" : flags.gameActive ? "playing" : "paused",
      coordinateSystem:
        "Maze origin is at center of world. +x moves east (right), +z moves south (toward larger row), +y is up.",
      maze: {
        cols: MAZE_COLS,
        rows: MAZE_ROWS,
        cellSize: CELL_SIZE,
        start: world.getStartCell(),
        exit: world.getExitCell(),
      },
      player: {
        x: round(camera.position.x),
        y: round(camera.position.y),
        z: round(camera.position.z),
        col: playerCell.col,
        row: playerCell.row,
        yaw: round(rotation.y),
        pitch: round(rotation.x),
      },
      flags: {
        pointerLocked: controls.isLocked,
        won: flags.hasWon,
        gameActive: flags.gameActive,
        topDownView: flags.isTopDownView,
        flashlightOn: isFlashlightEmissionActive(),
        flashlightSuppressedByTwoHandedBat: isFlashlightSuppressedByTwoHandedBat(),
        flashlightModelLoaded: flashlightState.flashlightModelLoaded,
        sprinting: healthState.staminaSprintActive,
        meleeSwinging: meleeState.meleeSwingActive,
        meleeCooldownSeconds: round(meleeState.meleeCooldownRemaining),
        playerDead: healthState.playerHealth <= 0,
        pistolInfiniteAmmo: pistolState.pistolInfiniteAmmo,
        pistolCooldownSeconds: round(pistolState.pistolFireCooldownRemaining),
        pistolImpactDebug: pistolState.pistolImpactDebugEnabled,
        pistolRecoil: round(pistolState.pistolRecoilAmount),
        pistolMuzzleFlash: round(pistolState.pistolMuzzleFlashRemaining),
        jerkyConsumeActive: activeJerkyConsume,
        jerkyConsumeProgress: round(jerkyConsumeProgress),
        consumableUseActive: healthState.jerkyConsumeActive,
        consumableUseItemId: healthState.consumableUseItemId,
        consumableUseProgress: round(consumableUseProgress),
        sodaBoostSeconds: round(healthState.sodaSpeedBoostRemaining),
        firstAidRegenSeconds: round(healthState.firstAidRegenRemaining),
        speedMultiplier: round(health.getPlayerSpeedMultiplier()),
        lowStaminaHeartbeatBoost: healthState.lowStaminaHeartbeatBoostActive,
      },
      health: {
        current: round(healthState.playerHealth),
        trail: round(healthState.playerHealthDamageTrail),
        max: PLAYER_MAX_HEALTH,
        ratio: round(healthRatio),
        percent: round(healthRatio * 100),
        trailPercent: round(
          (PLAYER_MAX_HEALTH > 0 ? healthState.playerHealthDamageTrail / PLAYER_MAX_HEALTH : 0) * 100,
        ),
      },
      stamina: {
        current: round(healthState.playerStamina),
        max: PLAYER_MAX_STAMINA,
        ratio: round(staminaRatio),
        percent: round(staminaRatio * 100),
        regenDelaySeconds: round(healthState.staminaRegenDelayRemaining),
      },
      ammo: {
        bulletCount: bulletAmmoCount,
        pistolInfinite: pistolState.pistolInfiniteAmmo,
      },
      decals: {
        bulletCount: pistolState.bulletDecalCount,
      },
      pistol: {
        lastHit: lastPistolHitPayload,
      },
      wireman: wiremanState
        ? {
            loaded: Boolean(wiremanState.loaded),
            loadFailed: Boolean(wiremanState.loadFailed),
            moving: Boolean(wiremanState.moving),
            sprinting: Boolean(wiremanState.sprinting),
            lineOfSightToPlayer: Boolean(wiremanState.lineOfSightToPlayer),
            animation: wiremanState.animation || null,
            position: wiremanState.position
              ? {
                  x: round(wiremanState.position.x),
                  y: round(wiremanState.position.y),
                  z: round(wiremanState.position.z),
                }
              : null,
            cell: wiremanState.cell || null,
            pathLength: wiremanState.pathLength ?? 0,
            pathIndex: wiremanState.pathIndex ?? 0,
            goalCell: wiremanState.goalCell || null,
            distanceToPlayer: round(wiremanState.distanceToPlayer || 0),
            distanceToGoal: round(wiremanState.distanceToGoal || 0),
          }
        : null,
      inventory: inventory.getInventory().flatMap((item, index) =>
        item
          ? [
              {
                slot: index + 1,
                id: item.id,
                name: item.name,
              },
            ]
          : [],
      ),
      selectedInventory: selectedInventoryItem
        ? {
            slot: inventory.getSelectedInventorySlotIndex() + 1,
            id: selectedInventoryItem.id,
            name: selectedInventoryItem.name,
            meleeAttack:
              selectedMeleeWeaponConfig
                ? {
                    range: selectedMeleeWeaponConfig.range,
                    cooldownSeconds: selectedMeleeWeaponConfig.cooldownSeconds,
                  }
                : null,
            pistol:
              selectedIsPistol
                ? {
                    range: PISTOL_FIRE_RANGE,
                    infiniteAmmo: pistolState.pistolInfiniteAmmo,
                    ammo: bulletAmmoCount,
                  }
                : null,
            consumable:
              selectedIsJerky
                ? {
                    type: "jerky",
                    holdDurationSeconds: JERKY_CONSUME_DURATION_SECONDS,
                    healAmount: JERKY_HEAL_AMOUNT,
                    holdProgress: round(jerkyConsumeProgress),
                    active: activeJerkyConsume,
                  }
                : selectedIsFirstAidKit
                  ? {
                      type: "first_aid_kit",
                      consumeDurationSeconds: FIRST_AID_USE_DURATION_SECONDS,
                      instantHealAmount: FIRST_AID_KIT_HEAL_AMOUNT,
                      regenPerSecond: FIRST_AID_REGEN_PER_SECOND,
                      regenDurationSeconds: FIRST_AID_REGEN_DURATION_SECONDS,
                      activeRegenSeconds: round(healthState.firstAidRegenRemaining),
                      holdProgress:
                        healthState.jerkyConsumeActive &&
                        healthState.consumableUseItemId === FIRST_AID_KIT_ITEM_ID
                          ? round(consumableUseProgress)
                          : 0,
                      activeUse:
                        healthState.jerkyConsumeActive &&
                        healthState.consumableUseItemId === FIRST_AID_KIT_ITEM_ID,
                    }
                  : selectedIsSodaCan
                    ? {
                        type: "soda_can",
                        consumeDurationSeconds: SODA_USE_DURATION_SECONDS,
                        speedMultiplier: SODA_SPEED_MULTIPLIER,
                        durationSeconds: SODA_SPEED_DURATION_SECONDS,
                        activeSpeedBoostSeconds: round(healthState.sodaSpeedBoostRemaining),
                        holdProgress:
                          healthState.jerkyConsumeActive &&
                          healthState.consumableUseItemId === SODA_CAN_ITEM_ID
                            ? round(consumableUseProgress)
                            : 0,
                        activeUse:
                          healthState.jerkyConsumeActive &&
                          healthState.consumableUseItemId === SODA_CAN_ITEM_ID,
                      }
                    : null,
            wheelRotationDegrees: round(
              inventory.normalizeInventorySlotIndex(inventory.getInventoryWheelRotationSteps()) *
                INVENTORY_ROTATION_STEP_DEGREES,
            ),
          }
        : null,
      nearby: collectNearbyCells({
        maze: world.getMaze(),
        exitCell: world.getExitCell(),
        cols: MAZE_COLS,
        rows: MAZE_ROWS,
        centerCol: playerCell.col,
        centerRow: playerCell.row,
        radius: 2,
      }),
    });
  };
}
