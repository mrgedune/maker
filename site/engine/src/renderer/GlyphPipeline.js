/**
 * Upgrade 83 glyph pipeline contracts.
 *
 * Until now the G-buffer was allocated at character-grid resolution, so every
 * glyph cell received exactly one sample of the world. That made sub-cell
 * structure unrepresentable and left the renderer's directional-glyph branch
 * permanently unreachable: it sampled neighbours 0.35 texels away from a cell
 * centre, which under NEAREST filtering is always the same texel.
 *
 * This module owns the resolution contract between the 3D scene and the glyph
 * grid, plus the glyph vocabulary shared by the renderer and its shaders. It is
 * deliberately free of DOM/WebGL dependencies so the contracts can be validated
 * without launching Electron.
 */

/**
 * Canonical renderer glyph set. Index 0-94 is printable ASCII in code order
 * (index === charCode - 32), followed by the renderer's symbol extensions.
 * The order is load-bearing: saved character-set preferences and the shader
 * ramp uniforms both address glyphs by this index, so entries are only ever
 * appended.
 */
const GLYPH_CHARS_BASE =
  " !\"#$%&'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_`abcdefghijklmnopqrstuvwxyz{|}~▼◄▲►☼·°●REC░▒▓█◆★";

/**
 * Upgrade 84: the fourteen quadrant block glyphs that were missing from the
 * set. With space and the full block they complete all sixteen 2x2 coverage
 * masks, which is what lets a cell carry two colours and resolve sub-cell
 * structure the density ramp cannot express.
 *
 * Ordered by mask so the lookup below is a direct index.
 */
const GLYPH_CHARS_QUADRANTS = "▘▝▀▖▌▞▛▗▚▐▜▄▙▟";

export const GLYPH_CHARS = GLYPH_CHARS_BASE + GLYPH_CHARS_QUADRANTS;

export const GLYPH_CHARS_BASE_LENGTH = GLYPH_CHARS_BASE.length;

export const GLYPH_INDEX_BY_CHAR = Object.freeze(
  GLYPH_CHARS.split('').reduce((table, char, index) => {
    if (table[char] === undefined) table[char] = index;
    return table;
  }, Object.create(null))
);

export function glyphIndexForChar(char) {
  const index = GLYPH_INDEX_BY_CHAR[char];
  return index === undefined ? 0 : index;
}

/**
 * Whether the atlas can actually draw a character. glyphIndexForChar answers
 * 0 (the blank cell) for anything it does not know, which makes undrawable
 * HUD copy fail silently as a hole in the line — this is how a caller checks
 * first. Letters are matched case-insensitively because the atlas carries a
 * single case for A-Z.
 */
export function canDrawGlyph(char) {
  return GLYPH_INDEX_BY_CHAR[char] !== undefined
    || GLYPH_INDEX_BY_CHAR[String(char).toUpperCase()] !== undefined;
}

/**
 * Structural glyphs used when a cell straddles a detected edge.
 *
 * These are verified against GLYPH_CHARS rather than hand-counted. The previous
 * inline shader constant used 93 for the vertical bar, which is '}' — the bug
 * was invisible only because the branch never executed.
 */
export const STRUCTURAL_GLYPHS = Object.freeze({
  arcLeft: glyphIndexForChar('('),
  arcRight: glyphIndexForChar(')'),
  horizontal: glyphIndexForChar('-'),
  vertical: glyphIndexForChar('|'),
  diagonalUp: glyphIndexForChar('/'),
  diagonalDown: glyphIndexForChar('\\')
});

/** Density ramp break points shared by the reduce shader and the ramp builder. */
export const GLYPH_LUMA_SCALE = Object.freeze([
  0.0, 0.08, 0.15, 0.22, 0.3, 0.38, 0.45, 0.55, 0.65, 0.75, 0.82, 0.9, 1.0
]);

export const GLYPH_RAMP_STEPS = GLYPH_LUMA_SCALE.length;

/**
 * The empty cell. GLYPH_CHARS starts at space, so this is 0 - but it is derived
 * rather than written, because the rule below turns on it.
 */
export const BLANK_GLYPH_INDEX = glyphIndexForChar(' ');

/**
 * The 4x4 ordered-dither matrix, in the reduce shader's cell-major order.
 *
 * Exported so the model below is the same function the shader runs rather than
 * an approximation of it; `cellFS` mirrors the table verbatim.
 */
export const BAYER_4X4 = Object.freeze([
  0, 8, 2, 10,
  12, 4, 14, 6,
  3, 11, 1, 9,
  15, 7, 13, 5
]);

