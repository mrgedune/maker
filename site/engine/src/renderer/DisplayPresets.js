/**
 * DisplayPresets.js - what the display menu's picture controls mean, and what
 * the current window will actually be given.
 *
 * ## The name is a fossil and the presets are gone
 *
 * This file is still called DisplayPresets because renaming a module on a
 * repository several sessions are editing costs more than the name does. There
 * are no presets in it. `RENDER_QUALITY_TIERS`, `CUSTOM_RENDER_QUALITY`,
 * `DEFAULT_RENDER_QUALITY_TIER` and the four functions that resolved and
 * applied them were deleted on 2026-08-25, with the Signal Form control, on
 * Ged's ruling: *"this makes no sense either, redo all those to make it logical
 * and real."*
 *
 * **What he was describing was two settings asked twice each.** `native` was an
 * option in Character Size AND the whole of the Signal Form dropdown; the glyph
 * supersample was the Texture dropdown AND the thing Render Quality's four
 * rungs turned. So touching either real control flipped the preset to `Custom`,
 * which is a control announcing that the player has left a ladder they never
 * chose to be on. Three menu passes had each left one duplicate behind. What
 * ships now is three picture controls - Character Size, Texture Inside Each
 * Character, Glyph Screening - each of which sets exactly one thing, and
 * nothing anywhere says Custom.
 *
 * ## What survived the deletion, and why
 *
 * - **`RENDER_FEATURES`**, the seven renderer switches the advanced grid draws.
 *   No preset moves them any more, but the list is what
 *   `DisplayDefaultsMigration` resets, so it is read rather than hand-copied.
 * - **`describeDeliveredPicture`**, which is the whole reason the deletion is
 *   safe. See below.
 * - **`shippedDisplayDefaults`**, which is new: the one description of what an
 *   unconfigured install looks like, derived from the two engine constants
 *   rather than restated.
 *
 * ## The measurement the deleted ladder was built on, kept because it is why
 * the advanced grid is a disclosure rather than a menu
 *
 * On 2026-08-13 (`914ce3a`) all thirteen performance controls were measured for
 * the first time on any hardware - RTX 4080, 1920x1080 and 2560x1440, both QA
 * scenes, 14 interleaved repeats of 90 frames per configuration, with a control
 * row stating the instrument's own noise floor. Artefacts:
 * `captures/display-cost.json` and
 * `captures/display-cost-no-firstPersonViewmodel.json`.
 *
 * - **Every GPU checkbox costs zero VRAM.** None of them frees an allocation;
 *   every render target exists whether its feature is on or not.
 * - **One of the eleven costs anything: the first-person viewmodel**, at
 *   -0.79 ms of a 1.05 ms frame. It is in LOOK, with its cost written beside it.
 * - **The other ten together are worth 0.056 ms**, 0.3% of a 60fps frame here,
 *   and six of them do not separate at all against a 0.002 ms noise floor.
 *   Held against a baseline with the viewmodel already off - the only sweep
 *   where savings this small clear the floor - exactly three of the nine
 *   remaining separated: contact shadows (-0.023 ms), CRT bloom (-0.019) and
 *   reactive surfaces (-0.012). The other six landed between -0.004 and +0.002.
 * - **Character Size is the axis.** `native` is 7.50x the cells of `max` at
 *   1080p and 10.0x at 1440p, 4.9x the GPU time and 3.8x the VRAM.
 * - **Texture is the VRAM axis** and frame time cannot separate its four rungs
 *   on this card at all: 11.5 / 27.7 / 54.8 / 92.6 MB at 1080p.
 *
 * ## The constraint that killed the FIRST ladder, and why folding `native`
 * back into Character Size does not resurrect it
 *
 * Scene texels are `cells x sceneScale^2` against `MAX_SCENE_TEXELS`' 8M, and
 * `native` draws 1,036,800 cells at 1080p:
 *
 * |        | cells     | x1 flat   | x4 light | x9 fine  | x16 heaviest |
 * |--------|-----------|-----------|----------|----------|--------------|
 * | native | 1,036,800 | 1.04M ok  | 4.15M ok | 9.33M NO | 16.6M NO     |
 * | max    |   138,240 | 0.14M ok  | 0.55M ok | 1.24M ok |  2.21M ok    |
 *
 * The old `Ultra` rung rode `native` and could only ever be given 4 samples, so
 * it shipped the word Ultra over the balanced pipeline. **That defect was a
 * PRESET promising a pairing the renderer declines.** With the presets gone
 * there is nothing left to make that promise: the player picks a size and a
 * texture, and the two impossible pairings are refused at the point of choosing
 * by `glyphPipelineAvailability` below, which asks the real
 * `resolveSceneResolution` against the real window rather than reasoning about
 * it. A size control silently moving a texture control - which is what
 * `applySignalForm` used to do - would have been the same duplication in a
 * third costume.
 *
 * ## The honest limit, unchanged
 *
 * This is an RTX 4080, which is submission-bound where a weak card is
 * fill-bound. `npm run frame-cost -- --suite=toggles,resolution,compose`
 * re-runs the whole pass anywhere and reports its own noise floor.
 */

