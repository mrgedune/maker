/**
 * SceneGeometry.js
 *
 * Produces GPU-ready environment meshes while preserving the integer map as
 * the source of truth for collision, AI, and procedural gameplay. The output
 * vertex format is [position.xyz, normal.xyz, uv.xy].
 */

import { WORLD_CEILING_Z, WORLD_FLOOR_Z } from './WorldZ.js';
import { resolveCeilingZGrid, collectClerestoryBands } from './CeilingMesh.js';

const TAU = Math.PI * 2;
const EPSILON = 0.0001;

const DEFAULT_OPTIONS = Object.freeze({
  roundedCorners: true,
  cornerRadius: 0.22,
  cornerSegments: 6,
  zFloor: WORLD_FLOOR_Z,
  zCeiling: WORLD_CEILING_Z,
  // Whether `buildGrid` closes each open cell with a lid at `zCeiling`. True is
  // the facility as a person walks through it, where the camera stands inside
  // that volume and the ceiling is architecture.
  //
  // A camera hung above the grid cannot be inside it. `resolveTacticalCamera`
  // derives its height from `range * sin(elevation)` and clamps those at a
  // minimum range of 5 and a minimum elevation of 30 degrees, so the lowest a
  // tactical camera can ever hang is 2.5 units - five times the ceiling height.
  // Every such frame looks down through a lid that is nearer to it than the
  // floor is, and the geometry pass runs with CULL_FACE disabled (only the
  // flashlight shadow pass turns it on), so the lid takes the depth test and
  // becomes the entire picture. False omits it, which is also simply what a
  // top-down tactical board is.
  ceilings: true
});

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function finiteOr(value, fallback) {
  return Number.isFinite(value) ? value : fallback;
}

function pointAt(start, end, amount) {
  return [
    start[0] + (end[0] - start[0]) * amount,
    start[1] + (end[1] - start[1]) * amount
  ];
}

function validCurvePoints(points) {
  return Array.isArray(points)
    ? points.filter(point => Array.isArray(point) && Number.isFinite(point[0]) && Number.isFinite(point[1]))
    : [];
}

function sampleCurve(points, amount) {
  const t = clamp(amount, 0, 1);
  if (points.length === 2) return pointAt(points[0], points[1], t);
  if (points.length === 3) {
    const inverse = 1 - t;
    return [
      inverse * inverse * points[0][0] + 2 * inverse * t * points[1][0] + t * t * points[2][0],
      inverse * inverse * points[0][1] + 2 * inverse * t * points[1][1] + t * t * points[2][1]
    ];
  }
  if (points.length === 4) {
    const inverse = 1 - t;
    return [
      inverse ** 3 * points[0][0] + 3 * inverse * inverse * t * points[1][0] + 3 * inverse * t * t * points[2][0] + t ** 3 * points[3][0],
      inverse ** 3 * points[0][1] + 3 * inverse * inverse * t * points[1][1] + 3 * inverse * t * t * points[2][1] + t ** 3 * points[3][1]
    ];
  }

  const segmentCount = points.length - 1;
  const scaled = Math.min(segmentCount - EPSILON, t * segmentCount);
  const segment = Math.floor(scaled);
  const localT = scaled - segment;
  const p0 = points[Math.max(0, segment - 1)];
  const p1 = points[segment];
  const p2 = points[Math.min(points.length - 1, segment + 1)];
  const p3 = points[Math.min(points.length - 1, segment + 2)];
  const localT2 = localT * localT;
  const localT3 = localT2 * localT;
  return [0, 1].map(axis => 0.5 * (
    2 * p1[axis] + (-p0[axis] + p2[axis]) * localT +
    (2 * p0[axis] - 5 * p1[axis] + 4 * p2[axis] - p3[axis]) * localT2 +
    (-p0[axis] + 3 * p1[axis] - 3 * p2[axis] + p3[axis]) * localT3
  ));
}

/**
 * Every atlas slot the mesh under construction has addressed.
 *
 * A slot that holds no baked material is not an error anywhere in this file -
 * the UVs are valid, the triangles are emitted, and the surface samples cleared
 * atlas and comes out empty. Nothing reports it, which makes it the one
 * renderer failure with no symptom at all. makeAtlasUV is the single place an
 * index becomes UVs, so it is the single place to record one; toMesh hands the
 * list to the renderer, which is where the atlas is and so where the answer is.
 *
 * Builds are synchronous and one at a time, which is what lets this be a
 * module-level set rather than threaded through every emit.
 */
const addressedAtlasSlots = new Set();

function takeAddressedAtlasSlots() {
  const slots = [...addressedAtlasSlots];
  addressedAtlasSlots.clear();
  return slots;
}

/**
 * Deterministic per-course hash for the opt-in course-variation U offsets.
 * Same recipe family as the facade's texel bake hash: integer mixing, no
 * state, so the same course index and seed shift the same columns on every
 * machine and every rebuild.
 */
