import { normalizeWorldMetrics } from './WorldMetrics.js';

/**
 * A serializable, renderer-agnostic view of the world at one point in time.
 *
 * SceneSnapshot intentionally knows nothing about WebGL, game loops, assets,
 * or Liminal Protocol.  It gives renderer and physics code one stable contract
 * for a grid, camera, entities, lights, feature flags, and optional gameplay
 * effects.  A snapshot is shallowly immutable; cells and normalized records
 * are also frozen so a later mutation cannot change an already-submitted frame.
 */
export class SceneSnapshot {
  constructor(input = {}, options = {}) {
    Object.assign(this, buildSceneSnapshot(input, options));
    Object.freeze(this);
  }

  static normalize(input, options) {
    return normalizeSceneSnapshot(input, options);
  }

  static validate(input, options) {
    return validateSceneSnapshot(input, options);
  }
}

export class SceneSnapshotValidationError extends Error {
  constructor(issues) {
    const message = issues.length === 1
      ? `Invalid scene snapshot: ${issues[0].message}`
      : `Invalid scene snapshot (${issues.length} issues).`;
    super(message);
    this.name = 'SceneSnapshotValidationError';
    this.issues = Object.freeze(issues.map((issue) => Object.freeze({ ...issue })));
  }
}

export function normalizeSceneSnapshot(input, options = {}) {
  return input instanceof SceneSnapshot ? input : new SceneSnapshot(input, options);
}

/** Create a normalized immutable scene snapshot. */
export const createSceneSnapshot = normalizeSceneSnapshot;

/**
 * Validate without throwing.  On success `value` is the normalized snapshot;
 * on failure it is null and `issues` describes each invalid field.
 */
export function validateSceneSnapshot(input, options = {}) {
  try {
    return Object.freeze({
      valid: true,
      value: normalizeSceneSnapshot(input, options),
      issues: Object.freeze([])
    });
  } catch (error) {
    if (error instanceof SceneSnapshotValidationError) {
      return Object.freeze({ valid: false, value: null, issues: error.issues });
    }
    throw error;
  }
}

function buildSceneSnapshot(input, options) {
  const issues = [];
  if (!isRecord(input)) {
    throw new SceneSnapshotValidationError([issue('', 'A scene snapshot must be an object.')]);
  }

  const gridSource = input.grid ?? input.map ?? null;
  const grid = normalizeGrid(gridSource, input, issues);
  const metrics = normalizeMetrics(input, gridSource, issues);
  const camera = normalizeCamera(input.camera ?? input.player, metrics, issues);
  const entities = normalizeEntities(input.entities, issues);
  const lights = normalizeLights(input.lights, issues);
  const effects = normalizeEffects(input.effects, input, grid, issues);
  const features = normalizeFeatures(input.features, { grid, entities, lights }, issues);
  const materials = normalizeRecord(input.materials, 'materials', issues);
  const atmosphere = normalizeRecord(input.atmosphere, 'atmosphere', issues);
  const metadata = normalizeRecord(input.metadata, 'metadata', issues);

  const version = normalizePositiveInteger(input.version ?? 1, 'version', issues);
  const id = input.id === undefined || input.id === null ? null : normalizeString(input.id, 'id', issues);

  if (issues.length > 0) throw new SceneSnapshotValidationError(issues);

  return Object.freeze({
    id,
    version,
    grid,
    metrics,
    camera,
    entities,
    lights,
    effects,
    features,
    materials,
    atmosphere,
    metadata
  });
}

