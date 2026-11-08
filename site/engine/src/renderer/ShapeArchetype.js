/**
 * The `shape` archetype: a plain box, ball or cylinder of any size, turned
 * by a full 3D rotation, for physics toys (a crate tumbling, a plank on a
 * seesaw, a barrel rolling on its side). Every other archetype turns only
 * about the vertical axis (`heading`) and scales evenly; this one takes its
 * size and its rotation from `entity.params` on each build, so a game can
 * draw whatever its physics says. Nothing is stored between frames.
 *
 * params (all optional):
 *   kind        'box' (default) | 'ball' | 'cylinder'
 *   sx, sy, sz  full size in renderer cells along the shape's own x, y and z
 *               (default 1 each). A ball uses sx as its diameter; a
 *               cylinder's round section is sx by sy and its length is sz,
 *               along its own z.
 *   qx, qy, qz, qw
 *               the rotation as a unit quaternion in the facade's world axes
 *               (X/Y on the ground, Z up), as a physics engine reports it.
 *               Default identity. A quaternion that is not unit length is
 *               normalised; a zero one is identity.
 *   trim        true (default) draws the details that make a turn visible:
 *               a band round a box, hoops round a cylinder, a stripe round a
 *               ball. false draws the bare shape.
 *
 * Placement differs from the other archetypes in one way, on purpose: the
 * entity's `z` is the height of the shape's CENTRE, not of its feet, because
 * a turned shape has no fixed underside. `heading` is ignored (the rotation
 * says everything). `scale` still multiplies the whole shape about its
 * centre, and `tint` is the usual way to colour each toy: the shape is
 * authored light grey so a tint reads as the colour asked for.
 *
 * Palette hints: █ the body, # the trim.
 */
import { ENTITY_LOD, createMeshBuffer, finishMesh, resolveMaterial } from './EntityGeometry.js';

const num = (v, fallback, min, max) => Math.max(min, Math.min(max, Number.isFinite(v) ? v : fallback));

const BALL_LONGITUDES = { full: 16, simplified: 10 };
const BALL_LATITUDES = { full: 10, simplified: 6 };
const CYLINDER_SIDES = { full: 16, simplified: 10 };
const TRIM = 0.025; // how far trim stands proud of the body, in cells

/** Resolved params with defaults and clamps; exported for tests. */
export function resolveShapeParams(params) {
  const p = params && typeof params === 'object' ? params : {};
  const kind = p.kind === 'ball' || p.kind === 'cylinder' ? p.kind : 'box';
  let qx = Number.isFinite(p.qx) ? p.qx : 0;
  let qy = Number.isFinite(p.qy) ? p.qy : 0;
  let qz = Number.isFinite(p.qz) ? p.qz : 0;
  let qw = Number.isFinite(p.qw) ? p.qw : 1;
  const length = Math.hypot(qx, qy, qz, qw);
  if (length > 1e-9) {
    qx /= length; qy /= length; qz /= length; qw /= length;
  } else {
    qx = 0; qy = 0; qz = 0; qw = 1;
  }
  return {
    kind,
    sx: num(p.sx, 1, 0.02, 64),
    sy: num(p.sy, 1, 0.02, 64),
    sz: num(p.sz, 1, 0.02, 64),
    qx, qy, qz, qw,
    trim: p.trim !== false
  };
}

/** The rotation as a 3x3 matrix, rows first, from a unit quaternion. */
export function shapeRotationMatrix({ qx, qy, qz, qw }) {
  return [
    1 - 2 * (qy * qy + qz * qz), 2 * (qx * qy - qz * qw), 2 * (qx * qz + qy * qw),
    2 * (qx * qy + qz * qw), 1 - 2 * (qx * qx + qz * qz), 2 * (qy * qz - qx * qw),
    2 * (qx * qz - qy * qw), 2 * (qy * qz + qx * qw), 1 - 2 * (qx * qx + qy * qy)
  ];
}

/**
 * Emits triangles in the renderer's space from points in the shape's own
 * frame (z up, centred on the origin). The renderer's z runs down with the
 * floor contact at 0.5; the facade's lift then moves that contact to the
 * entity's z, which for this archetype is the centre.
 */
