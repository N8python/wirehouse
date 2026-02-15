function clamp01(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return 0;
  }
  return Math.max(0, Math.min(1, numeric));
}

function createSoundPool({ src, baseVolume = 1, voices = 1 }) {
  const safeVoices = Math.max(1, Math.floor(Number(voices) || 1));
  const safeBaseVolume = clamp01(baseVolume);
  const players = [];
  for (let index = 0; index < safeVoices; index += 1) {
    const audio = new Audio(src);
    audio.preload = "auto";
    audio.volume = safeBaseVolume;
    players.push(audio);
  }
  let nextPlayerIndex = 0;

  function play({ volumeScale = 1, playbackRate = 1, rateJitter = 0 } = {}) {
    if (!players.length) {
      return false;
    }
    const player = players[nextPlayerIndex];
    nextPlayerIndex = (nextPlayerIndex + 1) % players.length;

    try {
      player.pause();
      player.currentTime = 0;
    } catch {
      // Intentionally ignored; browser media state can vary by platform.
    }

    const jitter = (Math.random() * 2 - 1) * Math.max(0, Number(rateJitter) || 0);
    player.playbackRate = Math.max(0.5, Number(playbackRate) + jitter || 1);
    player.volume = clamp01(safeBaseVolume * (Number(volumeScale) || 0));
    const playPromise = player.play();
    if (playPromise && typeof playPromise.catch === "function") {
      playPromise.catch(() => {});
    }
    return true;
  }

  function stop() {
    for (const player of players) {
      try {
        player.pause();
        player.currentTime = 0;
      } catch {
        // No-op
      }
    }
  }

  return { play, stop };
}

function createLoopingSound({ src, baseVolume = 1 }) {
  const safeBaseVolume = clamp01(baseVolume);
  const player = new Audio(src);
  player.preload = "auto";
  player.loop = true;
  let currentVolumeScale = 1;

  function applyVolume() {
    player.volume = clamp01(safeBaseVolume * currentVolumeScale);
  }

  applyVolume();

  function start({ volumeScale = 1, playbackRate = 1 } = {}) {
    currentVolumeScale = Number.isFinite(Number(volumeScale)) ? Number(volumeScale) : 1;
    player.playbackRate = Math.max(0.5, Number(playbackRate) || 1);
    applyVolume();
    try {
      if (player.paused) {
        player.currentTime = 0;
      }
    } catch {
      // Intentionally ignored; browser media state can vary by platform.
    }
    const playPromise = player.play();
    if (playPromise && typeof playPromise.catch === "function") {
      playPromise.catch(() => {});
    }
    return true;
  }

  function stop() {
    try {
      player.pause();
      player.currentTime = 0;
    } catch {
      // No-op
    }
  }

  function setVolumeScale(volumeScale = 1) {
    currentVolumeScale = Number.isFinite(Number(volumeScale)) ? Number(volumeScale) : 1;
    applyVolume();
  }

  return { start, stop, setVolumeScale };
}

