import * as THREE from "three";
import { PointerLockControls } from "three/addons/controls/PointerLockControls.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { DecalGeometry } from "three/addons/geometries/DecalGeometry.js";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { SMAAPass } from "three/addons/postprocessing/SMAAPass.js";
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
import { buildWallSurfaceGeometry, generateMaze, findFarthestOpenCell, findPath } from "../world/maze.js";
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

  let hasWon = false;
  let gameActive = false;
  let isTopDownView = false;
  let suppressUnlockPause = false;
  let flashlightEnabled = true;
  let previousAnimationTimeMs = 0;
  let frameAccumulatorMs = 0;
  let n8aoSplitDebug = false;
  let elapsed = 0;

  const keyState = {
    forward: false,
    backward: false,
    left: false,
    right: false,
    sprint: false,
  };
  const mazePerf = {
    renderedFrames: 0,
    startTimeMs: performance.now(),
  };
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
  });

  function setStatus(text) {
    dom.status.textContent = text;
  }

  function getFlags() {
    return { hasWon, gameActive, isTopDownView };
  }

  let inventory = null;
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
    setStatus,
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
  const wireman = createWiremanSystem({
    THREE,
    GLTFLoader,
    scene: runtime.scene,
    camera: runtime.camera,
    world,
    config,
    constants,
  });

  function regenerateMaze({ silent = false } = {}) {
    hasWon = false;
    gameActive = false;
    isTopDownView = false;
    keyState.forward = false;
    keyState.backward = false;
    keyState.left = false;
    keyState.right = false;
    keyState.sprint = false;
    playerView.resetPose();
    health.reset();
    melee.reset();
    pistol.reset();
    inventory.reset();
    world.regenerateMaze();
    wireman.onMazeRegenerated();
    if (!silent) {
      setStatus("New maze generated.");
    }
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
      return;
    }
    runtime.flashlightModelAnchor.visible = flashlightModelVisibleInFirstPerson;
    runtime.inventoryLeftHandRig.visible = true;
    runtime.topDownFillLight.intensity = 0;
    runtime.topDownPlayerMarker.visible = false;
    runtime.topDownLookLine.visible = false;
    runtime.scene.fog = runtime.mazeFog;
    runtime.composer.render();
  }

  function update(deltaSeconds) {
    elapsed += deltaSeconds;
    health.updateConsumableEffects(deltaSeconds, getFlags());
    const hasMovementInput = keyState.forward || keyState.backward || keyState.left || keyState.right;
    const staminaCanChange = gameActive && !hasWon && !isTopDownView;
    const sprintActive = health.updateStamina(deltaSeconds, {
      wantsSprint: staminaCanChange && hasMovementInput && keyState.sprint,
      allowRegeneration: staminaCanChange,
    });
    health.updateHealthHeartBeatVisual(elapsed, { isSprinting: sprintActive });
    health.updateHealthDamageTrail(deltaSeconds);
    health.updateJerkyConsume(deltaSeconds, getFlags());
    flashlight.updateFlashlightFlicker(deltaSeconds, { isTopDownView });
    flashlight.updateFlashlightBounceLight(deltaSeconds, { isTopDownView, hasWon });
    runtime.pickupSystem.update(deltaSeconds);
    if (world.getExitMarker()) {
      world.getExitMarker().rotation.y += deltaSeconds * 1.6;
      world.getExitMarker().position.y = 1.2 + Math.sin(elapsed * 2.8) * 0.12;
    }
    playerView.updatePlayerMovement(deltaSeconds, {
      gameActive,
      keyState,
      isSprintActive: sprintActive,
      getPlayerSpeedMultiplier: health.getPlayerSpeedMultiplier,
    });
    playerView.updateViewBobbing(deltaSeconds, {
      gameActive,
      hasWon,
      isTopDownView,
      isSprintActive: sprintActive,
    });
    wireman.update(deltaSeconds, { gameActive, hasWon, isTopDownView });
    melee.updateMeleeAttack(deltaSeconds);
    health.updateConsumableUseVisuals(elapsed);
    pistol.update(deltaSeconds, { gameActive, isTopDownView });
    pistol.updatePistolPropDebugMarker(deltaSeconds, elapsed);
    inventory.updatePickupPrompt();
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
    gameActive = true;
    isTopDownView = false;
    health.cancelJerkyConsume();
    dom.overlay.classList.add("hidden");
    dom.crosshair.style.opacity = "1";
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
    if (!gameActive || hasWon) {
      return;
    }

    if (isTopDownView) {
      isTopDownView = false;
      dom.crosshair.style.opacity = "1";
      setStatus("First-person view. Press V for top-down view.");
      if (runtime.canUsePointerLock && !runtime.controls.isLocked) {
        runtime.controls.lock();
      }
      return;
    }

    isTopDownView = true;
    dom.crosshair.style.opacity = "0";
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
    const code = event.code;
    if (code === "ArrowLeft" || code === "ArrowRight" || code === "Space") {
      event.preventDefault();
    }
    if (code === "ArrowLeft") return inventory.rotateInventoryWheel(-1);
    if (code === "ArrowRight") return inventory.rotateInventoryWheel(1);
    if (code === "KeyW") keyState.forward = true;
    if (code === "KeyS") keyState.backward = true;
    if (code === "KeyA") keyState.left = true;
    if (code === "KeyD") keyState.right = true;
    if (code === "ShiftLeft" || code === "ShiftRight") keyState.sprint = true;
    if (code === "KeyF") void toggleFullscreen();
    if (code === "KeyL") toggleFlashlight();
    if (code === "KeyV") toggleTopDownView();
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
    if (code === "ShiftLeft" || code === "ShiftRight") keyState.sprint = false;
  }

  function onPointerDown(event) {
    if (event.button !== 0) return;
    if (!gameActive || hasWon || isTopDownView) return;
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
  });

  function setupInteractions() {
    dom.startButton.addEventListener("click", () => {
      if (hasWon) {
        regenerateMaze();
      }
      activateGameplay();
    });
    runtime.renderer.domElement.addEventListener("click", () => {
      if (!gameActive) {
        activateGameplay();
      } else if (runtime.canUsePointerLock && !runtime.controls.isLocked) {
        runtime.controls.lock();
      }
    });
    runtime.renderer.domElement.addEventListener("pointerdown", onPointerDown);
    runtime.renderer.domElement.addEventListener("pointerup", onPointerUp);
    runtime.renderer.domElement.addEventListener("pointercancel", onPointerUp);

    runtime.controls.addEventListener("lock", () => {
      isTopDownView = false;
      dom.overlay.classList.add("hidden");
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
      if (runtime.canUsePointerLock) {
        gameActive = false;
        isTopDownView = false;
        dom.crosshair.style.opacity = "0.25";
        if (hasWon) {
          dom.overlay.classList.remove("hidden");
          return;
        }
        dom.overlay.classList.add("hidden");
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
      inventory,
      pistol,
      health,
      runtime,
    });
  }

  world.createFloorAndCeiling();
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