function courseHash(index, seed) {
  let h = ((index | 0) * 374761393 + (seed | 0) * 668265263) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function makeAtlasUV(atlasIndex, cellSize, atlasSize) {
  const size = clamp(cellSize / atlasSize, 0.0001, 1.0);
  const index = Math.max(0, Math.floor(finiteOr(atlasIndex, 0)));
  addressedAtlasSlots.add(index);
  const column = index % 16;
  const row = Math.floor(index / 16);

  return {
    uMin: column * size,
    uMax: (column + 1) * size,
    vMin: row * size,
    vMax: (row + 1) * size
  };
}

function isOpenCell(map, width, height, x, y) {
  return x >= 0 && x < width && y >= 0 && y < height &&
    Array.isArray(map[y]) && map[y][x] === 0;
}

/**
 * One solid cell's walls: its exposed faces, its rounded corners, and the floor
 * and ceiling wedges that close those corners.
 *
 * Factored out of `buildGrid` so `buildCells` can emit the SAME triangles for a
 * chosen handful of cells, which is the whole of what makes a phase dissolve
 * honest: the slab that fades is not a stand-in for the bulkhead, it is the
 * bulkhead's own geometry lifted into a draw call of its own. A test asserts the
 * two agree triangle for triangle; if this ever forks, the dissolve would start
 * by popping to a different wall.
 *
 * `uv.floor()` and `uv.ceiling()` are called rather than passed, because
 * `makeAtlasUV` is what records an addressed slot and a mesh must not claim a
 * slot it never samples - see the note above it. A bulkhead in a corridor has
 * two opposite faces and so no rounded corners at all, and must not report the
 * floor slot for wedges it did not build.
 */
function appendCellWalls(mesh, map, x, y, context) {
  const { width, height, zFloor, zCeiling, cornerRadius, cornerSegments, roundedCorners, ceilings, uv } = context;
  const cell = map[y] && map[y][x];
  if (!(cell > 0) || cell === 9) return;

  const wallUV = makeAtlasUV(cell === 5 ? 7 : cell - 1, context.cellSize, context.atlasSize);
  const faces = {};
  if (isOpenCell(map, width, height, x, y - 1)) faces.north = { start: [x, y], end: [x + 1, y], normal: [0, -1, 0], trimStart: 0, trimEnd: 0 };
  if (isOpenCell(map, width, height, x + 1, y)) faces.east = { start: [x + 1, y], end: [x + 1, y + 1], normal: [1, 0, 0], trimStart: 0, trimEnd: 0 };
  if (isOpenCell(map, width, height, x, y + 1)) faces.south = { start: [x + 1, y + 1], end: [x, y + 1], normal: [0, 1, 0], trimStart: 0, trimEnd: 0 };
  if (isOpenCell(map, width, height, x - 1, y)) faces.west = { start: [x, y + 1], end: [x, y], normal: [-1, 0, 0], trimStart: 0, trimEnd: 0 };

  for (const face of Object.values(faces)) {
    face.zCeiling = context.ceilZGrid
      ? context.ceilZGrid[(y + face.normal[1]) * width + x + face.normal[0]]
      : zCeiling;
  }
  const rounded = [];
  const addRoundedCorner = (first, second, firstEnd, secondEnd, outerCorner, center, startAngle, endAngle) => {
    if (!roundedCorners || !faces[first] || !faces[second]) return;
    // A stepped junction stays square: rounding across unequal lids would
    // leave a wedge open above the lower room.
    if (Math.abs(faces[first].zCeiling - faces[second].zCeiling) > EPSILON) return;
    faces[first][firstEnd] = cornerRadius;
    faces[second][secondEnd] = cornerRadius;
    rounded.push({ outerCorner, center, startAngle, endAngle, zCeiling: faces[first].zCeiling });
  };

  addRoundedCorner('north', 'east', 'trimEnd', 'trimStart', [x + 1, y], [x + 1 - cornerRadius, y + cornerRadius], -Math.PI / 2, 0);
  addRoundedCorner('east', 'south', 'trimEnd', 'trimStart', [x + 1, y + 1], [x + 1 - cornerRadius, y + 1 - cornerRadius], 0, Math.PI / 2);
  addRoundedCorner('south', 'west', 'trimEnd', 'trimStart', [x, y + 1], [x + cornerRadius, y + 1 - cornerRadius], Math.PI / 2, Math.PI);
  addRoundedCorner('west', 'north', 'trimEnd', 'trimStart', [x, y], [x + cornerRadius, y + cornerRadius], Math.PI, Math.PI * 1.5);

  for (const face of Object.values(faces)) {
    const startFactor = face.trimStart;
    const endFactor = 1 - face.trimEnd;
    if (endFactor - startFactor <= EPSILON) continue;
    const firstVertex = mesh.vertexFloatCount / 8;
    mesh.addWallSegment({
      start: pointAt(face.start, face.end, startFactor),
      end: pointAt(face.start, face.end, endFactor),
      normal: face.normal,
      zFloor,
      zCeiling: face.zCeiling,
      uv: wallUV,
      startFraction: startFactor,
      endFraction: endFactor
    });
    const cellCode = (y + face.normal[1]) * width + x + face.normal[0] + 1;
    mesh.markVisibilityRange(firstVertex, cellCode, width, height);
  }

  for (const corner of rounded) {
    mesh.addArcWall({
      center: corner.center,
      radius: cornerRadius,
      startAngle: corner.startAngle,
      endAngle: corner.endAngle,
      segments: cornerSegments,
      zFloor,
      zCeiling: corner.zCeiling,
      uv: wallUV
    });
    mesh.addCornerFill({
      ...corner,
      radius: cornerRadius,
      segments: cornerSegments,
      z: zFloor,
      normal: [0, 0, -1],
      uv: uv.floor()
    });
    if (ceilings) {
      mesh.addCornerFill({
        ...corner,
        radius: cornerRadius,
        segments: cornerSegments,
        z: corner.zCeiling,
        normal: [0, 0, 1],
        uv: uv.ceiling()
      });
    }
  }
}

function centerOf(feature) {
  if (Array.isArray(feature.center) && feature.center.length >= 2 &&
      Number.isFinite(feature.center[0]) && Number.isFinite(feature.center[1])) {
    return [feature.center[0], feature.center[1]];
  }
  if (Number.isFinite(feature.x) && Number.isFinite(feature.y)) {
    return [feature.x, feature.y];
  }
  return null;
}

function featureAtlasIndex(feature, fallback) {
  if (Number.isFinite(feature.atlasIndex)) return Math.max(0, Math.floor(feature.atlasIndex));
  if (Number.isFinite(feature.materialId)) return Math.max(0, Math.floor(feature.materialId) - 1);
  return fallback;
}

/**
 * A cache key for one feature: every field it is built from. Boxes, the bulk of
 * a variable-height grid, are spelled out; anything else is serialized.
 */
function featureKey(feature) {
  if (feature.type !== 'box') return JSON.stringify(feature);
  const faces = feature.visibilityFaces;
  // Exactly what the box branch of appendFeatures reads.
  return `b${feature.center},${feature.x},${feature.y},${feature.sizeX},${feature.sizeY},${feature.zMin},${feature.zMax},`
    + `${feature.atlasIndex},${feature.materialId}`
    + (faces ? `|v${faces.width},${faces.height},${faces.codes}` : '')
    + (feature.course ? `|c${JSON.stringify(feature.course)}` : '');
}

/** Collects cached fragments in build order for SceneGeometry#assemble. */
class FragmentList {
  constructor() { this.entries = []; }
  appendFragment(entry) { this.entries.push(entry); }
}

class MeshBuilder {
  constructor() {
    // Private staging storage stays empty until the first emitted vertex.
    // Small dynamic feature builds must not reserve a district-sized buffer.
    this.vertices = new Float32Array(0);
    this.vertexFloatCount = 0;
    this.visibilityCells = null;
    this.visibilityMapWidth = 0;
    this.visibilityMapHeight = 0;
  }

  addVertex(position, normal, uv) {
    if (this.vertexFloatCount + 8 > this.vertices.length) {
      const grown = new Float32Array(Math.max(256, this.vertices.length * 2));
      grown.set(this.vertices);
      this.vertices = grown;
      if (this.visibilityCells) {
        const cells = new this.visibilityCells.constructor(grown.length / 8);
        cells.set(this.visibilityCells);
        this.visibilityCells = cells;
      }
    }
    // Emission never reads these floats back into geometry calculations;
    // rounding on write preserves the former final Float32 conversion.
    let index = this.vertexFloatCount;
    this.vertices[index++] = position[0];
    this.vertices[index++] = position[1];
    this.vertices[index++] = position[2];
    this.vertices[index++] = normal[0];
    this.vertices[index++] = normal[1];
    this.vertices[index++] = normal[2];
    this.vertices[index++] = uv[0];
    this.vertices[index++] = uv[1];
    this.vertexFloatCount = index;
  }

  /**
   * Appends a fragment captured by SceneGeometry#fragment: its vertices and,
   * when it declared any, its per-vertex light-visibility cells, exactly as if
   * the fragment's own build had run here.
   */
  appendFragment(fragment) {
    const floats = fragment.vertices.length;
    if (floats === 0) return;
    const firstVertex = this.vertexFloatCount / 8;
    if (this.vertexFloatCount + floats > this.vertices.length) {
      let size = Math.max(256, this.vertices.length * 2);
      while (size < this.vertexFloatCount + floats) size *= 2;
      const grown = new Float32Array(size);
      grown.set(this.vertices);
      this.vertices = grown;
      if (this.visibilityCells) {
        const cells = new this.visibilityCells.constructor(grown.length / 8);
        cells.set(this.visibilityCells);
        this.visibilityCells = cells;
      }
    }
    this.vertices.set(fragment.vertices, this.vertexFloatCount);
    this.vertexFloatCount += floats;
    if (!fragment.visibility) return;
    if (this.visibilityCells && (this.visibilityMapWidth !== fragment.mapWidth || this.visibilityMapHeight !== fragment.mapHeight)) return;
    if (!this.visibilityCells) {
      const CellArray = fragment.visibility.constructor;
      this.visibilityCells = new CellArray(this.vertices.length / 8);
      this.visibilityMapWidth = fragment.mapWidth;
      this.visibilityMapHeight = fragment.mapHeight;
    }
    this.visibilityCells.set(fragment.visibility, firstVertex);
  }

  addTriangle(p1, p2, p3, normal, uv1, uv2, uv3) {
    this.addVertex(p1, normal, uv1);
    this.addVertex(p2, normal, uv2);
    this.addVertex(p3, normal, uv3);
  }

  addQuad(p1, p2, p3, p4, normal, uv1, uv2, uv3, uv4) {
    this.addTriangle(p1, p2, p3, normal, uv1, uv2, uv3);
    this.addTriangle(p1, p3, p4, normal, uv1, uv3, uv4);
  }

  // Polyline cylinders for exposed services. Z follows the engine's down axis.
  addTube({ points, radius, segments = 8, uv }) {
    if (!Array.isArray(points) || !(radius > EPSILON) || !Number.isFinite(radius)) return;
    const count = clamp(Math.floor(finiteOr(segments, 8)), 3, 32);
    const cross = (a,b) => [a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
    const norm = a => { const d=Math.hypot(...a); return a.map(v=>v/d); };
    for (let p=1;p<points.length;p++) {
      const a=points[p-1],b=points[p];
      if (![a,b].every(v=>Array.isArray(v)&&v.length===3&&v.every(Number.isFinite))) continue;
      const delta=b.map((v,i)=>v-a[i]);
      if (Math.hypot(...delta)<EPSILON) continue;
      const axis=norm(delta), u=norm(cross(axis,Math.abs(axis[2])<.9?[0,0,1]:[0,1,0])), v=cross(axis,u);
      const radial=t=>u.map((n,i)=>n*Math.cos(t)+v[i]*Math.sin(t));
      const point=(c,t)=>radial(t).map((n,i)=>c[i]+radius*n);
      for(let i=0;i<count;i++) {
        const t0=i*TAU/count,t1=(i+1)*TAU/count,n=radial((t0+t1)/2);
        const ua=uv.uMin+(uv.uMax-uv.uMin)*i/count,ub=uv.uMin+(uv.uMax-uv.uMin)*(i+1)/count;
        this.addQuad(point(a,t0),point(a,t1),point(b,t1),point(b,t0),n,
          [ua,uv.vMin],[ub,uv.vMin],[ub,uv.vMax],[ua,uv.vMax]);
        this.addTriangle(a,point(a,t1),point(a,t0),axis.map(n=>-n),[ua,uv.vMin],[ub,uv.vMax],[ua,uv.vMax]);
        this.addTriangle(b,point(b,t0),point(b,t1),axis,[ua,uv.vMin],[ua,uv.vMax],[ub,uv.vMax]);
      }
    }
  }

  addWallSegment({ start, end, normal, zFloor, zCeiling, uv, startFraction = 0, endFraction = 1, course = null }) {
    // `course` is the opt-in facade-material tiling contract (see
    // addCoursedWallSegment). Null — every direct renderer consumer, and
    // every facade material that sets none of the new texture options —
    // keeps the historical path below byte-for-byte.
    if (course && typeof course === 'object') {
      this.addCoursedWallSegment({ start, end, normal, zFloor, zCeiling, uv, startFraction, endFraction, course });
      return;
    }
    const uStart = uv.uMin + (uv.uMax - uv.uMin) * startFraction;
    const uEnd = uv.uMin + (uv.uMax - uv.uMin) * endFraction;
    const span = Math.abs(zFloor - zCeiling);
    if (span <= 1 + EPSILON) {
      this.addQuad(
        [start[0], start[1], zFloor],
        [end[0], end[1], zFloor],
        [end[0], end[1], zCeiling],
        [start[0], start[1], zCeiling],
        normal,
        [uStart, uv.vMax], [uEnd, uv.vMax], [uEnd, uv.vMin], [uStart, uv.vMin]
      );
      return;
    }

    // A wall taller than one unit is laid in unit courses so the atlas tile
    // tiles up it instead of stretching; the top course is cut to fit and
    // samples the lower fraction of the tile, like a course cut at the
    // ceiling line. Spans of one unit or less keep the single-quad path
    // above, so authored features (boxes, sub-unit bands) are bit-identical.
    const direction = zCeiling < zFloor ? -1 : 1;
    let bottom = zFloor;
    let remaining = span;
    while (remaining > EPSILON) {
      const courseHeight = Math.min(1, remaining);
      const top = bottom + direction * courseHeight;
      const vTop = uv.vMax - (uv.vMax - uv.vMin) * courseHeight;
      this.addQuad(
        [start[0], start[1], bottom],
        [end[0], end[1], bottom],
        [end[0], end[1], top],
        [start[0], start[1], top],
        normal,
        [uStart, uv.vMax], [uEnd, uv.vMax], [uEnd, vTop], [uStart, vTop]
      );
      bottom = top;
      remaining -= courseHeight;
    }
  }

  /**
   * The opt-in coursed wall (facade texture options courseHeight /
   * courseVariation, and style 'street''s doorEvery). Reached only when a box
   * feature carries a `course` record — never by direct renderer consumers,
   * whose walls keep the historical one-unit-course path in addWallSegment.
   *
   *  - course.height: the atlas tile spans this many grid units VERTICALLY,
   *    so one tile can bake several distinct storeys before repeating.
   *    Courses shorter than a full tile (the cut top course, or a low podium)
   *    crop the LOWER fraction of the tile rather than stretching it, so
   *    storeys keep their proportions.
   *  - course.width: the tile spans this many grid units HORIZONTALLY, keyed
   *    on each face's world coordinate along its own axis, so a pattern wider
   *    than one cell (a shopfront with a door every N units) stays
   *    phase-continuous across the 1-unit faces of adjacent cells.
   *  - course.variation (0..1): each course's U is additionally offset by a
   *    hash of its course index, quantized to WHOLE window columns
   *    (course.columns), so stacked storeys stop repeating the identical lit
   *    stamp. The strength scales how far the hash may shift.
   *
   * A shifted or world-keyed U window can cross the tile's edge, and the
   * atlas is shared — sampling past uMax bleeds into the neighbouring
   * material — so addCourseQuad splits each course at whole-tile seams
   * instead of relying on sampler wrap.
   */
  addCoursedWallSegment({ start, end, normal, zFloor, zCeiling, uv, startFraction, endFraction, course }) {
    const courseSpan = Number.isFinite(course.height) && course.height > EPSILON ? course.height : 1;
    const variation = clamp(finiteOr(course.variation, 0), 0, 1);
    const courseWidth = Number.isFinite(course.width) && course.width > EPSILON ? course.width : 1;
    const columns = Math.max(1, Math.round(finiteOr(course.columns, 4)));
    const seed = finiteOr(course.seed, 1) | 0;
    const span = Math.abs(zFloor - zCeiling);
    if (span <= EPSILON) return;
    const direction = zCeiling < zFloor ? -1 : 1;
    const vWidth = uv.vMax - uv.vMin;

    // Base U window in unwrapped tile fractions. courseWidth === 1 keeps the
    // legacy meaning (the caller's fractions OF THE TILE, whole tile per box
    // face); wider tiles key the window on world position along the face.
    let f0 = startFraction;
    let f1 = endFraction;
    if (courseWidth !== 1) {
      const axisIsX = Math.abs(end[0] - start[0]) >= Math.abs(end[1] - start[1]);
      f0 = (axisIsX ? start[0] : start[1]) / courseWidth;
      f1 = (axisIsX ? end[0] : end[1]) / courseWidth;
    }

    let bottom = zFloor;
    let remaining = span;
    let courseIndex = 0;
    while (remaining > EPSILON && courseIndex < 4096) {
      const courseHeight = Math.min(courseSpan, remaining);
      const top = bottom + direction * courseHeight;
      const vTop = uv.vMax - vWidth * (courseHeight / courseSpan);
      let offset = 0;
      if (variation > 0) {
        offset = (Math.floor(courseHash(courseIndex, seed) * columns * variation) % columns) / columns;
      }
      this.addCourseQuad(start, end, normal, bottom, top, uv, vTop, f0 + offset, f1 + offset);
      bottom = top;
      remaining -= courseHeight;
      courseIndex++;
    }
  }

  /**
   * One course quad whose U window [g0..g1] lives in unwrapped tile
   * fractions, emitted as sub-quads split at every whole-tile seam so the
   * sampled U never leaves this material's atlas rect.
   */
  addCourseQuad(start, end, normal, bottom, top, uv, vTop, g0, g1) {
    if (!(Math.abs(g1 - g0) > 1e-9)) return;
    const uWidth = uv.uMax - uv.uMin;
    const lo = Math.min(g0, g1);
    const hi = Math.max(g0, g1);
    const seams = [];
    for (let s = Math.ceil(lo - EPSILON); s <= Math.floor(hi + EPSILON); s++) {
      if (s > lo + EPSILON && s < hi - EPSILON) seams.push(s);
    }
    if (g1 < g0) seams.reverse();
    const stops = [g0, ...seams, g1];
    for (let i = 0; i < stops.length - 1; i++) {
      const ga = stops[i];
      const gb = stops[i + 1];
      const ta = (ga - g0) / (g1 - g0);
      const tb = (gb - g0) / (g1 - g0);
      const pa = pointAt(start, end, ta);
      const pb = pointAt(start, end, tb);
      // The span midpoint decides which whole-tile copy this sub-quad lives
      // in; both ends then land inside [uMin, uMax] by construction. The
      // clamp only absorbs float error at a seam endpoint — without it a
      // sub-texel excursion past the rect samples the neighbouring
      // material's edge texels, since the atlas is shared.
      const base = Math.floor((ga + gb) * 0.5);
      const ua = clamp(uv.uMin + (ga - base) * uWidth, uv.uMin, uv.uMax);
      const ub = clamp(uv.uMin + (gb - base) * uWidth, uv.uMin, uv.uMax);
      this.addQuad(
        [pa[0], pa[1], bottom],
        [pb[0], pb[1], bottom],
        [pb[0], pb[1], top],
        [pa[0], pa[1], top],
        normal,
        [ua, uv.vMax], [ub, uv.vMax], [ub, vTop], [ua, vTop]
      );
    }
  }

  addArcWall({ center, radius, startAngle, endAngle, segments, zFloor, zCeiling, uv, normalDirection = 1 }) {
    const safeRadius = Math.max(EPSILON, finiteOr(radius, 0));
    const safeSegments = clamp(Math.floor(finiteOr(segments, 6)), 3, 64);
    const span = endAngle - startAngle;
    if (safeRadius <= EPSILON || Math.abs(span) <= EPSILON) return;

    for (let index = 0; index < safeSegments; index++) {
      const startProgress = index / safeSegments;
      const endProgress = (index + 1) / safeSegments;
      const angleA = startAngle + span * startProgress;
      const angleB = startAngle + span * endProgress;
      const middle = (angleA + angleB) * 0.5;
      const start = [center[0] + Math.cos(angleA) * safeRadius, center[1] + Math.sin(angleA) * safeRadius];
      const end = [center[0] + Math.cos(angleB) * safeRadius, center[1] + Math.sin(angleB) * safeRadius];
      const normal = [Math.cos(middle) * normalDirection, Math.sin(middle) * normalDirection, 0];

      this.addWallSegment({
        start,
        end,
        normal,
        zFloor,
        zCeiling,
        uv,
        startFraction: startProgress,
        endFraction: endProgress
      });
    }
  }

  addFloorTile(x, y, z, normal, uv, ceiling = false) {
    if (ceiling) {
      this.addQuad(
        [x, y, z], [x + 1, y, z], [x + 1, y + 1, z], [x, y + 1, z],
        normal,
        [uv.uMin, uv.vMin], [uv.uMax, uv.vMin], [uv.uMax, uv.vMax], [uv.uMin, uv.vMax]
      );
      return;
    }

    this.addQuad(
      [x, y + 1, z], [x + 1, y + 1, z], [x + 1, y, z], [x, y, z],
      normal,
      [uv.uMin, uv.vMax], [uv.uMax, uv.vMax], [uv.uMax, uv.vMin], [uv.uMin, uv.vMin]
    );
  }

  addCornerFill({ outerCorner, center, radius, startAngle, endAngle, segments, z, normal, uv }) {
    const safeSegments = clamp(Math.floor(finiteOr(segments, 6)), 3, 64);
    const span = endAngle - startAngle;
    for (let index = 0; index < safeSegments; index++) {
      const startProgress = index / safeSegments;
      const endProgress = (index + 1) / safeSegments;
      const angleA = startAngle + span * startProgress;
      const angleB = startAngle + span * endProgress;
      const pointA = [center[0] + Math.cos(angleA) * radius, center[1] + Math.sin(angleA) * radius, z];
      const pointB = [center[0] + Math.cos(angleB) * radius, center[1] + Math.sin(angleB) * radius, z];

      this.addTriangle(
        [outerCorner[0], outerCorner[1], z],
        pointA,
        pointB,
        normal,
        [uv.uMax, uv.vMin],
        [uv.uMin + (uv.uMax - uv.uMin) * startProgress, uv.vMax],
        [uv.uMin + (uv.uMax - uv.uMin) * endProgress, uv.vMax]
      );
    }
  }

  addRing({ center, innerRadius, outerRadius, startAngle = 0, endAngle = TAU, segments = 12, z, normal, uv }) {
    const inner = Math.max(0, finiteOr(innerRadius, 0));
    const outer = Math.max(inner + EPSILON, finiteOr(outerRadius, 0));
    const safeSegments = clamp(Math.floor(finiteOr(segments, 12)), 3, 96);
    const span = endAngle - startAngle;
    if (Math.abs(span) <= EPSILON) return;

    for (let index = 0; index < safeSegments; index++) {
      const startProgress = index / safeSegments;
      const endProgress = (index + 1) / safeSegments;
      const angleA = startAngle + span * startProgress;
      const angleB = startAngle + span * endProgress;
      const outerA = [center[0] + Math.cos(angleA) * outer, center[1] + Math.sin(angleA) * outer, z];
      const outerB = [center[0] + Math.cos(angleB) * outer, center[1] + Math.sin(angleB) * outer, z];
      const innerB = [center[0] + Math.cos(angleB) * inner, center[1] + Math.sin(angleB) * inner, z];
      const innerA = [center[0] + Math.cos(angleA) * inner, center[1] + Math.sin(angleA) * inner, z];
      const uA = uv.uMin + (uv.uMax - uv.uMin) * startProgress;
      const uB = uv.uMin + (uv.uMax - uv.uMin) * endProgress;

      this.addQuad(
        outerA, outerB, innerB, innerA, normal,
        [uA, uv.vMin], [uB, uv.vMin], [uB, uv.vMax], [uA, uv.vMax]
      );
    }
  }

  addSplineWall({ points, segments = 16, zFloor, zCeiling, uv, normalDirection = 1 }) {
    const curvePoints = validCurvePoints(points);
    if (curvePoints.length < 2) return;
    const safeSegments = clamp(Math.floor(finiteOr(segments, 16)), 2, 96);

    for (let index = 0; index < safeSegments; index++) {
      const startProgress = index / safeSegments;
      const endProgress = (index + 1) / safeSegments;
      const start = sampleCurve(curvePoints, startProgress);
      const end = sampleCurve(curvePoints, endProgress);
      const dx = end[0] - start[0];
      const dy = end[1] - start[1];
      const length = Math.hypot(dx, dy);
      if (length <= EPSILON) continue;

      this.addWallSegment({
        start,
        end,
        normal: [dy / length * normalDirection, -dx / length * normalDirection, 0],
        zFloor,
        zCeiling,
        uv,
        startFraction: startProgress,
        endFraction: endProgress
      });
    }
  }

  addSplineRibbon({ points, width, segments = 16, z, normal, uv }) {
    const curvePoints = validCurvePoints(points);
    const safeWidth = Math.max(EPSILON, finiteOr(width, 0));
    if (curvePoints.length < 2 || safeWidth <= EPSILON) return;
    const safeSegments = clamp(Math.floor(finiteOr(segments, 16)), 2, 96);
    const halfWidth = safeWidth * 0.5;

    const edgeAt = progress => {
      const point = sampleCurve(curvePoints, progress);
      const before = sampleCurve(curvePoints, Math.max(0, progress - 0.002));
      const after = sampleCurve(curvePoints, Math.min(1, progress + 0.002));
      const dx = after[0] - before[0];
      const dy = after[1] - before[1];
      const length = Math.hypot(dx, dy) || 1;
      const offsetX = dy / length * halfWidth;
      const offsetY = -dx / length * halfWidth;
      return {
        left: [point[0] + offsetX, point[1] + offsetY, z],
        right: [point[0] - offsetX, point[1] - offsetY, z]
      };
    };

    for (let index = 0; index < safeSegments; index++) {
      const startProgress = index / safeSegments;
      const endProgress = (index + 1) / safeSegments;
      const start = edgeAt(startProgress);
      const end = edgeAt(endProgress);
      const uStart = uv.uMin + (uv.uMax - uv.uMin) * startProgress;
      const uEnd = uv.uMin + (uv.uMax - uv.uMin) * endProgress;
      this.addQuad(
        start.left, end.left, end.right, start.right, normal,
        [uStart, uv.vMin], [uEnd, uv.vMin], [uEnd, uv.vMax], [uStart, uv.vMax]
      );
    }
  }

  markVisibilityRange(firstVertex, code, width, height) {
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0 ||
        width * height > 0xffffffff || !Number.isInteger(code) || code <= 0 || code > width * height) return;
    if (this.visibilityCells && (this.visibilityMapWidth !== width || this.visibilityMapHeight !== height)) return;
    // Keep declared cells before interpolation and position quantization.
    // Capacity includes an unused tail, which must remain zero for later props.
    if (!this.visibilityCells) {
      const CellArray = width * height <= 65535 ? Uint16Array : Uint32Array;
      this.visibilityCells = new CellArray(this.vertices.length / 8);
      this.visibilityMapWidth = width;
      this.visibilityMapHeight = height;
    }
    this.visibilityCells.fill(code, firstVertex, this.vertexFloatCount / 8);
  }

  addBox({ center, sizeX, sizeY, zMin, zMax, uv, course = null, visibilityFaces = null }) {
    const halfX = Math.max(EPSILON, finiteOr(sizeX, 0)) * 0.5;
    const halfY = Math.max(EPSILON, finiteOr(sizeY, 0)) * 0.5;
    const lowZ = Math.min(finiteOr(zMin, -0.5), finiteOr(zMax, 0.5));
    const highZ = Math.max(finiteOr(zMin, -0.5), finiteOr(zMax, 0.5));
    if (halfX <= EPSILON || halfY <= EPSILON || highZ - lowZ <= EPSILON) return;
    const x0 = center[0] - halfX;
    const x1 = center[0] + halfX;
    const y0 = center[1] - halfY;
    const y1 = center[1] + halfY;

    let firstVertex = this.vertexFloatCount / 8;
    this.addWallSegment({ start: [x0, y0], end: [x1, y0], normal: [0, -1, 0], zFloor: highZ, zCeiling: lowZ, uv, course });
    if (visibilityFaces) this.markVisibilityRange(firstVertex, visibilityFaces.codes?.[0], visibilityFaces.width, visibilityFaces.height);
    firstVertex = this.vertexFloatCount / 8;
    this.addWallSegment({ start: [x1, y0], end: [x1, y1], normal: [1, 0, 0], zFloor: highZ, zCeiling: lowZ, uv, course });
    if (visibilityFaces) this.markVisibilityRange(firstVertex, visibilityFaces.codes?.[1], visibilityFaces.width, visibilityFaces.height);
    firstVertex = this.vertexFloatCount / 8;
    this.addWallSegment({ start: [x1, y1], end: [x0, y1], normal: [0, 1, 0], zFloor: highZ, zCeiling: lowZ, uv, course });
    if (visibilityFaces) this.markVisibilityRange(firstVertex, visibilityFaces.codes?.[2], visibilityFaces.width, visibilityFaces.height);
    firstVertex = this.vertexFloatCount / 8;
    this.addWallSegment({ start: [x0, y1], end: [x0, y0], normal: [-1, 0, 0], zFloor: highZ, zCeiling: lowZ, uv, course });
    if (visibilityFaces) this.markVisibilityRange(firstVertex, visibilityFaces.codes?.[3], visibilityFaces.width, visibilityFaces.height);
    this.addQuad(
      [x0, y0, lowZ], [x1, y0, lowZ], [x1, y1, lowZ], [x0, y1, lowZ],
      [0, 0, 1],
      [uv.uMin, uv.vMin], [uv.uMax, uv.vMin], [uv.uMax, uv.vMax], [uv.uMin, uv.vMax]
    );
    this.addQuad(
      [x0, y1, highZ], [x1, y1, highZ], [x1, y0, highZ], [x0, y0, highZ],
      [0, 0, -1],
      [uv.uMin, uv.vMax], [uv.uMax, uv.vMax], [uv.uMax, uv.vMin], [uv.uMin, uv.vMin]
    );
  }

  addEllipseWall({ center, radiusX, radiusY, startAngle = 0, endAngle = TAU, segments = 24, zFloor, zCeiling, uv, normalDirection = 1 }) {
    const safeRadiusX = Math.max(EPSILON, finiteOr(radiusX, 0));
    const safeRadiusY = Math.max(EPSILON, finiteOr(radiusY, 0));
    const safeSegments = clamp(Math.floor(finiteOr(segments, 24)), 4, 96);
    const span = endAngle - startAngle;
    if (Math.abs(span) <= EPSILON) return;

    for (let index = 0; index < safeSegments; index++) {
      const startProgress = index / safeSegments;
      const endProgress = (index + 1) / safeSegments;
      const angleA = startAngle + span * startProgress;
      const angleB = startAngle + span * endProgress;
      const middle = (angleA + angleB) * 0.5;
      const start = [center[0] + Math.cos(angleA) * safeRadiusX, center[1] + Math.sin(angleA) * safeRadiusY];
      const end = [center[0] + Math.cos(angleB) * safeRadiusX, center[1] + Math.sin(angleB) * safeRadiusY];
      const nx = Math.cos(middle) / safeRadiusX;
      const ny = Math.sin(middle) / safeRadiusY;
      const normalLength = Math.hypot(nx, ny) || 1;
      this.addWallSegment({
        start,
        end,
        normal: [nx / normalLength * normalDirection, ny / normalLength * normalDirection, 0],
        zFloor,
        zCeiling,
        uv,
        startFraction: startProgress,
        endFraction: endProgress
      });
    }
  }

  addEllipseBand({ center, innerRadiusX, innerRadiusY, outerRadiusX, outerRadiusY, startAngle = 0, endAngle = TAU, segments = 24, z, normal, uv }) {
    const innerX = Math.max(0, finiteOr(innerRadiusX, 0));
    const innerY = Math.max(0, finiteOr(innerRadiusY, 0));
    const outerX = Math.max(innerX + EPSILON, finiteOr(outerRadiusX, 0));
    const outerY = Math.max(innerY + EPSILON, finiteOr(outerRadiusY, 0));
    const safeSegments = clamp(Math.floor(finiteOr(segments, 24)), 4, 96);
    const span = endAngle - startAngle;
    if (Math.abs(span) <= EPSILON) return;

    for (let index = 0; index < safeSegments; index++) {
      const progressA = index / safeSegments;
      const progressB = (index + 1) / safeSegments;
      const angleA = startAngle + span * progressA;
      const angleB = startAngle + span * progressB;
      const point = (angle, radiusX, radiusY) => [center[0] + Math.cos(angle) * radiusX, center[1] + Math.sin(angle) * radiusY, z];
      const uA = uv.uMin + (uv.uMax - uv.uMin) * progressA;
      const uB = uv.uMin + (uv.uMax - uv.uMin) * progressB;
      this.addQuad(
        point(angleA, outerX, outerY), point(angleB, outerX, outerY),
        point(angleB, innerX, innerY), point(angleA, innerX, innerY), normal,
        [uA, uv.vMin], [uB, uv.vMin], [uB, uv.vMax], [uA, uv.vMax]
      );
    }
  }

  toMesh() {
    // Return independently owned, exact-sized storage so spare capacity
    // cannot alter the eight-float stride, draw count or retained bytes.
    const vertices = this.vertices.slice(0, this.vertexFloatCount);
    return {
      vertices, vertexCount: vertices.length / 8, atlasSlots: takeAddressedAtlasSlots(),
      ...(this.visibilityCells ? {
        visibilityCells: this.visibilityCells.slice(0, this.vertexFloatCount / 8),
        visibilityMapWidth: this.visibilityMapWidth,
        visibilityMapHeight: this.visibilityMapHeight
      } : {})
    };
  }
}

export default class SceneGeometry {
  constructor(options = {}) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
    this.features = [];
  }

  /**
   * Opt-in fragment caching for grids that change a few cells at a time.
   *
   * With it on, buildGrid builds each wall cell, the floor layer and each
   * feature into a cached fragment keyed by exactly what it depends on (a
   * wall cell: itself and its four neighbours; a feature: its own fields), and
   * the mesh is those fragments copied in the original build order. A one-cell
   * edit therefore rebuilds that cell, its neighbours and the floor layer, and
   * copies the rest. The resulting vertex and visibility arrays are identical
   * to an uncached build. Fragments unused by two consecutive builds are
   * dropped. Grids with a ceiling field build uncached. Off by default.
   */
  setFragmentCaching(enabled) {
    this.fragmentCache = enabled === true ? (this.fragmentCache || new Map()) : null;
    this.fragmentGeneration = 0;
    return this;
  }

  fragment(mesh, key, build) {
    let entry = this.fragmentCache.get(key);
    if (!entry) {
      // Capture only the slots this fragment addresses, then put the build's
      // own record back and add them, as the uncached build would have.
      const saved = [...addressedAtlasSlots];
      addressedAtlasSlots.clear();
      const part = new MeshBuilder();
      build(part);
      const slots = [...addressedAtlasSlots];
      addressedAtlasSlots.clear();
      for (const slot of saved) addressedAtlasSlots.add(slot);
      entry = {
        vertices: part.vertices.slice(0, part.vertexFloatCount),
        visibility: part.visibilityCells ? part.visibilityCells.slice(0, part.vertexFloatCount / 8) : null,
        mapWidth: part.visibilityMapWidth,
        mapHeight: part.visibilityMapHeight,
        slots
      };
      this.fragmentCache.set(key, entry);
    }
    entry.generation = this.fragmentGeneration;
    for (const slot of entry.slots) addressedAtlasSlots.add(slot);
    mesh.appendFragment(entry);
  }

  /**
   * One mesh from fragments in order, as toMesh would return it. Consecutive
   * builds mostly share their fragments, so the unchanged run at each end is
   * copied from the previous assembly in one block, and only the middle is
   * gathered fragment by fragment.
   */
  assemble(entries) {
    const last = this.lastAssembly;
    let floats = 0;
    let visibilityType = null, mapWidth = 0, mapHeight = 0;
    const offsets = new Array(entries.length + 1);
    for (let i = 0; i < entries.length; i++) {
      offsets[i] = floats;
      floats += entries[i].vertices.length;
      if (!visibilityType && entries[i].visibility) {
        visibilityType = entries[i].visibility.constructor;
        mapWidth = entries[i].mapWidth;
        mapHeight = entries[i].mapHeight;
      }
    }
    offsets[entries.length] = floats;
    const vertices = new Float32Array(floats);
    const visibility = visibilityType ? new visibilityType(floats / 8) : null;
    const reusable = last && last.visibilityType === visibilityType
      && last.mapWidth === mapWidth && last.mapHeight === mapHeight;
    let head = 0, tail = 0;
    if (reusable) {
      const shorter = Math.min(entries.length, last.entries.length);
      while (head < shorter && entries[head] === last.entries[head]) head++;
      while (tail < shorter - head && entries[entries.length - 1 - tail] === last.entries[last.entries.length - 1 - tail]) tail++;
      const headFloats = offsets[head];
      vertices.set(last.vertices.subarray(0, headFloats), 0);
      if (visibility) visibility.set(last.visibility.subarray(0, headFloats / 8), 0);
      const tailFloats = floats - offsets[entries.length - tail];
      vertices.set(last.vertices.subarray(last.vertices.length - tailFloats), floats - tailFloats);
      if (visibility) visibility.set(last.visibility.subarray(last.visibility.length - tailFloats / 8), (floats - tailFloats) / 8);
    }
    for (let i = head; i < entries.length - tail; i++) {
      const entry = entries[i];
      vertices.set(entry.vertices, offsets[i]);
      if (visibility && entry.visibility && entry.mapWidth === mapWidth && entry.mapHeight === mapHeight) {
        visibility.set(entry.visibility, offsets[i] / 8);
      }
    }
    this.lastAssembly = { entries, vertices, visibility, visibilityType, mapWidth, mapHeight };
    return {
      vertices, vertexCount: floats / 8, atlasSlots: takeAddressedAtlasSlots(),
      ...(visibility ? { visibilityCells: visibility.slice(), visibilityMapWidth: mapWidth, visibilityMapHeight: mapHeight } : {})
    };
  }

  setOptions(options = {}) {
    this.options = { ...this.options, ...options };
    return this;
  }

  setFeatures(features = []) {
    this.features = Array.isArray(features) ? [...features] : [];
    return this;
  }

  buildFeatures(features = [], layout = {}) {
    const cellSize = Math.max(1, finiteOr(layout.cellSize, 64));
    const atlasSize = Math.max(cellSize, finiteOr(layout.atlasSize, 1024));
    const zFloor = finiteOr(layout.zFloor, this.options.zFloor);
    const zCeiling = finiteOr(layout.zCeiling, this.options.zCeiling);
    addressedAtlasSlots.clear();
    const mesh = new MeshBuilder();
    this.appendFeatures(mesh, features, { cellSize, atlasSize, zFloor, zCeiling });
    return mesh.toMesh();
  }

  /**
   * Builds a mesh from a logical grid, which fixes four atlas slots.
   *
   * A grid cell carries a number, not a material, so this has to decide what a
   * number means: slot 4 is the floor, slot 5 the ceiling, slot 6 a corroded
   * tile, slot 7 a cell numbered 5, and every other solid cell N takes slot N-1.
   * That is the whole of the engine's opinion about slot contents, and a world
   * installing its own table with `setStaticMaterialSlots` has to honour those
   * four to use this builder. `buildFeatures` has no such convention - a feature
   * names its own slot - so an authored scene is free of it entirely.
   */
  buildGrid(map, layout = {}) {
    if (!Array.isArray(map) || map.length === 0 || !Array.isArray(map[0]) || map[0].length === 0) {
      return { vertices: new Float32Array(0), vertexCount: 0 };
    }

    const options = { ...this.options, ...layout };
    const height = map.length;
    const width = map[0].length;
    const cellSize = Math.max(1, finiteOr(options.cellSize, 64));
    const atlasSize = Math.max(cellSize, finiteOr(options.atlasSize, 1024));
    const zFloor = finiteOr(options.zFloor, DEFAULT_OPTIONS.zFloor);
    const zCeiling = finiteOr(options.zCeiling, DEFAULT_OPTIONS.zCeiling);
    const cornerRadius = clamp(finiteOr(options.cornerRadius, DEFAULT_OPTIONS.cornerRadius), 0, 0.45);
    const cornerSegments = clamp(Math.floor(finiteOr(options.cornerSegments, DEFAULT_OPTIONS.cornerSegments)), 3, 16);
    const roundedCorners = options.roundedCorners !== false && cornerRadius > EPSILON;
    // Only the lid is at stake. Walls still span floor to ceiling, and the
    // rounded corners still carry their arc up the full height - what goes is
    // the flat tile that caps an open cell and the fill that closes the corner
    // radius against it.
    const ceilings = options.ceilings !== false;
    const corrodedCells = options.corrodedCells;
    const ceilZGrid = options.ceilingField ? resolveCeilingZGrid(map, options.ceilingField, {floorZ:zFloor, ceilingZ:zCeiling}) : null;
    addressedAtlasSlots.clear();
    // Built only where they can be reached, so the slots this grid reports as
    // addressed are the ones it actually samples - a lidless room does not
    // claim the ceiling slot, and a floor with no rot does not claim slot 6.
    const floorUV = makeAtlasUV(4, cellSize, atlasSize);
    const ceilingUV = ceilings ? makeAtlasUV(5, cellSize, atlasSize) : null;
    const corrosionUV = corrodedCells && typeof corrodedCells.has === 'function'
      ? makeAtlasUV(6, cellSize, atlasSize)
      : null;
    const mesh = new MeshBuilder();
    const cellContext = {
      width, height, cellSize, atlasSize, zFloor, zCeiling, ceilZGrid,
      cornerRadius, cornerSegments, roundedCorners, ceilings,
      uv: { floor: () => floorUV, ceiling: () => ceilingUV }
    };

    const cached = this.fragmentCache && !ceilZGrid;
    if (cached) this.fragmentGeneration++;
    // Cached builds collect fragments in build order and assemble them once.
    const target = cached ? new FragmentList() : mesh;
    const contextKey = cached
      ? [width, height, cellSize, atlasSize, zFloor, zCeiling, cornerRadius, cornerSegments, roundedCorners, ceilings].join(',')
      : '';
    const at = (cx, cy) => (cy >= 0 && cy < height && cx >= 0 && cx < width ? String(map[cy][cx]) : '_');

    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        // Cells that build no walls (open, or the reserved 9) skip the key.
        const value = map[y][x];
        if (cached && value > 0 && value !== 9) {
          this.fragment(target, `w|${contextKey}|${x},${y}|${at(x, y)}|${at(x, y - 1)}|${at(x + 1, y)}|${at(x, y + 1)}|${at(x - 1, y)}`,
            part => appendCellWalls(part, map, x, y, cellContext));
        } else {
          appendCellWalls(mesh, map, x, y, cellContext);
        }
      }
    }

    const appendFloors = target => {
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          if (!isOpenCell(map, width, height, x, y) && map[y][x] !== 9) continue;
          const isCorroded = corrodedCells && typeof corrodedCells.has === 'function' && corrodedCells.has(`${x},${y}`);
          target.addFloorTile(x, y, zFloor, [0, 0, -1], isCorroded ? corrosionUV : floorUV);
          if (ceilings) target.addFloorTile(x, y, ceilZGrid ? ceilZGrid[y * width + x] : zCeiling, [0, 0, 1], ceilingUV, true);
        }
      }
    };
    if (cached) {
      // One fragment for the whole floor layer, keyed on which cells are open
      // and which are corroded: rebuilt on any edit that opens or closes a
      // cell, copied otherwise.
      let open = '';
      for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) open += isOpenCell(map, width, height, x, y) || map[y][x] === 9 ? '1' : '0';
      const corroded = corrodedCells && typeof corrodedCells.has === 'function' ? [...corrodedCells].sort().join(';') : '';
      this.fragment(target, `f|${contextKey}|${open}|${corroded}`, appendFloors);
    } else {
      appendFloors(mesh);
    }

    const features = Array.isArray(layout.features) ? layout.features : this.features;
    this.appendFeatures(target, features, { cellSize, atlasSize, zFloor, zCeiling }, cached ? contextKey : null);
    if (cached) {
      for (const [key, entry] of this.fragmentCache) {
        if (this.fragmentGeneration - entry.generation > 1) this.fragmentCache.delete(key);
      }
      return this.assemble(target.entries);
    }
    if (ceilings && ceilZGrid) for (const band of collectClerestoryBands(map, ceilZGrid)) {
      mesh.addWallSegment({start:band.a, end:band.b, normal:band.normal,
        zFloor:band.zBottom, zCeiling:band.zTop, uv:makeAtlasUV(0, cellSize, atlasSize)});
    }
    return mesh.toMesh();
  }

  /**
   * The walls of a chosen handful of cells, and nothing else.
   *
   * Built for the phase shift, where a bulkhead has to be drawn in a call of its
   * own so the dissolve uniform can address it without touching the rest of the
   * facility. The map is still the source of truth for which faces exist - a
   * bulkhead is faced against its neighbours exactly as `buildGrid` faces it -
   * but no floor, no ceiling and no other cell comes with it, because the static
   * mesh is already drawing the room the bulkhead is leaving.
   *
   * `map` is the grid the cells are SOLID in, which for a phase shift is always
   * the Stable one, whichever direction the shift is going. The static mesh is
   * meanwhile drawn from the Void grid for the length of the dissolve, so the
   * two never draw the same bulkhead twice.
   */
  buildCells(map, cells, layout = {}) {
    if (!Array.isArray(map) || map.length === 0 || !Array.isArray(map[0]) || map[0].length === 0 ||
        !Array.isArray(cells) || cells.length === 0) {
      return { vertices: new Float32Array(0), vertexCount: 0, atlasSlots: [] };
    }

    const options = { ...this.options, ...layout };
    const height = map.length;
    const width = map[0].length;
    const cellSize = Math.max(1, finiteOr(options.cellSize, 64));
    const atlasSize = Math.max(cellSize, finiteOr(options.atlasSize, 1024));
    const cornerRadius = clamp(finiteOr(options.cornerRadius, DEFAULT_OPTIONS.cornerRadius), 0, 0.45);
    addressedAtlasSlots.clear();

    // Claimed on demand: a bulkhead sealing a corridor has two opposite faces
    // and so builds no corner wedges, and a mesh that reported the floor slot
    // anyway would make the atlas audit cry wolf on every shift.
    let floorUV = null;
    let ceilingUV = null;
    const cellContext = {
      width,
      height,
      cellSize,
      atlasSize,
      zFloor: finiteOr(options.zFloor, DEFAULT_OPTIONS.zFloor),
      zCeiling: finiteOr(options.zCeiling, DEFAULT_OPTIONS.zCeiling),
      ceilZGrid: options.ceilingField ? resolveCeilingZGrid(map, options.ceilingField, {floorZ:options.zFloor, ceilingZ:options.zCeiling}) : null,
      cornerRadius,
      cornerSegments: clamp(Math.floor(finiteOr(options.cornerSegments, DEFAULT_OPTIONS.cornerSegments)), 3, 16),
      roundedCorners: options.roundedCorners !== false && cornerRadius > EPSILON,
      ceilings: options.ceilings !== false,
      uv: {
        floor: () => (floorUV || (floorUV = makeAtlasUV(4, cellSize, atlasSize))),
        ceiling: () => (ceilingUV || (ceilingUV = makeAtlasUV(5, cellSize, atlasSize)))
      }
    };

    const mesh = new MeshBuilder();
    for (const cell of cells) {
      if (!cell) continue;
      const x = Math.floor(finiteOr(cell.x, -1));
      const y = Math.floor(finiteOr(cell.y, -1));
      if (x < 0 || x >= width || y < 0 || y >= height) continue;
      appendCellWalls(mesh, map, x, y, cellContext);
    }
    return mesh.toMesh();
  }

  appendFeatures(mesh, features, layout, cacheKey = null) {
    if (!Array.isArray(features)) return;

    for (const feature of features) {
      if (!feature || typeof feature !== 'object') continue;
      if (cacheKey !== null && this.fragmentCache) {
        this.fragment(mesh, `x|${cacheKey}|${featureKey(feature)}`, part => this.appendFeatures(part, [feature], layout));
        continue;
      }

      if (feature.type === 'tube') {
        mesh.addTube({points:feature.points, radius:feature.radius, segments:feature.segments,
          uv:makeAtlasUV(featureAtlasIndex(feature, 0), layout.cellSize, layout.atlasSize)});
        continue;
      }
      if (feature.type === 'splineWall') {
        mesh.addSplineWall({
          points: feature.points,
          segments: feature.segments,
          zFloor: finiteOr(feature.zFloor, layout.zFloor),
          zCeiling: finiteOr(feature.zCeiling, layout.zCeiling),
          uv: makeAtlasUV(featureAtlasIndex(feature, 0), layout.cellSize, layout.atlasSize),
          normalDirection: finiteOr(feature.normalDirection, 1)
        });
        continue;
      }

      if (feature.type === 'floorRibbon' || feature.type === 'ceilingRibbon') {
        const isCeiling = feature.type === 'ceilingRibbon';
        mesh.addSplineRibbon({
          points: feature.points,
          width: feature.width,
          segments: feature.segments,
          z: finiteOr(feature.z, isCeiling ? layout.zCeiling + 0.003 : layout.zFloor - 0.003),
          normal: isCeiling ? [0, 0, 1] : [0, 0, -1],
          uv: makeAtlasUV(featureAtlasIndex(feature, isCeiling ? 5 : 4), layout.cellSize, layout.atlasSize)
        });
        continue;
      }

      const center = centerOf(feature);
      if (!center) continue;

      if (feature.type === 'box') {
        mesh.addBox({
          center,
          sizeX: feature.sizeX,
          sizeY: feature.sizeY,
          zMin: feature.zMin,
          zMax: feature.zMax,
          uv: makeAtlasUV(featureAtlasIndex(feature, 0), layout.cellSize, layout.atlasSize),
          // Opt-in facade material tiling (courseHeight/courseVariation/
          // street doorEvery); absent on every feature built before those
          // options existed, which keeps addWallSegment on its legacy path.
          course: feature.course && typeof feature.course === 'object' ? feature.course : null,
          visibilityFaces: feature.visibilityFaces || null
        });
      } else if (feature.type === 'ellipseWall' || feature.type === 'ellipseColumn') {
        mesh.addEllipseWall({
          center,
          radiusX: feature.radiusX,
          radiusY: feature.radiusY,
          startAngle: finiteOr(feature.startAngle, 0),
          endAngle: feature.type === 'ellipseColumn' ? TAU : finiteOr(feature.endAngle, TAU),
          segments: feature.segments,
          zFloor: finiteOr(feature.zFloor, layout.zFloor),
          zCeiling: finiteOr(feature.zCeiling, layout.zCeiling),
          uv: makeAtlasUV(featureAtlasIndex(feature, 0), layout.cellSize, layout.atlasSize),
          normalDirection: finiteOr(feature.normalDirection, 1)
        });
      } else if (feature.type === 'arcWall' || feature.type === 'column') {
        const radius = finiteOr(feature.radius, 0);
        if (radius <= EPSILON) continue;
        const startAngle = finiteOr(feature.startAngle, 0);
        const endAngle = feature.type === 'column' ? TAU : finiteOr(feature.endAngle, TAU);
        mesh.addArcWall({
          center,
          radius,
          startAngle,
          endAngle,
          segments: feature.segments,
          zFloor: finiteOr(feature.zFloor, layout.zFloor),
          zCeiling: finiteOr(feature.zCeiling, layout.zCeiling),
          uv: makeAtlasUV(featureAtlasIndex(feature, 0), layout.cellSize, layout.atlasSize),
          normalDirection: finiteOr(feature.normalDirection, 1)
        });
      } else if (feature.type === 'floorEllipse' || feature.type === 'ceilingEllipse') {
        const isCeiling = feature.type === 'ceilingEllipse';
        mesh.addEllipseBand({
          center,
          innerRadiusX: feature.innerRadiusX,
          innerRadiusY: feature.innerRadiusY,
          outerRadiusX: feature.outerRadiusX,
          outerRadiusY: feature.outerRadiusY,
          startAngle: feature.startAngle,
          endAngle: feature.endAngle,
          segments: feature.segments,
          z: finiteOr(feature.z, isCeiling ? layout.zCeiling + 0.003 : layout.zFloor - 0.003),
          normal: isCeiling ? [0, 0, 1] : [0, 0, -1],
          uv: makeAtlasUV(featureAtlasIndex(feature, isCeiling ? 5 : 4), layout.cellSize, layout.atlasSize)
        });
      } else if (feature.type === 'ring' || feature.type === 'floorRing' || feature.type === 'ceilingRing') {
        const isCeiling = feature.type === 'ceilingRing';
        mesh.addRing({
          center,
          innerRadius: feature.innerRadius,
          outerRadius: feature.outerRadius,
          startAngle: feature.startAngle,
          endAngle: feature.endAngle,
          segments: feature.segments,
          z: finiteOr(feature.z, isCeiling ? layout.zCeiling + 0.003 : layout.zFloor - 0.003),
          normal: isCeiling ? [0, 0, 1] : [0, 0, -1],
          uv: makeAtlasUV(featureAtlasIndex(feature, isCeiling ? 5 : 4), layout.cellSize, layout.atlasSize)
        });
      }
    }
  }
}
