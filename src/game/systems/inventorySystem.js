export function createInventorySystem({
  THREE,
  dom,
  constants,
  pickupSystem,
  camera,
  heldItemDisplay,
  setStatus,
  getFlags,
  onDebugInventoryGranted,
}) {
  const {
    INVENTORY_MAX_ITEMS,
    INVENTORY_SLOT_RADIUS_PX,
    PICKUP_INTERACT_DISTANCE,
    DEBUG_INVENTORY_ITEMS,
    BASEBALL_BAT_ITEM_ID,
  } = constants;
  const { inventoryRadial, interactionHint } = dom;
  const INVENTORY_ROTATE_ANIMATION_DURATION_MS = 160;

  const inventory = [];
  const inventorySlots = [];
  let inventoryWheelRotationSteps = 0;
  let inventoryWheelRotationUnlockAtMs = 0;
  const inventoryWheelRotationQueue = [];
  let inventorySelectionOutline = null;
  const dropForward = new THREE.Vector3();
  const dropRight = new THREE.Vector3();
  const worldUp = new THREE.Vector3(0, 1, 0);

  function normalizeInventorySlotIndex(index) {
    return ((index % INVENTORY_MAX_ITEMS) + INVENTORY_MAX_ITEMS) % INVENTORY_MAX_ITEMS;
  }

  function getSelectedInventorySlotIndex() {
    return normalizeInventorySlotIndex(-inventoryWheelRotationSteps);
  }

  function getSelectedInventoryItem() {
    return inventory[getSelectedInventorySlotIndex()] || null;
  }

  function getInventoryOccupiedCount() {
    let count = 0;
    for (let i = 0; i < INVENTORY_MAX_ITEMS; i += 1) {
      if (inventory[i]) {
        count += 1;
      }
    }
    return count;
  }

  function findFirstEmptyInventorySlotIndex() {
    for (let i = 0; i < INVENTORY_MAX_ITEMS; i += 1) {
      if (!inventory[i]) {
        return i;
      }
    }
    return -1;
  }

  function removeInventoryItemById(itemId) {
    const selectedSlotIndex = getSelectedInventorySlotIndex();
    if (
      selectedSlotIndex >= 0 &&
      selectedSlotIndex < INVENTORY_MAX_ITEMS &&
      inventory[selectedSlotIndex]?.id === itemId
    ) {
      inventory[selectedSlotIndex] = null;
      return true;
    }
    for (let i = INVENTORY_MAX_ITEMS - 1; i >= 0; i -= 1) {
      if (inventory[i]?.id !== itemId) {
        continue;
      }
      inventory[i] = null;
      return true;
    }
    return false;
  }

  function isFlashlightSuppressedByTwoHandedBat() {
    return getSelectedInventoryItem()?.id === BASEBALL_BAT_ITEM_ID;
  }

  function updateInventoryWheelSlotPositions() {
    const stepRadians = (Math.PI * 2) / INVENTORY_MAX_ITEMS;
    for (let i = 0; i < inventorySlots.length; i++) {
      const angle = -Math.PI / 2 + (i + inventoryWheelRotationSteps) * stepRadians;
      const x = Math.cos(angle) * INVENTORY_SLOT_RADIUS_PX;
      const y = Math.sin(angle) * INVENTORY_SLOT_RADIUS_PX;
      inventorySlots[i].slot.style.left = `calc(50% + ${x.toFixed(3)}px)`;
      inventorySlots[i].slot.style.top = `calc(50% + ${y.toFixed(3)}px)`;
    }
  }

  function setInventoryWheelRotationSteps(steps) {
    inventoryWheelRotationSteps = Math.trunc(steps || 0);
    updateInventoryWheelSlotPositions();
  }

  function consumeQueuedInventoryRotation(nowMs = performance.now()) {
    const { gameActive, isTopDownView } = getFlags();
    if (!gameActive || isTopDownView) {
      inventoryWheelRotationQueue.length = 0;
      inventoryWheelRotationUnlockAtMs = 0;
      return false;
    }
    if (nowMs < inventoryWheelRotationUnlockAtMs) {
      return false;
    }
    if (!inventoryWheelRotationQueue.length) {
      return false;
    }

    const step = inventoryWheelRotationQueue.shift();
    setInventoryWheelRotationSteps(inventoryWheelRotationSteps + step);
    inventoryWheelRotationUnlockAtMs = nowMs + INVENTORY_ROTATE_ANIMATION_DURATION_MS;
    updateInventoryHud();
    return true;
  }

  function rotateInventoryWheel(stepDirection) {
    const { gameActive, isTopDownView } = getFlags();
    if (!gameActive || isTopDownView) {
      return false;
    }
    const step = stepDirection > 0 ? 1 : -1;
    inventoryWheelRotationQueue.push(step);
    consumeQueuedInventoryRotation(performance.now());
    return true;
  }

  function initInventoryRadial() {
    if (!inventoryRadial || inventorySlots.length > 0) {
      return;
    }

    for (let i = 0; i < INVENTORY_MAX_ITEMS; i++) {
      const slot = document.createElement("div");
      slot.className = "inventory-slot empty";
      slot.style.left = "50%";
      slot.style.top = "50%";
      slot.style.zIndex = "1";
      slot.style.transition =
        `left ${INVENTORY_ROTATE_ANIMATION_DURATION_MS}ms ease, top ${INVENTORY_ROTATE_ANIMATION_DURATION_MS}ms ease, border-color 120ms ease, box-shadow 120ms ease, background-color 120ms ease`;

      const icon = document.createElement("span");
      icon.className = "inventory-slot-icon";
      icon.textContent = "";

      const image = document.createElement("img");
      image.className = "inventory-slot-image";
      image.alt = "";
      image.decoding = "async";
      image.loading = "lazy";
      image.style.display = "none";

      slot.append(image);
      slot.append(icon);
      inventoryRadial.append(slot);
      inventorySlots.push({ slot, icon, image });
    }

    const selectionOutline = document.createElement("div");
    selectionOutline.className = "inventory-slot";
    selectionOutline.style.left = "50%";
    selectionOutline.style.top = `calc(50% - ${INVENTORY_SLOT_RADIUS_PX}px)`;
    selectionOutline.style.zIndex = "3";
    selectionOutline.style.pointerEvents = "none";
    selectionOutline.style.background = "transparent";
    selectionOutline.style.borderColor = "#f5d58fd6";
    selectionOutline.style.boxShadow = "0 0 0 1px #f5d58f66, 0 0 14px #f5d58f36, inset 0 1px 5px #0007";
    inventoryRadial.append(selectionOutline);
    inventorySelectionOutline = selectionOutline;

    setInventoryWheelRotationSteps(inventoryWheelRotationSteps);
  }

  function updateInventoryHud() {
    if (!inventoryRadial) {
      return;
    }

    setInventoryWheelRotationSteps(inventoryWheelRotationSteps);

    if (inventorySelectionOutline) {
      inventorySelectionOutline.style.display = "grid";
    }

    for (let i = 0; i < inventorySlots.length; i++) {
      const slotRef = inventorySlots[i];
      const item = inventory[i];
      slotRef.slot.style.borderColor = "#96b8d154";
      slotRef.slot.style.background = "#102030c7";
      slotRef.slot.style.boxShadow = "inset 0 1px 5px #0007";

      if (!item) {
        slotRef.slot.classList.add("empty");
        slotRef.slot.removeAttribute("title");
        slotRef.icon.textContent = "";
        slotRef.image.style.display = "none";
        slotRef.image.removeAttribute("src");
        continue;
      }

      slotRef.slot.classList.remove("empty");
      slotRef.slot.title = item.name;
      const iconDataUrl = pickupSystem.getIconDataUrlByItemId(item.id);
      if (iconDataUrl) {
        if (slotRef.image.src !== iconDataUrl) {
          slotRef.image.src = iconDataUrl;
        }
        slotRef.image.style.display = "block";
        slotRef.icon.textContent = "";
      } else {
        slotRef.image.style.display = "none";
        slotRef.image.removeAttribute("src");
        slotRef.icon.textContent = "◆";
        void pickupSystem.ensureIconForItemId(item.id).then(() => {
          updateInventoryHud();
        });
      }
    }

    heldItemDisplay.onSelectionChanged();
  }

  function updatePickupPrompt() {
    if (!interactionHint) {
      return;
    }
    const { gameActive, isTopDownView } = getFlags();
    if (!gameActive || isTopDownView) {
      interactionHint.textContent = "";
      return;
    }

    const nearest = pickupSystem.findNearestPickup(camera.position, PICKUP_INTERACT_DISTANCE);
    if (!nearest) {
      interactionHint.textContent = "";
      return;
    }

    const occupiedCount = getInventoryOccupiedCount();
    if (occupiedCount >= INVENTORY_MAX_ITEMS) {
      interactionHint.textContent = `Inventory full (${INVENTORY_MAX_ITEMS}/${INVENTORY_MAX_ITEMS})`;
      return;
    }

    interactionHint.textContent = `Press E to pick up ${nearest.name}`;
  }

  function tryPickupNearest() {
    const { gameActive, isTopDownView } = getFlags();
    if (!gameActive || isTopDownView) {
      return;
    }
    if (getInventoryOccupiedCount() >= INVENTORY_MAX_ITEMS) {
      setStatus(`Inventory full (${INVENTORY_MAX_ITEMS} items max).`);
      updatePickupPrompt();
      return;
    }

    const picked = pickupSystem.pickupNearest(camera.position, PICKUP_INTERACT_DISTANCE);
    if (!picked) {
      return;
    }

    const emptySlotIndex = findFirstEmptyInventorySlotIndex();
    if (emptySlotIndex < 0) {
      setStatus(`Inventory full (${INVENTORY_MAX_ITEMS} items max).`);
      updatePickupPrompt();
      return;
    }
    inventory[emptySlotIndex] = { id: picked.id, name: picked.name };
    updateInventoryHud();
    updatePickupPrompt();
    setStatus(`Picked up ${picked.name}.`);
  }

  async function dropSelectedItem() {
    const { gameActive, isTopDownView } = getFlags();
    if (!gameActive || isTopDownView) {
      return false;
    }

    const selectedSlotIndex = getSelectedInventorySlotIndex();
    if (selectedSlotIndex < 0 || selectedSlotIndex >= INVENTORY_MAX_ITEMS) {
      return false;
    }
    const selectedItem = inventory[selectedSlotIndex];
    if (!selectedItem) {
      setStatus("No selected item to drop.");
      return false;
    }

    dropForward.set(0, 0, -1).applyQuaternion(camera.quaternion);
    dropForward.y = 0;
    if (dropForward.lengthSq() < 0.000001) {
      dropForward.set(0, 0, -1);
    }
    dropForward.normalize();
    dropRight.crossVectors(dropForward, worldUp).normalize();

    const dropDistance = 1.25;
    const lateralJitter = (Math.random() - 0.5) * 0.24;
    const dropPosition = {
      x: camera.position.x + dropForward.x * dropDistance + dropRight.x * lateralJitter,
      z: camera.position.z + dropForward.z * dropDistance + dropRight.z * lateralJitter,
    };
    const dropped = await pickupSystem.dropItemById(selectedItem.id, dropPosition);
    if (!dropped) {
      setStatus(`Could not drop ${selectedItem.name}.`);
      return false;
    }

    inventory[selectedSlotIndex] = null;
    updateInventoryHud();
    updatePickupPrompt();
    setStatus(`Dropped ${selectedItem.name}.`);
    return true;
  }

  function grantDebugInventory() {
    inventory.length = 0;
    for (const item of DEBUG_INVENTORY_ITEMS) {
      const emptySlotIndex = findFirstEmptyInventorySlotIndex();
      if (emptySlotIndex < 0) {
        break;
      }
      inventory[emptySlotIndex] = { id: item.id, name: item.name };
    }
    setInventoryWheelRotationSteps(0);
    updateInventoryHud();
    updatePickupPrompt();
    onDebugInventoryGranted?.();
    setStatus("Debug inventory loaded (one of each item). Infinite pistol ammo enabled.");
  }

  function reset() {
    inventory.length = 0;
    inventoryWheelRotationUnlockAtMs = 0;
    inventoryWheelRotationQueue.length = 0;
    setInventoryWheelRotationSteps(0);
    updateInventoryHud();
    updatePickupPrompt();
  }

  function getInventory() {
    return inventory;
  }

  function getInventoryWheelRotationSteps() {
    return inventoryWheelRotationSteps;
  }

  function update() {
    consumeQueuedInventoryRotation(performance.now());
  }

  return {
    initInventoryRadial,
    update,
    updateInventoryHud,
    updatePickupPrompt,
    tryPickupNearest,
    dropSelectedItem,
    grantDebugInventory,
    rotateInventoryWheel,
    setInventoryWheelRotationSteps,
    normalizeInventorySlotIndex,
    getSelectedInventorySlotIndex,
    getSelectedInventoryItem,
    getInventoryOccupiedCount,
    removeInventoryItemById,
    isFlashlightSuppressedByTwoHandedBat,
    reset,
    getInventory,
    getInventoryWheelRotationSteps,
  };
}