/** Ordered-dither threshold for a cell, in (0,1). */
export function bayerThreshold(cellX, cellY) {
  const x = ((Math.floor(cellX) % 4) + 4) % 4;
  const y = ((Math.floor(cellY) % 4) + 4) % 4;
  return (BAYER_4X4[y * 4 + x] + 0.5) / 16;
}

/**
 * Whether the ordered dither may promote a cell from one ramp rung to the next.
 *
 * **An ordered dither redistributes density between two marks. It does not
 * decide whether a cell is marked at all.**
 *
 * The reduce pass dithers a cell across the rung boundary its luminance falls
 * on, which breaks the banding a thirteen-step ramp would otherwise show on a
 * smooth surface. Everywhere in the middle of the ramp that swaps one ink glyph
 * for a slightly denser one - a low-contrast change, which is what dithering is
 * for. At the boundary where the ramp stops being blank it swaps *nothing* for
 * *something*, which is the only full-contrast step on the whole ramp, and the
 * Bayer matrix lays those out on a regular 4-cell lattice.
 *
 * That is what made every surface the flashlight does not reach read as a hard
 * chequerboard above the legacy pipeline, which has no dither at all: a
 * shadowed wall sits at a display luminance of roughly 0.15-0.22, which for the
 * shipped `blocks` character set is the rung directly below its first ink
 * glyph. Measured on `gaoler_emerge` - a baselined visual-QA scene id that keeps
 * EXT-04's old name; the creature is The Warden - 14.2% of the cells in a shadowed region
 * were promoted this way at 2x, 14.6% at 3x and 14.8% at 4x, against 1.4% at 1x
 * - and the four 2x2 cell parities inked at 7.7 / 14.9 / 43.3 / 10.0 percent,
 * which is the dither matrix itself showing through.
 *
 * It is worse than a stipple because of the glyph raster: at the cell sizes this
 * game runs (3x5 pixels at 1080p) the font atlas minifies past
 * GLYPH_COVERAGE_THRESHOLD, so a quarter-block draws as a *solid* block of the
 * cell colour. There is no faint mark to dither toward - the promotion is the
 * whole cell.
 *
 * Character sets whose first entry is already ink - `classic` and `hex` - have
 * no such boundary and are unaffected, which is why the sprite ramp keeps its
 * dither.
 */
export function ditherMayPromote(lowerGlyphIndex) {
  return lowerGlyphIndex !== BLANK_GLYPH_INDEX;
}

/**
 * Resolve which ramp rung a cell's luminance selects, dither included.
 *
 * The authority for the branch `cellFS` runs, so the rule can be exercised
 * without a GPU. Returns the rung index, not the glyph.
 */
export function resolveRampBin(luma, rampIndices, ditherThreshold = 1) {
  let matched = 0;
  for (let i = 0; i < GLYPH_RAMP_STEPS; i++) {
    if (luma >= GLYPH_LUMA_SCALE[i]) matched = i;
  }
  const upper = Math.min(matched + 1, GLYPH_RAMP_STEPS - 1);
  const low = GLYPH_LUMA_SCALE[matched];
  const high = GLYPH_LUMA_SCALE[upper];
  const fraction = high > low
    ? Math.min(Math.max((luma - low) / (high - low), 0), 1)
    : 0;
  if (!ditherMayPromote(rampIndices[matched])) return matched;
  return fraction > ditherThreshold ? upper : matched;
}

/**
 * Font atlas geometry. Aligned power-of-two cells keep mip texels within
 * one glyph up to log2(min(glyphWidth, glyphHeight)). Scene raster sampling
 * clamps the LOD and filter footprint to prevent neighbouring-glyph bleed.
 */
export const FONT_ATLAS = Object.freeze({
  columns: 16,
  rows: 8,
  glyphWidth: 32,
  glyphHeight: 64,
  get width() { return this.columns * this.glyphWidth; },
  get height() { return this.rows * this.glyphHeight; }
});

/**
 * Block-element glyphs are drawn procedurally rather than taken from the font
 * so the density ramp has exact, calibrated coverage. Consolas' block glyphs do
 * not reliably fill their em box, which skews the ramp the renderer depends on.
 */
export const PROCEDURAL_BLOCK_COVERAGE = Object.freeze({
  '░': 0.25,
  '▒': 0.5,
  '▓': 0.75,
  '█': 1
});

/**
 * Quadrant bit assignments for the 2x2 sub-cell mask.
 *
 * The vertical axis follows the render target, where +y is up, so the "upper"
 * bits are the higher sub-cell rows.
 */