function normalizeGrid(source, input, issues) {
  if (source === null || source === undefined) return null;

  // A grid this function already normalized is reused by reference. Games
  // rebuild a snapshot every frame to move entities and lights; carrying the
  // previous frame's frozen grid through unchanged keeps the renderer's
  // map-identity caches (static mesh, light visibility) warm instead of
  // forcing a full static rebuild per frame.
  if (isNormalizedGrid(source)) return source;

  const sourceRecord = Array.isArray(source) ? { cells: source } : source;
  if (!isRecord(sourceRecord) || !Array.isArray(sourceRecord.cells)) {
    issues.push(issue('grid', 'grid must be a cells[y][x] array or an object with a cells array.'));
    return null;
  }

  const cells = sourceRecord.cells;
  if (cells.length === 0) {
    issues.push(issue('grid.cells', 'grid.cells must include at least one row.'));
    return null;
  }

  let width = null;
  const normalizedCells = cells.map((row, rowIndex) => {
    if (!Array.isArray(row) || row.length === 0) {
      issues.push(issue(`grid.cells[${rowIndex}]`, 'each grid row must be a non-empty array.'));
      return Object.freeze([]);
    }
    if (width === null) width = row.length;
    else if (row.length !== width) {
      issues.push(issue(`grid.cells[${rowIndex}]`, `row width must equal ${width}.`));
    }
    return Object.freeze([...row]);
  });

  if (sourceRecord.width !== undefined && sourceRecord.width !== width) {
    issues.push(issue('grid.width', `grid.width must equal the cells width (${width}).`));
  }
  if (sourceRecord.height !== undefined && sourceRecord.height !== cells.length) {
    issues.push(issue('grid.height', `grid.height must equal the cells height (${cells.length}).`));
  }

  const revision = normalizeNonNegativeInteger(
    sourceRecord.revision ?? input.mapRevision ?? 0,
    'grid.revision',
    issues
  );

  return Object.freeze({
    cells: Object.freeze(normalizedCells),
    width: width ?? 0,
    height: cells.length,
    revision
  });
}

function isNormalizedGrid(source) {
  return isRecord(source) &&
    Object.isFrozen(source) &&
    Array.isArray(source.cells) &&
    Object.isFrozen(source.cells) &&
    source.cells.length > 0 &&
    source.cells.every(row => Array.isArray(row) && Object.isFrozen(row)) &&
    Number.isInteger(source.width) &&
    Number.isInteger(source.height) &&
    Number.isInteger(source.revision) && source.revision >= 0;
}

function normalizeMetrics(input, gridSource, issues) {
  const gridMetrics = isRecord(gridSource) ? gridSource.metrics : undefined;
  const value = input.metrics ?? input.worldMetrics ?? gridMetrics;
  try {
    return normalizeWorldMetrics(value);
  } catch (error) {
    issues.push(issue('metrics', error.message));
    return normalizeWorldMetrics();
  }
}

function normalizeCamera(source, metrics, issues) {
  const input = source ?? {};
  if (!isRecord(input)) {
    issues.push(issue('camera', 'camera must be an object.'));
    return defaultCamera(metrics);
  }

  const defaultPosition = {
    x: metrics.originX + metrics.cellSize / 2,
    y: metrics.originY + metrics.cellSize / 2,
    z: metrics.floorHeight + metrics.wallHeight / 2
  };
  const position = isRecord(input.position) ? input.position : input;
  const x = normalizeFinite(position.x ?? defaultPosition.x, 'camera.x', issues);
  const y = normalizeFinite(position.y ?? defaultPosition.y, 'camera.y', issues);
  const z = normalizeFinite(position.z ?? defaultPosition.z, 'camera.z', issues);
  const yaw = normalizeFinite(input.yaw ?? input.angle ?? 0, 'camera.yaw', issues);
  const pitch = normalizeFinite(input.pitch ?? 0, 'camera.pitch', issues);
  const fov = normalizeFinite(input.fov ?? Math.PI / 3, 'camera.fov', issues);

  if (fov <= 0 || fov >= Math.PI) {
    issues.push(issue('camera.fov', 'camera.fov must be greater than 0 and less than PI radians.'));
  }

  // Optional free-camera fields ride along only when supplied, so existing
  // snapshots keep exactly their historical shape.
  const extra = {};
  if (input.roll !== undefined) extra.roll = normalizeFinite(input.roll, 'camera.roll', issues);
  if (input.free !== undefined) {
    if (typeof input.free !== 'boolean') issues.push(issue('camera.free', 'camera.free must be a boolean.'));
    else extra.free = input.free;
  }

  return Object.freeze({ x, y, z, yaw, pitch, fov, ...extra });
}

function defaultCamera(metrics) {
  return Object.freeze({
    x: metrics.originX + metrics.cellSize / 2,
    y: metrics.originY + metrics.cellSize / 2,
    z: metrics.floorHeight + metrics.wallHeight / 2,
    yaw: 0,
    pitch: 0,
    fov: Math.PI / 3
  });
}

