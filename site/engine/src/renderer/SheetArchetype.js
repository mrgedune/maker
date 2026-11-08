/**
 * The `sheet` archetype: a thin, parametric panel for membranes, curtains,
 * fences, glass and banners, which a 1x1 grid cell is too thick to be.
 *
 * The sheet stands on the entity's floor-contact point, centred on it, and
 * faces along the heading (its normal is +x locally, the way every archetype
 * faces +x). Everything is in renderer cells and comes from `entity.params`
 * each frame:
 *
 *   width     0.05..24, default 1    across, centred on the entity
 *   height    0.05..24, default 2    up from the floor contact
 *   thickness 0.005..0.5, default 0.03
 *   holes     [[left, bottom, right, top], ...] in sheet units, measured from
 *             the sheet's left edge (seen from the front) and its bottom.
 *             Tiles whose centres fall inside a hole are left out.
 *   sway      bend amplitude along the normal, default 0 (flat)
 *   phase     radians, default 0: the game advances it to animate the sway,
 *             so a frame depends only on its params
 *   waves     wavelengths across the width, default 1
 *   anchor    'both' (default: pinned top and bottom), 'top' (a curtain),
 *             'bottom' (a flag on a fence), or 'none' (the whole sheet moves)
 *
 * Faces are tiled (0.25 cells at full LOD, 0.5 simplified) so the sway bends
 * smoothly, holes have an edge to cut along, and derez sheds pieces rather
 * than half the sheet. Both sides are drawn, plus the outer rim; hole edges
 * have no rim, which at a sheet's thickness is invisible.
 *
 * Authored LIT (emission 0.05, lightResponse 0.9): a sheet takes the scene's
 * light. The palette hint is '█' for the whole sheet.
 */
import { createBasis, createMeshBuffer, finishMesh, resolveMaterial, ENTITY_LOD } from './EntityGeometry.js';

export const SHEET_TILE = Object.freeze({ full: 0.25, simplified: 0.5 });
const ANCHORS = new Set(['both', 'top', 'bottom', 'none']);

function param(params, name, fallback, min, max) {
  const value = params && Number.isFinite(params[name]) ? params[name] : fallback;
  return Math.max(min, Math.min(max, value));
}

/** The sheet's resolved shape from params; exported for tests and callers. */
export function resolveSheetParams(params) {
  const p = params && typeof params === 'object' ? params : null;
  const width = param(p, 'width', 1, 0.05, 24);
  const height = param(p, 'height', 2, 0.05, 24);
  const holes = Array.isArray(p?.holes)
    ? p.holes.filter(h => Array.isArray(h) && h.length === 4 && h.every(Number.isFinite))
      .map(([a, b, c, d]) => [Math.min(a, c), Math.min(b, d), Math.max(a, c), Math.max(b, d)])
    : [];
  return {
    width,
    height,
    thickness: param(p, 'thickness', 0.03, 0.005, 0.5),
    holes,
    sway: param(p, 'sway', 0, -4, 4),
    phase: param(p, 'phase', 0, -1e6, 1e6),
    waves: param(p, 'waves', 1, 0, 64),
    anchor: ANCHORS.has(p?.anchor) ? p.anchor : 'both'
  };
}

export function buildSheetMesh(entity, currentTime = 0, lod = ENTITY_LOD.FULL, options = {}) {
  const shape = resolveSheetParams(entity.params);
  const { width, height, thickness, holes, sway, phase, waves, anchor } = shape;
  const tile = lod === ENTITY_LOD.FULL ? SHEET_TILE.full : SHEET_TILE.simplified;
  const material = resolveMaterial(entity,
    { color: [0.86, 0.83, 0.8], roughness: 0.85, emission: 0.05, lightResponse: 0.9 },
    options, 0.5, 0.5, '█');
  const basis = createBasis(entity);
  const vertices = createMeshBuffer();
  const cols = Math.max(1, Math.ceil(width / tile - 1e-9));
  const rows = Math.max(1, Math.ceil(height / tile - 1e-9));

  // Sheet coordinates: s across from the left edge seen from the front
  // (local -y side), t up from the bottom. Offset is along the normal.
  const profile = t => {
    const k = t / height;
    if (anchor === 'top') return 1 - k;
    if (anchor === 'bottom') return k;
    if (anchor === 'none') return 1;
    return Math.sin(Math.PI * k);
  };
  const bend = (s, t) => (sway === 0 ? 0 : sway * Math.sin(phase + 2 * Math.PI * waves * s / width) * profile(t));
  const world = (s, t, n) => {
    const lx = n;
    const ly = s - width / 2;
    return [
      basis.origin[0] + basis.forward[0] * lx + basis.right[0] * ly,
      basis.origin[1] + basis.forward[1] * lx + basis.right[1] * ly,
      0.5 - t
    ];
  };
  const normalOf = (fx, ry, uz) => [
    basis.forward[0] * fx + basis.right[0] * ry,
    basis.forward[1] * fx + basis.right[1] * ry,
    uz
  ];
  const push = (p, n) => {
    const c = material.color;
    vertices.push(p[0], p[1], p[2], n[0], n[1], n[2], c[0], c[1], c[2],
      material.roughness, material.emission, material.lightResponse);
  };
  // Two triangles, wound counterclockwise about the outward normal.
  const quad = (a, b, c, d, n) => {
    const u = b.map((v, i) => v - a[i]), v = c.map((w, i) => w - a[i]);
    const cross = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    if (cross[0] * n[0] + cross[1] * n[1] + cross[2] * n[2] < 0) [b, d] = [d, b];
    push(a, n); push(b, n); push(c, n);
    push(a, n); push(c, n); push(d, n);
  };
  const inHole = (s, t) => holes.some(([l, b, r, top]) => s > l && s < r && t > b && t < top);
  const half = thickness / 2;
  const front = normalOf(1, 0, 0), back = normalOf(-1, 0, 0);
  const sAt = i => Math.min(width, (i / cols) * width), tAt = j => Math.min(height, (j / rows) * height);

  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const s0 = sAt(i), s1 = sAt(i + 1), t0 = tAt(j), t1 = tAt(j + 1);
      if (inHole((s0 + s1) / 2, (t0 + t1) / 2)) continue;
      const corner = (s, t, side) => world(s, t, bend(s, t) + side * half);
      quad(corner(s0, t0, 1), corner(s1, t0, 1), corner(s1, t1, 1), corner(s0, t1, 1), front);
      quad(corner(s0, t0, -1), corner(s1, t0, -1), corner(s1, t1, -1), corner(s0, t1, -1), back);
      // Outer rim, along the sheet's own border only.
      const rim = (sa, ta, sb, tb, n) => quad(corner(sa, ta, -1), corner(sb, tb, -1), corner(sb, tb, 1), corner(sa, ta, 1), n);
      if (i === 0) rim(s0, t0, s0, t1, normalOf(0, -1, 0));
      if (i === cols - 1) rim(s1, t0, s1, t1, normalOf(0, 1, 0));
      if (j === 0) rim(s0, t0, s1, t0, [0, 0, 1]);
      if (j === rows - 1) rim(s0, t1, s1, t1, [0, 0, -1]);
    }
  }
  return finishMesh(vertices, lod, { archetype: 'sheet', ...shape, holes: holes.length });
}
