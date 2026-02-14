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
  startEatJerkySoundLoop,
  stopEatJerkySoundLoop,
  playDrinkSodaSound,
  playHeartbeatSound,
}) {
  const {
    PLAYER_MAX_HEALTH,
    PLAYER_MAX_STAMINA,
    PLAYER_SPRINT_STAMINA_DRAIN_PER_SECOND,
    PLAYER_STAMINA_REGEN_DELAY_SECONDS,
    PLAYER_STAMINA_REGEN_PER_SECOND,
    STAMINA_LOW_HEARTBEAT_THRESHOLD_RATIO,
    STAMINA_LOW_SPRINT_HEARTBEAT_FREQUENCY_MULTIPLIER,
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
    healthHeartStaminaImage,
    consumeProgress,
    consumeProgressFill,
    consumeProgressLabel,
    sodaBoostIndicator,
    sodaBoostTimer,
    regenIndicator,
    regenTimer,
  } = dom;

  let playerHealth = PLAYER_MAX_HEALTH;
  let playerStamina = PLAYER_MAX_STAMINA;
  let staminaRegenDelayRemaining = 0;
  let staminaSprintActive = false;
  let lowStaminaHeartbeatBoostActive = false;
  let playerHealthDamageTrail = PLAYER_MAX_HEALTH;
  let playerHealthDamageTrailHoldRemaining = 0;
  let jerkyConsumeActive = false;
  let jerkyConsumeElapsed = 0;
  let consumableUseItemId = null;
  let consumableUseDuration = 0;
  let consumableUseLabel = "";
  let firstAidRegenRemaining = 0;
  let sodaSpeedBoostRemaining = 0;
  let previousHeartbeatCycleRaw = null;

  function reset() {
    setPlayerHealth(PLAYER_MAX_HEALTH);
    playerStamina = PLAYER_MAX_STAMINA;
    staminaRegenDelayRemaining = 0;
    staminaSprintActive = false;
    lowStaminaHeartbeatBoostActive = false;
    updateStaminaHud();
    cancelJerkyConsume();
    firstAidRegenRemaining = 0;
    sodaSpeedBoostRemaining = 0;
    previousHeartbeatCycleRaw = null;
    updateBuffHud();
  }

  function clampPlayerHealth(value) {
    if (!Number.isFinite(value)) {
      return playerHealth;
    }
    return Math.max(0, Math.min(PLAYER_MAX_HEALTH, value));
  }

  function clampPlayerStamina(value) {
    if (!Number.isFinite(value)) {
      return playerStamina;
    }
    return Math.max(0, Math.min(PLAYER_MAX_STAMINA, value));
  }

  function updateStaminaHud() {
    const staminaRatio = PLAYER_MAX_STAMINA > 0 ? playerStamina / PLAYER_MAX_STAMINA : 0;
    const staminaPercent = Math.max(0, Math.min(100, staminaRatio * 100));
    if (healthHeartStaminaImage) {
      healthHeartStaminaImage.style.setProperty(
        "--stamina-heart-gray-bottom-inset",
        `${staminaPercent.toFixed(3)}%`,
      );
    }
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

  function updateStamina(deltaSeconds, { wantsSprint = false, allowRegeneration = true } = {}) {
    const clampedDeltaSeconds = Math.max(0, Number(deltaSeconds) || 0);
    const sprintRequested = Boolean(wantsSprint);
    const canSprintThisFrame = sprintRequested && playerStamina > 0 && clampedDeltaSeconds > 0;
    let staminaDecreased = false;

    if (canSprintThisFrame) {
      const previousStamina = playerStamina;
      playerStamina = clampPlayerStamina(
        playerStamina - PLAYER_SPRINT_STAMINA_DRAIN_PER_SECOND * clampedDeltaSeconds,
      );
      staminaDecreased = playerStamina < previousStamina;
    }

    if (staminaDecreased) {
      staminaRegenDelayRemaining = PLAYER_STAMINA_REGEN_DELAY_SECONDS;
    } else if (allowRegeneration && staminaRegenDelayRemaining > 0) {
      staminaRegenDelayRemaining = Math.max(0, staminaRegenDelayRemaining - clampedDeltaSeconds);
    }

    if (
      allowRegeneration &&
      !sprintRequested &&
      staminaRegenDelayRemaining <= 0 &&
      playerStamina < PLAYER_MAX_STAMINA
    ) {
      playerStamina = clampPlayerStamina(
        playerStamina + PLAYER_STAMINA_REGEN_PER_SECOND * clampedDeltaSeconds,
      );
    }

    staminaSprintActive = canSprintThisFrame;
    updateStaminaHud();
    return staminaSprintActive;
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
    playDrinkSodaSound?.();
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
    if (consumableUseItemId === JERKY_ITEM_ID) {
      stopEatJerkySoundLoop?.();
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
    if (config.itemId === JERKY_ITEM_ID) {
      startEatJerkySoundLoop?.();
    }
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
      if (consumableUseItemId === JERKY_ITEM_ID) {
        stopEatJerkySoundLoop?.();
      }
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

  function updateHealthHeartBeatVisual(elapsed, { isSprinting = false, playBeatSound = true } = {}) {
    if (!healthHeartImage && !healthHeartStaminaImage) {
      lowStaminaHeartbeatBoostActive = false;
      previousHeartbeatCycleRaw = null;
      return;
    }
    const staminaRatio = PLAYER_MAX_STAMINA > 0 ? playerStamina / PLAYER_MAX_STAMINA : 0;
    const lowStaminaSprint =
      Boolean(isSprinting) && staminaRatio <= STAMINA_LOW_HEARTBEAT_THRESHOLD_RATIO;
    lowStaminaHeartbeatBoostActive = lowStaminaSprint;
    const heartbeatFrequencyScale = lowStaminaSprint
      ? STAMINA_LOW_SPRINT_HEARTBEAT_FREQUENCY_MULTIPLIER
      : 1;
    const heartbeatCycleRaw =
      (elapsed * heartbeatFrequencyScale) / Math.max(0.0001, HEALTH_HEARTBEAT_CYCLE_SECONDS);
    const phase = heartbeatCycleRaw - Math.floor(heartbeatCycleRaw);

    if (Number.isFinite(previousHeartbeatCycleRaw) && Number.isFinite(heartbeatCycleRaw)) {
      if (heartbeatCycleRaw > previousHeartbeatCycleRaw) {
        const pulseCenters = [HEALTH_HEARTBEAT_PRIMARY_TIME, HEALTH_HEARTBEAT_SECONDARY_TIME];
        for (const pulseCenter of pulseCenters) {
          const previousPulseCount = Math.floor(previousHeartbeatCycleRaw - pulseCenter);
          const currentPulseCount = Math.floor(heartbeatCycleRaw - pulseCenter);
          if (playBeatSound && currentPulseCount > previousPulseCount) {
            playHeartbeatSound?.({ lowStaminaBoost: lowStaminaSprint });
          }
        }
      } else if (heartbeatCycleRaw < previousHeartbeatCycleRaw) {
        // Frequency scaling can jump backward when sprint boost drops; realign silently.
      }
    }
    previousHeartbeatCycleRaw = heartbeatCycleRaw;

    const beatScale =
      1 +
      evaluateHeartbeatPulse(phase, HEALTH_HEARTBEAT_PRIMARY_TIME, HEALTH_HEARTBEAT_PRIMARY_AMPLITUDE) +
      evaluateHeartbeatPulse(
        phase,
        HEALTH_HEARTBEAT_SECONDARY_TIME,
        HEALTH_HEARTBEAT_SECONDARY_AMPLITUDE,
      );
    const transform = `scale(${beatScale.toFixed(4)})`;
    if (healthHeartImage) {
      healthHeartImage.style.transform = transform;
    }
    if (healthHeartStaminaImage) {
      healthHeartStaminaImage.style.transform = transform;
    }
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
      playerStamina,
      staminaRegenDelayRemaining,
      staminaSprintActive,
      lowStaminaHeartbeatBoostActive,
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
    updateStamina,
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
