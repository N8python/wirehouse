import * as THREE from "three";
import { performance } from "node:perf_hooks";
import { createWiremanSystem } from "../src/game/systems/wiremanSystem.js";
import { createGameConstants } from "../src/game/constants.js";
import * as config from "../src/config.js";
import {
  generateMaze,
  findFarthestOpenCell,
  buildWalkableVisibilityMap,
} from "../src/world/maze.js";

class FakeGLTFLoader {
  load(_path, onLoad, _onProgress, _onError) {
    const scene = new THREE.Group();
    const mesh = new THREE.Mesh(
      new THREE.BoxGeometry(1, 2, 1),
      new THREE.MeshBasicMaterial({ color: 0xffffff }),
    );
    scene.add(mesh);
    onLoad?.({ scene, animations: [] });
  }
}

function percentile(values, ratio) {
  if (!values.length) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor(Math.max(0, Math.min(1, ratio)) * (sorted.length - 1)));
  return sorted[idx];
}

function summarize(values) {
  const count = values.length;
  const total = values.reduce((sum, value) => sum + value, 0);
  const avgMs = count > 0 ? total / count : 0;
  return {
    count,
    avgMs,
    p50Ms: percentile(values, 0.5),
    p95Ms: percentile(values, 0.95),
    maxMs: count > 0 ? Math.max(...values) : 0,
  };
}

function makeWorld() {
  const maze = generateMaze(config.MAZE_COLS, config.MAZE_ROWS);
  const startCell = { col: 1, row: 1 };
  const exitCell = findFarthestOpenCell(startCell, (col, row) => {
    if (row < 0 || row >= config.MAZE_ROWS || col < 0 || col >= config.MAZE_COLS) {
      return false;
    }
    return maze[row][col] === 0;
  });
  const visibilityMap = buildWalkableVisibilityMap({
    maze,
    cols: config.MAZE_COLS,
    rows: config.MAZE_ROWS,
    isWalkableCell: (col, row) => {
      if (row < 0 || row >= config.MAZE_ROWS || col < 0 || col >= config.MAZE_COLS) {
        return false;
      }
      return maze[row][col] === 0;
    },
  });

  const worldHalfWidth = (config.MAZE_COLS * config.CELL_SIZE) * 0.5;
  const worldHalfDepth = (config.MAZE_ROWS * config.CELL_SIZE) * 0.5;

  const world = {
    isWalkableCell(col, row) {
      if (row < 0 || row >= config.MAZE_ROWS || col < 0 || col >= config.MAZE_COLS) {
        return false;
      }
      return maze[row][col] === 0;
    },
    worldToCell(x, z) {
      return {
        col: Math.floor((x + worldHalfWidth) / config.CELL_SIZE),
        row: Math.floor((z + worldHalfDepth) / config.CELL_SIZE),
      };
    },
    cellToWorld(col, row) {
      return {
        x: col * config.CELL_SIZE - worldHalfWidth + config.CELL_SIZE * 0.5,
        z: row * config.CELL_SIZE - worldHalfDepth + config.CELL_SIZE * 0.5,
      };
    },
    getStartCell() {
      return startCell;
    },
    getExitCell() {
      return exitCell;
    },
    getMaze() {
      return maze;
    },
    getVisibilityMap() {
      return visibilityMap;
    },
    getVisibleCellsForCell(col, row) {
      return visibilityMap.visibleCellsByKey.get(`${col},${row}`) || [];
    },
    areCellsVisible(fromCol, fromRow, toCol, toRow) {
      const visibleSet = visibilityMap.visibleCellKeySetByKey.get(`${fromCol},${fromRow}`);
      return visibleSet ? visibleSet.has(`${toCol},${toRow}`) : false;
    },
    resolveWorldCollision(x, z) {
      return { x, z };
    },
  };

  const walkableCells = visibilityMap.walkableCells.map((cell) => ({ col: cell.col, row: cell.row }));
  const neighborsByKey = new Map();
  for (const cell of walkableCells) {
    const key = `${cell.col},${cell.row}`;
    const neighbors = [];
    const offsets = [[1, 0], [-1, 0], [0, 1], [0, -1]];
    for (const [dc, dr] of offsets) {
      const nextCol = cell.col + dc;
      const nextRow = cell.row + dr;
      if (world.isWalkableCell(nextCol, nextRow)) {
        neighbors.push({ col: nextCol, row: nextRow });
      }
    }
    neighborsByKey.set(key, neighbors);
  }

  return { world, startCell, walkableCells, neighborsByKey };
}

