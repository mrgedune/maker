import { normalizeWorldMetrics } from '../core/WorldMetrics.js';
import {
  defaultIsPassable,
  getGridCells,
  getGridDimensions,
  isGridCellInBounds
} from './GridCollision.js';

/**
 * DDA grid raycaster with a game-neutral passability contract.
 *
 * Pass `isPassable(cell, context)` to identify cells a ray can travel through.
 * Returning false makes the cell an occluding hit.  The default keeps legacy
 * number maps working: 0/null/undefined are empty, everything else is solid.
 * No global map, player, scene, or game-loop state is read by this class.
 */
export class Raycaster {
  constructor(grid, options = {}) {
    const sceneGrid = getGridCells(grid) ? grid : grid?.grid;
    const sceneMetrics = grid && !getGridCells(grid) ? grid.metrics : undefined;
    const { width = 1, height = 1 } = options;

    this.metrics = normalizeWorldMetrics(options.metrics ?? sceneMetrics);
    this.resolution = { width: normalizeDimension(width, 'width'), height: normalizeDimension(height, 'height') };

    // Compatibility with the original standalone Raycaster API.
    this.x = 2;
    this.y = 2;
    this.angle = 0;
    this.pitch = 0;
    this.fov = Math.PI / 3;
    this.maxDepth = normalizePositive(options.maxDistance ?? options.maxDepth ?? 30, 'maxDistance');
    Object.defineProperty(this, 'maxDistance', {
      enumerable: true,
      configurable: false,
      get: () => this.maxDepth,
      set: (value) => { this.maxDepth = normalizePositive(value, 'maxDistance'); }
    });

    this.isPassable = options.isPassable ?? defaultIsPassable;
    if (typeof this.isPassable !== 'function') throw new TypeError('isPassable must be a function.');

    this.boundaryMode = options.boundaryMode ?? 'miss';
    if (this.boundaryMode !== 'miss' && this.boundaryMode !== 'solid') {
      throw new RangeError('boundaryMode must be either "miss" or "solid".');
    }
    this.boundaryWallId = options.boundaryWallId ?? 1;

    this.setGrid(sceneGrid);
    this._allocateFrame();
  }

  /** Replace the collision/occlusion grid without changing camera state. */
  setGrid(grid) {
    const cells = getGridCells(grid);
    if (!cells || cells.length === 0 || !Array.isArray(cells[0]) || cells[0].length === 0) {
      throw new TypeError('Raycaster requires a non-empty cells[y][x] grid.');
    }
    this.grid = grid;
    this.map = cells; // Legacy name retained for existing callers.
    this.refreshGridDimensions();
    return this;
  }

  /** Accept a normalized SceneSnapshot or an object containing grid + metrics. */
  setScene(scene) {
    if (!scene || !scene.grid) throw new TypeError('scene must provide a grid.');
    if (scene.metrics) this.metrics = normalizeWorldMetrics(scene.metrics);
    return this.setGrid(scene.grid);
  }

  refreshGridDimensions() {
    const { width, height } = getGridDimensions(this.map);
    this.mapWidth = width;
    this.mapHeight = height;
    return this;
  }

  setPassability(isPassable) {
    if (typeof isPassable !== 'function') throw new TypeError('isPassable must be a function.');
    this.isPassable = isPassable;
    return this;
  }