export function createSoundSystem() {
  const pools = {
    footsteps: createSoundPool({
      src: "./assets/audio/sfx/footsteps_freesound_706207.mp3",
      baseVolume: 0.42,
      voices: 5,
    }),
    wiremanFootsteps: createSoundPool({
      src: "./assets/audio/sfx/footsteps_freesound_706207.mp3",
      baseVolume: 0.56,
      voices: 4,
    }),
    wiremanAttack: createSoundPool({
      src: "./assets/audio/sfx/wireman_attack_freesound_810709.mp3",
      baseVolume: 0.66,
      voices: 3,
    }),
    heartbeat: createSoundPool({
      src: "./assets/audio/sfx/heartbeat_freesound_418788.mp3",
      baseVolume: 0.56,
      voices: 4,
    }),
    meleeMiss: createSoundPool({
      src: "./assets/audio/sfx/melee_miss_whoosh.wav",
      baseVolume: 0.56,
      voices: 3,
    }),
    meleeHitWall: createSoundPool({
      src: "./assets/audio/sfx/melee_hit_wall.wav",
      baseVolume: 0.72,
      voices: 3,
    }),
    meleeHitWireman: createSoundPool({
      src: "./assets/audio/sfx/melee_hit_wireman.wav",
      baseVolume: 0.74,
      voices: 3,
    }),
    knifeHitWireman: createSoundPool({
      src: "./assets/audio/sfx/knife_hit_wireman_freesound_413496.mp3",
      baseVolume: 0.72,
      voices: 3,
    }),
    pistolFire: createSoundPool({
      src: "./assets/audio/sfx/pistol_fire.wav",
      baseVolume: 0.7,
      voices: 4,
    }),
    eatJerky: createSoundPool({
      src: "./assets/audio/sfx/eat_jerky.wav",
      baseVolume: 0.52,
      voices: 2,
    }),
    drinkSoda: createSoundPool({
      src: "./assets/audio/sfx/drink_soda.wav",
      baseVolume: 0.5,
      voices: 2,
    }),
  };
  const loops = {
    bgm: createLoopingSound({
      src: "./assets/audio/bgm.mp3",
      baseVolume: 0.32,
    }),
    eatJerky: createLoopingSound({
      src: "./assets/audio/sfx/eat_jerky.wav",
      baseVolume: 0.52,
    }),
  };

  let userGestureUnlocked = false;
  let musicVolume = 1;
  let sfxVolume = 1;

  function canPlay() {
    return userGestureUnlocked;
  }

  function markUserGesture() {
    userGestureUnlocked = true;
  }

  function setVolumes({ music = musicVolume, sfx = sfxVolume } = {}) {
    musicVolume = clamp01(music);
    sfxVolume = clamp01(sfx);
    loops.bgm.setVolumeScale(0.25 * musicVolume);
    loops.eatJerky.setVolumeScale(1 * sfxVolume);
  }

  function getVolumes() {
    return {
      musicVolume,
      sfxVolume,
    };
  }

  function stopAll() {
    for (const pool of Object.values(pools)) {
      pool.stop();
    }
    for (const loopSound of Object.values(loops)) {
      loopSound.stop();
    }
  }

  function playFootstep({ sprint = false } = {}) {
    if (!canPlay()) {
      return false;
    }
    return pools.footsteps.play({
      volumeScale: (sprint ? 1.05 : 0.9) * sfxVolume,
      playbackRate: sprint ? 1.12 : 0.95,
      rateJitter: 0.08,
    });
  }

  function playWiremanFootstep({ distance = 0, maxDistance = 20, sprint = false } = {}) {
    if (!canPlay()) {
      return false;
    }

    const safeDistance = Math.max(0, Number(distance) || 0);
    const safeMaxDistance = Math.max(0.001, Number(maxDistance) || 20);
    if (safeDistance > safeMaxDistance) {
      return false;
    }

    const proximity = clamp01(1 - safeDistance / safeMaxDistance);
    const attenuation = proximity * proximity;
    const minDistanceScale = 0.08;
    const distanceScale = minDistanceScale + (1 - minDistanceScale) * attenuation;
    return pools.wiremanFootsteps.play({
      volumeScale: distanceScale * (sprint ? 1.04 : 0.92) * sfxVolume,
      playbackRate: sprint ? 1.03 : 0.94,
      rateJitter: 0.05,
    });
  }

  function playWiremanAttackSound() {
    if (!canPlay()) {
      return false;
    }
    return pools.wiremanAttack.play({
      volumeScale: 1 * sfxVolume,
      playbackRate: 0.92,
      rateJitter: 0.06,
    });
  }

  function playHeartbeat({ lowStaminaBoost = false } = {}) {
    if (!canPlay()) {
      return false;
    }
    return pools.heartbeat.play({
      volumeScale: (lowStaminaBoost ? 0.55 : 0.5) * sfxVolume,
      playbackRate: lowStaminaBoost ? 1.04 : 1.0,
      rateJitter: 0.02,
    });
  }

  function playMeleeMiss() {
    if (!canPlay()) {
      return false;
    }
    return pools.meleeMiss.play({
      volumeScale: 1 * sfxVolume,
      playbackRate: 1.0,
      rateJitter: 0.12,
    });
  }

  function playMeleeHitWall() {
    if (!canPlay()) {
      return false;
    }
    return pools.meleeHitWall.play({
      volumeScale: 1 * sfxVolume,
      playbackRate: 1.0,
      rateJitter: 0.04,
    });
  }

  function playMeleeHitWireman() {
    if (!canPlay()) {
      return false;
    }
    return pools.meleeHitWireman.play({
      volumeScale: 1 * sfxVolume,
      playbackRate: 0.96,
      rateJitter: 0.08,
    });
  }

  function playKnifeHitWireman() {
    if (!canPlay()) {
      return false;
    }
    return pools.knifeHitWireman.play({
      volumeScale: 1 * sfxVolume,
      playbackRate: 1,
      rateJitter: 0.05,
    });
  }

  function playPistolFire() {
    if (!canPlay()) {
      return false;
    }
    return pools.pistolFire.play({
      volumeScale: 1 * sfxVolume,
      playbackRate: 1,
      rateJitter: 0.05,
    });
  }

  function playEatJerky() {
    if (!canPlay()) {
      return false;
    }
    return pools.eatJerky.play({
      volumeScale: 1 * sfxVolume,
      playbackRate: 1,
      rateJitter: 0.04,
    });
  }

  function startEatJerkyLoop() {
    if (!canPlay()) {
      return false;
    }
    return loops.eatJerky.start({
      playbackRate: 1,
      volumeScale: 1 * sfxVolume,
    });
  }

  function stopEatJerkyLoop() {
    loops.eatJerky.stop();
  }

  function startBgmLoop() {
    if (!canPlay()) {
      return false;
    }
    return loops.bgm.start({
      playbackRate: 1,
      volumeScale: 0.25 * musicVolume,
    });
  }

  function stopBgmLoop() {
    loops.bgm.stop();
  }

  function playDrinkSoda() {
    if (!canPlay()) {
      return false;
    }
    return pools.drinkSoda.play({
      volumeScale: 1 * sfxVolume,
      playbackRate: 1,
      rateJitter: 0.05,
    });
  }

  return {
    markUserGesture,
    setVolumes,
    getVolumes,
    stopAll,
    playFootstep,
    playWiremanFootstep,
    playWiremanAttackSound,
    playHeartbeat,
    playMeleeMiss,
    playMeleeHitWall,
    playMeleeHitWireman,
    playKnifeHitWireman,
    playPistolFire,
    playEatJerky,
    startEatJerkyLoop,
    stopEatJerkyLoop,
    startBgmLoop,
    stopBgmLoop,
    playDrinkSoda,
  };
}
