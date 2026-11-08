const BLOCKED_VISIBILITY = 0;

function isOpaque(map, x, y) {
  return y < 0 || y >= map.length || x < 0 || x >= map[0].length || map[y][x] > 0;
}

export function traceGridVisibility(map, fromX, fromY, toX, toY) {
  if (!map || !map.length || !map[0].length) return 1;

  const dx = toX - fromX;
  const dy = toY - fromY;
  const distance = Math.hypot(dx, dy);
  if (distance < 0.001) return 1;

  const steps = Math.max(1, Math.ceil(distance * 5));
  for (let step = 1; step < steps; step++) {
    const t = step / steps;
    if (t > 0.9) break;
    const x = Math.floor(fromX + dx * t);
    const y = Math.floor(fromY + dy * t);
    if (isOpaque(map, x, y)) return BLOCKED_VISIBILITY;
  }

  return 1;
}

/**
 * Each light's layer, kept between bakes.
 *
 * A layer depends on the map and on its own light's position and range, and
 * on nothing else: not on the slot it lands in, nor on the other lights. So a
 * bake whose set differs from the last by one fixture need trace only that
 * one. The renderer's cullable fixtures are reselected as the camera walks,
 * and every change of the set used to retrace every layer; in a facility of
 * a few hundred fixtures that was a 13 ms bake about five times a second at a
 * run (Liminal Protocol: Critical Response, 2026-10-26).
 *
 * The cache hands back the very bytes the trace would write, so an atlas
 * baked through it is identical to one baked without
 * (test/core/LightVisibilityCache.test.js). Only the bounded path is kept: a
 * light with a finite position and a finite numeric range. Everything else
 * traces as it always has. The cache empties when the map object or the
 * caller's `mapKey` changes, and when it holds `limit` layers.
 */
export function createLightVisibilityCache(limit = 1024) {
  return { map: null, mapKey: undefined, layers: new Map(), limit };
}

export function buildLightVisibilityAtlas(map, lights, maxLights = 32, { cache = null, mapKey = '' } = {}) {
  const width = map && map[0] ? map[0].length : 1;
  const mapHeight = map && map.length ? map.length : 1;
  const activeLights = (lights || []).filter(light => light.active !== false).slice(0, maxLights);
  const layerCount = Math.max(1, activeLights.length);
  const data = new Uint8Array(width * mapHeight * layerCount);
  // Finite lights already return 255 outside range + 1. Fill that unchanged
  // default once, then visit only a conservative rectangle around each light.
  data.fill(255);

  // No shadow-casting lights still allocates the one mandatory layer; it must
  // read fully visible, or the light that happens to sit in slot 0 (a scene
  // lit purely by dynamic lights) is crushed to the shadow floor everywhere.
  if (!map || !map.length || !map[0].length || activeLights.length === 0) {
    return { width, mapHeight, layerCount, activeLights, data };
  }

  if (cache && (cache.map !== map || cache.mapKey !== mapKey)) {
    cache.map = map;
    cache.mapKey = mapKey;
    cache.layers.clear();
  }

  activeLights.forEach((light, lightIndex) => {
    let minX = 0, maxX = width - 1, minY = 0, maxY = mapHeight - 1;
    // Non-numeric ranges use the historical full-map path without coercion.
    const radius = Number.isFinite(light.range) ? light.range + 1 : Infinity;
    // One cell of outward padding preserves near-boundary floating-point
    // cases. Invalid/extreme inputs retain the historical full-grid path.
    const bounded = Number.isFinite(light.range) && light.range >= 0 &&
        Number.isFinite(light.x) && Number.isFinite(light.y) &&
        Math.max(Math.abs(light.x), Math.abs(light.y), radius) < 2 ** 50;
    if (bounded) {
      minX = Math.max(0, Math.floor(light.x - radius - 0.5) - 1);
      maxX = Math.min(width - 1, Math.ceil(light.x + radius - 0.5) + 1);
      minY = Math.max(0, Math.floor(light.y - radius - 0.5) - 1);
      maxY = Math.min(mapHeight - 1, Math.ceil(light.y + radius - 0.5) + 1);
    }
    const layer = lightIndex * width * mapHeight;
    const span = maxX - minX + 1;
    // Finite numbers only, so the key is exact: a number's string is its value.
    const key = cache && bounded ? `${light.x},${light.y},${light.range}` : null;
    const kept = key === null ? undefined : cache.layers.get(key);
    if (kept) {
      for (let y = minY, row = 0; y <= maxY; y++, row += span) {
        data.set(kept.subarray(row, row + span), layer + y * width + minX);
      }
      return;
    }
    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        const targetX = x + 0.5;
        const targetY = y + 0.5;
        const dx = targetX - light.x;
        const dy = targetY - light.y;
        const distance = Math.max(Math.hypot(dx, dy), 0.001);
        const index = lightIndex * width * mapHeight + y * width + x;
        if (Number.isFinite(light.range) && distance > light.range + 1) {
          continue;
        }
        const offsetX = (-dy / distance) * 0.2;
        const offsetY = (dx / distance) * 0.2;
        const center = traceGridVisibility(map, light.x, light.y, targetX, targetY);
        const left = traceGridVisibility(map, light.x, light.y, targetX + offsetX, targetY + offsetY);
        const right = traceGridVisibility(map, light.x, light.y, targetX - offsetX, targetY - offsetY);
        const visibility = center * 0.5 + left * 0.25 + right * 0.25;
        data[index] = Math.round(visibility * 255);
      }
    }
    if (key !== null && maxX >= minX && maxY >= minY) {
      if (cache.layers.size >= cache.limit) cache.layers.clear();
      const bytes = new Uint8Array(span * (maxY - minY + 1));
      for (let y = minY, row = 0; y <= maxY; y++, row += span) {
        bytes.set(data.subarray(layer + y * width + minX, layer + y * width + maxX + 1), row);
      }
      cache.layers.set(key, bytes);
    }
  });

  return { width, mapHeight, layerCount, activeLights, data };
}

export function getLightVisibilityFingerprint(mapHash, lights, maxLights = 32) {
  const lightKey = (lights || [])
    .filter(light => light.active !== false)
    .slice(0, maxLights)
    .map(light => `${Number(light.x).toFixed(3)},${Number(light.y).toFixed(3)},${Number(light.range || 0).toFixed(3)}`)
    .join('|');
  return `${mapHash || ''}:${lightKey}`;
}
