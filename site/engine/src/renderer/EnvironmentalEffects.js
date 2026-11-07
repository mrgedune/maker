import { ceilingDrop, wallMidZ } from './WorldZ.js';

export const ENVIRONMENT_PARTICLE_STRIDE = 10;
export const MAX_FOG_VOLUMES = 6;

/**
 * The precipitation streak ceiling, historically an inline 160. Profile-
 * independent, unlike the dust ceiling (`baseParticles` below), which is why
 * it lives out here. Overridable per frame via the atmosphere's
 * `precipitationBudget`.
 */
export const PRECIPITATION_BASE_BUDGET = 160;

/**
 * The per-open-cell density cap for precipitation (dust has the profile's own
 * `particlesPerOpenCell`). This half of the ceiling is deliberately NOT
 * configurable: it exists so a tiny room cannot be packed with a whole
 * district's budget. Note it counts against the cells actually eligible to
 * hold a particle, so under `focus` it is the FOCUSED cells that set it.
 */
const PRECIPITATION_PER_OPEN_CELL = 3;

const PROFILE_SETTINGS = {
  stable: {
    dustColor: [0.32, 0.62, 0.66],
    fogColor: [0.06, 0.2, 0.22],
    baseParticles: 72,
    particlesPerOpenCell: 2,
    fogVolumes: 1
  },
  ascii: {
    dustColor: [0.12, 0.46, 0.72],
    fogColor: [0.05, 0.12, 0.4],
    baseParticles: 96,
    particlesPerOpenCell: 2,
    fogVolumes: 2
  },
  black_annex: {
    dustColor: [0.55, 0.12, 0.16],
    fogColor: [0.36, 0.04, 0.08],
    baseParticles: 220,
    particlesPerOpenCell: 4,
    fogVolumes: 3
  }
};

