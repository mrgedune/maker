/** Optional articulated draws over a cached 12-float, non-indexed mesh. */
export const MAX_VIEWMODEL_DRAW_RANGES = 128;

// Copy to float32: values finite as doubles may still overflow GPU uniforms.
export function normalizeViewmodelTransform(value) {
  if ((!Array.isArray(value) && !ArrayBuffer.isView(value)) || value.length !== 16) return null;
  if (!Array.from(value).every(Number.isFinite)) return null;
  const matrix = new Float32Array(value);
  return matrix.every(Number.isFinite) ? matrix : null;
}

/** Invalid/absent articulation falls back to the builder's single transform.
 * Ranges cover the complete base + overlay buffer once, in triangle order.
 * Each transform is a complete model matrix (not relative to result.transform).
 */
export function normalizeViewmodelDrawRanges(ranges, vertexCount) {
  if (!Array.isArray(ranges) || ranges.length === 0 || ranges.length > MAX_VIEWMODEL_DRAW_RANGES
      || !Number.isSafeInteger(vertexCount) || vertexCount <= 0 || vertexCount % 3 !== 0) return null;
  let next = 0;
  const result = [];
  for (const range of ranges) {
    if (!range || range.first !== next || !Number.isSafeInteger(range.count)
        || range.count <= 0 || range.count % 3 !== 0 || range.count > vertexCount - next) return null;
    const transform = normalizeViewmodelTransform(range.transform);
    if (!transform) return null;
    result.push({ first: next, count: range.count, transform });
    next += range.count;
  }
  return next === vertexCount ? result : null;
}

export function isValidViewmodelGeometry(result) {
  if (!result || !(result.vertices instanceof Float32Array)) return false;
  const overlay = result.overlayVertices;
  if (overlay != null && !(overlay instanceof Float32Array)) return false;
  const floats = result.vertices.length + (overlay?.length || 0);
  return result.vertices.length % 36 === 0 && (overlay?.length || 0) % 36 === 0
    && Number.isSafeInteger(result.vertexCount) && result.vertexCount >= 0
    && result.vertexCount % 3 === 0 && result.vertexCount <= floats / 12;
}
