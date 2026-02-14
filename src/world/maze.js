export function buildWallSurfaceGeometry({
  THREE,
  maze,
  cols,
  rows,
  cellSize,
  wallHeight,
  worldHalfWidth,
  worldHalfDepth,
}) {
  const positions = [];
  const normals = [];
  const uvs = [];
  const indices = [];

  let vertexIndex = 0;
  const verticalVRepeat = wallHeight / cellSize;

  const hasWallAt = (col, row) => {
    if (col < 0 || col >= cols || row < 0 || row >= rows) {
      return false;
    }
    return maze[row][col] === 1;
  };

  function pushFace(center, u, v, normal, uvU = 1, uvV = 1) {
    const hx = u.x * 0.5;
    const hy = u.y * 0.5;
    const hz = u.z * 0.5;
    const vx = v.x * 0.5;
    const vy = v.y * 0.5;
    const vz = v.z * 0.5;

    const p0 = [center.x - hx - vx, center.y - hy - vy, center.z - hz - vz];
    const p1 = [center.x + hx - vx, center.y + hy - vy, center.z + hz - vz];
    const p2 = [center.x + hx + vx, center.y + hy + vy, center.z + hz + vz];
    const p3 = [center.x - hx + vx, center.y - hy + vy, center.z - hz + vz];

    positions.push(...p0, ...p1, ...p2, ...p3);
    for (let i = 0; i < 4; i++) {
      normals.push(normal.x, normal.y, normal.z);
    }
    uvs.push(0, 0, uvU, 0, uvU, uvV, 0, uvV);
    indices.push(
      vertexIndex,
      vertexIndex + 1,
      vertexIndex + 2,
      vertexIndex,
      vertexIndex + 2,
      vertexIndex + 3,
    );
    vertexIndex += 4;
  }

  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      if (!hasWallAt(col, row)) {
        continue;
      }

      const minX = col * cellSize - worldHalfWidth;
      const maxX = minX + cellSize;
      const minZ = row * cellSize - worldHalfDepth;
      const maxZ = minZ + cellSize;
      const midX = minX + cellSize * 0.5;
      const midZ = minZ + cellSize * 0.5;

      if (!hasWallAt(col - 1, row)) {
        pushFace(
          new THREE.Vector3(minX, wallHeight * 0.5, midZ),
          new THREE.Vector3(0, 0, cellSize),
          new THREE.Vector3(0, wallHeight, 0),
          new THREE.Vector3(-1, 0, 0),
          1,
          verticalVRepeat,
        );
      }
      if (!hasWallAt(col + 1, row)) {
        pushFace(
          new THREE.Vector3(maxX, wallHeight * 0.5, midZ),
          new THREE.Vector3(0, 0, -cellSize),
          new THREE.Vector3(0, wallHeight, 0),
          new THREE.Vector3(1, 0, 0),
          1,
          verticalVRepeat,
        );
      }
      if (!hasWallAt(col, row - 1)) {
        pushFace(
          new THREE.Vector3(midX, wallHeight * 0.5, minZ),
          new THREE.Vector3(-cellSize, 0, 0),
          new THREE.Vector3(0, wallHeight, 0),
          new THREE.Vector3(0, 0, -1),
          1,
          verticalVRepeat,
        );
      }
      if (!hasWallAt(col, row + 1)) {
        pushFace(
          new THREE.Vector3(midX, wallHeight * 0.5, maxZ),
          new THREE.Vector3(cellSize, 0, 0),
          new THREE.Vector3(0, wallHeight, 0),
          new THREE.Vector3(0, 0, 1),
          1,
          verticalVRepeat,
        );
      }

      pushFace(
        new THREE.Vector3(midX, wallHeight, midZ),
        new THREE.Vector3(cellSize, 0, 0),
        new THREE.Vector3(0, 0, -cellSize),
        new THREE.Vector3(0, 1, 0),
        1,
        1,
      );
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute("normal", new THREE.Float32BufferAttribute(normals, 3));
  geometry.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.computeBoundingSphere();
  geometry.computeBoundingBox();
  return geometry;
}

export function generateMaze(cols, rows) {
  const width = cols % 2 === 0 ? cols + 1 : cols;
  const height = rows % 2 === 0 ? rows + 1 : rows;
  const grid = Array.from({ length: height }, () => Array(width).fill(1));

  const directions = [
    [2, 0],
    [-2, 0],
    [0, 2],
    [0, -2],
  ];

  function shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      const temp = arr[i];
      arr[i] = arr[j];
      arr[j] = temp;
    }
  }

  function carve(col, row) {
    grid[row][col] = 0;
    const dirs = directions.slice();
    shuffle(dirs);

    for (const [dx, dy] of dirs) {
      const nextCol = col + dx;
      const nextRow = row + dy;
      if (nextCol <= 0 || nextCol >= width - 1 || nextRow <= 0 || nextRow >= height - 1) {
        continue;
      }
      if (grid[nextRow][nextCol] === 0) {
        continue;
      }

      grid[row + dy / 2][col + dx / 2] = 0;
      carve(nextCol, nextRow);
    }
  }

  carve(1, 1);
  grid[1][1] = 0;
  grid[height - 2][width - 2] = 0;
  return grid;
}

function makeCellKey(col, row) {
  return `${col},${row}`;
}

