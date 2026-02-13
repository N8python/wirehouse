export function createHeldItemDisplaySystem({
  THREE,
  constants,
  pickupSystem,
  inventoryLeftHandItemAnchor,
  getSelectedInventoryItem,
  setStatus,
}) {
  const {
    HELD_ITEM_DISPLAY_TUNING,
    LEFT_HAND_ITEM_TARGET_SIZE,
    HELD_ITEM_TUNING_SLIDER_DEFS,
    ENABLE_HELD_ITEM_TUNING_UI,
  } = constants;

  const heldItemBounds = new THREE.Box3();
  const heldItemCenter = new THREE.Vector3();
  const heldItemSize = new THREE.Vector3();
  const heldItemLocalBoundsScratch = new THREE.Box3();

  const heldInventoryModelById = new Map();
  const heldInventoryModelPromiseById = new Map();
  let heldInventoryItemId = null;
  let heldInventoryLoadToken = 0;

  const heldItemTuningUi = {
    panel: null,
    selectedLabel: null,
    rows: new Map(),
    exportBox: null,
  };

  function getOrCreateHeldItemTuning(itemId) {
    if (!HELD_ITEM_DISPLAY_TUNING[itemId]) {
      HELD_ITEM_DISPLAY_TUNING[itemId] = {
        targetSize: LEFT_HAND_ITEM_TARGET_SIZE,
        offset: [0, 0, 0],
        rotation: [0, 0, 0],
      };
    }
    const tuning = HELD_ITEM_DISPLAY_TUNING[itemId];
    if (!Array.isArray(tuning.offset) || tuning.offset.length !== 3) {
      tuning.offset = [0, 0, 0];
    }
    if (!Array.isArray(tuning.rotation) || tuning.rotation.length !== 3) {
      tuning.rotation = [0, 0, 0];
    }
    if (typeof tuning.targetSize !== "number" || !Number.isFinite(tuning.targetSize)) {
      tuning.targetSize = LEFT_HAND_ITEM_TARGET_SIZE;
    }
    return tuning;
  }

  function getHeldItemTuningValue(tuning, key) {
    switch (key) {
      case "targetSize":
        return tuning.targetSize;
      case "offsetX":
        return tuning.offset[0];
      case "offsetY":
        return tuning.offset[1];
      case "offsetZ":
        return tuning.offset[2];
      case "rotX":
        return tuning.rotation[0];
      case "rotY":
        return tuning.rotation[1];
      case "rotZ":
        return tuning.rotation[2];
      default:
        return 0;
    }
  }

  function setHeldItemTuningValue(tuning, key, value) {
    switch (key) {
      case "targetSize":
        tuning.targetSize = value;
        break;
      case "offsetX":
        tuning.offset[0] = value;
        break;
      case "offsetY":
        tuning.offset[1] = value;
        break;
      case "offsetZ":
        tuning.offset[2] = value;
        break;
      case "rotX":
        tuning.rotation[0] = value;
        break;
      case "rotY":
        tuning.rotation[1] = value;
        break;
      case "rotZ":
        tuning.rotation[2] = value;
        break;
      default:
        break;
    }
  }

  function normalizeHeldInventoryModel(model, itemId) {
    model.position.set(0, 0, 0);
    model.rotation.set(0, 0, 0);
    model.scale.set(1, 1, 1);
    model.updateMatrixWorld(true);

    heldItemBounds.setFromObject(model);
    if (heldItemBounds.isEmpty()) {
      return;
    }

    const tuning = HELD_ITEM_DISPLAY_TUNING[itemId];
    heldItemBounds.getCenter(heldItemCenter);
    model.position.sub(heldItemCenter);
    model.updateMatrixWorld(true);

    heldItemBounds.setFromObject(model);
    heldItemBounds.getSize(heldItemSize);
    const maxDimension = Math.max(heldItemSize.x, heldItemSize.y, heldItemSize.z, 0.001);
    const targetSize = tuning?.targetSize ?? LEFT_HAND_ITEM_TARGET_SIZE;
    const scale = targetSize / maxDimension;
    model.scale.multiplyScalar(scale);
    model.position.y -= targetSize * 0.12;
    if (tuning?.offset) {
      model.position.x += tuning.offset[0];
      model.position.y += tuning.offset[1];
      model.position.z += tuning.offset[2];
    }
    if (tuning?.rotation) {
      model.rotation.set(tuning.rotation[0], tuning.rotation[1], tuning.rotation[2]);
    }
    model.updateMatrixWorld(true);
    heldItemLocalBoundsScratch.setFromObject(model);
    if (!heldItemLocalBoundsScratch.isEmpty()) {
      model.userData.localBounds = heldItemLocalBoundsScratch.clone();
    }
  }

  function retuneHeldInventoryModel(itemId) {
    const model = heldInventoryModelById.get(itemId);
    if (!model) {
      return;
    }
    const parent = model.parent || null;
    if (parent) {
      parent.remove(model);
    }
    normalizeHeldInventoryModel(model, itemId);
    if (parent) {
      parent.add(model);
    }
    model.updateMatrixWorld(true);
  }

  function updateHeldItemTuningExportText(itemId, tuning) {
    if (!heldItemTuningUi.exportBox) {
      return;
    }
    if (!itemId || !tuning) {
      heldItemTuningUi.exportBox.value = "";
      return;
    }
    heldItemTuningUi.exportBox.value = `"${itemId}": ${JSON.stringify(tuning, null, 2)}`;
  }

  function syncHeldItemTuningPanel() {
    if (!heldItemTuningUi.panel) {
      return;
    }

    const selected = getSelectedInventoryItem();
    if (!selected) {
      heldItemTuningUi.selectedLabel.textContent = "selected: none";
      for (const row of heldItemTuningUi.rows.values()) {
        row.input.disabled = true;
        row.value.textContent = "--";
        row.input.value = "0";
      }
      updateHeldItemTuningExportText(null, null);
      return;
    }

    const tuning = getOrCreateHeldItemTuning(selected.id);
    heldItemTuningUi.selectedLabel.textContent = `selected: ${selected.name} (${selected.id})`;

    for (const [key, row] of heldItemTuningUi.rows) {
      const value = getHeldItemTuningValue(tuning, key);
      row.input.disabled = false;
      row.input.value = `${value}`;
      row.value.textContent = value.toFixed(3);
    }

    updateHeldItemTuningExportText(selected.id, tuning);
  }

  function onHeldItemTuningSliderInput(key, value) {
    const selected = getSelectedInventoryItem();
    if (!selected) {
      return;
    }
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) {
      return;
    }
    const tuning = getOrCreateHeldItemTuning(selected.id);
    setHeldItemTuningValue(tuning, key, numeric);
    retuneHeldInventoryModel(selected.id);
    syncHeldItemTuningPanel();
  }

  function createHeldItemTuningRow(def) {
    const row = document.createElement("div");
    row.style.display = "grid";
    row.style.gridTemplateColumns = "40px 1fr 54px";
    row.style.gap = "6px";
    row.style.alignItems = "center";
    row.style.marginBottom = "4px";

    const label = document.createElement("span");
    label.textContent = def.label;
    label.style.fontSize = "11px";
    label.style.color = "#d7e7ff";

    const input = document.createElement("input");
    input.type = "range";
    input.min = `${def.min}`;
    input.max = `${def.max}`;
    input.step = `${def.step}`;
    input.value = "0";
    input.addEventListener("input", () => onHeldItemTuningSliderInput(def.key, input.value));

    const value = document.createElement("span");
    value.textContent = "0.000";
    value.style.fontSize = "11px";
    value.style.color = "#c6d7ee";
    value.style.fontFamily = "monospace";
    value.style.textAlign = "right";

    row.append(label, input, value);
    return { row, input, value };
  }

  function initHeldItemTuningPanel() {
    if (heldItemTuningUi.panel) {
      return;
    }

    const panel = document.createElement("div");
    panel.style.position = "fixed";
    panel.style.left = "10px";
    panel.style.bottom = "10px";
    panel.style.width = "320px";
    panel.style.maxHeight = "46vh";
    panel.style.overflow = "auto";
    panel.style.zIndex = "8";
    panel.style.padding = "10px";
    panel.style.border = "1px solid #5f7c95aa";
    panel.style.borderRadius = "10px";
    panel.style.background = "#0b1119e6";
    panel.style.backdropFilter = "blur(3px)";
    panel.style.boxShadow = "0 6px 20px #0009";
    panel.style.pointerEvents = "auto";

    const title = document.createElement("div");
    title.textContent = "Held Item Tuning";
    title.style.fontSize = "13px";
    title.style.fontWeight = "700";
    title.style.color = "#eaf2ff";
    title.style.marginBottom = "6px";

    const selectedLabel = document.createElement("div");
    selectedLabel.style.fontSize = "11px";
    selectedLabel.style.color = "#b8cbe4";
    selectedLabel.style.marginBottom = "8px";
    selectedLabel.textContent = "selected: none";
    panel.append(title, selectedLabel);

    for (const def of HELD_ITEM_TUNING_SLIDER_DEFS) {
      const row = createHeldItemTuningRow(def);
      panel.append(row.row);
      heldItemTuningUi.rows.set(def.key, row);
    }

    const copyButton = document.createElement("button");
    copyButton.type = "button";
    copyButton.textContent = "Copy Selected Tuning";
    copyButton.style.marginTop = "6px";
    copyButton.style.marginBottom = "6px";
    copyButton.style.width = "100%";
    copyButton.style.padding = "6px 8px";
    copyButton.style.border = "1px solid #8db6da66";
    copyButton.style.borderRadius = "7px";
    copyButton.style.background = "#1a3148";
    copyButton.style.color = "#eaf2ff";
    copyButton.style.cursor = "pointer";
    copyButton.addEventListener("click", async () => {
      const text = heldItemTuningUi.exportBox?.value || "";
      if (!text) {
        return;
      }
      try {
        await navigator.clipboard.writeText(text);
        setStatus("Copied selected tuning JSON.");
      } catch {
        setStatus("Could not copy tuning JSON (clipboard unavailable).");
      }
    });

    const exportBox = document.createElement("textarea");
    exportBox.readOnly = true;
    exportBox.spellcheck = false;
    exportBox.style.width = "100%";
    exportBox.style.height = "118px";
    exportBox.style.resize = "vertical";
    exportBox.style.fontFamily = "monospace";
    exportBox.style.fontSize = "11px";
    exportBox.style.color = "#d8e8ff";
    exportBox.style.background = "#060b10";
    exportBox.style.border = "1px solid #355271";
    exportBox.style.borderRadius = "7px";
    exportBox.style.padding = "6px";

    panel.append(copyButton, exportBox);
    document.body.append(panel);

    heldItemTuningUi.panel = panel;
    heldItemTuningUi.selectedLabel = selectedLabel;
    heldItemTuningUi.exportBox = exportBox;
    syncHeldItemTuningPanel();
  }

  function ensureHeldInventoryModel(itemId) {
    if (heldInventoryModelById.has(itemId)) {
      return Promise.resolve(heldInventoryModelById.get(itemId));
    }
    if (heldInventoryModelPromiseById.has(itemId)) {
      return heldInventoryModelPromiseById.get(itemId);
    }

    const promise = pickupSystem
      .createDisplayModelForItemId(itemId)
      .then((model) => {
        if (!model) {
          return null;
        }
        normalizeHeldInventoryModel(model, itemId);
        heldInventoryModelById.set(itemId, model);
        return model;
      })
      .catch(() => null);

    heldInventoryModelPromiseById.set(itemId, promise);
    return promise;
  }

  function updateHeldInventoryItem() {
    const selectedItem = getSelectedInventoryItem();
    const nextItemId = selectedItem?.id || null;
    if (nextItemId === heldInventoryItemId) {
      return;
    }

    heldInventoryItemId = nextItemId;
    heldInventoryLoadToken += 1;
    const loadToken = heldInventoryLoadToken;
    inventoryLeftHandItemAnchor.clear();

    if (!nextItemId) {
      return;
    }

    void ensureHeldInventoryModel(nextItemId).then((model) => {
      if (loadToken !== heldInventoryLoadToken || heldInventoryItemId !== nextItemId || !model) {
        return;
      }
      inventoryLeftHandItemAnchor.clear();
      inventoryLeftHandItemAnchor.add(model);
    });
  }

  function reset() {
    heldInventoryItemId = null;
    heldInventoryLoadToken += 1;
    inventoryLeftHandItemAnchor.clear();
  }

  function onSelectionChanged() {
    updateHeldInventoryItem();
    syncHeldItemTuningPanel();
  }

  function init() {
    if (ENABLE_HELD_ITEM_TUNING_UI) {
      initHeldItemTuningPanel();
    }
  }

  function getHeldInventoryItemId() {
    return heldInventoryItemId;
  }

  function getHeldInventoryModelById() {
    return heldInventoryModelById;
  }

  return {
    init,
    reset,
    onSelectionChanged,
    getHeldInventoryItemId,
    getHeldInventoryModelById,
  };
}