import {
  DEFAULT_GLYPH_PIPELINE_MODE,
  GLYPH_PIPELINE_MODES,
  normalizeGlyphPipelineMode,
  resolveSceneResolution
} from './GlyphPipeline.js';
import {
  DEFAULT_RESOLUTION_MODE,
  normalizeResolutionMode,
  resolveRendererLayout
} from './RendererScalability.js';

/**
 * The renderer features the advanced grid draws, in menu order.
 *
 * These are `GameLoop` field names, because the settings object they are read
 * from and written to is the game loop itself. Nothing presets them any more;
 * the list survives because `DisplayDefaultsMigration` resets all seven and
 * reads the list rather than repeating it. STATUS.md's tenth lesson is what
 * that is for: a check built from a hand-copied list can only ever find what is
 * on the list.
 *
 * The reset is not the same list. It is these seven, the two picture settings
 * and - since 2026-08-26 - the first-person viewmodel, which is not a render
 * feature and must not be added here to get itself reset; the migration's own
 * table is where that is said.
 */
export const RENDER_FEATURES = Object.freeze([
  'sobelEdges',
  'subCellColor',
  'shadowMaps',
  'crtBloom',
  'environmentalFx',
  'reactiveSurfaces',
  'entityMeshes3D'
]);

/**
 * What an install renders when no profile says otherwise.
 *
 * Ged, 2026-08-25: *"Native resolution, Legacy Glyph this is the best look,
 * hands down, this needs to be the default and what everyone plays in, any
 * different setting is manually by their hands."*
 *
 * **Derived, never restated.** The two values come from the engine constants
 * that `normalizeResolutionMode` and `normalizeGlyphPipelineMode` already fall
 * back to, so there is exactly one answer to "what does this game look like
 * unconfigured" and it cannot drift into two. The features are `true` because
 * absence means on everywhere in this system - every one is read out of storage
 * as `!== "false"` - so this table and a profile that has never touched a
 * checkbox describe the same renderer.
 *
 * A fresh object each call. It is written onto game loops and onto test
 * fixtures, and a frozen shared one would be a table every caller could edit.
 */
export function shippedDisplayDefaults() {
  const defaults = {
    resolutionMode: DEFAULT_RESOLUTION_MODE,
    glyphPipeline: DEFAULT_GLYPH_PIPELINE_MODE
  };
  for (const feature of RENDER_FEATURES) defaults[feature] = true;
  // The arms and the wrist scope. Not a render feature - it is drawn by the
  // viewmodel path rather than by the advanced grid's switches - but it is
  // `true` for exactly the same reason as the seven above: absence means on, so
  // a profile that has never touched the checkbox and this table describe the
  // same renderer. Added to the table on 2026-08-26, when Ged ruled it into the
  // reset; before that the table stopped where the reset stopped, which made
  // "what does an unconfigured install look like" quietly narrower than it
  // sounded.
  defaults.firstPersonViewmodel = true;
  return defaults;
}

