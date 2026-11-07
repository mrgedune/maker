/**
 * The primitives every entity mesh is built out of, and the batching pass that
 * packs the built meshes into one vertex buffer.
 *
 * What is built is not here. The roster, the creatures, the props and the
 * palette they are coloured from moved to `world/WorldEntityMeshes.js` and come
 * back through `AsciiRendererWebGL#setEntityContent`; with nothing installed,
 * the pass below draws nothing rather than inventing a bestiary.
 *
 * This path is load-bearing: Creature Studio writes it into the import header
 * of every builder it generates, so the primitives keep both this address and
 * these names.
 */

import { applyAsciiDerez } from './AsciiDerez.js';
import { WORLD_CEILING_CLEARING_LIFT } from './WorldZ.js';

export const ENTITY_VERTEX_STRIDE = 12;

export const ENTITY_LOD = Object.freeze({
  FULL: 'full',
  SIMPLIFIED: 'simplified',
  BILLBOARD: 'billboard'
});

export const ENTITY_LOD_DISTANCES = Object.freeze({
  full: 12,
  simplified: 19
});

/**
 * Give a builder's authored material to the frame's color resolver, if one is
 * installed, and apply what comes back.
 *
 * The resolver may return, all fields optional:
 *   r, g, b          — replacement color, 0-255 (all three or none).
 *   emission,
 *   roughness,
 *   lightResponse    — replacement material scalars, applied verbatim to the
 *                      per-vertex material floats the G-buffer receives. This
 *                      is what lets a facade palette drop a body out of the
 *                      deferred pass's binary emissive branch (lightFS keys it
 *                      on `isSelfLuminous > 0.95`): authored emission 1 takes
 *                      the pure-emissive path, palette emission 0.15 exits it
 *                      into the lit path with a faint self-glow floor.
 *   exact            — true skips the brightness rescue below, so a palette
 *                      states its colors exactly. Absent (every sprite-template
 *                      resolver predating the field) keeps the rescue.
 *
 * The authored material rides along as a fifth resolver argument so a resolver
 * can key on what it is overriding (the facade's accent rule reads the
 * authored emission). Resolvers written before that argument existed ignore
 * it; a resolver that returns null/absent fields leaves the material - and
 * every existing consumer's output - byte-identical.
 *
 * `paletteOnly` marks a call site added AFTER games shipped on the resolver:
 * it consults the resolver only when `options.paletteResolver` is true — the
 * flag the facade sets when the installed resolver is a registration's own
 * per-char palette/accent resolver. The renderer's sprite-template resolver
 * (the path Liminal's creatures recolor through) never sets it, so materials
 * that historically bypassed that resolver keep bypassing it and a shipped
 * game's bodies stay byte-identical. A palette without the char is likewise
 * a no-op, so the new hints are opt-in per palette entry.
 */