  setPosition(x, y) {
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      throw new TypeError('Raycaster position must use finite x and y values.');
    }
    this.x = x;
    this.y = y;
    return this;
  }

  resize(width, height) {
    this.resolution.width = normalizeDimension(width, 'width');
    this.resolution.height = normalizeDimension(height, 'height');
    this._allocateFrame();
    return this;
  }

  /**
   * Cast one world-space ray.  The supplied direction is normalized first, so
   * the returned distance is a world-space distance independent of its length.
   */
  castRay(directionX, directionY, options = {}) {
    if (!Number.isFinite(directionX) || !Number.isFinite(directionY)) {
      throw new TypeError('Ray direction must use finite x and y values.');
    }
    const length = Math.hypot(directionX, directionY);
    const result = createFrameColumn(options.columnIndex ?? -1);
    if (length === 0) return resetFrameColumn(result);
    return this._castInto(result, directionX / length, directionY / length, options);
  }

  /**
   * Cast one ray per viewport column and reuse the same result array each call.
   */
  castRays() {
    if (!Number.isFinite(this.x) || !Number.isFinite(this.y)) {
      throw new TypeError('Raycaster x and y must be finite numbers.');
    }
    if (!Number.isFinite(this.angle) || !Number.isFinite(this.fov) || this.fov <= 0 || this.fov >= Math.PI) {
      throw new RangeError('Raycaster angle must be finite and fov must be between 0 and PI radians.');
    }

    this.refreshGridDimensions();
    const directionX = Math.cos(this.angle);
    const directionY = Math.sin(this.angle);
    const planeScale = Math.tan(this.fov / 2);
    const planeX = -directionY * planeScale;
    const planeY = directionX * planeScale;
    const width = this.resolution.width;

    for (let column = 0; column < width; column += 1) {
      // Retains the source engine's left-edge sampling convention for visual compatibility.
      const cameraX = (2 * column) / width - 1;
      this._castInto(
        this.frame[column],
        directionX + planeX * cameraX,
        directionY + planeY * cameraX,
        { columnIndex: column }
      );
    }

    return this.frame;
  }

  _allocateFrame() {
    this.frame = Array.from(
      { length: this.resolution.width },
      (_, columnIndex) => createFrameColumn(columnIndex)
    );
  }

  _castInto(frame, rayDirectionX, rayDirectionY, options) {
    const maxDistance = normalizePositive(
      options.maxDistance ?? options.maxDepth ?? this.maxDepth,
      'maxDistance'
    );
    const sourceX = this.x;
    const sourceY = this.y;
    const metrics = this.metrics;
    const cellSize = metrics.cellSize;
    let cellX = metrics.worldToCellX(sourceX);
    let cellY = metrics.worldToCellY(sourceY);

    if (rayDirectionX === 0 && rayDirectionY === 0) return resetFrameColumn(frame);

    const deltaDistanceX = rayDirectionX === 0 ? Infinity : Math.abs(cellSize / rayDirectionX);
    const deltaDistanceY = rayDirectionY === 0 ? Infinity : Math.abs(cellSize / rayDirectionY);

    let stepX;
    let stepY;
    let sideDistanceX;
    let sideDistanceY;

    if (rayDirectionX < 0) {
      stepX = -1;
      sideDistanceX = (sourceX - (metrics.originX + cellX * cellSize)) / -rayDirectionX;
    } else {
      stepX = 1;
      sideDistanceX = ((metrics.originX + (cellX + 1) * cellSize) - sourceX) / rayDirectionX;
    }

    if (rayDirectionY < 0) {
      stepY = -1;
      sideDistanceY = (sourceY - (metrics.originY + cellY * cellSize)) / -rayDirectionY;
    } else {
      stepY = 1;
      sideDistanceY = ((metrics.originY + (cellY + 1) * cellSize) - sourceY) / rayDirectionY;
    }

    let side = 0;
    let distance = 0;
    let hit = false;
    let hitCell;
    let outOfBoundsHit = false;

    while (distance <= maxDistance) {
      if (sideDistanceX < sideDistanceY) {
        distance = sideDistanceX;
        sideDistanceX += deltaDistanceX;
        cellX += stepX;
        side = 0;
      } else {
        distance = sideDistanceY;
        sideDistanceY += deltaDistanceY;
        cellY += stepY;
        side = 1;
      }

      if (distance > maxDistance) break;

      if (!isGridCellInBounds(this.map, cellX, cellY)) {
        if (this.boundaryMode === 'solid') {
          hit = true;
          outOfBoundsHit = true;
        }
        break;
      }

      hitCell = this.map[cellY][cellX];
      const passable = this.isPassable === defaultIsPassable
        ? defaultIsPassable(hitCell)
        : Boolean(this.isPassable(hitCell, {
          cell: hitCell,
          cellX,
          cellY,
          grid: this.grid,
          metrics,
          position: { x: sourceX, y: sourceY },
          direction: { x: rayDirectionX, y: rayDirectionY },
          distance,
          purpose: 'raycast'
        }));

      if (!passable) {
        hit = true;
        break;
      }
    }

    if (!hit) return resetFrameColumn(frame);

    const hitX = sourceX + distance * rayDirectionX;
    const hitY = sourceY + distance * rayDirectionY;
    let textureX = side === 0
      ? fractional((hitY - metrics.originY) / cellSize)
      : fractional((hitX - metrics.originX) / cellSize);
    if ((side === 0 && rayDirectionX > 0) || (side === 1 && rayDirectionY < 0)) {
      textureX = 1 - textureX;
    }

    const wallHeight = resolveWallHeight(hitCell, metrics);
    frame.columnIndex = options.columnIndex ?? frame.columnIndex;
    frame.hit = true;
    frame.distance = distance;
    frame.perpendicularDistance = distance;
    frame.wallHeight = Math.floor(
      this.resolution.height * wallHeight / Math.max(0.01, distance)
    );
    frame.wallId = outOfBoundsHit ? this.boundaryWallId : resolveWallId(hitCell);
    frame.cell = outOfBoundsHit ? undefined : hitCell;
    frame.cellX = cellX;
    frame.cellY = cellY;
    frame.side = side;
    frame.hitX = hitX;
    frame.hitY = hitY;
    frame.textureX = textureX;
    frame.depth = distance;
    return frame;
  }
}

export default Raycaster;

function createFrameColumn(columnIndex) {
  return {
    columnIndex,
    hit: false,
    distance: Infinity,
    perpendicularDistance: Infinity,
    wallHeight: 0,
    wallId: 0,
    cell: undefined,
    cellX: null,
    cellY: null,
    side: 0,
    hitX: 0,
    hitY: 0,
    textureX: 0,
    depth: Infinity
  };
}

function resetFrameColumn(frame) {
  frame.hit = false;
  frame.distance = Infinity;
  frame.perpendicularDistance = Infinity;
  frame.wallHeight = 0;
  frame.wallId = 0;
  frame.cell = undefined;
  frame.cellX = null;
  frame.cellY = null;
  frame.side = 0;
  frame.hitX = 0;
  frame.hitY = 0;
  frame.textureX = 0;
  frame.depth = Infinity;
  return frame;
}

function resolveWallId(cell) {
  if (typeof cell === 'number' || typeof cell === 'string') return cell;
  if (cell && typeof cell === 'object') return cell.materialId ?? cell.wallId ?? cell.id ?? 1;
  return 1;
}

function resolveWallHeight(cell, metrics) {
  const suppliedHeight = cell && typeof cell === 'object'
    ? cell.wallHeight ?? cell.height
    : undefined;
  return Number.isFinite(suppliedHeight) && suppliedHeight > 0
    ? suppliedHeight
    : metrics.wallHeight;
}

function fractional(value) {
  return value - Math.floor(value);
}

function normalizeDimension(value, name) {
  if (!Number.isInteger(value) || value < 1) {
    throw new RangeError(`${name} must be a positive integer.`);
  }
  return value;
}

function normalizePositive(value, name) {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive finite number.`);
  }
  return value;
}