export const QUADRANT_BITS = Object.freeze({
  upperLeft: 1,
  upperRight: 2,
  lowerLeft: 4,
  lowerRight: 8
});

/**
 * Quadrant fill rectangles in cell-relative coordinates, keyed by glyph. The
 * atlas draws these directly so coverage is exact rather than dependent on a
 * font face carrying the block-elements range at all.
 */
export const PROCEDURAL_QUADRANT_MASKS = Object.freeze(
  GLYPH_CHARS_QUADRANTS.split('').reduce((table, char, offset) => {
    table[char] = offset + 1;
    return table;
  }, Object.create(null))
);

/**
 * Mask -> glyph index, for all sixteen 2x2 coverage patterns. Mask 0 resolves to
 * space and mask 15 to the full block, both of which already existed.
 */
export const QUADRANT_GLYPH_INDICES = Object.freeze(
  Array.from({ length: 16 }, (unused, mask) => {
    if (mask === 0) return glyphIndexForChar(' ');
    if (mask === 15) return glyphIndexForChar('█');
    return GLYPH_CHARS_BASE_LENGTH + (mask - 1);
  })
);

export const GLYPH_PIPELINE_MODES = Object.freeze({
  legacy: Object.freeze({ sceneScale: 1, structural: false, twoPass: false }),
  balanced: Object.freeze({ sceneScale: 2, structural: true, twoPass: true }),
  high: Object.freeze({ sceneScale: 3, structural: true, twoPass: true }),
  ultra: Object.freeze({ sceneScale: 4, structural: true, twoPass: true })
});

/**
 * `legacy`, on Ged's ruling of 2026-08-25 and on four measurement passes.
 *
 * **This is not the bottom of the ladder being chosen as a default. It is a
 * different render path being chosen as the look**, and everything below is
 * about why those are not the same statement. `legacy` is single-pass: one
 * scene sample a cell, no reduce, and therefore no ordered dither, no
 * structural glyphs and no sub-cell colour. The other three differ from each
 * other only in how many samples one cell is reduced from.
 *
 * Ged: *"Native resolution, Legacy Glyph this is the best look, hands down,
 * this needs to be the default and what everyone plays in, any different
 * setting is manually by their hands."*
 *
 * ### What the four passes measured, and what they refuted
 *
 * `.visual-qa/pipeline-ab-2026-08-23/`, `dither-ab-2026-08-23/`,
 * `structural-ab-2026-08-23/`, `temporal-ab-2026-08-23/`, each with a
 * `review.html`.
 *
 * - The "newspaper halftone" Ged disliked is **the supersample itself**, not
 *   the dither and not the structural glyphs: `ultra` inks 3.4x as many cells
 *   as `legacy` on a dim wall. The dither owns 0% of walls and structural
 *   glyphs 1.1%, so switching either off would not have got here.
 * - `legacy` does **not** shimmer more in motion. Measured standing still and
 *   walking; the hypothesis that a still-frame preference would not survive
 *   play is false.
 * - The three supersampled rungs land within 2% of each other on every metric
 *   captured - brightFraction, brightLevels, meanLuma, litFraction - and differ
 *   by roughly 3% of pixels against the 11% that separates `legacy` from
 *   `high`. **The one big step on this axis is the step off `legacy`**, which
 *   is exactly why it is a look and not a rung.
 *
 * ### Why this is cheap rather than expensive, which is the counter-intuitive part
 *
 * The shipped default is `native` + this, and `native` is the densest grid the
 * engine draws - 1,036,800 cells at 1080p. At one sample a cell that is 1.04M
 * scene texels against `MAX_SCENE_TEXELS`' 8M. The same grid at `balanced` is
 * 4.15M, at `high` 9.33M and at `ultra` 16.6M, and the last two are over the
 * ceiling at every window from 1080p up. **`native` and `legacy` are the pair
 * that fits**; see `NATIVE_SIGNAL_GLYPH_PIPELINE` in DisplayPresets.js.
 *
 * ### What this constant is NOT
 *
 * It is not the ladder's middle rung. `RENDER_QUALITY_TIERS.medium` used to be
 * written as this constant and is now `'balanced'` in longhand, because the
 * grid ladder and the shipped look stopped being the same answer on the day
 * this moved. Deriving one from the other would have collapsed `medium` onto
 * `low`'s pipeline the moment this line changed - and it very nearly did.
 *
 * It is also not `PINNED_CELL_BUDGET`'s supersample any more, for the same
 * reason and with a sharper edge: that budget existed to guarantee a pinned
 * grid could always afford the supersample it would be given, and deriving it
 * from a 1x default would have quadrupled it. See RendererScalability.js.
 */
