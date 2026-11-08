import { normalizeWorldMetrics } from '../core/WorldMetrics.js';

/**
 * The engine-wide default: empty/absent cells are passable and every other
 * cell blocks movement and ray traversal.  Games should supply `isPassable`
 * when they use richer cell objects, doors, water, or one-way barriers.
 */
export function defaultIsPassable(cell) {
  return cell === 0 || cell === null || cell === undefined;
}

/**
 * Return the cells matrix from either a raw `cells[y][x]` array or a snapshot
 * grid object with a `cells` property.
 */
export function getGridCells(grid) {
  if (Array.isArray(grid)) return grid;
  if (grid && Array.isArray(grid.cells)) return grid.cells;
  return null;
}

export function getGridDimensions(grid) {
  const cells = getGridCells(grid);
  if (!cells || cells.length === 0) return Object.freeze({ width: 0, height: 0 });
  return Object.freeze({
    width: Array.isArray(cells[0]) ? cells[0].length : 0,
    height: cells.length
  });
}

export function isGridCellInBounds(grid, cellX, cellY) {
  const { width, height } = getGridDimensions(grid);
  return Number.isInteger(cellX)
    && Number.isInteger(cellY)
    && cellX >= 0
    && cellY >= 0
    && cellX < width
    && cellY < height;
}

export function getGridCell(grid, cellX, cellY) {
  const cells = getGridCells(grid);
  if (!cells || !isGridCellInBounds(cells, cellX, cellY)) return undefined;
  return cells[cellY][cellX];
}

/**
 * Ask whether a grid cell can be traversed.
 *
 * `isPassable(cell, context)` must return true for a traversable cell and
 * false for a blocking/occluding cell.  The same predicate can be shared by
 * GridCollision and Raycaster; `context.purpose` is respectively `movement`
 * or `raycast` so games can intentionally distinguish the two when needed.
 */
export function isGridCellPassable(grid, cellX, cellY, options = {}) {
  const {
    isPassable = defaultIsPassable,
    outOfBoundsPassable = false,
    purpose = 'movement',
    metrics,
    position,
    direction,
    distance
  } = options;

  if (typeof isPassable !== 'function') {
    throw new TypeError('isPassable must be a function.');
  }

  if (!isGridCellInBounds(grid, cellX, cellY)) {
    return Boolean(outOfBoundsPassable);
  }

  const cell = getGridCell(grid, cellX, cellY);
  return Boolean(isPassable(cell, {
    cell,
    cellX,
    cellY,
    grid,
    metrics,
    position,
    direction,
    distance,
    purpose
  }));
}

/**
 * Test a circular world-space collider against solid grid cells.  The return
 * value is deliberately descriptive so a game can drive footstep, bump, or
 * AI behavior without re-running the collision query.
 */
export function testGridCircle(grid, position, options = {}) {
  const metrics = normalizeWorldMetrics(options.metrics);
  const radius = finiteNonNegative(options.radius ?? 0, 'radius');
  const { x, y } = normalizePoint(position, 'position');
  const isPassable = options.isPassable ?? defaultIsPassable;
  const outOfBoundsPassable = options.outOfBoundsPassable ?? false;

  if (typeof isPassable !== 'function') {
    throw new TypeError('isPassable must be a function.');
  }

  const minCellX = metrics.worldToCellX(x - radius);
  const maxCellX = metrics.worldToCellX(x + radius);
  const minCellY = metrics.worldToCellY(y - radius);
  const maxCellY = metrics.worldToCellY(y + radius);

  for (let cellY = minCellY; cellY <= maxCellY; cellY += 1) {
    for (let cellX = minCellX; cellX <= maxCellX; cellX += 1) {
      if (isGridCellPassable(grid, cellX, cellY, {
        isPassable,
        outOfBoundsPassable,
        purpose: 'movement',
        metrics,
        position: { x, y }
      })) {
        continue;
      }

      const bounds = metrics.cellBounds(cellX, cellY);
      const closestX = clamp(x, bounds.minX, bounds.maxX);
      const closestY = clamp(y, bounds.minY, bounds.maxY);
      const dx = x - closestX;
      const dy = y - closestY;

      if (dx * dx + dy * dy <= radius * radius) {
        return Object.freeze({
          collides: true,
          cell: getGridCell(grid, cellX, cellY),
          cellX,
          cellY,
          position: Object.freeze({ x, y })
        });
      }
    }
  }

  return Object.freeze({
    collides: false,
    cell: undefined,
    cellX: null,
    cellY: null,
    position: Object.freeze({ x, y })
  });
}

/**
 * Move a circular world-space collider with deterministic axis-separated
 * sliding.  It never mutates the supplied position or grid.
 */
export function moveWithGridCollision(grid, position, delta, options = {}) {
  const start = normalizePoint(position, 'position');
  const movement = normalizePoint(delta, 'delta');
  const queryOptions = {
    metrics: normalizeWorldMetrics(options.metrics),
    radius: finiteNonNegative(options.radius ?? 0, 'radius'),
    isPassable: options.isPassable ?? defaultIsPassable,
    outOfBoundsPassable: options.outOfBoundsPassable ?? false
  };

  let x = start.x;
  let y = start.y;
  let collisionX = null;
  let collisionY = null;

  if (movement.x !== 0) {
    const result = testGridCircle(grid, { x: start.x + movement.x, y }, queryOptions);
    if (result.collides) collisionX = result;
    else x = start.x + movement.x;
  }

  if (movement.y !== 0) {
    const result = testGridCircle(grid, { x, y: start.y + movement.y }, queryOptions);
    if (result.collides) collisionY = result;
    else y = start.y + movement.y;
  }

  return Object.freeze({
    x,
    y,
    movedX: x - start.x,
    movedY: y - start.y,
    collidedX: collisionX !== null,
    collidedY: collisionY !== null,
    collisionX,
    collisionY
  });
}

export const resolveGridMovement = moveWithGridCollision;

function normalizePoint(value, name) {
  if (!value || typeof value !== 'object') {
    throw new TypeError(`${name} must be an object with finite x and y values.`);
  }
  if (!Number.isFinite(value.x) || !Number.isFinite(value.y)) {
    throw new TypeError(`${name}.x and ${name}.y must be finite numbers.`);
  }
  return { x: value.x, y: value.y };
}

function finiteNonNegative(value, name) {
  if (!Number.isFinite(value)) {
    throw new TypeError(`${name} must be a finite number.`);
  }
  if (value < 0) {
    throw new RangeError(`${name} cannot be negative.`);
  }
  return value;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}
