import * as THREE from "three";

import * as config from "./config.mjs";
import { createGameConstants } from "./constants.mjs";
import {
  generateMaze,
  buildWalkableVisibilityMap,
  findFarthestOpenCell,
} from "./maze.mjs";
import { createWiremanSystem as createBaselineWiremanSystem } from "./wiremanSystem.baseline.mjs";
import { createWiremanSystem as createCandidateWiremanSystem } from "./wiremanSystem.candidate.mjs";

const DT_SECONDS = 1 / 60;
const WARMUP_FRAMES = 240;
const TEST_FRAMES = 5400;

function withSeededRandom(seed, fn) {
  const prevRandom = Math.random;
  let state = seed >>> 0;
  Math.random = () => {
    state = (1664525 * state + 1013904223) >>> 0;
    return state / 4294967296;
  };
  try {
    return fn();
  } finally {
    Math.random = prevRandom;
  }
}

function makeCellKey(col, row) {
  return `${col},${row}`;
}

function buildBenchmarkWorld() {
  const cols = config.MAZE_COLS;
  const rows = config.MAZE_ROWS;
  const cellSize = config.CELL_SIZE;
  const worldHalfWidth = (cols * cellSize) * 0.5;
  const worldHalfDepth = (rows * cellSize) * 0.5;

  const maze = withSeededRandom(1337, () => generateMaze(cols, rows));
  const isWalkableCell = (col, row) =>
    row >= 0 && row < rows && col >= 0 && col < cols && maze[row]?.[col] === 0;

  const visibilityMap = buildWalkableVisibilityMap({
    maze,
    cols,
    rows,
    isWalkableCell,
  });

  const startCell = isWalkableCell(1, 1)
    ? { col: 1, row: 1 }
    : visibilityMap.walkableCells[0] || { col: 1, row: 1 };
  const farthest = findFarthestOpenCell(startCell, isWalkableCell);
  const exitCell = isWalkableCell(farthest.col, farthest.row)
    ? { col: farthest.col, row: farthest.row }
    : visibilityMap.walkableCells.at(-1) || startCell;

  const cellToWorld = (col, row) => ({
    x: col * cellSize - worldHalfWidth + cellSize * 0.5,
    z: row * cellSize - worldHalfDepth + cellSize * 0.5,
  });

  const worldToCell = (x, z) => {
    const col = Math.floor((x + worldHalfWidth) / cellSize);
    const row = Math.floor((z + worldHalfDepth) / cellSize);
    return {
      col: Math.max(0, Math.min(cols - 1, col)),
      row: Math.max(0, Math.min(rows - 1, row)),
    };
  };

  const getVisibleCellsForCell = (col, row) => {
    const key = makeCellKey(col, row);
    return visibilityMap.visibleCellsByKey.get(key) || [];
  };

  const areCellsVisible = (fromCol, fromRow, toCol, toRow) => {
    const fromKey = makeCellKey(fromCol, fromRow);
    const toKey = makeCellKey(toCol, toRow);
    const set = visibilityMap.visibleCellKeySetByKey.get(fromKey);
    return Boolean(set && set.has(toKey));
  };

  return {
    cols,
    rows,
    maze,
    visibilityMap,
    isWalkableCell,
    getStartCell: () => ({ ...startCell }),
    getExitCell: () => ({ ...exitCell }),
    getMaze: () => maze,
    worldToCell,
    cellToWorld,
    getVisibilityMap: () => visibilityMap,
    getVisibleCellsForCell,
    areCellsVisible,
  };
}

class MockGLTFLoader {
  load(_modelPath, onLoad, _onProgress, onError) {
    try {
      const scene = new THREE.Group();
      const body = new THREE.Mesh(
        new THREE.BoxGeometry(0.8, 2.0, 0.8),
        new THREE.MeshBasicMaterial(),
      );
      body.position.y = 1;
      scene.add(body);
      onLoad?.({ scene, animations: [] });
    } catch (error) {
      onError?.(error);
    }
  }
}

