import * as THREE from "three";
import { PointerLockControls } from "three/addons/controls/PointerLockControls.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { DecalGeometry } from "three/addons/geometries/DecalGeometry.js";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { SMAAPass } from "three/addons/postprocessing/SMAAPass.js";
import { ShaderPass } from "three/addons/postprocessing/ShaderPass.js";
import {
  MeshBVH,
  acceleratedRaycast,
  computeBoundsTree,
  disposeBoundsTree,
} from "three-mesh-bvh";
import { N8AOPass } from "n8ao";
import * as config from "../config.js";
import { createTextureHelpers } from "../graphics/textures.js";
import { inferWallHeightTexture, applyParallaxOcclusionToMaterial } from "../graphics/pom.js";
import { loadFlashlightModel } from "../entities/flashlightModel.js";
import {
  buildWallSurfaceGeometry,
  buildWalkableVisibilityMap,
  generateMaze,
  findFarthestOpenCell,
  findPath,
} from "../world/maze.js";
import { createWarehousePropScatter } from "../world/props.js";
import { createPickupSystem } from "../world/pickups.js";
import { createGameConstants } from "./constants.js";
import { getDomRefs } from "./domRefs.js";
import { createRuntime } from "./setupRuntime.js";
import { createWorldSystem } from "./systems/worldSystem.js";
import { createPlayerViewSystem } from "./systems/playerViewSystem.js";
import { createFlashlightSystem } from "./systems/flashlightSystem.js";
import { createHeldItemDisplaySystem } from "./systems/heldItemDisplaySystem.js";
import { createInventorySystem } from "./systems/inventorySystem.js";
import { createHealthConsumableSystem } from "./systems/healthConsumableSystem.js";
import { createPistolSystem } from "./systems/pistolSystem.js";
import { createMeleeSystem } from "./systems/meleeSystem.js";
import { createWiremanSystem } from "./systems/wiremanSystem.js";
import { createSoundSystem } from "./systems/soundSystem.js";
import { createRenderGameToText } from "./renderGameToText.js";
import { configureDebugApis } from "./debugApi.js";

THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
THREE.BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree;
THREE.Mesh.prototype.raycast = acceleratedRaycast;

