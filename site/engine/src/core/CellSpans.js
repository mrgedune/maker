// Optional vertical spans inside one grid cell, so a slit, a window or a
// breach can open in the middle of a wall without extra cells. Heights are
// world units above floorHeight, like `height` and `base`. Cells with neither
// field keep their single box from `base` to `height`.

/**
 * The solid vertical spans of a cell, or null when it uses neither `spans`
 * nor `holes`.
 *
 *   spans: [[bottom, top], ...]  the solid parts, replacing base..height
 *   holes: [[bottom, top], ...]  cut out of base..height (or out of spans)
 *
 * Spans are clamped to the floor, sorted and merged; empty ones drop. The
 * result can be an empty array, which draws nothing. Malformed input throws,
 * naming the cell when its coordinates are given.
 */
export function cellSpans(cell, defaultHeight, x = null, y = null) {
  if (!cell || typeof cell !== 'object') return null;
  const hasSpans = cell.spans !== undefined && cell.spans !== null;
  const hasHoles = cell.holes !== undefined && cell.holes !== null;
  if (!hasSpans && !hasHoles) return null;
  const where = x === null ? 'cell' : `grid.cells[${y}][${x}]`;
  const read = (list, name) => {
    if (!Array.isArray(list) || !list.every(pair => Array.isArray(pair) && pair.length === 2 && pair.every(Number.isFinite))) {
      throw new TypeError(`${where}.${name} must be an array of finite [bottom, top] pairs.`);
    }
    return list.map(([a, b]) => [Math.min(a, b), Math.max(a, b)]);
  };
  let solid;
  if (hasSpans) {
    solid = read(cell.spans, 'spans');
  } else {
    const height = Number.isFinite(cell.height) ? cell.height : defaultHeight;
    const base = Number.isFinite(cell.base) ? cell.base : 0;
    solid = [[base, height]];
  }
  solid = merge(solid.map(([a, b]) => [Math.max(0, a), b]));
  if (hasHoles) {
    for (const [a, b] of read(cell.holes, 'holes')) {
      solid = solid.flatMap(([s, t]) => {
        if (b <= s || a >= t) return [[s, t]];
        const parts = [];
        if (a > s) parts.push([s, a]);
        if (b < t) parts.push([b, t]);
        return parts;
      });
    }
  }
  return solid.filter(([a, b]) => b - a > 1e-6);
}

function merge(spans) {
  const sorted = spans.filter(([a, b]) => b > a).sort((p, q) => p[0] - q[0]);
  const out = [];
  for (const span of sorted) {
    const last = out[out.length - 1];
    if (last && span[0] <= last[1]) last[1] = Math.max(last[1], span[1]);
    else out.push([span[0], span[1]]);
  }
  return out;
}