function createHarness(createWiremanSystemFactory, world) {
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(75, 16 / 9, 0.1, 1000);
  const constants = createGameConstants({
    THREE,
    cellSize: config.CELL_SIZE,
    playerSpeed: config.PLAYER_SPEED,
  });

  const wireman = createWiremanSystemFactory({
    THREE,
    GLTFLoader: MockGLTFLoader,
    scene,
    camera,
    world,
    config,
    constants,
    applyPlayerDamage: () => {},
    playWiremanAttackSound: () => {},
  });

  if (!wireman.isLoaded()) {
    throw new Error("Wireman failed to load");
  }

  wireman.onMazeRegenerated();
  return { wireman, camera };
}

function selectCameraCell(world, frame) {
  const spawn = world.getExitCell();
  const spawnKey = makeCellKey(spawn.col, spawn.row);
  const visibleFromSpawn = world.getVisibleCellsForCell(spawn.col, spawn.row);
  const visibleSet = world.visibilityMap.visibleCellKeySetByKey.get(spawnKey) || new Set([spawnKey]);

  const hiddenCells = world.visibilityMap.walkableCells
    .filter((cell) => !visibleSet.has(cell.key))
    .sort(
      (a, b) =>
        Math.abs(b.col - spawn.col) + Math.abs(b.row - spawn.row) -
        (Math.abs(a.col - spawn.col) + Math.abs(a.row - spawn.row)),
    );

  const visibleCells = visibleFromSpawn
    .filter((cell) => !(cell.col === spawn.col && cell.row === spawn.row))
    .sort(
      (a, b) =>
        Math.abs(a.col - spawn.col) + Math.abs(a.row - spawn.row) -
        (Math.abs(b.col - spawn.col) + Math.abs(b.row - spawn.row)),
    );

  const hiddenPool = hiddenCells.length ? hiddenCells : [spawn];
  const visiblePool = visibleCells.length ? visibleCells : [spawn];

  const phase = frame % 720;
  if (phase < 240) {
    return hiddenPool[phase % hiddenPool.length];
  }
  if (phase < 360) {
    return visiblePool[phase % visiblePool.length];
  }
  if (phase < 540) {
    return hiddenPool[(phase * 3) % hiddenPool.length];
  }
  return visiblePool[(phase * 5) % visiblePool.length];
}

function areCellsEqual(a, b) {
  if (!a && !b) {
    return true;
  }
  if (!a || !b) {
    return false;
  }
  return a.col === b.col && a.row === b.row;
}

function areNumbersClose(a, b, epsilon = 1e-9) {
  return Math.abs((a || 0) - (b || 0)) <= epsilon;
}

function comparePathCells(aPath, bPath) {
  if (aPath.length !== bPath.length) {
    return false;
  }
  for (let i = 0; i < aPath.length; i += 1) {
    if (!areCellsEqual(aPath[i], bPath[i])) {
      return false;
    }
  }
  return true;
}