function normalizeEntities(source, issues) {
  if (source === undefined || source === null) return Object.freeze([]);
  if (!Array.isArray(source)) {
    issues.push(issue('entities', 'entities must be an array.'));
    return Object.freeze([]);
  }

  return Object.freeze(source.map((entity, index) => {
    const path = `entities[${index}]`;
    if (!isRecord(entity)) {
      issues.push(issue(path, 'an entity must be an object.'));
      return Object.freeze({ id: `entity-${index}`, type: 'entity', x: 0, y: 0, z: 0, visible: false });
    }
    const position = isRecord(entity.position) ? entity.position : entity;
    const x = normalizeFinite(position.x ?? 0, `${path}.x`, issues);
    const y = normalizeFinite(position.y ?? 0, `${path}.y`, issues);
    const z = normalizeFinite(position.z ?? 0, `${path}.z`, issues);
    const id = entity.id === undefined ? `entity-${index}` : normalizeString(entity.id, `${path}.id`, issues);
    const type = entity.type === undefined ? 'entity' : normalizeString(entity.type, `${path}.type`, issues);
    // Every field this function does not name survives the spread BY
    // REFERENCE - `mesh`, `pose`, `tint`, `sprite` and whatever a game adds -
    // which is fine for scalars and strings and is not fine for an object a
    // game keeps and mutates. `params` is a nested object the contract
    // names (a per-entity shape channel a parametric archetype reads: the
    // tether's reach/rise/slack/hook), and a game will naturally hold ONE
    // params object per winch and rewrite its fields every tick. Copying it
    // here is what makes the header's promise true for it: a frame already
    // submitted cannot be changed by the next tick's edits.
    const params = normalizeEntityParams(entity.params, `${path}.params`, issues);
    return Object.freeze({
      ...entity,
      id,
      type,
      x,
      y,
      z,
      visible: entity.visible !== false,
      ...(params === undefined ? {} : { params }),
      ...(entity.derezPalette === undefined ? {} : {
        derezPalette: normalizeDerezPalette(entity.derezPalette, path + '.derezPalette', issues)
      })
    });
  }));
}

function normalizeDerezPalette(source, path, issues) {
  if (source === null) return null;
  if (!Array.isArray(source) || source.length === 0 || !source.every(color =>
    Array.isArray(color) && color.length === 3 && color.every(Number.isFinite))) {
    issues.push(issue(path, path + ' must be a non-empty array of finite RGB triples.'));
    return null;
  }
  return Object.freeze(source.map(color => Object.freeze(color.map(n => Math.max(0, Math.min(1, n))))));
}

/**
 * `entity.params`: absent stays absent (so an entity that never had one
 * normalizes to exactly the record it did before this existed), null stays
 * null, a plain object becomes a FROZEN SHALLOW COPY. Values are left as the
 * game wrote them - plain numbers and strings by contract; a builder coerces
 * what it reads with Number.isFinite and defaults the rest - so the cost is
 * one small object per entity that carries one, which is the cheap half of a
 * per-frame snapshot.
 */
function normalizeEntityParams(source, path, issues) {
  if (source === undefined) return undefined;
  if (source === null) return null;
  if (!isRecord(source)) {
    issues.push(issue(path, `${path} must be a plain object of per-entity shape parameters.`));
    return null;
  }
  return Object.freeze({ ...source });
}

function normalizeLights(source, issues) {
  if (source === undefined || source === null) return Object.freeze([]);
  if (!Array.isArray(source)) {
    issues.push(issue('lights', 'lights must be an array.'));
    return Object.freeze([]);
  }

  return Object.freeze(source.map((light, index) => {
    const path = `lights[${index}]`;
    if (!isRecord(light)) {
      issues.push(issue(path, 'a light must be an object.'));
      return Object.freeze({ id: `light-${index}`, x: 0, y: 0, z: 0, active: false });
    }
    const position = isRecord(light.position) ? light.position : light;
    const x = normalizeFinite(position.x ?? 0, `${path}.x`, issues);
    const y = normalizeFinite(position.y ?? 0, `${path}.y`, issues);
    const z = normalizeFinite(position.z ?? 0, `${path}.z`, issues);
    const id = light.id === undefined ? `light-${index}` : normalizeString(light.id, `${path}.id`, issues);
    const range = light.range === undefined ? undefined : normalizeFinite(light.range, `${path}.range`, issues);
    if (range !== undefined && range < 0) issues.push(issue(`${path}.range`, 'range cannot be negative.'));
    return Object.freeze({ ...light, id, x, y, z, ...(range === undefined ? {} : { range }), active: light.active !== false });
  }));
}

