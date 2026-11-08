export const MAX_REACTIVE_SURFACES = 12;

const PROFILE_SETTINGS = {
  stable: { basePatches: 6, minRadius: 0.65, maxRadius: 1.25 },
  ascii: { basePatches: 9, minRadius: 0.75, maxRadius: 1.45 },
  black_annex: { basePatches: 11, minRadius: 0.9, maxRadius: 1.7 }
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

function isOpen(map, x, y) {
  return y >= 0 && y < map.length && x >= 0 && x < map[y].length && map[y][x] === 0;
}

export function getReactiveSurfacesFingerprint(mapHash, profileName, enabled = true, variant = '') {
  return `${enabled ? 1 : 0}:${profileName}:${variant}:${mapHash}`;
}

export function buildReactiveSurfaces(map, options = {}) {
  const profileName = PROFILE_SETTINGS[options.profileName] ? options.profileName : 'stable';
  const profile = PROFILE_SETTINGS[profileName];
  if (options.enabled === false || !Array.isArray(map) || !map.length || !map[0]?.length) {
    return { patches: [] };
  }

  if (options.fullCoverage === true) {
    const width = map[0].length;
    const height = map.length;
    return {
      patches: [{
        x: width * 0.5,
        y: height * 0.5,
        // The shader stretches patches into ellipses. This deliberately large
        // radius keeps the mask at full strength through all four corners.
        radius: Math.hypot(width, height) * 2,
        intensity: 1,
        phase: 0
      }]
    };
  }

  const candidates = [];
  const hasFocus = Number.isFinite(options.focusX) && Number.isFinite(options.focusY);
  for (let y = 1; y < map.length - 1; y++) {
    for (let x = 1; x < map[y].length - 1; x++) {
      if (!isOpen(map, x, y)) continue;
      const nearStructure = !isOpen(map, x - 1, y)
        || !isOpen(map, x + 1, y)
        || !isOpen(map, x, y - 1)
        || !isOpen(map, x, y + 1);
      candidates.push({
        x,
        y,
        priority: nearStructure ? 0 : 1,
        focusDist: hasFocus ? Math.hypot(x + 0.5 - options.focusX, y + 0.5 - options.focusY) : 0,
        hash: hashString(`${options.mapHash || ''}:${profileName}:${x}:${y}`)
      });
    }
  }

  // With a focus, the nearest qualifying cells win so a large map keeps its
  // few patches around the viewer; without one, the historical whole-map
  // hash order is preserved exactly.
  candidates.sort((a, b) => a.priority - b.priority || a.focusDist - b.focusDist || a.hash - b.hash);
  const density = Math.max(0, Math.min(1, Number(options.density ?? 1)));
  const targetCount = Math.min(MAX_REACTIVE_SURFACES, Math.round(profile.basePatches * density));
  const random = createRandom(hashString(`${options.mapHash || ''}:${profileName}:reactive`));
  const patches = [];

  for (const cell of candidates) {
    if (patches.length >= targetCount) break;
    const centerX = cell.x + 0.28 + random() * 0.44;
    const centerY = cell.y + 0.28 + random() * 0.44;
    if (patches.some(patch => Math.hypot(patch.x - centerX, patch.y - centerY) < 2.1)) continue;

    patches.push({
      x: centerX,
      y: centerY,
      radius: profile.minRadius + random() * (profile.maxRadius - profile.minRadius),
      intensity: 0.62 + random() * 0.32,
      phase: random() * Math.PI * 2
    });
  }

  return { patches };
}