function runBenchmark() {
  const { world, startCell, walkableCells, neighborsByKey } = makeWorld();

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(75, 16 / 9, 0.1, 1000);
  const startWorld = world.cellToWorld(startCell.col, startCell.row);
  camera.position.set(startWorld.x, config.PLAYER_HEIGHT, startWorld.z);

  const constants = createGameConstants({
    THREE,
    cellSize: config.CELL_SIZE,
    playerSpeed: config.PLAYER_SPEED,
  });

  const wireman = createWiremanSystem({
    THREE,
    GLTFLoader: FakeGLTFLoader,
    scene,
    camera,
    world,
    config,
    constants,
    applyPlayerDamage: () => {},
    playWiremanAttackSound: () => {},
  });

  wireman.onMazeRegenerated();

  const frameDt = 1 / 60;
  const warmupFrames = 600;
  const sampleFrames = 6000;
  const all = [];
  const los = [];
  const noLos = [];

  let playerCell = { ...startCell };
  let targetCell = { ...startCell };
  let targetBlend = 1;

  const pickRandomWalkableCell = () => walkableCells[Math.floor(Math.random() * walkableCells.length)];

  for (let frame = 0; frame < warmupFrames + sampleFrames; frame += 1) {
    if (targetBlend >= 1) {
      const currentKey = `${playerCell.col},${playerCell.row}`;
      const localNeighbors = neighborsByKey.get(currentKey) || [];
      if (localNeighbors.length > 0 && Math.random() < 0.8) {
        targetCell = localNeighbors[Math.floor(Math.random() * localNeighbors.length)];
      } else {
        targetCell = pickRandomWalkableCell();
      }
      targetBlend = 0;
    }

    targetBlend = Math.min(1, targetBlend + 0.12);
    const fromWorld = world.cellToWorld(playerCell.col, playerCell.row);
    const toWorld = world.cellToWorld(targetCell.col, targetCell.row);
    const x = THREE.MathUtils.lerp(fromWorld.x, toWorld.x, targetBlend);
    const z = THREE.MathUtils.lerp(fromWorld.z, toWorld.z, targetBlend);
    camera.position.x = x;
    camera.position.z = z;

    if (targetBlend >= 1) {
      playerCell = { ...targetCell };
    }

    const start = performance.now();
    wireman.update(frameDt, { gameActive: true, hasWon: false });
    const elapsedMs = performance.now() - start;

    if (frame >= warmupFrames) {
      all.push(elapsedMs);
      const state = wireman.getState();
      if (state.lineOfSightToPlayer) {
        los.push(elapsedMs);
      } else {
        noLos.push(elapsedMs);
      }
    }
  }

  const inactive = [];
  for (let frame = 0; frame < 3000; frame += 1) {
    const start = performance.now();
    wireman.update(frameDt, { gameActive: false, hasWon: false });
    const elapsedMs = performance.now() - start;
    inactive.push(elapsedMs);
  }

  return {
    metadata: {
      sampleFrames,
      warmupFrames,
      dtSeconds: frameDt,
      maze: `${config.MAZE_COLS}x${config.MAZE_ROWS}`,
      cellSize: config.CELL_SIZE,
    },
    activeAll: summarize(all),
    activeLos: summarize(los),
    activeNoLos: summarize(noLos),
    inactive: summarize(inactive),
  };
}

const report = runBenchmark();
console.log(JSON.stringify(report, null, 2));