/**
 * Write the shipped defaults onto a target, and report whether anything moved.
 *
 * Deliberately narrow. It touches the two picture settings, the seven renderer
 * features and the first-person viewmodel, and NOTHING else - not the palette,
 * not the character sets, not flicker, not the accessibility profile, not Red
 * Edition. See `renderer/game/DisplayDefaultsMigration.js`, which owns the
 * classification and the argument for it.
 *
 * `fields` narrows it further, and it is what the migration passes. An epoch
 * names the keys IT retires rather than the whole table, so a player who was
 * reset once and then chose something else does not get that choice taken again
 * by the next graphics push. Absent, every field is written - which is what the
 * release-gate capture wants, because "the menu a fresh install opens on" is the
 * whole table by definition.
 */
export function applyShippedDisplayDefaults(target, fields = null) {
  if (!target) return false;
  const defaults = shippedDisplayDefaults();
  const wanted = fields === null ? Object.keys(defaults) : [...fields];
  let moved = false;
  for (const field of wanted) {
    if (!(field in defaults)) continue;
    const value = defaults[field];
    if (target[field] !== value) moved = true;
    target[field] = value;
  }
  return moved;
}

function groupDigits(value) {
  return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/**
 * What the current window will ACTUALLY deliver, as a line the menu prints.
 *
 * This is the surfaced half of a defect no menu can design its way out of. Two
 * ceilings sit under every Character Size and neither one announces itself:
 * `RENDERER_GRID_LIMITS` cuts an over-wide grid and upscales the canvas into
 * the window, and `MAX_SCENE_TEXELS` cuts the glyph supersample. At 4K every
 * size crosses the first - `max` asks for 960x308 and is given 800x256, and the
 * smooth feed asks for 3840x1080 and is given 2730x768 - so the finest picture
 * the menu offers is, on the largest desktops, one being resampled.
 *
 * Neither is worth refusing to offer: a cut grid at full glyph quality is still
 * the finest picture available, it is just not the one the label implies. So
 * the menu states the delivered grid, the delivered supersample, and says when
 * either was cut, rather than printing a number the renderer is not honouring.
 *
 * `isMenu` is deliberately false: the settings screen runs on the menu's own
 * cell, and the figure a player wants is the one gameplay will use.
 *
 * Renamed from `describeRenderQuality` on 2026-08-25 with the control it was
 * named after.
 */
export function describeDeliveredPicture({
  viewportWidth,
  viewportHeight,
  resolutionMode,
  glyphPipeline,
  // Defaults to the shipped behaviour so every existing caller keeps describing
  // the picture it used to describe.
  glyphScreening = true
} = {}) {
  const mode = normalizeResolutionMode(resolutionMode);
  const pipeline = normalizeGlyphPipelineMode(glyphPipeline);
  const layout = resolveRendererLayout({
    viewportWidth: Math.max(1, Number(viewportWidth) || 1),
    viewportHeight: Math.max(1, Number(viewportHeight) || 1),
    mode
  });
  const scene = resolveSceneResolution({
    gridWidth: layout.gridWidth,
    gridHeight: layout.gridHeight,
    mode: pipeline
  });
  const cells = layout.gridWidth * layout.gridHeight;
  const notes = [];
  if (layout.capped) {
    notes.push(`GRID CUT TO FIT (${layout.rawGridWidth}x${layout.rawGridHeight} REQUESTED)`);
  }
  if (scene.clamped) {
    notes.push(`SUPERSAMPLE CUT ${scene.requestedScale}x -> ${scene.sceneScale}x`);
  }
  // Screening is the reduce pass's ordered dither, so a single-pass picture has
  // none whatever the setting says. Stated in the same breath as the two other
  // things the single-pass path does not have, rather than as a second note, so
  // the line does not imply a player choice where there is no choice to make.
  const screeningRequested = glyphScreening !== false;
  const screeningActive = scene.twoPass && screeningRequested;
  if (!scene.twoPass) {
    notes.push('FLAT CHARACTERS: NO STRUCTURAL GLYPHS, SUB-CELL COLOUR OR SCREENING');
  } else if (!screeningRequested) {
    // Deliberately NOT a warning. The two notes above are the renderer
    // declining what the menu offered; this one is a look the player asked for.
    notes.push('GLYPH SCREENING OFF // FLAT TONE');
  }
  const head = `GRID ${layout.gridWidth}x${layout.gridHeight}`
    + `  //  ${groupDigits(cells)} CELLS`
    + `  //  SCENE ${scene.sceneWidth}x${scene.sceneHeight} @ ${scene.sceneScale}x`;
  return Object.freeze({
    mode,
    pipeline,
    gridWidth: layout.gridWidth,
    gridHeight: layout.gridHeight,
    cells,
    sceneWidth: scene.sceneWidth,
    sceneHeight: scene.sceneHeight,
    sceneScale: scene.sceneScale,
    requestedScale: scene.requestedScale,
    gridCapped: layout.capped,
    sceneClamped: scene.clamped,
    twoPass: scene.twoPass,
    // What the player asked for, and what the picture will actually carry. They
    // differ on `legacy`, which is the whole reason the menu greys the control
    // there instead of leaving it looking live.
    glyphScreening: screeningRequested,
    screeningActive,
    // A warning is the renderer DECLINING what the menu offered, and nothing
    // else. A cut grid and a cut supersample are declines. A single-pass frame
    // is not: it is what `legacy` IS, and since 2026-08-25 it is also what a
    // fresh install runs - so counting it here would have painted the shipped
    // picture as a fault on every untouched profile. The same argument was
    // already made for glyph screening being switched off by hand, one branch
    // up; this is that argument applied to the pipeline that made it necessary.
    warning: layout.capped || scene.clamped,
    text: notes.length > 0 ? `${head}  //  ${notes.join('  //  ')}` : head
  });
}

/**
 * Which texture settings this window can actually deliver at a given size, and
 * which it would decline.
 *
 * **This is the mechanism that lets `native` live in Character Size again.**
 * The first ladder's defect was a preset that promised `native` at 9 or 16
 * samples, which `resolveSceneResolution` hands back clamped - and a clamped
 * scene loses two-pass, structural glyphs and sub-cell colour TOGETHER, so the
 * player gets a picture that is cheaper AND worse-processed than the one below
 * it. The old fix was for the size control to move the texture control on the
 * player's behalf. That fix is gone with the control it lived in, because a
 * control that changes another control is exactly the coupling this menu pass
 * exists to delete.
 *
 * What replaces it: the texture options that would be declined are DISABLED in
 * the dropdown, at the current window, with the reason printed underneath. The
 * player is never moved and never silently downgraded, and the menu never
 * offers a pairing the renderer will refuse - which is all three of the things
 * the old preset could not do at once.
 *
 * Asked of the real `resolveSceneResolution` against the real layout rather
 * than computed from the table in this file's header. A second copy of that
 * arithmetic is a place an edit lands and is silently ignored; STATUS.md's
 * seventeenth lesson is that shape exactly.
 */
export function glyphPipelineAvailability({
  viewportWidth,
  viewportHeight,
  resolutionMode
} = {}) {
  const layout = resolveRendererLayout({
    viewportWidth: Math.max(1, Number(viewportWidth) || 1),
    viewportHeight: Math.max(1, Number(viewportHeight) || 1),
    mode: normalizeResolutionMode(resolutionMode)
  });
  const available = Object.create(null);
  for (const mode of Object.keys(GLYPH_PIPELINE_MODES)) {
    const scene = resolveSceneResolution({
      gridWidth: layout.gridWidth,
      gridHeight: layout.gridHeight,
      mode
    });
    available[mode] = !scene.clamped;
  }
  return Object.freeze(available);
}
