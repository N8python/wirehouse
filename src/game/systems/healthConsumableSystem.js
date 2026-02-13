export function createHealthConsumableSystem({
  THREE,
  constants,
  config,
  dom,
  controls,
  canUsePointerLock,
  inventoryLeftHandItemAnchor,
  removeInventoryItemById,
  getSelectedInventoryItem,
  updateInventoryHud,
  updatePickupPrompt,
  setStatus,
}) {
  const {
    PLAYER_MAX_HEALTH,
    HEALTH_DAMAGE_TRAIL_DECAY_RATE,
    HEALTH_DAMAGE_TRAIL_MIN_DELTA,
    HEALTH_DAMAGE_TRAIL_HOLD_SECONDS,
    JERKY_ITEM_ID,
    JERKY_HEAL_AMOUNT,
    JERKY_CONSUME_DURATION_SECONDS,
    JERKY_EAT_BOB_FREQUENCY,
    JERKY_EAT_BOB_AMPLITUDE,
    JERKY_EAT_BOB_DEPTH,
    FIRST_AID_KIT_ITEM_ID,
    FIRST_AID_KIT_HEAL_AMOUNT,
    FIRST_AID_USE_DURATION_SECONDS,
    FIRST_AID_REGEN_DURATION_SECONDS,
    FIRST_AID_REGEN_PER_SECOND,
    SODA_CAN_ITEM_ID,
    SODA_SPEED_MULTIPLIER,
    SODA_USE_DURATION_SECONDS,
    SODA_SPEED_DURATION_SECONDS,
    HEALTH_HEARTBEAT_CYCLE_SECONDS,
    HEALTH_HEARTBEAT_PRIMARY_TIME,
    HEALTH_HEARTBEAT_SECONDARY_TIME,
    HEALTH_HEARTBEAT_PRIMARY_AMPLITUDE,
    HEALTH_HEARTBEAT_SECONDARY_AMPLITUDE,
    HEALTH_HEARTBEAT_WIDTH,
  } = constants;
  const { TWO_PI } = config;
  const {
    healthRingFill,
    healthRingLoss,
    healthHeartImage,
    consumeProgress,
    consumeProgressFill,
    consumeProgressLabel,
    sodaBoostIndicator,
    sodaBoostTimer,
    regenIndicator,
    regenTimer,
  } = dom;

  let playerHealth = PLAYER_MAX_HEALTH;
  let playerHealthDamageTrail = PLAYER_MAX_HEALTH;
  let playerHealthDamageTrailHoldRemaining = 0;
  let jerkyConsumeActive = false;
  let jerkyConsumeElapsed = 0;
  let consumableUseItemId = null;
  let consumableUseDuration = 0;
  let consumableUseLabel = "";
  let firstAidRegenRemaining = 0;
  let sodaSpeedBoostRemaining = 0;

  function reset() {
    setPlayerHealth(PLAYER_MAX_HEALTH);
    cancelJerkyConsume();
    firstAidRegenRemaining = 0;
    sodaSpeedBoostRemaining = 0;
    updateBuffHud();
  }

  function clampPlayerHealth(value) {
    if (!Number.isFinite(value)) {
      return playerHealth;
    }
    return Math.max(0, Math.min(PLAYER_MAX_HEALTH, value));
  }

  function updateHealthHud() {
    const healthRatio = PLAYER_MAX_HEALTH > 0 ? playerHealth / PLAYER_MAX_HEALTH : 0;
    const healthPercent = Math.max(0, Math.min(100, healthRatio * 100));
    const healthTrailRatio =
      PLAYER_MAX_HEALTH > 0 ? playerHealthDamageTrail / PLAYER_MAX_HEALTH : 0;
    const healthTrailPercent = Math.max(
      healthPercent,
      Math.max(0, Math.min(100, healthTrailRatio * 100)),
    );

    if (healthRingFill) {
      healthRingFill.style.setProperty("--health-progress", healthPercent.toFixed(3));
    }
    if (healthRingLoss) {
      healthRingLoss.style.setProperty("--health-progress", healthPercent.toFixed(3));
      healthRingLoss.style.setProperty("--health-loss-progress", healthTrailPercent.toFixed(3));
    }
  }

  function setPlayerHealth(nextHealth) {
    const previousHealth = playerHealth;
    const clampedHealth = clampPlayerHealth(nextHealth);
    if (clampedHealth < previousHealth) {
      playerHealthDamageTrail = Math.max(playerHealthDamageTrail, previousHealth);
      playerHealthDamageTrailHoldRemaining = HEALTH_DAMAGE_TRAIL_HOLD_SECONDS;
    } else if (clampedHealth >= previousHealth) {
      playerHealthDamageTrail = clampedHealth;
      playerHealthDamageTrailHoldRemaining = 0;
    }
    playerHealth = clampedHealth;
    updateHealthHud();
  }

  function updateHealthDamageTrail(deltaSeconds) {
    if (playerHealthDamageTrail <= playerHealth) {
      playerHealthDamageTrail = playerHealth;
      return;
    }
    if (playerHealthDamageTrailHoldRemaining > 0) {
      playerHealthDamageTrailHoldRemaining = Math.max(
        0,
        playerHealthDamageTrailHoldRemaining - deltaSeconds,
      );
      return;
    }
    const clampedDeltaSeconds = Math.max(0, deltaSeconds);
    const trailDelta = playerHealthDamageTrail - playerHealth;
    const decayFactor = Math.exp(-HEALTH_DAMAGE_TRAIL_DECAY_RATE * clampedDeltaSeconds);
    const nextTrail = playerHealth + trailDelta * decayFactor;
    playerHealthDamageTrail =
      nextTrail - playerHealth <= HEALTH_DAMAGE_TRAIL_MIN_DELTA ? playerHealth : nextTrail;
    updateHealthHud();
  }

  function getActiveConsumableUseProgress() {
    if (!jerkyConsumeActive || consumableUseDuration <= 0) {
      return 0;
    }
    return THREE.MathUtils.clamp(jerkyConsumeElapsed / consumableUseDuration, 0, 1);
  }

  function getJerkyConsumeProgress() {
    if (!jerkyConsumeActive || consumableUseItemId !== JERKY_ITEM_ID) {
      return 0;
    }
    return getActiveConsumableUseProgress();
  }

  function updateJerkyConsumeHud() {
    const progress = getActiveConsumableUseProgress();
    if (consumeProgress) {
      consumeProgress.classList.toggle("active", jerkyConsumeActive);
    }
    if (consumeProgressFill) {
      consumeProgressFill.style.width = `${(progress * 100).toFixed(2)}%`;
    }
    if (consumeProgressLabel) {
      consumeProgressLabel.textContent = jerkyConsumeActive ? consumableUseLabel : "";
    }
  }

  function getPlayerSpeedMultiplier() {
    return sodaSpeedBoostRemaining > 0 ? SODA_SPEED_MULTIPLIER : 1;
  }

  function updateTimedBuffIndicator(indicator, timerNode, active, remainingSeconds) {
    if (!indicator) return;
    indicator.classList.toggle("active", active);
    if (!timerNode) return;
    timerNode.textContent = active ? `${Math.ceil(remainingSeconds)}s` : "";
  }

  function updateBuffHud() {
    updateTimedBuffIndicator(
      sodaBoostIndicator,
      sodaBoostTimer,
      sodaSpeedBoostRemaining > 0,
      sodaSpeedBoostRemaining,
    );
    updateTimedBuffIndicator(
      regenIndicator,
      regenTimer,
      firstAidRegenRemaining > 0,
      firstAidRegenRemaining,
    );
  }

  function useFirstAidKit() {
    if (!removeInventoryItemById(FIRST_AID_KIT_ITEM_ID)) {
      setStatus("First aid kit unavailable.");
      return false;
    }
    const previousHealth = playerHealth;
    setPlayerHealth(playerHealth + FIRST_AID_KIT_HEAL_AMOUNT);
    firstAidRegenRemaining = FIRST_AID_REGEN_DURATION_SECONDS;
    const healedAmount = Math.max(0, Math.round(playerHealth - previousHealth));
    updateInventoryHud();
    updatePickupPrompt();
    setStatus(
      `Used first aid kit. +${healedAmount} health. Regen active (${FIRST_AID_REGEN_PER_SECOND}/s for ${FIRST_AID_REGEN_DURATION_SECONDS}s).`,
    );
    return true;
  }

  function useSodaCan() {
    if (!removeInventoryItemById(SODA_CAN_ITEM_ID)) {
      setStatus("Soda can unavailable.");
      return false;
    }
    sodaSpeedBoostRemaining = SODA_SPEED_DURATION_SECONDS;
    updateInventoryHud();
    updatePickupPrompt();
    updateBuffHud();
    setStatus(`Drank soda. Speed boost active (+50% for ${SODA_SPEED_DURATION_SECONDS}s).`);
    return true;
  }

  function consumeJerkyAndHeal() {
    if (!removeInventoryItemById(JERKY_ITEM_ID)) {
      setStatus("Jerky use canceled (item missing).");
      updateInventoryHud();
      updatePickupPrompt();
      return false;
    }

    const previousHealth = playerHealth;
    setPlayerHealth(playerHealth + JERKY_HEAL_AMOUNT);
    const healedAmount = Math.max(0, Math.round(playerHealth - previousHealth));
    updateInventoryHud();
    updatePickupPrompt();
    setStatus(`Ate jerky. +${healedAmount} health.`);
    return true;
  }

  function getConsumableUseConfig(itemId) {
    if (itemId === JERKY_ITEM_ID) {
      return {
        itemId,
        durationSeconds: JERKY_CONSUME_DURATION_SECONDS,
        label: "Eating jerky...",
        cancelStatus: "Jerky use canceled.",
        onComplete: consumeJerkyAndHeal,
      };
    }
    if (itemId === FIRST_AID_KIT_ITEM_ID) {
      return {
        itemId,
        durationSeconds: FIRST_AID_USE_DURATION_SECONDS,
        label: "Using first aid kit...",
        cancelStatus: "First aid use canceled.",
        onComplete: useFirstAidKit,
      };
    }
    if (itemId === SODA_CAN_ITEM_ID) {
      return {
        itemId,
        durationSeconds: SODA_USE_DURATION_SECONDS,
        label: "Drinking soda...",
        cancelStatus: "Soda use canceled.",
        onComplete: useSodaCan,
      };
    }
    return null;
  }

  function getActiveConsumableCancelStatus() {
    const config = getConsumableUseConfig(consumableUseItemId);
    return config?.cancelStatus || "Consumable use canceled.";
  }

  function cancelJerkyConsume(statusText = null) {
    if (!jerkyConsumeActive && jerkyConsumeElapsed <= 0 && !consumableUseItemId) {
      return;
    }
    jerkyConsumeActive = false;
    jerkyConsumeElapsed = 0;
    consumableUseItemId = null;
    consumableUseDuration = 0;
    consumableUseLabel = "";
    updateJerkyConsumeHud();
    if (statusText) {
      setStatus(statusText);
    }
  }

  function tryStartJerkyConsume() {
    const selectedItem = getSelectedInventoryItem();
    const config = getConsumableUseConfig(selectedItem?.id);
    if (!config) {
      return false;
    }
    if (jerkyConsumeActive) {
      return consumableUseItemId === config.itemId;
    }
    jerkyConsumeActive = true;
    jerkyConsumeElapsed = 0;
    consumableUseItemId = config.itemId;
    consumableUseDuration = config.durationSeconds;
    consumableUseLabel = config.label;
    updateJerkyConsumeHud();
    setStatus(`${config.label} Keep holding left click.`);
    return true;
  }

  function updateJerkyConsume(deltaSeconds, flags) {
    const { gameActive, hasWon, isTopDownView } = flags;
    if (!jerkyConsumeActive) {
      return;
    }

    if (
      !gameActive ||
      hasWon ||
      isTopDownView ||
      (canUsePointerLock && !controls.isLocked) ||
      getSelectedInventoryItem()?.id !== consumableUseItemId
    ) {
      cancelJerkyConsume();
      return;
    }

    const config = getConsumableUseConfig(consumableUseItemId);
    if (!config) {
      cancelJerkyConsume();
      return;
    }

    jerkyConsumeElapsed += Math.max(0, deltaSeconds);
    if (jerkyConsumeElapsed >= consumableUseDuration) {
      jerkyConsumeActive = false;
      jerkyConsumeElapsed = consumableUseDuration;
      updateJerkyConsumeHud();
      consumableUseItemId = null;
      consumableUseDuration = 0;
      consumableUseLabel = "";
      config.onComplete();
      jerkyConsumeElapsed = 0;
      updateJerkyConsumeHud();
      return;
    }

    updateJerkyConsumeHud();
  }

  function updateConsumableEffects(deltaSeconds, flags) {
    const { gameActive, hasWon } = flags;
    if (gameActive && !hasWon) {
      if (sodaSpeedBoostRemaining > 0) {
        sodaSpeedBoostRemaining = Math.max(0, sodaSpeedBoostRemaining - deltaSeconds);
      }
      if (firstAidRegenRemaining > 0) {
        firstAidRegenRemaining = Math.max(0, firstAidRegenRemaining - deltaSeconds);
        if (playerHealth < PLAYER_MAX_HEALTH) {
          setPlayerHealth(playerHealth + FIRST_AID_REGEN_PER_SECOND * deltaSeconds);
        }
      }
    }
    updateBuffHud();
  }

  function updateConsumableUseVisuals(elapsed) {
    if (jerkyConsumeActive && getSelectedInventoryItem()?.id === consumableUseItemId) {
      const phase = elapsed * JERKY_EAT_BOB_FREQUENCY * TWO_PI;
      inventoryLeftHandItemAnchor.position.y = Math.sin(phase) * JERKY_EAT_BOB_AMPLITUDE;
      inventoryLeftHandItemAnchor.position.z = Math.sin(phase * 0.5) * JERKY_EAT_BOB_DEPTH;
      return;
    }
    inventoryLeftHandItemAnchor.position.set(0, 0, 0);
  }

  function evaluateHeartbeatPulse(phase, pulseCenter, amplitude) {
    const distance = phase - pulseCenter;
    const sigma = HEALTH_HEARTBEAT_WIDTH;
    const gaussian = Math.exp(-(distance * distance) / (2 * sigma * sigma));
    return amplitude * gaussian;
  }

  function updateHealthHeartBeatVisual(elapsed) {
    if (!healthHeartImage) {
      return;
    }
    const phase = (elapsed % HEALTH_HEARTBEAT_CYCLE_SECONDS) / HEALTH_HEARTBEAT_CYCLE_SECONDS;
    const beatScale =
      1 +
      evaluateHeartbeatPulse(phase, HEALTH_HEARTBEAT_PRIMARY_TIME, HEALTH_HEARTBEAT_PRIMARY_AMPLITUDE) +
      evaluateHeartbeatPulse(
        phase,
        HEALTH_HEARTBEAT_SECONDARY_TIME,
        HEALTH_HEARTBEAT_SECONDARY_AMPLITUDE,
      );
    healthHeartImage.style.transform = `scale(${beatScale.toFixed(4)})`;
  }

  function applyPlayerDamage(amount, sourceLabel = "damage") {
    const damageAmount = Number(amount);
    if (!Number.isFinite(damageAmount) || damageAmount <= 0) {
      return;
    }
    const previousHealth = playerHealth;
    setPlayerHealth(playerHealth - damageAmount);
    const appliedDamage = Math.max(0, previousHealth - playerHealth);
    if (appliedDamage <= 0) {
      setStatus("Health is already at minimum.");
      return;
    }
    setStatus(
      `Health -${Math.round(appliedDamage)} (${sourceLabel}). ${Math.round(playerHealth)}/${PLAYER_MAX_HEALTH}`,
    );
  }

  function getState() {
    return {
      playerHealth,
      playerHealthDamageTrail,
      jerkyConsumeActive,
      jerkyConsumeElapsed,
      consumableUseItemId,
      consumableUseDuration,
      firstAidRegenRemaining,
      sodaSpeedBoostRemaining,
    };
  }

  return {
    reset,
    updateHealthHud,
    setPlayerHealth,
    updateHealthDamageTrail,
    getActiveConsumableUseProgress,
    getJerkyConsumeProgress,
    getPlayerSpeedMultiplier,
    tryStartJerkyConsume,
    getActiveConsumableCancelStatus,
    cancelJerkyConsume,
    updateJerkyConsume,
    updateConsumableEffects,
    updateConsumableUseVisuals,
    updateHealthHeartBeatVisual,
    applyPlayerDamage,
    getState,
  };
}
