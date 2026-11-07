/**
 * Shared coordinate conversion rules for grid-backed scenes.
 *
 * The engine uses X/Y for the horizontal world plane and Z for vertical height.
 * Grid coordinates always address a cell as (x, y), while a JavaScript grid is
 * stored as rows: cells[y][x].  Keeping the conversion here prevents renderer,
 * physics, and game code from silently assuming a one-unit grid.
 */

export const DEFAULT_WORLD_METRICS = Object.freeze({
  cellSize: 1,
  originX: 0,
  originY: 0,
  floorHeight: 0,
  ceilingHeight: 1
});

/**
 * Immutable world/grid coordinate metrics.
 */
export class WorldMetrics {
  constructor(options = {}) {
    if (options instanceof WorldMetrics) return options;

    if (options === null || typeof options !== 'object') {
      throw new TypeError('WorldMetrics options must be an object.');
    }

    const origin = options.origin && typeof options.origin === 'object' ? options.origin : {};
    const cellSize = finitePositive(options.cellSize ?? DEFAULT_WORLD_METRICS.cellSize, 'cellSize');
    const originX = finiteNumber(options.originX ?? origin.x ?? DEFAULT_WORLD_METRICS.originX, 'originX');
    const originY = finiteNumber(options.originY ?? origin.y ?? DEFAULT_WORLD_METRICS.originY, 'originY');
    const floorHeight = finiteNumber(options.floorHeight ?? DEFAULT_WORLD_METRICS.floorHeight, 'floorHeight');
    const ceilingHeight = finiteNumber(
      options.ceilingHeight ?? (floorHeight + cellSize),
      'ceilingHeight'
    );

    if (ceilingHeight <= floorHeight) {
      throw new RangeError('ceilingHeight must be greater than floorHeight.');
    }

    this.cellSize = cellSize;
    this.originX = originX;
    this.originY = originY;
    this.floorHeight = floorHeight;
    this.ceilingHeight = ceilingHeight;

    Object.freeze(this);
  }

  get wallHeight() {
    return this.ceilingHeight - this.floorHeight;
  }

  /** Convert a world-space X coordinate to its containing grid column. */
  worldToCellX(worldX) {
    return Math.floor((finiteNumber(worldX, 'worldX') - this.originX) / this.cellSize);
  }

  /** Convert a world-space Y coordinate to its containing grid row. */
  worldToCellY(worldY) {
    return Math.floor((finiteNumber(worldY, 'worldY') - this.originY) / this.cellSize);
  }

  /** Convert a world-space point to a grid coordinate. */
  worldToCell(worldX, worldY) {
    return Object.freeze({
      x: this.worldToCellX(worldX),
      y: this.worldToCellY(worldY)
    });
  }

  /** Return the lower-left world-space corner of a grid cell. */
  cellToWorld(cellX, cellY) {
    assertInteger(cellX, 'cellX');
    assertInteger(cellY, 'cellY');
    return Object.freeze({
      x: this.originX + cellX * this.cellSize,
      y: this.originY + cellY * this.cellSize
    });
  }

  /** Return the world-space center of a grid cell. */
  cellCenter(cellX, cellY) {
    const corner = this.cellToWorld(cellX, cellY);
    const half = this.cellSize / 2;
    return Object.freeze({ x: corner.x + half, y: corner.y + half });
  }

  /** Return the world-space axis-aligned bounds of a grid cell. */
  cellBounds(cellX, cellY) {
    const min = this.cellToWorld(cellX, cellY);
    return Object.freeze({
      minX: min.x,
      minY: min.y,
      maxX: min.x + this.cellSize,
      maxY: min.y + this.cellSize
    });
  }

  toJSON() {
    return {
      cellSize: this.cellSize,
      originX: this.originX,
      originY: this.originY,
      floorHeight: this.floorHeight,
      ceilingHeight: this.ceilingHeight
    };
  }
}

/** Normalize a metrics object without forcing callers to know about the class. */
export function normalizeWorldMetrics(value) {
  return value instanceof WorldMetrics ? value : new WorldMetrics(value);
}

/** Create an immutable WorldMetrics instance from plain serializable data. */
export const createWorldMetrics = normalizeWorldMetrics;

export function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function finiteNumber(value, name) {
  if (!isFiniteNumber(value)) {
    throw new TypeError(`${name} must be a finite number.`);
  }
  return value;
}

function finitePositive(value, name) {
  const number = finiteNumber(value, name);
  if (number <= 0) {
    throw new RangeError(`${name} must be greater than zero.`);
  }
  return number;
}

function assertInteger(value, name) {
  if (!Number.isInteger(value)) {
    throw new TypeError(`${name} must be an integer.`);
  }
}