function areCellsMutuallyVisible(fromCell, toCell, isWalkableCell) {
  if (fromCell.col === toCell.col && fromCell.row === toCell.row) {
    return true;
  }
  if (!isWalkableCell(fromCell.col, fromCell.row) || !isWalkableCell(toCell.col, toCell.row)) {
    return false;
  }

  const fromX = fromCell.col + 0.5;
  const fromY = fromCell.row + 0.5;
  const toX = toCell.col + 0.5;
  const toY = toCell.row + 0.5;
  const deltaX = toX - fromX;
  const deltaY = toY - fromY;
  const distance = Math.hypot(deltaX, deltaY);
  if (distance <= 0.0001) {
    return true;
  }

  // Quarter-cell samples keep diagonal corner peeks from leaking through walls.
  const sampleCount = Math.max(1, Math.ceil(distance * 4));
  for (let sampleIndex = 1; sampleIndex < sampleCount; sampleIndex += 1) {
    const t = sampleIndex / sampleCount;
    const sampleCol = Math.floor(fromX + deltaX * t);
    const sampleRow = Math.floor(fromY + deltaY * t);
    if (!isWalkableCell(sampleCol, sampleRow)) {
      return false;
    }
  }
  return true;
}

export function buildWalkableVisibilityMap({
  maze,
  cols,
  rows,
  isWalkableCell: isWalkableCellInput,
}) {
  const isWalkableCell =
    typeof isWalkableCellInput === "function"
      ? isWalkableCellInput
      : (col, row) =>
          row >= 0 &&
          row < rows &&
          col >= 0 &&
          col < cols &&
          maze[row]?.[col] === 0;

  const walkableCells = [];
  const cellByKey = new Map();
  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      if (!isWalkableCell(col, row)) {
        continue;
      }
      const key = makeCellKey(col, row);
      const cell = { col, row, key };
      walkableCells.push(cell);
      cellByKey.set(key, cell);
    }
  }

  const visibleCellsByKey = new Map();
  const visibleCellKeySetByKey = new Map();
  for (const cell of walkableCells) {
    visibleCellsByKey.set(cell.key, [cell]);
    visibleCellKeySetByKey.set(cell.key, new Set([cell.key]));
  }

  for (let fromIndex = 0; fromIndex < walkableCells.length; fromIndex += 1) {
    const fromCell = walkableCells[fromIndex];
    for (let toIndex = fromIndex + 1; toIndex < walkableCells.length; toIndex += 1) {
      const toCell = walkableCells[toIndex];
      if (!areCellsMutuallyVisible(fromCell, toCell, isWalkableCell)) {
        continue;
      }

      visibleCellsByKey.get(fromCell.key).push(toCell);
      visibleCellKeySetByKey.get(fromCell.key).add(toCell.key);
      visibleCellsByKey.get(toCell.key).push(fromCell);
      visibleCellKeySetByKey.get(toCell.key).add(fromCell.key);
    }
  }

  return {
    walkableCells,
    cellByKey,
    visibleCellsByKey,
    visibleCellKeySetByKey,
  };
}

export function findFarthestOpenCell(fromCell, isWalkableCell) {
  const queue = [{ ...fromCell, distance: 0 }];
  const visited = new Set([`${fromCell.col},${fromCell.row}`]);
  let farthest = { col: fromCell.col, row: fromCell.row, distance: 0 };
  const offsets = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ];

  while (queue.length > 0) {
    const current = queue.shift();
    if (current.distance > farthest.distance) {
      farthest = current;
    }

    for (const [dc, dr] of offsets) {
      const nextCol = current.col + dc;
      const nextRow = current.row + dr;
      const key = `${nextCol},${nextRow}`;
      if (visited.has(key)) {
        continue;
      }
      if (!isWalkableCell(nextCol, nextRow)) {
        continue;
      }

      visited.add(key);
      queue.push({
        col: nextCol,
        row: nextRow,
        distance: current.distance + 1,
      });
    }
  }

  return { col: farthest.col, row: farthest.row };
}

export function findPath(from, to, isWalkableCell) {
  const queue = [{ col: from.col, row: from.row }];
  const visited = new Set([`${from.col},${from.row}`]);
  const previous = new Map();
  const offsets = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ];

  while (queue.length > 0) {
    const current = queue.shift();
    if (current.col === to.col && current.row === to.row) {
      break;
    }

    for (const [dc, dr] of offsets) {
      const nextCol = current.col + dc;
      const nextRow = current.row + dr;
      const key = `${nextCol},${nextRow}`;
      if (visited.has(key) || !isWalkableCell(nextCol, nextRow)) {
        continue;
      }

      visited.add(key);
      previous.set(key, `${current.col},${current.row}`);
      queue.push({ col: nextCol, row: nextRow });
    }
  }

  const endKey = `${to.col},${to.row}`;
  if (!visited.has(endKey)) {
    return [{ col: from.col, row: from.row }];
  }

  const path = [];
  let currentKey = endKey;
  while (currentKey) {
    const [colText, rowText] = currentKey.split(",");
    path.push({ col: Number(colText), row: Number(rowText) });
    currentKey = previous.get(currentKey);
  }
  path.reverse();
  return path;
}

export function collectNearbyCells({
  maze,
  exitCell,
  cols,
  rows,
  centerCol,
  centerRow,
  radius,
}) {
  const nearby = [];
  for (let row = centerRow - radius; row <= centerRow + radius; row++) {
    for (let col = centerCol - radius; col <= centerCol + radius; col++) {
      if (row < 0 || row >= rows || col < 0 || col >= cols) {
        continue;
      }
      if (maze[row][col] === 1) {
        nearby.push({ col, row, type: "wall" });
      } else if (col === exitCell.col && row === exitCell.row) {
        nearby.push({ col, row, type: "exit" });
      }
    }
  }
  return nearby;
}
