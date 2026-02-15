import * as THREE from "three";
import { performance } from "node:perf_hooks";

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
const WARMUP_FRAMES = 300;
const MEASURED_FRAMES = 5400;
const RUNS = 3;

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

function percentile(sortedValues, q) {
  if (!sortedValues.length) {
    return 0;
  }
  const clamped = Math.max(0, Math.min(1, q));
  const index = Math.floor((sortedValues.length - 1) * clamped);
  return sortedValues[index];
}

function summarize(samples) {
  const sorted = samples.slice().sort((a, b) => a - b);
  const total = sorted.reduce((acc, value) => acc + value, 0);
  return {
    frames: sorted.length,
    avgMs: total / sorted.length,
    p50Ms: percentile(sorted, 0.5),
    p95Ms: percentile(sorted, 0.95),
    p99Ms: percentile(sorted, 0.99),
    maxMs: sorted[sorted.length - 1],
  };
}

function buildBenchmarkWorld(seed = 1337) {
  const cols = config.MAZE_COLS;
  const rows = config.MAZE_ROWS;
  const cellSize = config.CELL_SIZE;
  const worldHalfWidth = (cols * cellSize) * 0.5;
  const worldHalfDepth = (rows * cellSize) * 0.5;

  const maze = withSeededRandom(seed, () => generateMaze(cols, rows));
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

function createHarness(createWiremanSystemFactory, seed) {
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(75, 16 / 9, 0.1, 1000);
  const world = buildBenchmarkWorld(seed);
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

  return { camera, world, wireman };
}

function pickHiddenCell(world, observerCell) {
  const observerKey = makeCellKey(observerCell.col, observerCell.row);
  const visibleSet = world.visibilityMap.visibleCellKeySetByKey.get(observerKey) || new Set([observerKey]);
  let bestCell = null;
  let bestDistance = -1;

  for (const cell of world.visibilityMap.walkableCells) {
    if (visibleSet.has(cell.key)) {
      continue;
    }
    const distance = Math.abs(cell.col - observerCell.col) + Math.abs(cell.row - observerCell.row);
    if (distance > bestDistance) {
      bestCell = cell;
      bestDistance = distance;
    }
  }

  return bestCell || observerCell;
}

function pickCloseVisibleCell(world, observerCell) {
  const visible = world.getVisibleCellsForCell(observerCell.col, observerCell.row);
  let bestCell = observerCell;
  let bestDistance = Number.POSITIVE_INFINITY;

  for (const cell of visible) {
    if (cell.col === observerCell.col && cell.row === observerCell.row) {
      continue;
    }
    const distance = Math.abs(cell.col - observerCell.col) + Math.abs(cell.row - observerCell.row);
    if (distance >= 1 && distance <= 2 && distance < bestDistance) {
      bestCell = cell;
      bestDistance = distance;
    }
  }

  if (bestDistance !== Number.POSITIVE_INFINITY) {
    return bestCell;
  }

  for (const cell of visible) {
    if (cell.col === observerCell.col && cell.row === observerCell.row) {
      continue;
    }
    const distance = Math.abs(cell.col - observerCell.col) + Math.abs(cell.row - observerCell.row);
    if (distance < bestDistance) {
      bestCell = cell;
      bestDistance = distance;
    }
  }

  return bestCell;
}

function runScenario({ harness, warmupFrames, measuredFrames, gameActive, hasWon, poseCamera }) {
  const { wireman, world, camera } = harness;
  wireman.onMazeRegenerated();

  for (let i = 0; i < warmupFrames; i += 1) {
    const state = wireman.getState();
    const wireCell = state.cell || world.getExitCell();
    poseCamera({ world, camera, wireCell, frame: i, warmup: true });
    wireman.update(DT_SECONDS, { gameActive, hasWon });
  }

  const durationsMs = [];
  for (let i = 0; i < measuredFrames; i += 1) {
    const state = wireman.getState();
    const wireCell = state.cell || world.getExitCell();
    poseCamera({ world, camera, wireCell, frame: i, warmup: false });

    const startMs = performance.now();
    wireman.update(DT_SECONDS, { gameActive, hasWon });
    durationsMs.push(performance.now() - startMs);
  }

  return summarize(durationsMs);
}

function meanMetric(records, metric) {
  const total = records.reduce((acc, row) => acc + row[metric], 0);
  return total / records.length;
}

function runImplementation(name, createFactory) {
  const perRun = [];

  for (let run = 0; run < RUNS; run += 1) {
    const seed = 1337 + run;
    const harness = createHarness(createFactory, seed);

    const hiddenInvestigate = runScenario({
      harness,
      warmupFrames: WARMUP_FRAMES,
      measuredFrames: MEASURED_FRAMES,
      gameActive: true,
      hasWon: false,
      poseCamera: ({ world, camera, wireCell }) => {
        const hiddenCell = pickHiddenCell(world, wireCell);
        const pos = world.cellToWorld(hiddenCell.col, hiddenCell.row);
        camera.position.set(pos.x, config.PLAYER_HEIGHT, pos.z);
      },
    });

    const visibleChase = runScenario({
      harness,
      warmupFrames: WARMUP_FRAMES,
      measuredFrames: MEASURED_FRAMES,
      gameActive: true,
      hasWon: false,
      poseCamera: ({ world, camera, wireCell }) => {
        const chaseCell = pickCloseVisibleCell(world, wireCell);
        const pos = world.cellToWorld(chaseCell.col, chaseCell.row);
        camera.position.set(pos.x, config.PLAYER_HEIGHT, pos.z);
      },
    });

    const pausedBaseline = runScenario({
      harness,
      warmupFrames: WARMUP_FRAMES,
      measuredFrames: MEASURED_FRAMES,
      gameActive: false,
      hasWon: false,
      poseCamera: ({ world, camera, wireCell }) => {
        const pos = world.cellToWorld(wireCell.col, wireCell.row);
        camera.position.set(pos.x, config.PLAYER_HEIGHT, pos.z);
      },
    });

    perRun.push({ run: run + 1, hiddenInvestigate, visibleChase, pausedBaseline });
  }

  const aggregate = {
    hiddenInvestigate: {
      avgMs: meanMetric(perRun.map((r) => r.hiddenInvestigate), "avgMs"),
      p95Ms: meanMetric(perRun.map((r) => r.hiddenInvestigate), "p95Ms"),
      p99Ms: meanMetric(perRun.map((r) => r.hiddenInvestigate), "p99Ms"),
      maxMs: meanMetric(perRun.map((r) => r.hiddenInvestigate), "maxMs"),
    },
    visibleChase: {
      avgMs: meanMetric(perRun.map((r) => r.visibleChase), "avgMs"),
      p95Ms: meanMetric(perRun.map((r) => r.visibleChase), "p95Ms"),
      p99Ms: meanMetric(perRun.map((r) => r.visibleChase), "p99Ms"),
      maxMs: meanMetric(perRun.map((r) => r.visibleChase), "maxMs"),
    },
    pausedBaseline: {
      avgMs: meanMetric(perRun.map((r) => r.pausedBaseline), "avgMs"),
      p95Ms: meanMetric(perRun.map((r) => r.pausedBaseline), "p95Ms"),
      p99Ms: meanMetric(perRun.map((r) => r.pausedBaseline), "p99Ms"),
      maxMs: meanMetric(perRun.map((r) => r.pausedBaseline), "maxMs"),
    },
  };

  return { name, perRun, aggregate };
}

function main() {
  const baseline = runImplementation("baseline", createBaselineWiremanSystem);
  const candidate = runImplementation("candidate", createCandidateWiremanSystem);

  const speedup = {
    hiddenInvestigateAvg: baseline.aggregate.hiddenInvestigate.avgMs /
      Math.max(candidate.aggregate.hiddenInvestigate.avgMs, 1e-9),
    hiddenInvestigateP95: baseline.aggregate.hiddenInvestigate.p95Ms /
      Math.max(candidate.aggregate.hiddenInvestigate.p95Ms, 1e-9),
    visibleChaseAvg: baseline.aggregate.visibleChase.avgMs /
      Math.max(candidate.aggregate.visibleChase.avgMs, 1e-9),
  };

  console.log(
    JSON.stringify(
      {
        env: {
          node: process.version,
          dtSeconds: DT_SECONDS,
          warmupFrames: WARMUP_FRAMES,
          measuredFrames: MEASURED_FRAMES,
          runs: RUNS,
        },
        baseline,
        candidate,
        speedup,
      },
      null,
      2,
    ),
  );
}

main();