export function resolveMaterial(entity, material, options = {}, sampleY = 0.5, sampleX = 0.5, char = '█', paletteOnly = false) {
  if (paletteOnly && options.paletteResolver !== true) return material;
  if (typeof options.colorResolver !== 'function') return material;
  const resolved = options.colorResolver(entity, sampleY, sampleX, char, material);
  if (!resolved) return material;
  const hasColor = Number.isFinite(resolved.r) && Number.isFinite(resolved.g) && Number.isFinite(resolved.b);
  const hasEmission = Number.isFinite(resolved.emission);
  const hasRoughness = Number.isFinite(resolved.roughness);
  const hasLightResponse = Number.isFinite(resolved.lightResponse);
  if (!hasColor && !hasEmission && !hasRoughness && !hasLightResponse) return material;
  let color = material.color;
  if (hasColor) {
    color = [resolved.r, resolved.g, resolved.b].map(channel => Math.min(1, Math.max(0, channel / 255)));
    // The brightness rescue: a sprite-template tier tint must not dim a body
    // below its authored peak. A palette resolver opts out with `exact`.
    if (resolved.exact !== true) {
      const resolvedPeak = Math.max(...color);
      const intendedPeak = Math.max(...material.color);
      if (resolvedPeak > 0 && resolvedPeak < intendedPeak) {
        const scale = intendedPeak / resolvedPeak;
        for (let index = 0; index < color.length; index++) color[index] = Math.min(1, color[index] * scale);
      }
    }
  }
  const overridden = {
    ...material,
    color
  };
  if (hasEmission) overridden.emission = resolved.emission;
  if (hasRoughness) overridden.roughness = resolved.roughness;
  if (hasLightResponse) overridden.lightResponse = resolved.lightResponse;
  return overridden;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

/**
 * One vertex, from loose scalars rather than from three little arrays.
 *
 * This replaced a `pushVertex(vertices, position, normal, material)` that read
 * its numbers out of two triples, and the triples were the cost rather than a
 * readability tax worth paying: measured 2026-08-26, the ellipsoid's `sample()`
 * closure allocated five arrays and an object PER VERTEX, and the tapered
 * segment's `.map()` over a freshly built triple allocated two more.
 *
 * THE ARITHMETIC IS UNCHANGED, deliberately and to the bit. Every expression in
 * the primitives below applies the same operations in the same order as the
 * array spelling it replaces - the only thing removed is where the intermediate
 * values were kept, and `1e-16` of reassociation would have been enough to make
 * "byte-identical" untrue. `test/entity_geometry_emit.test.js` holds each
 * primitive against a literal transcription of the old one, over a sweep that
 * includes the near-vertical axis where the segment's reference vector switches.
 */
function emitVertex(vertices, px, py, pz, nx, ny, nz, material) {
  const color = material.color;
  vertices.push(
    px, py, pz, nx, ny, nz,
    color[0], color[1], color[2],
    material.roughness, material.emission, material.lightResponse
  );
}

function addEllipsoid(vertices, center, radii, material, longitudeSegments, latitudeSegments) {
  const centerX = center[0];
  const centerY = center[1];
  const centerZ = center[2];
  const radiusX = radii[0];
  const radiusY = radii[1];
  const radiusZ = radii[2];
  for (let latitude = 0; latitude < latitudeSegments; latitude++) {
    const v0 = latitude / latitudeSegments;
    const v1 = (latitude + 1) / latitudeSegments;
    const phi0 = -Math.PI / 2 + v0 * Math.PI;
    const phi1 = -Math.PI / 2 + v1 * Math.PI;
    const cosPhi0 = Math.cos(phi0);
    const sinPhi0 = Math.sin(phi0);
    const cosPhi1 = Math.cos(phi1);
    const sinPhi1 = Math.sin(phi1);

    for (let longitude = 0; longitude < longitudeSegments; longitude++) {
      const theta0 = (longitude / longitudeSegments) * Math.PI * 2;
      const theta1 = ((longitude + 1) / longitudeSegments) * Math.PI * 2;
      const cosTheta0 = Math.cos(theta0);
      const sinTheta0 = Math.sin(theta0);
      const cosTheta1 = Math.cos(theta1);
      const sinTheta1 = Math.sin(theta1);

      // a = (theta0, phi0)
      let localX = cosPhi0 * cosTheta0;
      let localY = cosPhi0 * sinTheta0;
      let localZ = sinPhi0;
      const aX = centerX + localX * radiusX;
      const aY = centerY + localY * radiusY;
      const aZ = centerZ + localZ * radiusZ;
      let unitX = localX / radiusX;
      let unitY = localY / radiusY;
      let unitZ = localZ / radiusZ;
      let length = Math.hypot(unitX, unitY, unitZ) || 1;
      const aNormalX = unitX / length;
      const aNormalY = unitY / length;
      const aNormalZ = unitZ / length;

      // b = (theta1, phi0)
      localX = cosPhi0 * cosTheta1;
      localY = cosPhi0 * sinTheta1;
      localZ = sinPhi0;
      const bX = centerX + localX * radiusX;
      const bY = centerY + localY * radiusY;
      const bZ = centerZ + localZ * radiusZ;
      unitX = localX / radiusX;
      unitY = localY / radiusY;
      unitZ = localZ / radiusZ;
      length = Math.hypot(unitX, unitY, unitZ) || 1;
      const bNormalX = unitX / length;
      const bNormalY = unitY / length;
      const bNormalZ = unitZ / length;

      // c = (theta1, phi1)
      localX = cosPhi1 * cosTheta1;
      localY = cosPhi1 * sinTheta1;
      localZ = sinPhi1;
      const cX = centerX + localX * radiusX;
      const cY = centerY + localY * radiusY;
      const cZ = centerZ + localZ * radiusZ;
      unitX = localX / radiusX;
      unitY = localY / radiusY;
      unitZ = localZ / radiusZ;
      length = Math.hypot(unitX, unitY, unitZ) || 1;
      const cNormalX = unitX / length;
      const cNormalY = unitY / length;
      const cNormalZ = unitZ / length;

      // d = (theta0, phi1)
      localX = cosPhi1 * cosTheta0;
      localY = cosPhi1 * sinTheta0;
      localZ = sinPhi1;
      const dX = centerX + localX * radiusX;
      const dY = centerY + localY * radiusY;
      const dZ = centerZ + localZ * radiusZ;
      unitX = localX / radiusX;
      unitY = localY / radiusY;
      unitZ = localZ / radiusZ;
      length = Math.hypot(unitX, unitY, unitZ) || 1;
      const dNormalX = unitX / length;
      const dNormalY = unitY / length;
      const dNormalZ = unitZ / length;

      emitVertex(vertices, aX, aY, aZ, aNormalX, aNormalY, aNormalZ, material);
      emitVertex(vertices, bX, bY, bZ, bNormalX, bNormalY, bNormalZ, material);
      emitVertex(vertices, cX, cY, cZ, cNormalX, cNormalY, cNormalZ, material);
      emitVertex(vertices, aX, aY, aZ, aNormalX, aNormalY, aNormalZ, material);
      emitVertex(vertices, cX, cY, cZ, cNormalX, cNormalY, cNormalZ, material);
      emitVertex(vertices, dX, dY, dZ, dNormalX, dNormalY, dNormalZ, material);
    }
  }
}

function addTaperedSegment(vertices, start, end, startRadius, endRadius, material, segments) {
  const startX = start[0];
  const startY = start[1];
  const startZ = start[2];
  const endX = end[0];
  const endY = end[1];
  const endZ = end[2];

  let axisX = endX - startX;
  let axisY = endY - startY;
  let axisZ = endZ - startZ;
  let length = Math.hypot(axisX, axisY, axisZ) || 1;
  axisX /= length;
  axisY /= length;
  axisZ /= length;

  // The reference vector switches when the axis is near-vertical, so that the
  // cross product below never degenerates. Same threshold, same two vectors.
  const upright = Math.abs(axisZ) < 0.82;
  const referenceX = upright ? 0 : 1;
  const referenceY = 0;
  const referenceZ = upright ? 1 : 0;

  let tangentX = axisY * referenceZ - axisZ * referenceY;
  let tangentY = axisZ * referenceX - axisX * referenceZ;
  let tangentZ = axisX * referenceY - axisY * referenceX;
  length = Math.hypot(tangentX, tangentY, tangentZ) || 1;
  tangentX /= length;
  tangentY /= length;
  tangentZ /= length;

  let bitangentX = axisY * tangentZ - axisZ * tangentY;
  let bitangentY = axisZ * tangentX - axisX * tangentZ;
  let bitangentZ = axisX * tangentY - axisY * tangentX;
  length = Math.hypot(bitangentX, bitangentY, bitangentZ) || 1;
  bitangentX /= length;
  bitangentY /= length;
  bitangentZ /= length;

  const sideSlope = startRadius - endRadius;

  for (let index = 0; index < segments; index++) {
    const angle0 = (index / segments) * Math.PI * 2;
    const angle1 = ((index + 1) / segments) * Math.PI * 2;
    const cos0 = Math.cos(angle0);
    const sin0 = Math.sin(angle0);
    const cos1 = Math.cos(angle1);
    const sin1 = Math.sin(angle1);

    const startCos0 = cos0 * startRadius;
    const startSin0 = sin0 * startRadius;
    const startCos1 = cos1 * startRadius;
    const startSin1 = sin1 * startRadius;
    const endCos1 = cos1 * endRadius;
    const endSin1 = sin1 * endRadius;
    const endCos0 = cos0 * endRadius;
    const endSin0 = sin0 * endRadius;

    const aX = startX + tangentX * startCos0 + bitangentX * startSin0;
    const aY = startY + tangentY * startCos0 + bitangentY * startSin0;
    const aZ = startZ + tangentZ * startCos0 + bitangentZ * startSin0;
    const bX = startX + tangentX * startCos1 + bitangentX * startSin1;
    const bY = startY + tangentY * startCos1 + bitangentY * startSin1;
    const bZ = startZ + tangentZ * startCos1 + bitangentZ * startSin1;
    const cX = endX + tangentX * endCos1 + bitangentX * endSin1;
    const cY = endY + tangentY * endCos1 + bitangentY * endSin1;
    const cZ = endZ + tangentZ * endCos1 + bitangentZ * endSin1;
    const dX = endX + tangentX * endCos0 + bitangentX * endSin0;
    const dY = endY + tangentY * endCos0 + bitangentY * endSin0;
    const dZ = endZ + tangentZ * endCos0 + bitangentZ * endSin0;

    let normal0X = 0 + tangentX * cos0 + bitangentX * sin0;
    let normal0Y = 0 + tangentY * cos0 + bitangentY * sin0;
    let normal0Z = 0 + tangentZ * cos0 + bitangentZ * sin0;
    normal0X += axisX * sideSlope;
    normal0Y += axisY * sideSlope;
    normal0Z += axisZ * sideSlope;
    length = Math.hypot(normal0X, normal0Y, normal0Z) || 1;
    normal0X /= length;
    normal0Y /= length;
    normal0Z /= length;

    let normal1X = 0 + tangentX * cos1 + bitangentX * sin1;
    let normal1Y = 0 + tangentY * cos1 + bitangentY * sin1;
    let normal1Z = 0 + tangentZ * cos1 + bitangentZ * sin1;
    normal1X += axisX * sideSlope;
    normal1Y += axisY * sideSlope;
    normal1Z += axisZ * sideSlope;
    length = Math.hypot(normal1X, normal1Y, normal1Z) || 1;
    normal1X /= length;
    normal1Y /= length;
    normal1Z /= length;

    emitVertex(vertices, aX, aY, aZ, normal0X, normal0Y, normal0Z, material);
    emitVertex(vertices, bX, bY, bZ, normal1X, normal1Y, normal1Z, material);
    emitVertex(vertices, cX, cY, cZ, normal1X, normal1Y, normal1Z, material);
    emitVertex(vertices, aX, aY, aZ, normal0X, normal0Y, normal0Z, material);
    emitVertex(vertices, cX, cY, cZ, normal1X, normal1Y, normal1Z, material);
    emitVertex(vertices, dX, dY, dZ, normal0X, normal0Y, normal0Z, material);
  }
}

export function createBasis(entity) {
  const angle = Number.isFinite(entity.angle) ? entity.angle : 0;
  return {
    origin: [entity.x, entity.y, 0],
    forward: [Math.cos(angle), Math.sin(angle), 0],
    right: [-Math.sin(angle), Math.cos(angle), 0]
  };
}

function transformPoint(basis, local) {
  return [
    basis.origin[0] + basis.forward[0] * local[0] + basis.right[0] * local[1],
    basis.origin[1] + basis.forward[1] * local[0] + basis.right[1] * local[1],
    local[2]
  ];
}

export function addLocalEllipsoid(vertices, basis, center, radii, material, longitudeSegments, latitudeSegments) {
  addEllipsoid(vertices, transformPoint(basis, center), radii, material, longitudeSegments, latitudeSegments);
}

export function addLocalSegment(vertices, basis, start, end, startRadius, endRadius, material, segments) {
  addTaperedSegment(
    vertices,
    transformPoint(basis, start),
    transformPoint(basis, end),
    startRadius,
    endRadius,
    material,
    segments
  );
}

export function addJointedLimb(vertices, basis, points, radii, material, segments) {
  for (let index = 0; index < points.length - 1; index++) {
    addLocalSegment(vertices, basis, points[index], points[index + 1], radii[index], radii[index + 1], material, segments);
  }
}

/** The eight transformed corners of the box currently being emitted. Module
 *  scratch rather than eight fresh arrays a box: `addLocalBox` never runs
 *  inside itself, and it is finished with these before it returns. */
const CORNER_SCRATCH_X = new Float64Array(8);
const CORNER_SCRATCH_Y = new Float64Array(8);
const CORNER_SCRATCH_Z = new Float64Array(8);

/** The unit cube's corners and its six faces, hoisted out of `addLocalBox` so
 *  that drawing a box does not first build eight arrays, six arrays and six more
 *  arrays inside them. Read-only; the box reads through them by index. */
const BOX_CORNERS = Object.freeze([
  -1, -1, -1, 1, -1, -1, 1, 1, -1, -1, 1, -1,
  -1, -1, 1, 1, -1, 1, 1, 1, 1, -1, 1, 1
]);
const BOX_FACES = Object.freeze([
  0, 4, 7, 3, -1, 0, 0,
  1, 2, 6, 5, 1, 0, 0,
  0, 1, 5, 4, 0, -1, 0,
  3, 7, 6, 2, 0, 1, 0,
  0, 3, 2, 1, 0, 0, -1,
  4, 5, 6, 7, 0, 0, 1
]);

export function addLocalBox(vertices, basis, center, halfSize, material) {
  const originX = basis.origin[0];
  const originY = basis.origin[1];
  const forwardX = basis.forward[0];
  const forwardY = basis.forward[1];
  const rightX = basis.right[0];
  const rightY = basis.right[1];
  const cornerX = CORNER_SCRATCH_X;
  const cornerY = CORNER_SCRATCH_Y;
  const cornerZ = CORNER_SCRATCH_Z;
  for (let corner = 0; corner < 8; corner++) {
    const localX = center[0] + BOX_CORNERS[corner * 3] * halfSize[0];
    const localY = center[1] + BOX_CORNERS[corner * 3 + 1] * halfSize[1];
    const localZ = center[2] + BOX_CORNERS[corner * 3 + 2] * halfSize[2];
    cornerX[corner] = originX + forwardX * localX + rightX * localY;
    cornerY[corner] = originY + forwardY * localX + rightY * localY;
    cornerZ[corner] = localZ;
  }
  const color = material.color;
  const colorR = color[0];
  const colorG = color[1];
  const colorB = color[2];
  const roughness = material.roughness;
  const emission = material.emission;
  const lightResponse = material.lightResponse;
  for (let face = 0; face < 6; face++) {
    const base = face * 7;
    const a = BOX_FACES[base];
    const b = BOX_FACES[base + 1];
    const c = BOX_FACES[base + 2];
    const d = BOX_FACES[base + 3];
    const localNormalX = BOX_FACES[base + 4];
    const localNormalY = BOX_FACES[base + 5];
    const localNormalZ = BOX_FACES[base + 6];
    // transformDirection, inline: rotate into the basis, then normalise.
    let normalX = forwardX * localNormalX + rightX * localNormalY;
    let normalY = forwardY * localNormalX + rightY * localNormalY;
    let normalZ = localNormalZ;
    const length = Math.hypot(normalX, normalY, normalZ) || 1;
    normalX /= length;
    normalY /= length;
    normalZ /= length;
    vertices.push(cornerX[a], cornerY[a], cornerZ[a], normalX, normalY, normalZ, colorR, colorG, colorB, roughness, emission, lightResponse);
    vertices.push(cornerX[b], cornerY[b], cornerZ[b], normalX, normalY, normalZ, colorR, colorG, colorB, roughness, emission, lightResponse);
    vertices.push(cornerX[c], cornerY[c], cornerZ[c], normalX, normalY, normalZ, colorR, colorG, colorB, roughness, emission, lightResponse);
    vertices.push(cornerX[a], cornerY[a], cornerZ[a], normalX, normalY, normalZ, colorR, colorG, colorB, roughness, emission, lightResponse);
    vertices.push(cornerX[c], cornerY[c], cornerZ[c], normalX, normalY, normalZ, colorR, colorG, colorB, roughness, emission, lightResponse);
    vertices.push(cornerX[d], cornerY[d], cornerZ[d], normalX, normalY, normalZ, colorR, colorG, colorB, roughness, emission, lightResponse);
  }
}

export function addLocalRing(vertices, basis, center, radius, tubeRadius, material, segments, axis = 'z') {
  const point = angle => {
    if (axis === 'x') return [center[0], center[1] + Math.cos(angle) * radius, center[2] + Math.sin(angle) * radius];
    if (axis === 'y') return [center[0] + Math.cos(angle) * radius, center[1], center[2] + Math.sin(angle) * radius];
    return [center[0] + Math.cos(angle) * radius, center[1] + Math.sin(angle) * radius, center[2]];
  };
  const radialSegments = Math.max(4, Math.min(7, Math.floor(segments / 2)));
  for (let index = 0; index < segments; index++) {
    const start = point((index / segments) * Math.PI * 2);
    const end = point(((index + 1) / segments) * Math.PI * 2);
    addLocalSegment(vertices, basis, start, end, tubeRadius, tubeRadius, material, radialSegments);
  }
}

/**
 * Where a mesh is accumulated while it is being built.
 *
 * A builder used to open `const vertices = []` and push twelve doubles a vertex
 * into it, and `finishMesh` converted the whole thing with
 * `new Float32Array(vertices)`. That container was the single most expensive
 * thing on this path - measured 2026-08-26 at **68.8 ns a vertex** for the push
 * and the conversion together, against **2.9 ns** for writing the same twelve
 * floats straight into a preallocated `Float32Array`, and against 28 ns for all
 * the trigonometry in an ellipsoid vertex. A floor-150 roster emits about
 * 186,000 vertices a rebuild, so the container alone was costing 13 ms of a
 * 33 ms slot to hold numbers on their way to a buffer of exactly this type.
 *
 * The class duck-types `Array#push` on purpose. Every primitive in this file,
 * every builder in `world/WorldEntityMeshes.js`, everything Creature Studio
 * generates and everything `studio/CreatureCompiler.js` compiles reaches its
 * vertices through `.push(...twelve)` and none of them has to know which
 * container it is holding - a plain array still works and still finishes
 * correctly, so a builder that has not been converted is slow rather than
 * broken.
 *
 * BYTE-IDENTICAL, and the reason is worth stating rather than assuming: a
 * double stored into a `Float32Array` element is rounded to the nearest float32
 * exactly as `new Float32Array(arrayOfDoubles)` rounds it. The rounding happens
 * once either way and at the same place in the arithmetic. What changes is only
 * WHEN.
 */
const MESH_BUFFER_INITIAL_FLOATS = 1 << 16;
const MESH_BUFFER_POOL = [];
/** Deep enough for the one nested build in the tree - a specimen capsule builds
 *  the creature inside it while its own buffer is open - with room to spare. A
 *  buffer that does not come back simply is not reused; the pool cannot hand the
 *  same one out twice, because taking it removes it. */
const MESH_BUFFER_POOL_LIMIT = 8;

class MeshBuffer {
  constructor(capacity) {
    this.data = new Float32Array(capacity);
    this.length = 0;
    this.open = true;
  }

  push(v0, v1, v2, v3, v4, v5, v6, v7, v8, v9, v10, v11) {
    // A wrong-arity push would write a mesh that is silently misaligned by a
    // field for every vertex after it, which is the kind of defect that reads
    // as an art bug. It is refused instead.
    if (arguments.length !== ENTITY_VERTEX_STRIDE) {
      throw new Error(`A mesh buffer takes ${ENTITY_VERTEX_STRIDE} floats a vertex; got ${arguments.length}.`);
    }
    let cursor = this.length;
    let data = this.data;
    if (cursor + ENTITY_VERTEX_STRIDE > data.length) {
      const grown = new Float32Array(Math.max(data.length * 2, cursor + ENTITY_VERTEX_STRIDE));
      grown.set(data.subarray(0, cursor));
      this.data = grown;
      data = grown;
    }
    data[cursor] = v0;
    data[cursor + 1] = v1;
    data[cursor + 2] = v2;
    data[cursor + 3] = v3;
    data[cursor + 4] = v4;
    data[cursor + 5] = v5;
    data[cursor + 6] = v6;
    data[cursor + 7] = v7;
    data[cursor + 8] = v8;
    data[cursor + 9] = v9;
    data[cursor + 10] = v10;
    data[cursor + 11] = v11;
    this.length = cursor + ENTITY_VERTEX_STRIDE;
  }
}

/**
 * Which container the meshes on this path were actually accumulated in.
 *
 * A builder left on `const vertices = []` still WORKS - the primitives duck-type
 * `push`, `finishMesh` still finishes it - so the regression is silent, costs
 * 69 ns a vertex, and reads as a perfectly ordinary file. Nothing about its
 * source could be scanned for reliably either: the accumulator is a local, and
 * a hand-copy is free to spell it any way it likes. So the run is asked instead,
 * and `test/entity_geometry_emit.test.js` requires every shipped volumetric type
 * to appear in `finishedAsBuffer` and none of them in `finishedAsArray`.
 */
const meshBufferStats = { created: 0, reused: 0, finishedAsBuffer: 0, finishedAsArray: 0 };

export function readMeshBufferStats() {
  return { ...meshBufferStats, pooled: MESH_BUFFER_POOL.length };
}

/**
 * A buffer to build one mesh into. Hand it to the primitives exactly where a
 * `[]` used to go, and hand it to `finishMesh`, which returns it here.
 */
export function createMeshBuffer() {
  const buffer = MESH_BUFFER_POOL.pop();
  if (!buffer) {
    meshBufferStats.created++;
    return new MeshBuffer(MESH_BUFFER_INITIAL_FLOATS);
  }
  meshBufferStats.reused++;
  buffer.length = 0;
  buffer.open = true;
  return buffer;
}

export function finishMesh(vertices, lod, animation = {}, options = {}) {
  let mesh;
  if (vertices instanceof MeshBuffer) {
    meshBufferStats.finishedAsBuffer++;
    // Copied out rather than handed over: the buffer goes back to the pool and
    // the caller keeps a mesh of exactly its own length, which `applyMeshOpacity`
    // then compacts in place and the batching pass copies out of.
    mesh = vertices.data.slice(0, vertices.length);
    if (vertices.open && MESH_BUFFER_POOL.length < MESH_BUFFER_POOL_LIMIT) {
      vertices.open = false;
      MESH_BUFFER_POOL.push(vertices);
    }
  } else {
    if (vertices.length > 0) meshBufferStats.finishedAsArray++;
    mesh = new Float32Array(vertices);
  }
  // The fragment pass decodes -(r + 1). Solid scenery opts out of the actor
  // glyph ramp without changing its physical roughness or material response.
  if (options.glyphCategory === 'world') {
    for (let i = 9; i < mesh.length; i += ENTITY_VERTEX_STRIDE) mesh[i] = -(mesh[i] + 1);
  }
  return {
    vertices: mesh,
    vertexCount: mesh.length / ENTITY_VERTEX_STRIDE,
    lod,
    animation: Object.freeze(animation)
  };
}

/** Floats in one triangle. Every mesh here is a non-indexed triangle list -
 *  the primitives above emit three vertices a triangle in build order and
 *  nothing indexes or reorders them, and the renderer draws them with
 *  `gl.drawArrays(gl.TRIANGLES, ...)`. */
const ENTITY_TRIANGLE_STRIDE = ENTITY_VERTEX_STRIDE * 3;

/**
 * A triangle's fixed place in the dissolve order, in [0, 1).
 *
 * The radical inverse of the index in base two - reverse the bits, read them
 * back as a fraction. Consecutive triangles land far apart, so ANY prefix of
 * this order is spread evenly across the whole build order rather than
 * clustered in it, and the order is a pure function of the index: no state, no
 * allocation, and the same answer on every frame and every machine.
 *
 * That last part is what makes a dissolve hold still. `cellFS` runs temporal
 * hysteresis over its glyph choices, so a body whose surviving triangles were
 * re-drawn at random each frame would fight it and boil. This is the same
 * ordered-dither idea the cell shader already uses on its density ramp
 * (`bayer4`), applied to whether a surface is there at all.
 */
function dissolveRank(index) {
  let bits = index;
  bits = ((bits >>> 1) & 0x55555555) | ((bits & 0x55555555) << 1);
  bits = ((bits >>> 2) & 0x33333333) | ((bits & 0x33333333) << 2);
  bits = ((bits >>> 4) & 0x0f0f0f0f) | ((bits & 0x0f0f0f0f) << 4);
  bits = ((bits >>> 8) & 0x00ff00ff) | ((bits & 0x00ff00ff) << 8);
  bits = (bits >>> 16) | (bits << 16);
  return (bits >>> 0) / 4294967296;
}

/**
 * Thins a built mesh to a fraction of its own surface. THIS IS WHAT OPACITY
 * MEANS ON THIS PATH, and it is not alpha.
 *
 * The entity pass is DEFERRED: `entityFS` writes albedo, a normal and a world
 * position into three G-buffer attachments with DEPTH_TEST on. There is nothing
 * to blend against - averaging two normals or two world positions does not
 * produce a lit half-transparent surface, it produces a wrong one - and there is
 * no alpha channel to carry a weight in even if there were. Adding one would
 * mean a thirteenth float per vertex, and `ENTITY_VERTEX_STRIDE` is written into
 * the import header of every builder Creature Studio generates.
 *
 * What this renderer does have is COVERAGE. `cellFS` counts how many of a glyph
 * cell's sub-samples are occupied - `step(0.1, length(normalData.xyz))` - and
 * multiplies the cell's luminance by the fraction, so a silhouette that only
 * partly fills a cell already resolves to a sparser glyph in the object's own
 * colour. A fade only has to feed that. Take away surface and the glyph pass
 * does the rest: the body thins, opens, and is finally not there. It is also
 * what `LORE.md` §1 describes - the projection stops being a separate object.
 *
 * DIMMING WAS THE OTHER CANDIDATE AND IT IS NOT A FADE. Occupancy is read off
 * the NORMAL buffer and never off the colour, and the structural-glyph branch
 * keys off the normal gradient, so a body dimmed to black still writes depth,
 * still occludes the room behind it and is still outlined along its silhouette.
 * It would be a body-shaped hole, which is a worse artifact than the body.
 *
 * Whole triangles, so a survivor is bit-identical to what the builder emitted -
 * a fade may remove geometry and may never move any. That is the property that
 * keeps this clear of the trap `zOffset` set for `renderLift`: `buildGoreMesh`
 * reads `zOffset` itself and applies it as `0.5 - zOffset`, and a shared pass
 * that transformed vertices would have to know about that. This one does not
 * transform anything.
 *
 * Note for authoring: the entity pass draws with CULL_FACE disabled, so a closed
 * limb presents two surfaces to every pixel. Screen coverage is therefore about
 * `1 - (1 - opacity)^2` rather than `opacity`, and a fade wants to spend its
 * last third quickly. Content shapes that curve; this stays linear in surface,
 * because "how much of the body is drawn" is the honest thing to be able to say.
 */
function applyMeshOpacity(mesh, opacity) {
  const presence = clamp(Number.isFinite(opacity) ? opacity : 1, 0, 1);
  if (presence >= 1 || mesh.vertices.length === 0) return mesh;
  if (presence <= 0) {
    mesh.vertices = new Float32Array(0);
    mesh.vertexCount = 0;
    return mesh;
  }
  // Compacted in place. The buffer belongs to this call - `finishMesh` allocates
  // a fresh Float32Array per build - and the batching pass copies out of it, so
  // a shortened view costs nothing and allocates nothing.
  const triangles = Math.floor(mesh.vertices.length / ENTITY_TRIANGLE_STRIDE);
  let kept = 0;
  for (let triangle = 0; triangle < triangles; triangle++) {
    if (dissolveRank(triangle) >= presence) continue;
    const source = triangle * ENTITY_TRIANGLE_STRIDE;
    const target = kept * ENTITY_TRIANGLE_STRIDE;
    if (target !== source) mesh.vertices.copyWithin(target, source, source + ENTITY_TRIANGLE_STRIDE);
    kept++;
  }
  mesh.vertices = mesh.vertices.subarray(0, kept * ENTITY_TRIANGLE_STRIDE);
  mesh.vertexCount = kept * 3;
  return mesh;
}

/**
 * The inspection camera swallowing the body it is orbiting.
 *
 * Delegates to `applyMeshOpacity` rather than thresholding. It used to be a
 * binary cull - anything under 0.5 emptied the mesh outright - which is why the
 * board carried "a body cannot leave a shot except by being deleted" as a
 * blocker for a fortnight of transition work. Its one caller in the shipped tree
 * passes exactly 0 and is unaffected either way.
 */
function applyCameraBodyFade(mesh, fade) {
  return applyMeshOpacity(mesh, Number.isFinite(fade) ? fade : 1);
}

/**
 * LOD tier for a viewer distance — optionally with hysteresis.
 *
 * With `hysteresis > 0` and the entity's previous tier supplied, a tier keeps
 * its entity for `hysteresis` extra cells past the boundary it entered
 * through: demotion is delayed, promotion is instant, so the flip-up and
 * flip-down points sit `hysteresis` apart and a viewer strafing on a boundary
 * cannot strobe tiers at the 30 Hz entity tick. With either argument absent
 * (every caller that predates them) the comparisons are exactly the
 * historical hard thresholds.
 */
export function selectEntityLOD(distance, distances = ENTITY_LOD_DISTANCES, hysteresis = 0, previousLod = null) {
  if (!Number.isFinite(distance) || distance < 0) return ENTITY_LOD.BILLBOARD;
  let fullLimit = distances.full;
  let simplifiedLimit = distances.simplified;
  if (hysteresis > 0 && previousLod) {
    if (previousLod === ENTITY_LOD.FULL) fullLimit += hysteresis;
    if (previousLod !== ENTITY_LOD.BILLBOARD) simplifiedLimit += hysteresis;
  }
  if (distance <= fullLimit) return ENTITY_LOD.FULL;
  if (distance <= simplifiedLimit) return ENTITY_LOD.SIMPLIFIED;
  return ENTITY_LOD.BILLBOARD;
}

/**
 * The neutral entity content pack: no types, so no entity is meshed at all.
 * An engine that has been handed no world is not entitled to guess at one.
 */
export const NEUTRAL_ENTITY_CONTENT = Object.freeze({
  types: new Set(),
  buildMesh: null,
  shouldRender: null,
  resolveRenderEntity: null,
  lodDistances: null
});

/**
 * Normalises an installed content pack into the four slots the batching pass
 * reads. Only `types` and `buildMesh` are needed to draw something; the other
 * two exist because placement is content's business too.
 *
 * - `types`               which entity types are volumetric at all
 * - `buildMesh`           `(entity, currentTime, lod, options)` -> mesh
 * - `shouldRender`        `(entity)` -> false to skip, before LOD accounting
 * - `resolveRenderEntity` `(entity, map, viewer)` -> the entity to mesh, for
 *   content that is placed against the map rather than by its own coordinates
 */
export function resolveEntityContent(content) {
  if (!content || typeof content !== 'object') return NEUTRAL_ENTITY_CONTENT;
  return {
    types: content.types instanceof Set
      ? content.types
      : new Set(Array.isArray(content.types) ? content.types : []),
    buildMesh: typeof content.buildMesh === 'function' ? content.buildMesh : null,
    lodDistances: typeof content.lodDistances === 'function' ? content.lodDistances : null,
    shouldRender: typeof content.shouldRender === 'function' ? content.shouldRender : null,
    resolveRenderEntity: typeof content.resolveRenderEntity === 'function'
      ? content.resolveRenderEntity
      : null
  };
}

export function buildEntityGeometry(entities, player, currentTime = 0, options = {}) {
  const meshesEnabled = options.enabled !== false;
  // Two layers of content sit under this pass. `options.content` is the world
  // installed at startup and is what the game draws. `options.meshBuilder` is
  // an override tried ahead of it - gore, or a Studio previewing a creature
  // that is not in the world yet - and returning null from it falls through to
  // the world, so an override only has to handle what it owns.
  const meshBuilder = typeof options.meshBuilder === 'function' ? options.meshBuilder : null;
  const extraTypes = options.extraTypes instanceof Set
    ? options.extraTypes
    : new Set(Array.isArray(options.extraTypes) ? options.extraTypes : []);
  const content = resolveEntityContent(options.content);
  const meshBuffers = [];
  let totalFloatCount = 0;
  const convertedEntities = new Set();
  const stats = { full: 0, simplified: 0, billboard: 0, vertexCount: 0, byType: {} };
  if (!meshesEnabled || !Array.isArray(entities)) {
    return { vertices: new Float32Array(0), vertexCount: 0, convertedEntities, stats };
  }

  const playerX = player && Number.isFinite(player.x) ? player.x : 0;
  const playerY = player && Number.isFinite(player.y) ? player.y : 0;
  // LOD transition presentation, both OFF by default and both engaged only
  // through `AsciiRendererWebGL#setEntityLodTransition` (which the facade
  // always sets; direct renderer consumers never call it, so Liminal's
  // thresholds, swaps and per-entity objects are byte-identical — the state
  // both features need is written onto the roster entities, and only the
  // facade's pooled entities are engine-owned):
  //
  //   lodHysteresis  — cells; see selectEntityLOD.
  //   lodDissolveMs  — the mesh<->billboard handoff. Instead of a
  //     frame-discrete swap at the `simplified` boundary, the mesh keeps
  //     building (at SIMPLIFIED tessellation) while its presence ramps 1->0
  //     over this many ms through the existing triangle-dissolve machinery
  //     (applyMeshOpacity / dissolveRank), and ramps back 0->1 on re-entry.
  //     While a handoff is running the entity stays OFF the converted set,
  //     so its billboard fallback (if registered) pops in under the
  //     dissolving mesh — a brief double-image, accepted in exchange for no
  //     hard swap. The ramp advances on the 30 Hz entity tick, which at
  //     250 ms is ~8 dissolve steps.
  //
  // Per-entity state lives on the persistent roster entity: _lodTier (the
  // tier hysteresis keys on), _lodFade and _lodFadeTime (the handoff ramp).
  // A newly seen entity snaps to its target presence — spawning far away
  // does not play a phantom fade-out, spawning near does not fade in.
  const lodHysteresis = Number.isFinite(options.lodHysteresis) && options.lodHysteresis > 0
    ? options.lodHysteresis
    : 0;
  const lodDissolveMs = Number.isFinite(options.lodDissolveMs) && options.lodDissolveMs > 0
    ? options.lodDissolveMs
    : 0;
  const lodTransitions = lodHysteresis > 0 || lodDissolveMs > 0;
  for (const entity of entities) {
    if (!entity || !(content.types.has(entity.type) || extraTypes.has(entity.type))) continue;
    if (content.shouldRender && !content.shouldRender(entity)) continue;
    const distance = Math.hypot(entity.x - playerX, entity.y - playerY);
    const defaults = options.distances || ENTITY_LOD_DISTANCES;
    const custom = content.lodDistances?.(entity, defaults);
    const distances = custom && Number.isFinite(custom.full) && Number.isFinite(custom.simplified)
      && custom.full >= 0 && custom.simplified >= custom.full ? custom : defaults;
    const lod = selectEntityLOD(
      distance,
      distances,
      lodHysteresis,
      lodTransitions ? (entity._lodTier || null) : null
    );
    if (lodTransitions) entity._lodTier = lod;
    stats[lod]++;
    if (!stats.byType[entity.type]) stats.byType[entity.type] = { full: 0, simplified: 0, billboard: 0, vertexCount: 0 };
    stats.byType[entity.type][lod]++;
    let lodFade = 1;
    if (lodDissolveMs > 0) {
      const target = lod === ENTITY_LOD.BILLBOARD ? 0 : 1;
      const previous = Number.isFinite(entity._lodFade) ? entity._lodFade : target;
      const step = Number.isFinite(entity._lodFadeTime)
        ? Math.max(0, currentTime - entity._lodFadeTime) / lodDissolveMs
        : 1;
      lodFade = previous + Math.sign(target - previous) * Math.min(step, Math.abs(target - previous));
      entity._lodFade = lodFade;
      entity._lodFadeTime = currentTime;
    }
    const renderEntity = content.resolveRenderEntity
      ? content.resolveRenderEntity(entity, options.map, player)
      : entity;
    const derezActive = Number.isFinite(renderEntity.renderDerez) && renderEntity.renderDerez > 0;
    if (derezActive && renderEntity.renderDerez >= 1) {
      // Completed effects must also suppress the distant billboard fallback.
      convertedEntities.add(entity);
      continue;
    }
    // An active effect retains simplified geometry beyond mesh LOD so its
    // fragments cannot turn back into an intact fallback sprite.
    if (!derezActive && lod === ENTITY_LOD.BILLBOARD && (lodDissolveMs <= 0 || lodFade <= 0)) continue;
    const buildLod = lod === ENTITY_LOD.BILLBOARD ? ENTITY_LOD.SIMPLIFIED : lod;
    const buildOptions = { ...options, viewerDistance: distance };
    let mesh = (meshBuilder && meshBuilder(renderEntity, currentTime, buildLod, buildOptions))
      || (content.buildMesh && content.buildMesh(renderEntity, currentTime, buildLod, buildOptions))
      || finishMesh([], ENTITY_LOD.BILLBOARD);
    if (derezActive) mesh = applyAsciiDerez(mesh, renderEntity.renderDerez, player, {
      ...renderEntity.renderDerezOptions, upSign: -1
    });
    if (renderEntity.localInspection && renderEntity.cameraBodyVisible === false) applyCameraBodyFade(mesh, 0);
    // `renderOpacity` is how much of this entity's own surface is drawn, 0..1.
    // See applyMeshOpacity for why that is what opacity means on a deferred
    // ASCII path and why it is not alpha. Presentation only, exactly like
    // `renderScale` and `renderLift` below, and applied FIRST because it only
    // ever removes triangles - so the two transforms after it walk a shorter
    // buffer, and a fully faded body costs them nothing at all.
    //
    // Absent, null, NaN and anything outside [0, 1] all mean "fully present",
    // and the >= 1 case returns the builder's own buffer untouched. An entity
    // that authors no fade is bit-identical to one built before this existed;
    // that is asserted per type rather than assumed, because this pass draws
    // every anomaly, every remote operator, every critical device and all the
    // gore.
    const renderOpacity = Number.isFinite(renderEntity.renderOpacity)
      ? clamp(renderEntity.renderOpacity, 0, 1)
      : 1;
    // The LOD handoff multiplies onto the authored presence; with the
    // transition knob unset lodFade is exactly 1 and this line is the
    // historical one to the float.
    const effectiveOpacity = renderOpacity * (derezActive ? 1 : lodFade);
    if (effectiveOpacity < 1) applyMeshOpacity(mesh, effectiveOpacity);
    const renderScale = Number.isFinite(renderEntity.renderScale)
      ? clamp(renderEntity.renderScale, 0.25, 2)
      : 1;
    if (renderScale !== 1) {
      // Scale around the floor contact plane. Authoritative entity position,
      // collision, interaction, and network state remain completely unchanged.
      const floorZ = 0.5;
      for (let vertex = 0; vertex < mesh.vertices.length; vertex += ENTITY_VERTEX_STRIDE) {
        mesh.vertices[vertex] = renderEntity.x + (mesh.vertices[vertex] - renderEntity.x) * renderScale;
        mesh.vertices[vertex + 1] = renderEntity.y + (mesh.vertices[vertex + 1] - renderEntity.y) * renderScale;
        mesh.vertices[vertex + 2] = floorZ + (mesh.vertices[vertex + 2] - floorZ) * renderScale;
      }
    }
    // `renderLift` takes a built body off the floor: height in world units,
    // POSITIVE IS UP. World -z is up, so it is subtracted - the same negation
    // FinisherDirector applies to an authored camera height. Presentation only,
    // exactly like `renderScale` above, and applied after it so a lift is an
    // absolute height rather than one the scale has shrunk.
    //
    // It is a field of its own rather than the entity's `zOffset` because
    // `zOffset` already means two incompatible things: the billboard quad and
    // the world labels read it as world z (negative up), while `buildGoreMesh`
    // reads it as a height above the floor and applies it itself. Honouring it
    // here would double every splat and droplet, with the sign flipped.
    //
    // Nothing here read a vertical offset at all before, which is how S-DRN-02's
    // authored suspension shipped inert: measured across all seventeen
    // volumetric types, a mesh built at zOffset 0.22 had exactly the same
    // z-range as the same mesh at zero, and a finisher frames its victim from
    // 1.05-3.20 units, so the billboard path that does read the field is never
    // the one drawing it.
    // The bound is the ROOM, not a literal. It was ±1 while a cell was one unit
    // tall and the reasoning written here was "1.0 is a body's own height plus
    // 0.007, so the clamp is almost exactly far enough to leave the room and no
    // further" - a statement about the room in a number that only equalled the
    // room by coincidence. Upgrade 88 made the room 1.25 tall and the coincidence
    // ended: the escape's authored climb was cut off a quarter of a body short
    // and the operative's boots hung out of the ceiling under the victory
    // receipt. `WORLD_CEILING_CLEARING_LIFT` is the same sentence, derived.
    const renderLift = Number.isFinite(renderEntity.renderLift)
      ? clamp(renderEntity.renderLift, -WORLD_CEILING_CLEARING_LIFT, WORLD_CEILING_CLEARING_LIFT)
      : 0;
    if (renderLift !== 0) {
      for (let vertex = 2; vertex < mesh.vertices.length; vertex += ENTITY_VERTEX_STRIDE) {
        mesh.vertices[vertex] -= renderLift;
      }
    }
    meshBuffers.push(mesh.vertices);
    totalFloatCount += mesh.vertices.length;
    // Mid-handoff (lodFade < 1) the entity stays OFF the converted set so its
    // billboard fallback draws under the partial mesh; fully present entities
    // convert exactly as always (lodFade is pinned 1 with the knob unset).
    if (derezActive || lodFade >= 1) convertedEntities.add(entity);
    stats.byType[entity.type].vertexCount += mesh.vertexCount;
  }

  const packedVertices = new Float32Array(totalFloatCount);
  let floatOffset = 0;
  for (const meshBuffer of meshBuffers) {
    packedVertices.set(meshBuffer, floatOffset);
    floatOffset += meshBuffer.length;
  }
  stats.vertexCount = packedVertices.length / ENTITY_VERTEX_STRIDE;
  return {
    vertices: packedVertices,
    vertexCount: stats.vertexCount,
    convertedEntities,
    stats
  };
}