export const DEFAULT_GLYPH_PIPELINE_MODE = 'legacy';

/** Guard against pathological allocations on very large grids. */
export const MAX_SCENE_TEXELS = 8 * 1024 * 1024;
export const MAX_SAMPLES_PER_AXIS = 4;

export function normalizeGlyphPipelineMode(mode) {
  return Object.prototype.hasOwnProperty.call(GLYPH_PIPELINE_MODES, mode)
    ? mode
    : DEFAULT_GLYPH_PIPELINE_MODE;
}

export function getGlyphPipelineContract(mode) {
  return GLYPH_PIPELINE_MODES[normalizeGlyphPipelineMode(mode)];
}

/**
 * Resolve the supersampled scene resolution for a glyph grid.
 *
 * The scale stays an integer so each glyph cell maps onto an exact NxN block of
 * scene texels. That exactness is what lets the reduce pass box-average a cell
 * without resampling error, and it keeps the legacy path bit-identical at 1x.
 */
export function resolveSceneResolution({
  gridWidth,
  gridHeight,
  mode = DEFAULT_GLYPH_PIPELINE_MODE,
  maxTextureSize = 8192,
  maxTexels = MAX_SCENE_TEXELS
} = {}) {
  const width = Math.max(1, Math.floor(Number(gridWidth) || 1));
  const height = Math.max(1, Math.floor(Number(gridHeight) || 1));
  const normalizedMode = normalizeGlyphPipelineMode(mode);
  const contract = GLYPH_PIPELINE_MODES[normalizedMode];
  const requestedScale = contract.sceneScale;
  const textureLimit = Math.max(1, Math.floor(Number(maxTextureSize) || 1));
  const texelLimit = Math.max(1, Math.floor(Number(maxTexels) || 1));

  let sceneScale = requestedScale;
  while (
    sceneScale > 1 &&
    (width * sceneScale > textureLimit ||
      height * sceneScale > textureLimit ||
      width * height * sceneScale * sceneScale > texelLimit)
  ) {
    sceneScale -= 1;
  }

  return Object.freeze({
    mode: normalizedMode,
    requestedScale,
    sceneScale,
    clamped: sceneScale !== requestedScale,
    sceneWidth: width * sceneScale,
    sceneHeight: height * sceneScale,
    // A 1x scene has no sub-cell detail to reduce, so the two-pass glyph path
    // would only add cost. Such a grid falls back to the single-pass shader.
    twoPass: contract.twoPass && sceneScale > 1,
    structural: contract.structural && sceneScale > 1,
    samplesPerAxis: Math.min(sceneScale, MAX_SAMPLES_PER_AXIS)
  });
}

/**
 * Map a character-set string onto the renderer's fixed 13-slot density ramp.
 *
 * Previously duplicated inline for the world and sprite ramps on every frame.
 */
export function buildRampIndices(characterSet, fallback = '_.,-~:;=!*#$@') {
  const scale = characterSet && characterSet.length ? characterSet : fallback;
  const length = scale.length;
  const indices = new Int32Array(GLYPH_RAMP_STEPS);
  for (let i = 0; i < GLYPH_RAMP_STEPS; i++) {
    const position = Math.min(length - 1, Math.floor((i / (GLYPH_RAMP_STEPS - 1)) * length));
    indices[i] = glyphIndexForChar(scale[position] || ' ');
  }
  return indices;
}

/**
 * The display luminance at which a character set's density ramp first draws
 * ink — the real number behind the "blank cliff".
 *
 * Computed from the same 13-slot mapping `buildRampIndices` hands the shader
 * every frame, against the same GLYPH_LUMA_SCALE break points the reduce pass
 * bins on: the lowest rung whose glyph is not the blank cell. Any cell whose
 * display luminance lands below this resolves to EMPTY — for the engine's
 * default ' ░▒▓█' set the first three rungs map to space, so the cliff sits
 * at GLYPH_LUMA_SCALE[3] = 0.22. Character sets whose first entry is already
 * ink return 0. A game pinning authored night minima (ambient floors, sky
 * gradients meant to remain visible) should pin them to this contract number
 * rather than to a rediscovered magic constant.
 */
export function firstInkDisplayLuminance(characterSet, fallback) {
  const indices = fallback === undefined
    ? buildRampIndices(characterSet)
    : buildRampIndices(characterSet, fallback);
  for (let i = 0; i < GLYPH_RAMP_STEPS; i++) {
    if (indices[i] !== BLANK_GLYPH_INDEX) return GLYPH_LUMA_SCALE[i];
  }
  return 1;
}
