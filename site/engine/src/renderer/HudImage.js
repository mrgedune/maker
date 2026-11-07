/**
 * The HUD image: a caller's own picture composited by the final passes over
 * the finished frame and the HUD's glyph cells, one texel a pixel (see
 * AsciiEngine#setHudImage and applyHudImage in ShaderSources.js). Pure data,
 * so the placement can be tested without GL.
 */

/**
 * What the renderer keeps for an image `source` (anything texImage2D takes
 * with a width and a height: a canvas, an ImageBitmap, ImageData) whose top
 * left is at (x, y) in canvas pixels, y down. Null for no image, or for one
 * with no area.
 */
export function hudImageState(source, { x = 0, y = 0 } = {}) {
  const width = Math.floor(Number(source?.width));
  const height = Math.floor(Number(source?.height));
  if (!source || !(width > 0) || !(height > 0)) return null;
  return {
    source,
    x: Number.isFinite(x) ? Math.round(x) : 0,
    y: Number.isFinite(y) ? Math.round(y) : 0,
    width,
    height
  };
}

/**
 * The image's rectangle as the shader reads it: [x, y, width, height] in
 * drawing-buffer pixels from the BOTTOM left, as gl_FragCoord runs.
 */
export function hudImageRect(state, drawingHeight) {
  return [state.x, drawingHeight - state.y - state.height, state.width, state.height];
}