export function createGameApp() {
  const dom = getDomRefs();
  const constants = createGameConstants({
    THREE,
    cellSize: config.CELL_SIZE,
    playerSpeed: config.PLAYER_SPEED,
  });
  const runtime = createRuntime({
    THREE,
    PointerLockControls,
    GLTFLoader,
    EffectComposer,
    SMAAPass,
    ShaderPass,
    N8AOPass,
    dom,
    config,
    constants,
    createTextureHelpers,
    inferWallHeightTexture,
    applyParallaxOcclusionToMaterial,
    loadFlashlightModel,
    createWarehousePropScatter,
    createPickupSystem,
  });
  const sound = createSoundSystem();

  let hasWon = false;
  let gameActive = false;
  let isTopDownView = false;
  let suppressUnlockPause = false;
  let flashlightEnabled = true;
  let previousAnimationTimeMs = 0;
  let frameAccumulatorMs = 0;
  let n8aoSplitDebug = false;
  let wiremanMinimapVisible = false;
  let elapsed = 0;
  let isGameOver = false;
  let gameOverCameraElapsed = 0;
  let gameOverCameraStartY = config.PLAYER_HEIGHT;
  let wiremanWinCountdownActive = false;
  let wiremanWinDelayRemaining = 0;
  let playerFootstepDistanceAccumulator = 0;
  let wiremanFootstepDistanceAccumulator = 0;
  let wiremanFootstepHasPreviousPosition = false;
  let wiremanFootstepPreviousX = 0;
  let wiremanFootstepPreviousZ = 0;

  const GAME_OVER_CAMERA_DROP_DURATION_SECONDS = 0.9;
  const GAME_OVER_CAMERA_TARGET_Y = Math.max(0.16, config.PLAYER_RADIUS * 0.45);
  const GAME_OVER_CAMERA_TARGET_ROLL_RADIANS = Math.PI * 0.5;
  const RESULT_OVERLAY_FADE_DURATION_SECONDS = 3;
  const WIREMAN_WIN_SCREEN_DELAY_SECONDS = 5;
  const DEBUG_KEY_ENABLED = true;
  const DEBUG_KEY_CODES = new Set([
    "KeyH",
    "Slash",
    "KeyO",
    "KeyN",
    "KeyI",
    "KeyU",
    "KeyB",
    "KeyP",
    "KeyT",
  ]);
  const PLAYER_FOOTSTEP_WALK_DISTANCE_UNITS = 1.52 * 1.5;
  const PLAYER_FOOTSTEP_SPRINT_DISTANCE_UNITS = 1.06 * 1.5;
  const WIREMAN_FOOTSTEP_WALK_DISTANCE_UNITS = 1.42;
  const WIREMAN_FOOTSTEP_SPRINT_DISTANCE_UNITS = 0.96;
  const WIREMAN_FOOTSTEP_AUDIBLE_DISTANCE_UNITS = 20;
  const gameOverCameraStartQuaternion = new THREE.Quaternion();
  const gameOverCameraTargetQuaternion = new THREE.Quaternion();
  const gameOverCameraEuler = new THREE.Euler(0, 0, 0, "YXZ");

  const keyState = {
    forward: false,
    backward: false,
    left: false,
    right: false,
    sprint: false,
    jump: false,
  };
  const immobilizedKeyState = {
    forward: false,
    backward: false,
    left: false,
    right: false,
    sprint: false,
    jump: false,
  };
  const mazePerf = {
    renderedFrames: 0,
    startTimeMs: performance.now(),
  };
  const wiremanMinimapCtx = dom.wiremanMinimap?.getContext("2d") || null;
  window.__mazePerf = mazePerf;

  const world = createWorldSystem({
    THREE,
    MeshBVH,
    scene: runtime.scene,
    camera: runtime.camera,
    constants: { ...config, collisionOffsets: constants.collisionOffsets },
    floorMaterial: runtime.floorMaterial,
    wallMaterial: runtime.wallMaterial,
    roofMaterial: runtime.roofMaterial,
    worldHalfWidth: runtime.worldHalfWidth,
    worldHalfDepth: runtime.worldHalfDepth,
    worldWidth: runtime.worldWidth,
    worldDepth: runtime.worldDepth,
    propScatter: runtime.propScatter,
    pickupSystem: runtime.pickupSystem,
    generateMaze,
    findFarthestOpenCell,
    findPath,
    buildWallSurfaceGeometry,
    buildWalkableVisibilityMap,
  });

  function setStatus(text) {
    dom.status.textContent = text;
  }

  function getFlags() {
    return { hasWon, gameActive, isTopDownView, isGameOver };
  }

  function setOverlayMode(mode = "start") {
    const winMode = mode === "win";
    const deathMode = mode === "death";
    if (dom.overlay) {
      dom.overlay.dataset.mode = mode;
    }
    if (dom.overlayTitle) {
      dom.overlayTitle.textContent = deathMode ? "Game Over" : winMode ? "Victory" : "Wirehouse";
    }
    if (dom.overlaySubtitle) {
      dom.overlaySubtitle.textContent = deathMode
        ? "The Wireman got you in the dark. Re-enter Wirehouse and try again."
        : winMode
          ? "Wireman eliminated. The warehouse is silent for now."
          : "Enter the warehouse. Scavenge what you can. Survive the Wireman.";
    }
    if (dom.overlayControls) {
      dom.overlayControls.classList.toggle("hidden", deathMode || winMode);
    }
    if (dom.startButton) {
      dom.startButton.textContent = deathMode ? "Try Again" : winMode ? "Run It Back" : "Enter Wirehouse";
    }
  }

  function clearOverlayFadeState() {
    if (!dom.overlay) {
      return;
    }
    dom.overlay.classList.remove("result-fade-in");
    dom.overlay.style.removeProperty("--overlay-fade-duration");
  }

  function hideOverlay() {
    if (!dom.overlay) {
      return;
    }
    dom.overlay.classList.add("hidden");
    clearOverlayFadeState();
  }

  function showOverlay({ fadeIn = false } = {}) {
    if (!dom.overlay) {
      return;
    }
    if (!fadeIn) {
      clearOverlayFadeState();
      dom.overlay.classList.remove("hidden");
      return;
    }

    dom.overlay.style.setProperty(
      "--overlay-fade-duration",
      `${RESULT_OVERLAY_FADE_DURATION_SECONDS}s`,
    );
    dom.overlay.classList.remove("result-fade-in");
    dom.overlay.classList.remove("hidden");
    void dom.overlay.offsetWidth;
    dom.overlay.classList.add("result-fade-in");
  }

  function resetMovementInput() {
    keyState.forward = false;
    keyState.backward = false;
    keyState.left = false;
    keyState.right = false;
    keyState.sprint = false;
    keyState.jump = false;
  }

  function resetGameOverState() {
    isGameOver = false;
    gameOverCameraElapsed = 0;
    if (dom.deathTint) {
      dom.deathTint.classList.remove("active");
    }
    setOverlayMode("start");
  }

  function resetWinCountdown() {
    wiremanWinCountdownActive = false;
    wiremanWinDelayRemaining = 0;
  }

  function updateGameOverCameraFall(deltaSeconds) {
    if (!isGameOver) {
      return;
    }
    gameOverCameraElapsed = Math.min(
      GAME_OVER_CAMERA_DROP_DURATION_SECONDS,
      gameOverCameraElapsed + Math.max(0, Number(deltaSeconds) || 0),
    );
    const t = THREE.MathUtils.clamp(
      gameOverCameraElapsed / Math.max(0.0001, GAME_OVER_CAMERA_DROP_DURATION_SECONDS),
      0,
      1,
    );
    const eased = 1 - Math.pow(1 - t, 3);
    runtime.camera.position.y = THREE.MathUtils.lerp(
      gameOverCameraStartY,
      GAME_OVER_CAMERA_TARGET_Y,
      eased,
    );
    runtime.camera.quaternion.copy(gameOverCameraStartQuaternion).slerp(gameOverCameraTargetQuaternion, eased);
  }

  function triggerGameOver() {
    if (isGameOver) {
      return;
    }
    isGameOver = true;
    gameActive = false;
    isTopDownView = false;
    resetMovementInput();
    health.cancelJerkyConsume();
    gameOverCameraElapsed = 0;
    gameOverCameraStartY = runtime.camera.position.y;
    gameOverCameraStartQuaternion.copy(runtime.camera.quaternion);
    gameOverCameraEuler.setFromQuaternion(gameOverCameraStartQuaternion, "YXZ");
    gameOverCameraEuler.z += GAME_OVER_CAMERA_TARGET_ROLL_RADIANS;
    gameOverCameraTargetQuaternion.setFromEuler(gameOverCameraEuler);
    dom.crosshair.style.opacity = "0";
    updateCrosshairCooldownIndicator();
    if (dom.deathTint) {
      dom.deathTint.classList.add("active");
    }
    setOverlayMode("death");
    showOverlay({ fadeIn: true });
    setStatus("You were killed by the Wireman.");
    sound.stopAll();
    if (runtime.canUsePointerLock && runtime.controls.isLocked) {
      suppressUnlockPause = true;
      runtime.controls.unlock();
    }
  }

  function triggerWin() {
    if (hasWon || isGameOver) {
      return;
    }
    resetWinCountdown();
    hasWon = true;
    gameActive = false;
    isTopDownView = false;
    resetMovementInput();
    health.cancelJerkyConsume();
    if (dom.deathTint) {
      dom.deathTint.classList.remove("active");
    }
    setOverlayMode("win");
    showOverlay({ fadeIn: true });
    dom.crosshair.style.opacity = "0";
    updateCrosshairCooldownIndicator();
    setStatus("Wireman eliminated. You win.");
    sound.stopAll();
    if (runtime.canUsePointerLock && runtime.controls.isLocked) {
      suppressUnlockPause = true;
      runtime.controls.unlock();
    }
  }

  let inventory = null;
  let wireman = null;
  const heldItemDisplay = createHeldItemDisplaySystem({
    THREE,
    constants,
    pickupSystem: runtime.pickupSystem,
    inventoryLeftHandItemAnchor: runtime.inventoryLeftHandItemAnchor,
    getSelectedInventoryItem: () => inventory?.getSelectedInventoryItem() || null,
    setStatus,
  });
  const pistol = createPistolSystem({
    THREE,
    DecalGeometry,
    constants,
    camera: runtime.camera,
    scene: runtime.scene,
    inventoryLeftHandRig: runtime.inventoryLeftHandRig,
    inventoryLeftHandItemAnchor: runtime.inventoryLeftHandItemAnchor,
    heldItemDisplay,
    getWorldSurfaces: () => ({
      wallMesh: world.getWallMesh(),
      floorMesh: world.getFloorMesh(),
      roofMesh: world.getRoofMesh(),
      exitMarker: world.getExitMarker(),
    }),
    propScatter: runtime.propScatter,
    getSelectedInventoryItem: () => inventory?.getSelectedInventoryItem() || null,
    getInventory: () => inventory?.getInventory() || [],
    updateInventoryHud: () => inventory?.updateInventoryHud(),
    updatePickupPrompt: () => inventory?.updatePickupPrompt(),
    setStatus,
    bulletDecalLitMaterial: runtime.bulletDecalLitMaterial,
    bulletDecalDebugMaterial: runtime.bulletDecalDebugMaterial,
    muzzleFlashTexture: runtime.muzzleFlashTexture,
    pistolMuzzleFlashMaterial: runtime.pistolMuzzleFlashMaterial,
    pistolMuzzleFlashSprite: runtime.pistolMuzzleFlashSprite,
    pistolMuzzleFlashLight: runtime.pistolMuzzleFlashLight,
    pistolHitDebugMarker: runtime.pistolHitDebugMarker,
    getWireman: () => wireman,
    playPistolFireSound: sound.playPistolFire,
  });
  inventory = createInventorySystem({
    THREE,
    dom,
    constants,
    pickupSystem: runtime.pickupSystem,
    camera: runtime.camera,
    heldItemDisplay,
    setStatus,
    getFlags,
    onDebugInventoryGranted: () => {
      pistol.setInfiniteAmmo(true);
    },
  });
  const health = createHealthConsumableSystem({
    THREE,
    constants,
    config,
    dom,
    controls: runtime.controls,
    canUsePointerLock: runtime.canUsePointerLock,
    inventoryLeftHandItemAnchor: runtime.inventoryLeftHandItemAnchor,
    removeInventoryItemById: inventory.removeInventoryItemById,
    getSelectedInventoryItem: inventory.getSelectedInventoryItem,
    updateInventoryHud: inventory.updateInventoryHud,
    updatePickupPrompt: inventory.updatePickupPrompt,
    setStatus,
    startEatJerkySoundLoop: sound.startEatJerkyLoop,
    stopEatJerkySoundLoop: sound.stopEatJerkyLoop,
    playDrinkSodaSound: sound.playDrinkSoda,
    playHeartbeatSound: sound.playHeartbeat,
  });
  const melee = createMeleeSystem({
    THREE,
    constants,
    camera: runtime.camera,
    getWorldSurfaces: () => ({
      wallMesh: world.getWallMesh(),
      exitMarker: world.getExitMarker(),
    }),
    propScatter: runtime.propScatter,
    pickupSystem: runtime.pickupSystem,
    inventoryLeftHandRig: runtime.inventoryLeftHandRig,
    getSelectedInventoryItem: inventory.getSelectedInventoryItem,
    getWireman: () => wireman,
    setStatus,
    playMeleeMissSound: sound.playMeleeMiss,
    playMeleeHitWallSound: sound.playMeleeHitWall,
    playMeleeHitWiremanSound: sound.playMeleeHitWireman,
    playKnifeHitWiremanSound: sound.playKnifeHitWireman,
  });
  const playerView = createPlayerViewSystem({
    THREE,
    camera: runtime.camera,
    topDownCamera: runtime.topDownCamera,
    constants,
    config,
    world,
    flashlightRig: runtime.flashlightRig,
    inventoryLeftHandRig: runtime.inventoryLeftHandRig,
    topDownPlayerMarker: runtime.topDownPlayerMarker,
    topDownLookLine: runtime.topDownLookLine,
    worldWidth: runtime.worldWidth,
    worldDepth: runtime.worldDepth,
  });
  const flashlight = createFlashlightSystem({
    THREE,
    constants,
    config,
    flashlight: runtime.flashlight,
    flashlightTarget: runtime.flashlightTarget,
    flashlightBounceLight: runtime.flashlightBounceLight,
    bounceLightDebugMarker: runtime.bounceLightDebugMarker,
    getBounceTargets: () => {
      const targets = [world.getWallMesh(), world.getFloorMesh(), world.getRoofMesh()].filter(Boolean);
      if (runtime.propScatter.root?.children?.length) {
        targets.push(...runtime.propScatter.root.children);
      }
      return targets;
    },
    isFlashlightEmissionActive: () =>
      flashlightEnabled && !inventory.isFlashlightSuppressedByTwoHandedBat(),
    setStatus,
  });
  wireman = createWiremanSystem({
    THREE,
    GLTFLoader,
    scene: runtime.scene,
    camera: runtime.camera,
    world,
    config,
    constants,
    applyPlayerDamage: health.applyPlayerDamage,
    playWiremanAttackSound: sound.playWiremanAttackSound,
  });

  function lerpColorChannel(from, to, t) {
    return Math.round(from + (to - from) * t);
  }

  function getWiremanMinimapScoreColor(score, maxScore) {
    const normalized = THREE.MathUtils.clamp(maxScore > 0 ? score / maxScore : 0, 0, 1);
    const colorStops = [
      [8, 18, 28],
      [19, 66, 72],
      [58, 124, 86],
      [168, 184, 90],
      [246, 223, 119],
    ];
    const scaled = normalized * (colorStops.length - 1);
    const lowerIndex = Math.floor(scaled);
    const upperIndex = Math.min(colorStops.length - 1, lowerIndex + 1);
    const t = scaled - lowerIndex;
    const from = colorStops[lowerIndex];
    const to = colorStops[upperIndex];
    const r = lerpColorChannel(from[0], to[0], t);
    const g = lerpColorChannel(from[1], to[1], t);
    const b = lerpColorChannel(from[2], to[2], t);
    return `rgb(${r}, ${g}, ${b})`;
  }

  function renderWiremanMinimap() {
    if (!dom.wiremanMinimap || !wiremanMinimapCtx) {
      return;
    }
    dom.wiremanMinimap.classList.toggle("visible", wiremanMinimapVisible);
    if (!wiremanMinimapVisible) {
      return;
    }

    const ctx = wiremanMinimapCtx;
    const maze = world.getMaze();
    const rows = maze.length;
    const cols = maze[0]?.length || 0;
    const width = dom.wiremanMinimap.width;
    const height = dom.wiremanMinimap.height;
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = "#050d16";
    ctx.fillRect(0, 0, width, height);

    if (!rows || !cols) {
      return;
    }

    const wiremanState = wireman.getState();
    const playerCell = world.worldToCell(runtime.camera.position.x, runtime.camera.position.z);
    const scoreMax = wireman.getHuntScoreMax?.() || 0.1;
    const pathCells = wireman.getPathCells?.() || [];
    const pathIndex = wireman.getPathIndex?.() || 0;
    const headerHeight = 22;
    const padding = 8;
    const gridSize = Math.min(width - padding * 2, height - padding * 2 - headerHeight);
    const cellSize = gridSize / Math.max(cols, rows, 1);
    const gridWidth = cols * cellSize;
    const gridHeight = rows * cellSize;
    const originX = (width - gridWidth) * 0.5;
    const originY = headerHeight + (height - headerHeight - gridHeight) * 0.5;

    for (let row = 0; row < rows; row += 1) {
      for (let col = 0; col < cols; col += 1) {
        const x = originX + col * cellSize;
        const y = originY + row * cellSize;
        if (maze[row][col] === 1) {
          ctx.fillStyle = "#6f7882";
        } else {
          const score = wireman.getHuntScoreForCell?.(col, row) ?? scoreMax;
          ctx.fillStyle = getWiremanMinimapScoreColor(score, scoreMax);
        }
        ctx.fillRect(x, y, cellSize, cellSize);
      }
    }

    if (cellSize >= 8) {
      ctx.strokeStyle = "rgba(207, 224, 255, 0.1)";
      ctx.lineWidth = 1;
      for (let row = 0; row <= rows; row += 1) {
        const y = originY + row * cellSize;
        ctx.beginPath();
        ctx.moveTo(originX, y);
        ctx.lineTo(originX + gridWidth, y);
        ctx.stroke();
      }
      for (let col = 0; col <= cols; col += 1) {
        const x = originX + col * cellSize;
        ctx.beginPath();
        ctx.moveTo(x, originY);
        ctx.lineTo(x, originY + gridHeight);
        ctx.stroke();
      }
    }

    if (pathCells.length > 1) {
      const startIndex = Math.min(Math.max(pathIndex, 0), pathCells.length - 1);
      ctx.strokeStyle = "rgba(255, 118, 222, 0.96)";
      ctx.lineWidth = Math.max(1.6, cellSize * 0.24);
      ctx.beginPath();
      for (let i = startIndex; i < pathCells.length; i += 1) {
        const pathCell = pathCells[i];
        const cx = originX + (pathCell.col + 0.5) * cellSize;
        const cy = originY + (pathCell.row + 0.5) * cellSize;
        if (i === startIndex) {
          ctx.moveTo(cx, cy);
        } else {
          ctx.lineTo(cx, cy);
        }
      }
      ctx.stroke();
    }

    const drawPoint = (cell, color, radiusScale = 0.34) => {
      if (!cell) {
        return;
      }
      const cx = originX + (cell.col + 0.5) * cellSize;
      const cy = originY + (cell.row + 0.5) * cellSize;
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(cx, cy, Math.max(2.5, cellSize * radiusScale), 0, Math.PI * 2);
      ctx.fill();
    };
    const drawCellOutline = (cell, color, sizeScale = 0.86) => {
      if (!cell) {
        return;
      }
      const inset = (1 - sizeScale) * 0.5 * cellSize;
      const x = originX + cell.col * cellSize + inset;
      const y = originY + cell.row * cellSize + inset;
      const size = cellSize * sizeScale;
      ctx.strokeStyle = color;
      ctx.lineWidth = Math.max(1.2, cellSize * 0.12);
      ctx.strokeRect(x, y, size, size);
    };

    drawCellOutline(wiremanState?.goalCell, "#ff67d9");
    drawCellOutline(wiremanState?.huntTargetCell, "#ffa14f", 0.72);
    drawCellOutline(wiremanState?.searchTargetCell, "#9dd2ff", 0.62);

    if (wiremanState?.cell) {
      const focusCell =
        wiremanState.lineOfSightToPlayer
          ? playerCell
          : pathCells[Math.min(Math.max(pathIndex, 0), Math.max(pathCells.length - 1, 0))] ||
            wiremanState.searchTargetCell ||
            wiremanState.huntTargetCell ||
            wiremanState.goalCell ||
            null;
      if (focusCell) {
        const fromX = originX + (wiremanState.cell.col + 0.5) * cellSize;
        const fromY = originY + (wiremanState.cell.row + 0.5) * cellSize;
        const toX = originX + (focusCell.col + 0.5) * cellSize;
        const toY = originY + (focusCell.row + 0.5) * cellSize;
        ctx.strokeStyle = wiremanState.lineOfSightToPlayer ? "#ff6262" : "#ffdd8f";
        ctx.lineWidth = Math.max(1, cellSize * 0.12);
        ctx.beginPath();
        ctx.moveTo(fromX, fromY);
        ctx.lineTo(toX, toY);
        ctx.stroke();
      }
    }

    drawPoint(playerCell, "#59d0ff", 0.3);
    drawPoint(wiremanState?.cell || null, "#ff6565");

    ctx.strokeStyle = "rgba(196, 216, 241, 0.45)";
    ctx.lineWidth = 1;
    ctx.strokeRect(originX - 0.5, originY - 0.5, gridWidth + 1, gridHeight + 1);

    ctx.fillStyle = "#e3eefc";
    ctx.font = "11px monospace";
    ctx.textBaseline = "top";
    const huntModeLabel = (wiremanState?.huntMode || "hunt").toUpperCase();
    ctx.fillText(`WIREMAN ${huntModeLabel}  (H)`, 9, 7);
  }

  function regenerateMaze({ silent = false } = {}) {
    hasWon = false;
    gameActive = false;
    isTopDownView = false;
    resetWinCountdown();
    resetMovementInput();
    resetGameOverState();
    playerFootstepDistanceAccumulator = 0;
    wiremanFootstepDistanceAccumulator = 0;
    wiremanFootstepHasPreviousPosition = false;
    playerView.resetPose();
    health.reset();
    melee.reset();
    pistol.reset();
    sound.stopAll();
    inventory.reset();
    world.regenerateMaze();
    wireman.onMazeRegenerated();
    if (!silent) {
      setStatus("New maze generated.");
    }
  }

  function updateCrosshairCooldownIndicator() {
    if (!dom.crosshairCooldown || !dom.crosshairCooldownFill) {
      return;
    }

    let visible = false;
    let progress = 0;
    if (gameActive && !hasWon && !isTopDownView) {
      const selectedItem = inventory.getSelectedInventoryItem();
      const selectedItemId = selectedItem?.id || "";

      if (selectedItemId === constants.PISTOL_ITEM_ID) {
        const pistolState = pistol.getState?.() || null;
        const cooldownRemaining = Math.max(0, pistolState?.pistolFireCooldownRemaining || 0);
        if (cooldownRemaining > 0) {
          visible = true;
          progress =
            1 -
            THREE.MathUtils.clamp(
              cooldownRemaining / Math.max(0.0001, constants.PISTOL_FIRE_COOLDOWN_SECONDS),
              0,
              1,
            );
        }
      } else {
        const meleeWeaponConfig = melee.getMeleeWeaponConfig?.(selectedItemId) || null;
        if (meleeWeaponConfig) {
          const meleeState = melee.getState?.() || null;
          const cooldownRemaining = Math.max(0, meleeState?.meleeCooldownRemaining || 0);
          if (cooldownRemaining > 0) {
            visible = true;
            progress =
              1 -
              THREE.MathUtils.clamp(
                cooldownRemaining / Math.max(0.0001, meleeWeaponConfig.cooldownSeconds),
                0,
                1,
              );
          }
        }
      }
    }

    dom.crosshairCooldown.classList.toggle("active", visible);
    dom.crosshairCooldownFill.style.width = `${Math.round(
      THREE.MathUtils.clamp(progress, 0, 1) * 100,
    )}%`;
  }

  function render() {
    const flashlightModelVisibleInFirstPerson = !inventory.isFlashlightSuppressedByTwoHandedBat();
    if (isTopDownView) {
      if (world.getRoofMesh()) {
        world.getRoofMesh().visible = false;
      }
      runtime.flashlightModelAnchor.visible = false;
      runtime.inventoryLeftHandRig.visible = false;
      runtime.topDownFillLight.intensity = 0.92;
      playerView.updateTopDownCamera();
      playerView.updateTopDownPlayerDebug();
      runtime.topDownPlayerMarker.visible = true;
      runtime.topDownLookLine.visible = true;
      runtime.scene.fog = null;
      runtime.renderer.render(runtime.scene, runtime.topDownCamera);
      if (world.getRoofMesh()) {
        world.getRoofMesh().visible = true;
      }
      runtime.flashlightModelAnchor.visible = true;
      runtime.topDownFillLight.intensity = 0;
      runtime.topDownPlayerMarker.visible = false;
      runtime.topDownLookLine.visible = false;
      runtime.scene.fog = runtime.mazeFog;
      renderWiremanMinimap();
      return;
    }
    runtime.flashlightModelAnchor.visible = flashlightModelVisibleInFirstPerson;
    runtime.inventoryLeftHandRig.visible = true;
    runtime.topDownFillLight.intensity = 0;
    runtime.topDownPlayerMarker.visible = false;
    runtime.topDownLookLine.visible = false;
    runtime.scene.fog = runtime.mazeFog;
    runtime.composer.render();
    renderWiremanMinimap();
  }

  function update(deltaSeconds) {
    elapsed += deltaSeconds;
    if (runtime.foundFootageGrainPass?.uniforms?.time) {
      runtime.foundFootageGrainPass.uniforms.time.value = elapsed;
    }
    const playerXBeforeMovement = runtime.camera.position.x;
    const playerZBeforeMovement = runtime.camera.position.z;
    inventory.update();
    health.updateConsumableEffects(deltaSeconds, getFlags());
    health.updateJerkyConsume(deltaSeconds, getFlags());
    const consumableState = health.getState();
    const consumableUseActive = Boolean(consumableState.jerkyConsumeActive);
    const movementKeyState = consumableUseActive ? immobilizedKeyState : keyState;
    const hasMovementInput =
      movementKeyState.forward ||
      movementKeyState.backward ||
      movementKeyState.left ||
      movementKeyState.right;
    const staminaCanChange = gameActive && !hasWon && !isTopDownView;
    const sprintActive = health.updateStamina(deltaSeconds, {
      wantsSprint: staminaCanChange && hasMovementInput && movementKeyState.sprint,
      allowRegeneration: staminaCanChange,
    });
    health.updateHealthHeartBeatVisual(elapsed, {
      isSprinting: sprintActive,
      playBeatSound: gameActive && !hasWon && !isGameOver,
    });
    health.updateHealthDamageTrail(deltaSeconds);
    flashlight.updateFlashlightFlicker(deltaSeconds, { isTopDownView });
    flashlight.updateFlashlightBounceLight(deltaSeconds, { isTopDownView, hasWon });
    runtime.pickupSystem.update(deltaSeconds);
    if (world.getExitMarker()) {
      world.getExitMarker().rotation.y += deltaSeconds * 1.6;
      world.getExitMarker().position.y = 1.2 + Math.sin(elapsed * 2.8) * 0.12;
    }
    if (!isGameOver) {
      playerView.updatePlayerMovement(deltaSeconds, {
        gameActive,
        hasWon,
        keyState: movementKeyState,
        isSprintActive: sprintActive,
        getPlayerSpeedMultiplier: health.getPlayerSpeedMultiplier,
      });
      playerView.updateViewBobbing(deltaSeconds, {
        gameActive,
        hasWon,
        isTopDownView,
        isSprintActive: sprintActive,
      });
    }
    wireman.update(deltaSeconds, { gameActive, hasWon, isTopDownView });
    const wiremanState = wireman.getState?.() || null;
    if (!isGameOver && gameActive && !hasWon && health.getState().playerHealth <= 0) {
      triggerGameOver();
    }
    if (!isGameOver && !hasWon) {
      if (wiremanState?.dead) {
        if (!wiremanWinCountdownActive) {
          wiremanWinCountdownActive = true;
          wiremanWinDelayRemaining = WIREMAN_WIN_SCREEN_DELAY_SECONDS;
          setStatus("Wireman eliminated.");
        } else {
          wiremanWinDelayRemaining = Math.max(0, wiremanWinDelayRemaining - deltaSeconds);
        }
        if (wiremanWinDelayRemaining <= 0) {
          triggerWin();
        }
      } else if (wiremanWinCountdownActive) {
        resetWinCountdown();
      }
    }
    const jumpState = playerView.getJumpState?.() || null;
    if (!isGameOver && gameActive && !hasWon && !isTopDownView) {
      const resolvedPlayerCollision = wireman.resolvePlayerCapsuleCollision?.({
        playerX: runtime.camera.position.x,
        playerZ: runtime.camera.position.z,
        playerRadius: config.PLAYER_RADIUS,
        playerHeightOffset: jumpState?.jumpOffset || 0,
      });
      if (resolvedPlayerCollision) {
        runtime.camera.position.x = resolvedPlayerCollision.x;
        runtime.camera.position.z = resolvedPlayerCollision.z;
      }
    }
    const playerMovedDistance = Math.hypot(
      runtime.camera.position.x - playerXBeforeMovement,
      runtime.camera.position.z - playerZBeforeMovement,
    );
    if (gameActive && !hasWon && !isTopDownView && !isGameOver) {
      const grounded = jumpState ? Boolean(jumpState.grounded) : true;
      if (hasMovementInput && grounded && playerMovedDistance > 0.0001) {
        const playerSpeedMultiplier = Math.max(
          0.0001,
          Number(health.getPlayerSpeedMultiplier?.() || 1),
        );
        const strideDistance =
          (sprintActive
            ? PLAYER_FOOTSTEP_SPRINT_DISTANCE_UNITS
            : PLAYER_FOOTSTEP_WALK_DISTANCE_UNITS) * playerSpeedMultiplier;
        playerFootstepDistanceAccumulator += playerMovedDistance;
        while (playerFootstepDistanceAccumulator >= strideDistance) {
          playerFootstepDistanceAccumulator -= strideDistance;
          sound.playFootstep({ sprint: sprintActive });
        }
      } else if (!hasMovementInput || !grounded) {
        playerFootstepDistanceAccumulator = 0;
      }
    } else {
      playerFootstepDistanceAccumulator = 0;
    }
    if (
      gameActive &&
      !hasWon &&
      !isTopDownView &&
      !isGameOver &&
      wiremanState?.loaded &&
      !wiremanState?.dead &&
      wiremanState?.position
    ) {
      const wiremanX = Number(wiremanState.position.x) || 0;
      const wiremanZ = Number(wiremanState.position.z) || 0;
      if (wiremanFootstepHasPreviousPosition) {
        const wiremanMovedDistance = Math.hypot(
          wiremanX - wiremanFootstepPreviousX,
          wiremanZ - wiremanFootstepPreviousZ,
        );
        if (wiremanState.moving && wiremanMovedDistance > 0.0001) {
          const strideDistance = wiremanState.sprinting
            ? WIREMAN_FOOTSTEP_SPRINT_DISTANCE_UNITS
            : WIREMAN_FOOTSTEP_WALK_DISTANCE_UNITS;
          wiremanFootstepDistanceAccumulator += wiremanMovedDistance;
          const playerDistanceToWireman = Math.hypot(
            runtime.camera.position.x - wiremanX,
            runtime.camera.position.z - wiremanZ,
          );
          while (wiremanFootstepDistanceAccumulator >= strideDistance) {
            wiremanFootstepDistanceAccumulator -= strideDistance;
            sound.playWiremanFootstep({
              sprint: Boolean(wiremanState.sprinting),
              distance: playerDistanceToWireman,
              maxDistance: WIREMAN_FOOTSTEP_AUDIBLE_DISTANCE_UNITS,
            });
          }
        } else {
          wiremanFootstepDistanceAccumulator = 0;
        }
      }
      wiremanFootstepPreviousX = wiremanX;
      wiremanFootstepPreviousZ = wiremanZ;
      wiremanFootstepHasPreviousPosition = true;
    } else {
      wiremanFootstepDistanceAccumulator = 0;
      wiremanFootstepHasPreviousPosition = false;
    }
    melee.updateMeleeAttack(deltaSeconds);
    health.updateConsumableUseVisuals(elapsed);
    pistol.update(deltaSeconds, { gameActive, isTopDownView });
    pistol.updatePistolPropDebugMarker(deltaSeconds, elapsed);
    inventory.updatePickupPrompt();
    updateGameOverCameraFall(deltaSeconds);
    updateCrosshairCooldownIndicator();
  }

  function animationFrame(timeMs = performance.now()) {
    if (previousAnimationTimeMs === 0) {
      previousAnimationTimeMs = timeMs;
      return;
    }
    const elapsedMs = Math.max(0, Math.min(250, timeMs - previousAnimationTimeMs));
    previousAnimationTimeMs = timeMs;
    frameAccumulatorMs += elapsedMs;
    if (frameAccumulatorMs < config.TARGET_FRAME_INTERVAL_MS) {
      return;
    }
    frameAccumulatorMs %= config.TARGET_FRAME_INTERVAL_MS;

    const delta = Math.min(runtime.clock.getDelta(), 0.05);
    update(delta);
    render();
    mazePerf.renderedFrames += 1;
  }

  function activateGameplay() {
    sound.markUserGesture();
    sound.startBgmLoop();
    resetGameOverState();
    gameActive = true;
    isTopDownView = false;
    health.cancelJerkyConsume();
    hideOverlay();
    dom.crosshair.style.opacity = "1";
    updateCrosshairCooldownIndicator();
    setStatus(config.GAMEPLAY_HINT);
    if (runtime.canUsePointerLock && !runtime.controls.isLocked) {
      runtime.controls.lock();
    }
  }

  function toggleFlashlight() {
    flashlightEnabled = !flashlightEnabled;
    if (!flashlightEnabled) {
      setStatus("Flashlight off. Press L to toggle.");
      return;
    }
    if (inventory.isFlashlightSuppressedByTwoHandedBat()) {
      setStatus("Flashlight on, but stowed while using the baseball bat.");
      return;
    }
    setStatus("Flashlight on. Press L to toggle.");
  }

  function toggleTopDownView() {
    if (!gameActive || hasWon || isGameOver) {
      return;
    }

    if (isTopDownView) {
      isTopDownView = false;
      dom.crosshair.style.opacity = "1";
      updateCrosshairCooldownIndicator();
      setStatus("First-person view. Press V for top-down view.");
      if (runtime.canUsePointerLock && !runtime.controls.isLocked) {
        runtime.controls.lock();
      }
      return;
    }

    isTopDownView = true;
    dom.crosshair.style.opacity = "0";
    updateCrosshairCooldownIndicator();
    setStatus("Top-down view. Press V to return to first-person.");
    if (runtime.canUsePointerLock && runtime.controls.isLocked) {
      suppressUnlockPause = true;
      runtime.controls.unlock();
    }
    playerView.updateTopDownCamera();
  }

  function toggleN8AODebugView() {
    n8aoSplitDebug = !n8aoSplitDebug;
    runtime.n8aoPass.setDisplayMode(n8aoSplitDebug ? "Split" : "Combined");
    setStatus(
      n8aoSplitDebug
        ? "N8AO split debug view on. Press O to return to combined view."
        : "N8AO split debug view off. Press O to enable.",
    );
  }

  function toggleWiremanMinimap() {
    wiremanMinimapVisible = !wiremanMinimapVisible;
    if (!wiremanMinimapVisible && dom.wiremanMinimap) {
      dom.wiremanMinimap.classList.remove("visible");
    }
    setStatus(
      wiremanMinimapVisible
        ? "Wireman debug minimap on. Press H to hide."
        : "Wireman debug minimap off. Press H to show.",
    );
  }

  function teleportPlayerToWireman() {
    const wiremanState = wireman.getState();
    if (!wiremanState?.loaded || !wiremanState.position) {
      setStatus("Wireman not loaded yet.");
      return;
    }
    runtime.camera.position.set(
      wiremanState.position.x,
      config.PLAYER_HEIGHT,
      wiremanState.position.z,
    );
    inventory.updatePickupPrompt();
    setStatus("Teleported player to Wireman.");
  }

  function onKeyDown(event) {
    sound.markUserGesture();
    const code = event.code;
    if (code === "ArrowLeft" || code === "ArrowRight" || code === "Space") {
      event.preventDefault();
    }
    if (!DEBUG_KEY_ENABLED && DEBUG_KEY_CODES.has(code)) {
      return;
    }
    if ((code === "ArrowLeft" || code === "ArrowRight") && event.repeat) {
      return;
    }
    if (code === "ArrowLeft") return inventory.rotateInventoryWheel(-1);
    if (code === "ArrowRight") return inventory.rotateInventoryWheel(1);
    if (code === "KeyW") keyState.forward = true;
    if (code === "KeyS") keyState.backward = true;
    if (code === "KeyA") keyState.left = true;
    if (code === "KeyD") keyState.right = true;
    if (code === "Space") keyState.jump = true;
    if (code === "ShiftLeft" || code === "ShiftRight") keyState.sprint = true;
    if (code === "KeyF") void toggleFullscreen();
    if (code === "KeyL") toggleFlashlight();
    if (code === "KeyV") toggleTopDownView();
    if (code === "KeyH") toggleWiremanMinimap();
    if (code === "Slash") teleportPlayerToWireman();
    if (code === "KeyO") toggleN8AODebugView();
    if (code === "KeyN") regenerateMaze();
    if (code === "KeyE") inventory.tryPickupNearest();
    if (code === "KeyQ") void inventory.dropSelectedItem();
    if (code === "KeyI") inventory.grantDebugInventory();
    if (code === "KeyU") {
      runtime.heldItemAmbientFillLight.intensity =
        runtime.heldItemAmbientFillLight.intensity > 0 ? 0 : constants.HELD_ITEM_AMBIENT_BOOST_INTENSITY;
      setStatus(
        runtime.heldItemAmbientFillLight.intensity > 0
          ? "Held-item ambient debug light enabled."
          : "Held-item ambient debug light disabled.",
      );
    }
    if (code === "KeyB") flashlight.toggleBounceLightDebugMarker();
    if (code === "KeyP") pistol.togglePistolImpactDebug();
    if (code === "KeyT") health.applyPlayerDamage(constants.PLAYER_TEST_DAMAGE_PER_PRESS, "debug");
  }

  function onKeyUp(event) {
    const code = event.code;
    if (code === "KeyW") keyState.forward = false;
    if (code === "KeyS") keyState.backward = false;
    if (code === "KeyA") keyState.left = false;
    if (code === "KeyD") keyState.right = false;
    if (code === "Space") keyState.jump = false;
    if (code === "ShiftLeft" || code === "ShiftRight") keyState.sprint = false;
  }

  function onPointerDown(event) {
    sound.markUserGesture();
    if (event.button !== 0) return;
    if (!gameActive || hasWon || isTopDownView || isGameOver) return;
    if (runtime.canUsePointerLock && !runtime.controls.isLocked) return;
    if (health.tryStartJerkyConsume()) return;
    if (pistol.tryShootPistol()) return;
    melee.tryMeleeAttack();
  }

  function onPointerUp(event) {
    if (event.type !== "pointercancel" && event.button !== 0) return;
    health.cancelJerkyConsume(health.getActiveConsumableCancelStatus());
  }

  async function toggleFullscreen() {
    try {
      if (document.fullscreenElement) {
        await document.exitFullscreen();
      } else {
        await document.documentElement.requestFullscreen();
      }
    } catch (error) {
      console.error("Fullscreen toggle failed:", error);
    }
  }

  function resizeRenderer() {
    runtime.camera.aspect = window.innerWidth / window.innerHeight;
    runtime.camera.updateProjectionMatrix();
    runtime.topDownCamera.aspect = window.innerWidth / window.innerHeight;
    runtime.topDownCamera.updateProjectionMatrix();
    const pixelRatio = 1;
    runtime.renderer.setPixelRatio(pixelRatio);
    runtime.renderer.setSize(window.innerWidth, window.innerHeight, false);
    runtime.composer.setPixelRatio(pixelRatio);
    runtime.composer.setSize(window.innerWidth, window.innerHeight);
    runtime.smaaPass.setSize(
      Math.floor(window.innerWidth * pixelRatio),
      Math.floor(window.innerHeight * pixelRatio),
    );
    if (typeof runtime.n8aoPass.setSize === "function") {
      runtime.n8aoPass.setSize(window.innerWidth, window.innerHeight);
    }
  }

  const renderGameToText = createRenderGameToText({
    THREE,
    config,
    constants,
    camera: runtime.camera,
    controls: runtime.controls,
    getFlags,
    world,
    inventory,
    melee,
    pistol,
    health,
    wireman,
    flashlightState: runtime.flashlightState,
    isFlashlightEmissionActive: () => flashlightEnabled && !inventory.isFlashlightSuppressedByTwoHandedBat(),
    isFlashlightSuppressedByTwoHandedBat: inventory.isFlashlightSuppressedByTwoHandedBat,
    getPlayerJumpState: playerView.getJumpState,
  });

  function setupInteractions() {
    dom.startButton.addEventListener("click", () => {
      sound.markUserGesture();
      if (hasWon || isGameOver) {
        regenerateMaze();
      }
      activateGameplay();
    });
    runtime.renderer.domElement.addEventListener("click", () => {
      sound.markUserGesture();
      if (!gameActive) {
        if (isGameOver || hasWon) {
          return;
        }
        activateGameplay();
      } else if (runtime.canUsePointerLock && !runtime.controls.isLocked) {
        runtime.controls.lock();
      }
    });
    runtime.renderer.domElement.addEventListener("pointerdown", onPointerDown);
    runtime.renderer.domElement.addEventListener("pointerup", onPointerUp);
    runtime.renderer.domElement.addEventListener("pointercancel", onPointerUp);

    runtime.controls.addEventListener("lock", () => {
      if (isGameOver || hasWon) {
        showOverlay();
        dom.crosshair.style.opacity = "0";
        return;
      }
      isTopDownView = false;
      hideOverlay();
      dom.crosshair.style.opacity = "1";
      if (!hasWon) {
        setStatus(config.GAMEPLAY_HINT);
      }
    });
    runtime.controls.addEventListener("unlock", () => {
      health.cancelJerkyConsume();
      if (suppressUnlockPause) {
        suppressUnlockPause = false;
        return;
      }
      if (isGameOver) {
        isTopDownView = false;
        dom.crosshair.style.opacity = "0";
        showOverlay();
        return;
      }
      if (runtime.canUsePointerLock) {
        gameActive = false;
        isTopDownView = false;
        dom.crosshair.style.opacity = "0.25";
        if (hasWon) {
          showOverlay();
          return;
        }
        hideOverlay();
        setStatus("Pointer unlocked. Adjust settings, then click the scene to resume.");
      }
    });
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", () => health.cancelJerkyConsume());
    window.addEventListener("resize", resizeRenderer);
    document.addEventListener("fullscreenchange", resizeRenderer);
    configureDebugApis({
      constants,
      update,
      render,
      renderGameToText,
      world,
      wireman,
      inventory,
      pistol,
      health,
      runtime,
    });
  }

  world.createFloorAndCeiling();
  setOverlayMode("start");
  regenerateMaze({ silent: true });
  setupInteractions();
  inventory.initInventoryRadial();
  heldItemDisplay.init();
  inventory.updateInventoryHud();
  health.updateHealthHud();
  inventory.updatePickupPrompt();
  render();
  runtime.renderer.setAnimationLoop(animationFrame);
}