function hashString(value) {
  let hash = 2166136261;
  const input = String(value);
  for (let index = 0; index < input.length; index++) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function createRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state += 0x6D2B79F5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * The cells a particle may spawn in.
 *
 * Returns `openCells` ITSELF (not a copy) whenever no usable focus was given,
 * so the no-focus path is the historical one by identity rather than by
 * reconstruction. With a focus, the cells are ranked by distance to it —
 * nearest first, scan order breaking ties — and optionally clipped to
 * `focusRadius`. A radius that excludes everything falls back to the full
 * nearest-first ranking rather than emitting no particles at all.
 */
function focusedCells(openCells, options) {
  const focusX = options.focusX;
  const focusY = options.focusY;
  if (!Number.isFinite(focusX) || !Number.isFinite(focusY) || openCells.length === 0) {
    return openCells;
  }
  const ranked = openCells.map((cell, order) => ({
    cell,
    order,
    distance: Math.hypot(cell.x + 0.5 - focusX, cell.y + 0.5 - focusY)
  }));
  ranked.sort((a, b) => a.distance - b.distance || a.order - b.order);
  const radius = Number(options.focusRadius);
  if (Number.isFinite(radius) && radius > 0) {
    const within = ranked.filter(entry => entry.distance <= radius);
    if (within.length > 0) return within.map(entry => entry.cell);
  }
  return ranked.map(entry => entry.cell);
}

function pushParticle(target, x, y, z, color, size, phase, type, intensity) {
  target.push(x, y, z, color[0], color[1], color[2], size, phase, type, intensity);
}

export function getEnvironmentalEffectsFingerprint(mapHash, profileName, lights = [], enabled = true, variant = '') {
  // Only typed fixture lights (spark/tube/rift) contribute particles, so
  // only they may enter the fingerprint: hashing every light made any
  // moving point light rebuild the whole particle VBO every frame.
  const lightState = lights
    .filter(light => {
      const type = light.lightType || light.type;
      return type === 'spark' || type === 'tube' || type === 'rift';
    })
    .map(light => [
      Number(light.x || 0).toFixed(2),
      Number(light.y || 0).toFixed(2),
      light.lightType || light.type,
      Number(light.range || 0).toFixed(1)
    ].join(':')).join('|');
  return `${enabled ? 1 : 0}:${profileName}:${variant}:${mapHash}:${lightState}`;
}

export function buildEnvironmentalEffects(map, lights = [], options = {}) {
  const profileName = PROFILE_SETTINGS[options.profileName] ? options.profileName : 'stable';
  const profile = PROFILE_SETTINGS[profileName];
  if (options.enabled === false || !Array.isArray(map) || !map.length || !map[0]?.length) {
    return { particles: new Float32Array(0), particleCount: 0, fogVolumes: [] };
  }

  const openCells = [];
  for (let y = 1; y < map.length - 1; y++) {
    for (let x = 1; x < map[y].length - 1; x++) {
      if (map[y][x] === 0) openCells.push({ x, y });
    }
  }

  // FOCUS. Without one, `spawnCells` IS `openCells` — same array, same order,
  // same length — so every count and every random() draw below is the
  // historical one. With one, the budget is spent on the cells nearest the
  // focus instead of scattered across a district the player cannot see, which
  // is the whole point: 72 motes over a 200x200 city is nothing, and over the
  // 30 cells actually in view is weather.
  //
  // The pick is nearest-first and deterministic (distance, then scan order),
  // NOT random, so a sector's particle set is a pure function of its sector —
  // see the renderer's 16-cell sector fingerprint.
  const spawnCells = focusedCells(openCells, options);
  const seed = hashString(`${options.mapHash || ''}:${profileName}`);
  const random = createRandom(seed);
  const particles = [];
  const density = Math.max(0, Math.min(1, Number(options.particleDensity ?? 1)));
  // A world may recolor the ambient dust (0..1 triple); the profile's tone
  // palette stays the default.
  const dustBase = Array.isArray(options.dustColor) && options.dustColor.length >= 3
    ? options.dustColor
    : profile.dustColor;
  // The ceiling: the profile's own constant unless the world named one.
  const dustBudget = Number.isFinite(options.particleBudget)
    ? Math.max(0, Math.round(options.particleBudget))
    : profile.baseParticles;
  const dustCount = Math.min(
    spawnCells.length * profile.particlesPerOpenCell,
    Math.round(dustBudget * density)
  );

  for (let index = 0; index < dustCount && spawnCells.length; index++) {
    const cell = spawnCells[Math.floor(random() * spawnCells.length)];
    const colorScale = 0.72 + random() * 0.38;
    const color = dustBase.map(channel => channel * colorScale);
    pushParticle(
      particles,
      cell.x + 0.15 + random() * 0.7,
      cell.y + 0.15 + random() * 0.7,
      -0.38 + random() * 0.76,
      color,
      0.045 + random() * 0.055,
      random() * 10,
      0,
      0.18 + random() * 0.28
    );
  }

  // Precipitation: type-4 streaks the vertex shader drops through a tall
  // wrapped column; count scales with the option (0 = none, the default).
  const precipitation = Math.max(0, Math.min(1, Number(options.precipitation ?? 0)));
  if (precipitation > 0) {
    const dropBudget = Number.isFinite(options.precipitationBudget)
      ? Math.max(0, Math.round(options.precipitationBudget))
      : PRECIPITATION_BASE_BUDGET;
    const dropCount = Math.min(
      spawnCells.length * PRECIPITATION_PER_OPEN_CELL,
      Math.round(dropBudget * precipitation)
    );
    for (let index = 0; index < dropCount && spawnCells.length; index++) {
      const cell = spawnCells[Math.floor(random() * spawnCells.length)];
      pushParticle(
        particles,
        cell.x + random(),
        cell.y + random(),
        -0.6 + random() * 1.1,
        [0.5, 0.56, 0.7],
        0.045 + random() * 0.025,
        random() * 10,
        4,
        0.28 + random() * 0.26
      );
    }
  }

  const fogVolumes = [];
  // Only the first one to three cells feed fog volumes. Keep that stable
  // prefix while scanning instead of sorting the entire district and hashing
  // each cell again in every comparator. Equal hashes retain scan order.
  const shuffledCells = [];
  const fogHashes = [];
  for (const cell of openCells) {
    const hash = hashString(`${seed}:${cell.x}:${cell.y}`);
    let index = 0;
    while (index < fogHashes.length && fogHashes[index] <= hash) index++;
    if (index >= profile.fogVolumes) continue;
    shuffledCells.splice(index, 0, cell);
    fogHashes.splice(index, 0, hash);
    if (shuffledCells.length > profile.fogVolumes) {
      shuffledCells.pop();
      fogHashes.pop();
    }
  }
  for (let index = 0; index < Math.min(profile.fogVolumes, shuffledCells.length); index++) {
    const cell = shuffledCells[index];
    fogVolumes.push({
      x: cell.x + 0.5,
      y: cell.y + 0.5,
      z: 0,
      radius: 2.2 + random() * 1.8,
      color: [...profile.fogColor],
      density: 0.12 + random() * 0.12
    });
  }

  for (const light of lights) {
    const type = light.lightType || light.type;
    const x = Number(light.x || 0);
    const y = Number(light.y || 0);
    // Fixture-attached effects ride the fixture: particle z is the light's
    // own zOffset (which is ceiling-anchored, see WorldZ) plus the offset
    // the effect always had from its fixture, so a raised ceiling lifts the
    // burst with the spark and the glow with the tube instead of leaving
    // them at the old ceiling's height.
    if (type === 'spark') {
      const anchor = Number.isFinite(light.zOffset) ? light.zOffset : ceilingDrop(0.26);
      for (let index = 0; index < 14; index++) {
        pushParticle(particles, x, y, anchor, [0.55, 0.8, 1], 0.055 + random() * 0.04, random() * 10, 1, 0.65 + random() * 0.6);
      }
    } else if (type === 'tube') {
      const anchor = Number.isFinite(light.zOffset) ? light.zOffset : ceilingDrop(0.25);
      for (let index = 0; index < 7; index++) {
        pushParticle(particles, x, y, anchor + 0.43, [0.28, 0.7, 0.76], 0.07 + random() * 0.04, random() * 10, 2, 0.22 + random() * 0.25);
      }
    } else if (type === 'rift') {
      const anchor = Number.isFinite(light.zOffset) ? light.zOffset : wallMidZ() - 0.02;
      for (let index = 0; index < 18; index++) {
        pushParticle(particles, x, y, anchor - 0.03 + random() * 0.2, [0.62, 0.12, 0.95], 0.06 + random() * 0.055, random() * 10, 3, 0.55 + random() * 0.55);
      }
      if (fogVolumes.length < MAX_FOG_VOLUMES) {
        fogVolumes.push({ x, y, z: anchor + 0.02, radius: Math.max(2.5, (light.range || 5) * 0.55), color: [0.3, 0.03, 0.5], density: 0.34 });
      }
    }
  }

  return {
    particles: new Float32Array(particles),
    particleCount: particles.length / ENVIRONMENT_PARTICLE_STRIDE,
    fogVolumes: fogVolumes.slice(0, MAX_FOG_VOLUMES)
  };
}
