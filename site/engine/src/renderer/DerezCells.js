/**
 * Grid-cell disintegration (opt-in): a wall cell with `derez` progress leaves
 * the static mesh and is drawn as a subdivided box through the entity path,
 * where the same applyAsciiDerez that dissolves mesh entities sheds it into
 * glyph fragments. Played backwards, progress falling to 0 rezzes it in.
 *
 * The box is built in the entity vertex format, in renderer space (z points
 * down, floor at z 0.5), with every face tiled into squares of at most
 * DEREZ_CELL_TILE units. Tiling is what makes the effect read as a wall
 * shedding pieces: applyAsciiDerez drops whole source triangles in a fixed,
 * evenly spread order, and an untiled face is two triangles, so a wall would
 * lose half a face at a time.
 */
import { ENTITY_VERTEX_STRIDE, ENTITY_LOD } from './EntityGeometry.js';

/** Reserved entity type the facade gives disintegrating cells. */
export const DEREZ_CELL_TYPE = '__ascii_derez_cell';

/** Largest tile edge, in renderer units, at full and simplified LOD. */
export const DEREZ_CELL_TILE = Object.freeze({ full: 0.25, simplified: 0.5 });

const clamp01 = n => Math.max(0, Math.min(1, n));

/**
 * One cell's box(es) as a non-indexed triangle list in the entity format.
 * `entity.derezBoxes` holds { x0, y0, x1, y1, zTop, zBottom } in renderer
 * space (zTop < zBottom, since z points down); `entity.derezMaterial` holds
 * { color: [r, g, b] 0..1, roughness, emission, lightResponse }. The bottom
 * face is built only for raised boxes, whose underside can be seen.
 */
export function buildDerezCellMesh(entity, lod) {
  const tile = lod === ENTITY_LOD.FULL ? DEREZ_CELL_TILE.full : DEREZ_CELL_TILE.simplified;
  const material = entity.derezMaterial;
  const out = [];
  const emitQuad = (origin, u, v, normal) => {
    // Wind counterclockwise about the outward normal, as addLocalBox does:
    // the entity pass culls back faces.
    const cross = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    if (cross[0] * normal[0] + cross[1] * normal[1] + cross[2] * normal[2] < 0) [u, v] = [v, u];
    const nu = Math.max(1, Math.ceil(Math.hypot(...u) / tile - 1e-9));
    const nv = Math.max(1, Math.ceil(Math.hypot(...v) / tile - 1e-9));
    const point = (i, j) => [0, 1, 2].map(k => origin[k] + u[k] * (i / nu) + v[k] * (j / nv));
    const vertex = p => out.push(p[0], p[1], p[2], normal[0], normal[1], normal[2],
      material.color[0], material.color[1], material.color[2],
      material.roughness, material.emission, material.lightResponse);
    for (let j = 0; j < nv; j++) {
      for (let i = 0; i < nu; i++) {
        const a = point(i, j), b = point(i + 1, j), c = point(i + 1, j + 1), d = point(i, j + 1);
        vertex(a); vertex(b); vertex(c);
        vertex(a); vertex(c); vertex(d);
      }
    }
  };
  for (const box of entity.derezBoxes || []) {
    const { x0, y0, x1, y1, zTop, zBottom } = box;
    const w = x1 - x0, d = y1 - y0, h = zBottom - zTop;
    if (!(w > 0 && d > 0 && h > 0)) continue;
    emitQuad([x0, y0, zTop], [w, 0, 0], [0, 0, h], [0, -1, 0]);
    emitQuad([x0, y1, zTop], [w, 0, 0], [0, 0, h], [0, 1, 0]);
    emitQuad([x0, y0, zTop], [0, d, 0], [0, 0, h], [-1, 0, 0]);
    emitQuad([x1, y0, zTop], [0, d, 0], [0, 0, h], [1, 0, 0]);
    emitQuad([x0, y0, zTop], [w, 0, 0], [0, d, 0], [0, 0, -1]);
    if (box.raised) emitQuad([x0, y0, zBottom], [w, 0, 0], [0, d, 0], [0, 0, 1]);
  }
  const vertices = new Float32Array(out);
  // World scenery takes the world glyph ramp, not the actor ramp, so a cell
  // that starts to derez keeps the glyphs it had as static geometry.
  for (let i = 9; i < vertices.length; i += ENTITY_VERTEX_STRIDE) vertices[i] = -(vertices[i] + 1);
  return { vertices, vertexCount: vertices.length / ENTITY_VERTEX_STRIDE, lod, animation: Object.freeze({}) };
}

/**
 * The derez fields of one grid cell, validated. Returns null for a cell that
 * is not disintegrating (no field, nonfinite, or 0 and below), else
 * { progress, palette } with progress clamped to 1 and the palette as frozen
 * 0..1 triples, or null when the cell names none. Throws on a malformed
 * palette, naming the cell.
 */
export function readCellDerez(cell, x, y) {
  if (!cell || typeof cell !== 'object' || !Number.isFinite(cell.derez) || cell.derez <= 0) return null;
  let palette = null;
  if (cell.derezPalette !== undefined && cell.derezPalette !== null) {
    const valid = Array.isArray(cell.derezPalette) && cell.derezPalette.length > 0
      && cell.derezPalette.every(c => Array.isArray(c) && c.length === 3 && c.every(Number.isFinite));
    if (!valid) {
      throw new TypeError(`grid.cells[${y}][${x}].derezPalette must be a non-empty array of finite [r, g, b] triples in 0..1.`);
    }
    palette = cell.derezPalette.map(c => c.map(clamp01));
  }
  return { progress: Math.min(1, cell.derez), palette };
}