function compareStates(frame, aState, bState, aPathCells, bPathCells) {
  const checks = [
    ["loaded", aState.loaded === bState.loaded],
    ["moving", aState.moving === bState.moving],
    ["sprinting", aState.sprinting === bState.sprinting],
    ["lineOfSightToPlayer", aState.lineOfSightToPlayer === bState.lineOfSightToPlayer],
    ["animation", aState.animation === bState.animation],
    ["huntMode", aState.huntMode === bState.huntMode],
    ["pathLength", aState.pathLength === bState.pathLength],
    ["pathIndex", aState.pathIndex === bState.pathIndex],
    ["goalCell", areCellsEqual(aState.goalCell, bState.goalCell)],
    ["huntTargetCell", areCellsEqual(aState.huntTargetCell, bState.huntTargetCell)],
    ["searchTargetCell", areCellsEqual(aState.searchTargetCell, bState.searchTargetCell)],
    ["cell", areCellsEqual(aState.cell, bState.cell)],
    ["beliefPeakCell", areCellsEqual(aState.beliefPeakCell, bState.beliefPeakCell)],
    ["beliefPeak", areNumbersClose(aState.beliefPeak, bState.beliefPeak, 1e-12)],
    ["distanceToPlayer", areNumbersClose(aState.distanceToPlayer, bState.distanceToPlayer)],
    ["distanceToGoal", areNumbersClose(aState.distanceToGoal, bState.distanceToGoal)],
    ["position.x", areNumbersClose(aState.position?.x, bState.position?.x)],
    ["position.z", areNumbersClose(aState.position?.z, bState.position?.z)],
    ["pathCells", comparePathCells(aPathCells, bPathCells)],
  ];

  for (const [label, pass] of checks) {
    if (!pass) {
      return {
        ok: false,
        frame,
        field: label,
        baseline: {
          state: aState,
          pathCells: aPathCells,
        },
        candidate: {
          state: bState,
          pathCells: bPathCells,
        },
      };
    }
  }

  return { ok: true };
}

function compareBeliefs(frame, world, baselineWireman, candidateWireman) {
  for (const cell of world.visibilityMap.walkableCells) {
    const a = baselineWireman.getHuntScoreForCell(cell.col, cell.row);
    const b = candidateWireman.getHuntScoreForCell(cell.col, cell.row);
    if (!areNumbersClose(a, b, 1e-12)) {
      return {
        ok: false,
        frame,
        field: `belief:${cell.key}`,
        baseline: a,
        candidate: b,
      };
    }
  }
  return { ok: true };
}

function main() {
  const world = buildBenchmarkWorld();
  const baseline = createHarness(createBaselineWiremanSystem, world);
  const candidate = createHarness(createCandidateWiremanSystem, world);

  const runFrame = (frame, warmup = false) => {
    const cameraCell = selectCameraCell(world, frame);
    const cameraPosition = world.cellToWorld(cameraCell.col, cameraCell.row);
    baseline.camera.position.set(cameraPosition.x, config.PLAYER_HEIGHT, cameraPosition.z);
    candidate.camera.position.set(cameraPosition.x, config.PLAYER_HEIGHT, cameraPosition.z);

    const gameActive = frame % 500 < 460;
    const hasWon = false;

    baseline.wireman.update(DT_SECONDS, { gameActive, hasWon });
    candidate.wireman.update(DT_SECONDS, { gameActive, hasWon });

    if (warmup) {
      return { ok: true };
    }

    const aState = baseline.wireman.getState();
    const bState = candidate.wireman.getState();
    const aPath = baseline.wireman.getPathCells();
    const bPath = candidate.wireman.getPathCells();

    const stateResult = compareStates(frame, aState, bState, aPath, bPath);
    if (!stateResult.ok) {
      return stateResult;
    }

    const beliefResult = compareBeliefs(frame, world, baseline.wireman, candidate.wireman);
    if (!beliefResult.ok) {
      return beliefResult;
    }

    return { ok: true };
  };

  for (let frame = 0; frame < WARMUP_FRAMES; frame += 1) {
    const result = runFrame(frame, true);
    if (!result.ok) {
      console.log(JSON.stringify({ parity: false, mismatch: result }, null, 2));
      process.exit(1);
    }
  }

  for (let frame = 0; frame < TEST_FRAMES; frame += 1) {
    const result = runFrame(frame, false);
    if (!result.ok) {
      console.log(JSON.stringify({ parity: false, mismatch: result }, null, 2));
      process.exit(1);
    }
  }

  console.log(
    JSON.stringify(
      {
        parity: true,
        checkedFrames: TEST_FRAMES,
        warmupFrames: WARMUP_FRAMES,
        walkableCells: world.visibilityMap.walkableCells.length,
      },
      null,
      2,
    ),
  );
}

main();