function makeEmitter(vertices, entity, rotation) {
  const [m00, m01, m02, m10, m11, m12, m20, m21, m22] = rotation;
  const ox = entity.x;
  const oy = entity.y;
  const vertex = (x, y, z, nx, ny, nz, material) => {
    const wx = m00 * x + m01 * y + m02 * z;
    const wy = m10 * x + m11 * y + m12 * z;
    const wz = m20 * x + m21 * y + m22 * z;
    const vx = m00 * nx + m01 * ny + m02 * nz;
    const vy = m10 * nx + m11 * ny + m12 * nz;
    const vz = m20 * nx + m21 * ny + m22 * nz;
    const color = material.color;
    vertices.push(
      ox + wx, oy + wy, 0.5 - wz, vx, vy, -vz,
      color[0], color[1], color[2],
      material.roughness, material.emission, material.lightResponse
    );
  };
  // A flat quad a-b-c-d (counter-clockwise seen from outside) with one normal.
  const quad = (a, b, c, d, n, material) => {
    vertex(a[0], a[1], a[2], n[0], n[1], n[2], material);
    vertex(b[0], b[1], b[2], n[0], n[1], n[2], material);
    vertex(c[0], c[1], c[2], n[0], n[1], n[2], material);
    vertex(a[0], a[1], a[2], n[0], n[1], n[2], material);
    vertex(c[0], c[1], c[2], n[0], n[1], n[2], material);
    vertex(d[0], d[1], d[2], n[0], n[1], n[2], material);
  };
  // An axis-aligned box in the shape's frame: centre c, half sizes h.
  const box = (c, h, material) => {
    const x0 = c[0] - h[0], x1 = c[0] + h[0];
    const y0 = c[1] - h[1], y1 = c[1] + h[1];
    const z0 = c[2] - h[2], z1 = c[2] + h[2];
    quad([x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1], [1, 0, 0], material);
    quad([x0, y1, z0], [x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [-1, 0, 0], material);
    quad([x1, y1, z0], [x0, y1, z0], [x0, y1, z1], [x1, y1, z1], [0, 1, 0], material);
    quad([x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1], [0, -1, 0], material);
    quad([x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1], [0, 0, 1], material);
    quad([x0, y1, z0], [x1, y1, z0], [x1, y0, z0], [x0, y0, z0], [0, 0, -1], material);
  };
  return { vertex, quad, box };
}

function buildBox(emit, s, body, trim) {
  const hx = s.sx / 2, hy = s.sy / 2, hz = s.sz / 2;
  emit.box([0, 0, 0], [hx, hy, hz], body);
  if (!s.trim) return;
  // A band round the middle and a lip round each end: a crate's straps, and
  // the cue that tells top from side once it has turned over.
  const band = Math.min(0.12, s.sz * 0.12);
  emit.box([0, 0, 0], [hx + TRIM, hy + TRIM, band / 2], trim);
  emit.box([0, 0, hz - band / 2], [hx + TRIM, hy + TRIM, band / 2], trim);
  emit.box([0, 0, -hz + band / 2], [hx + TRIM, hy + TRIM, band / 2], trim);
}

function buildBall(emit, s, body, trim, lod) {
  const r = s.sx / 2;
  const longitudes = BALL_LONGITUDES[lod] ?? BALL_LONGITUDES.full;
  const latitudes = BALL_LATITUDES[lod] ?? BALL_LATITUDES.full;
  const point = (lat, lon) => {
    const theta = (lat / latitudes) * Math.PI; // 0 at +z
    const phi = (lon / longitudes) * Math.PI * 2;
    const st = Math.sin(theta);
    return [st * Math.cos(phi), st * Math.sin(phi), Math.cos(theta)];
  };
  for (let lat = 0; lat < latitudes; lat++) {
    for (let lon = 0; lon < longitudes; lon++) {
      const a = point(lat, lon), b = point(lat + 1, lon), c = point(lat + 1, lon + 1), d = point(lat, lon + 1);
      // A stripe through the poles, a quarter of the way round: a rolling ball
      // shows it turning, which a plain sphere cannot.
      const striped = s.trim && (lon === 0 || lon === longitudes / 2);
      const material = striped ? trim : body;
      // On a unit sphere a point is its own normal.
      const tri = (p, q, w) => {
        for (const v of [p, q, w]) emit.vertex(v[0] * r, v[1] * r, v[2] * r, v[0], v[1], v[2], material);
      };
      if (lat > 0) tri(a, b, d);
      if (lat < latitudes - 1) tri(b, c, d);
    }
  }
}

function buildCylinder(emit, s, body, trim, lod) {
  const rx = s.sx / 2, ry = s.sy / 2, hz = s.sz / 2;
  const sides = CYLINDER_SIDES[lod] ?? CYLINDER_SIDES.full;
  const ring = (k, grow = 0) => {
    const phi = (k / sides) * Math.PI * 2;
    return [Math.cos(phi) * (rx + grow), Math.sin(phi) * (ry + grow), Math.cos(phi), Math.sin(phi)];
  };
  const wall = (z0, z1, grow, material) => {
    for (let k = 0; k < sides; k++) {
      const p = ring(k, grow), q = ring(k + 1, grow);
      const n0 = [p[2], p[3], 0], n1 = [q[2], q[3], 0];
      emit.vertex(p[0], p[1], z0, n0[0], n0[1], 0, material);
      emit.vertex(q[0], q[1], z0, n1[0], n1[1], 0, material);
      emit.vertex(q[0], q[1], z1, n1[0], n1[1], 0, material);
      emit.vertex(p[0], p[1], z0, n0[0], n0[1], 0, material);
      emit.vertex(q[0], q[1], z1, n1[0], n1[1], 0, material);
      emit.vertex(p[0], p[1], z1, n0[0], n0[1], 0, material);
    }
  };
  wall(-hz, hz, 0, body);
  for (const [z, nz] of [[hz, 1], [-hz, -1]]) {
    for (let k = 0; k < sides; k++) {
      const p = ring(nz > 0 ? k : k + 1), q = ring(nz > 0 ? k + 1 : k);
      emit.vertex(0, 0, z, 0, 0, nz, body);
      emit.vertex(p[0], p[1], z, 0, 0, nz, body);
      emit.vertex(q[0], q[1], z, 0, 0, nz, body);
    }
  }
  if (!s.trim) return;
  // Hoops at a quarter and three quarters of the length, and a mark across
  // one end so a barrel rolling on its side shows the turn.
  const hoop = Math.min(0.08, s.sz * 0.08);
  for (const at of [-hz / 2, hz / 2]) wall(at - hoop / 2, at + hoop / 2, TRIM, trim);
  emit.box([0, 0, hz + TRIM / 2], [rx * 0.8, Math.min(rx, ry) * 0.12, TRIM / 2], trim);
}

export function buildShapeMesh(entity, currentTime = 0, lod = ENTITY_LOD.FULL, options = {}) {
  const vertices = createMeshBuffer();
  const s = resolveShapeParams(entity.params);
  const rotation = shapeRotationMatrix(s);
  const emit = makeEmitter(vertices, entity, rotation);
  const body = resolveMaterial(entity, { color: [0.78, 0.78, 0.76], roughness: 0.8, emission: 0.18, lightResponse: 0.62 }, options, 0.5);
  const trim = resolveMaterial(entity, { color: [0.46, 0.45, 0.43], roughness: 0.85, emission: 0.14, lightResponse: 0.5 }, options, 0.5, 0.5, '#');
  const tier = lod === ENTITY_LOD.SIMPLIFIED ? 'simplified' : 'full';
  if (s.kind === 'ball') buildBall(emit, s, body, trim, tier);
  else if (s.kind === 'cylinder') buildCylinder(emit, s, body, trim, tier);
  else buildBox(emit, s, body, trim);
  return finishMesh(vertices, lod, { archetype: 'shape', state: null, chassis: `shape-${s.kind}` });
}