function normalizeEffects(source, input, grid, issues) {
  if (source !== undefined && source !== null && !isRecord(source)) {
    issues.push(issue('effects', 'effects must be an object.'));
  }
  const record = isRecord(source) ? source : {};
  const mapRevision = normalizeNonNegativeInteger(
    record.mapRevision ?? input.mapRevision ?? grid?.revision ?? 0,
    'effects.mapRevision',
    issues
  );
  const corrodedCells = normalizeCellReferences(
    record.corrodedCells ?? input.corrodedCells ?? [],
    'effects.corrodedCells',
    issues
  );

  return Object.freeze({ ...record, mapRevision, corrodedCells });
}

function normalizeCellReferences(source, path, issues) {
  if (source instanceof Set) source = [...source];
  if (!Array.isArray(source)) {
    issues.push(issue(path, 'must be an array or Set of { x, y } cell coordinates.'));
    return Object.freeze([]);
  }

  return Object.freeze(source.map((reference, index) => {
    const itemPath = `${path}[${index}]`;
    let x;
    let y;
    if (Array.isArray(reference)) [x, y] = reference;
    else if (isRecord(reference)) {
      x = reference.x ?? reference.cellX;
      y = reference.y ?? reference.cellY;
    } else if (typeof reference === 'string') {
      const match = reference.trim().match(/^(-?\d+)\s*[,/:]\s*(-?\d+)$/);
      if (match) [x, y] = [Number(match[1]), Number(match[2])];
    }

    if (!Number.isInteger(x) || !Number.isInteger(y)) {
      issues.push(issue(itemPath, 'must provide integer x and y coordinates.'));
      return Object.freeze({ x: 0, y: 0 });
    }
    return Object.freeze({ x, y });
  }));
}

function normalizeFeatures(source, state, issues) {
  if (source !== undefined && source !== null && !isRecord(source)) {
    issues.push(issue('features', 'features must be an object of boolean flags.'));
  }
  const supplied = isRecord(source) ? source : {};
  const defaults = {
    grid: state.grid !== null,
    meshes: false,
    terrain: false,
    sky: false,
    atmosphere: false,
    entities: state.entities.length > 0,
    billboards: false,
    lights: state.lights.length > 0,
    particles: false,
    projectedLights: false,
    reactiveSurfaces: false
  };
  const normalized = { ...defaults };

  for (const [name, value] of Object.entries(supplied)) {
    if (typeof value !== 'boolean') {
      issues.push(issue(`features.${name}`, 'feature values must be boolean.'));
      continue;
    }
    normalized[name] = value;
  }

  return Object.freeze(normalized);
}

function normalizeRecord(source, path, issues) {
  if (source === undefined || source === null) return Object.freeze({});
  if (!isRecord(source)) {
    issues.push(issue(path, `${path} must be an object.`));
    return Object.freeze({});
  }
  return Object.freeze({ ...source });
}

function normalizeString(value, path, issues) {
  if (typeof value !== 'string' || value.length === 0) {
    issues.push(issue(path, `${path} must be a non-empty string.`));
    return '';
  }
  return value;
}

function normalizeFinite(value, path, issues) {
  if (!Number.isFinite(value)) {
    issues.push(issue(path, `${path} must be a finite number.`));
    return 0;
  }
  return value;
}

function normalizePositiveInteger(value, path, issues) {
  if (!Number.isInteger(value) || value < 1) {
    issues.push(issue(path, `${path} must be a positive integer.`));
    return 1;
  }
  return value;
}

function normalizeNonNegativeInteger(value, path, issues) {
  if (!Number.isInteger(value) || value < 0) {
    issues.push(issue(path, `${path} must be a non-negative integer.`));
    return 0;
  }
  return value;
}

function issue(path, message) {
  return { path, message };
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
