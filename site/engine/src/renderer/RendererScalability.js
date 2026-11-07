/**
 * Upgrade 78 renderer scalability contracts.
 *
 * This module is deliberately free of DOM/WebGL dependencies so display-mode
 * transitions can be validated without launching Electron. `GlyphPipeline.js` is
 * held to the same rule, which is why the cell budget below can be derived from
 * its texel ceiling rather than restated here.
 */

import {
  GLYPH_PIPELINE_MODES,
  MAX_SCENE_TEXELS
} from './GlyphPipeline.js';

export const RENDERER_GRID_LIMITS = Object.freeze({ width: 800, height: 450 });

/**
 * The most cells a pinned mode may ask for, and why it is not the constant above.
 *
 * `RENDERER_GRID_LIMITS` is a decision about how many characters the picture is
 * made of. A pinned mode has already made that decision the other way - its
 * whole definition is that the cell does not grow - so the only ceiling left is
 * the engine's own, and that one is real: crossing `MAX_SCENE_TEXELS` steps the
 * scene supersample from 2x to 1x, which switches off `twoPass`, structural
 * glyphs and sub-cell colour together. Past it the picture keeps rendering, gets
 * measurably cheaper, and gets worse - the one failure mode a player would read
 * as the mode not working.
 *
 * So a grid over budget is clamped and the canvas is upscaled to the window,
 * exactly as it is at `RENDERER_GRID_LIMITS`. Slightly soft at full glyph
 * quality beats sharp with three quality passes silently off. It binds at 4K and
 * nowhere below: a 1920x1080 window asks for 1.04M cells and a 2560x1440 one for
 * 1.84M, both inside this, and 3840x2160 asks for 4.15M and is cut to fit.
 *
 * Derived from a NAMED supersample rather than the mode in force, because the
 * layout runs before a pipeline mode is known. A player on a lighter pipeline
 * gets a budget too tight and a picture that is merely coarser than it could
 * be; the reverse would be a silent quality drop, which is the thing being
 * avoided.
 *
 * **It used to read `DEFAULT_GLYPH_PIPELINE_MODE` and must not go back to it.**
 * That was true and cheap while the default was `balanced`; on 2026-08-25 the
 * default became `legacy`, whose supersample is 1, and the same expression
 * would have quadrupled this budget to the whole 8M ceiling. The consequence is
 * not academic: a player who then picks a textured pipeline in the advanced
 * grid - which the menu still offers on any resolution - would be handed a 4K
 * pinned grid of 4,147,200 cells that cannot afford even 2x, and the renderer
 * would drop two-pass, structural glyphs and sub-cell colour together. The
 * budget is a promise about the WORST pipeline a pinned grid may be paired
 * with, and the default is no longer that pipeline.
 *
 * 2x rather than 4x because a pinned grid at 4x would be 524,288 cells, which
 * cuts 1080p - the mode's whole purpose is 1x2 at 1080p, so a budget that
 * cannot deliver it is not a budget, it is a deletion. 3x and 4x on a pinned
 * grid are declined and SAID to be declined, which is `describeDeliveredPicture`'s
 * job; this constant guarantees the rung below them.
 */
export const PINNED_BUDGET_SUPERSAMPLE = GLYPH_PIPELINE_MODES.balanced.sceneScale;
export const PINNED_CELL_BUDGET = Math.floor(
  MAX_SCENE_TEXELS / PINNED_BUDGET_SUPERSAMPLE ** 2
);
export const RENDERER_ATLAS_COLUMNS = 16;
export const RENDERER_ATLAS_ROWS = 16;
export const RENDERER_STATIC_ATLAS_ROWS = 2;
export const RENDERER_STATIC_ATLAS_SLOTS = RENDERER_ATLAS_COLUMNS * RENDERER_STATIC_ATLAS_ROWS;
export const RENDERER_TOTAL_ATLAS_SLOTS = RENDERER_ATLAS_COLUMNS * RENDERER_ATLAS_ROWS;
export const RENDERER_MAX_BILLBOARDS = RENDERER_TOTAL_ATLAS_SLOTS - RENDERER_STATIC_ATLAS_SLOTS;

/** Partition the existing atlas; additional materials do not enlarge textures. */
export function resolveAtlasLayout(staticSlots = RENDERER_STATIC_ATLAS_SLOTS) {
  if (!Number.isInteger(staticSlots) || staticSlots < RENDERER_STATIC_ATLAS_SLOTS ||
      staticSlots > RENDERER_TOTAL_ATLAS_SLOTS / 2 || staticSlots % RENDERER_ATLAS_COLUMNS !== 0) {
    throw new RangeError('staticAtlasSlots must be a multiple of 16 between 32 and 128.');
  }
  return Object.freeze({columns:RENDERER_ATLAS_COLUMNS, totalSlots:RENDERER_TOTAL_ATLAS_SLOTS,
    staticSlots, staticRows:staticSlots / RENDERER_ATLAS_COLUMNS,
    maxBillboards:RENDERER_TOTAL_ATLAS_SLOTS - staticSlots});
}

/**
 * The cells the renderer will draw, densest first.
 *
 * The order is load-bearing and not decoration: anything presenting these as a
 * ladder sorts by `charWidth`, and the names cannot be sorted by - `tiny` is
 * denser than `standard`, which is the sixth of eight. Append in position.
 */
export const RESOLUTION_CONTRACTS = Object.freeze({
  /**
   * One delivered pixel a column, which is the finest grid the engine draws
   * properly and the only mode whose cell does not grow with the window.
   *
   * `pinned` is what buys that, and it is two exemptions rather than a flag with
   * one meaning - see `resolveRendererLayout`, which is the only reader. Both
   * exist because the rules they turn off are rules about how many characters a
   * picture should have, and this mode is the answer "none you can see": at 1x2
   * nothing resolves as a character, and the facility reads as a clean render
   * rather than a character grid.
   *
   * 2 rather than 1 for the height because a cell is taller than it is wide - the
   * projection takes its aspect from the ratio, and the atlas bakes each glyph
   * into a 32x64 box. A 1x1 cell is square, which stretches every letterform to
   * twice its width, and is not offered for that reason.
   *
   * Measured before it was offered, in `captures/frame-cost.json`: 1.04M cells
   * at 1080p and 1.73M at 1440p, costing 0.7-1.2ms of GPU time against 0.16-0.75
   * at the mode below it. Seven percent of a 60fps frame on the machine that
   * measured it - which is submission-bound, so that figure is a floor for weak
   * hardware rather than an estimate of it. That is why this is a rung a player
   * chooses and not what an unconfigured install gets.
   */
  native: Object.freeze({ charWidth: 1, charHeight: 2, atlasCellSize: 128, atlasSize: 2048, pinned: true }),
  max: Object.freeze({ charWidth: 2, charHeight: 3, atlasCellSize: 128, atlasSize: 2048 }),
  hyper: Object.freeze({ charWidth: 3, charHeight: 5, atlasCellSize: 128, atlasSize: 2048 }),
  ultra: Object.freeze({ charWidth: 4, charHeight: 6, atlasCellSize: 128, atlasSize: 2048 }),
  tiny: Object.freeze({ charWidth: 5, charHeight: 8, atlasCellSize: 128, atlasSize: 2048 }),
  standard: Object.freeze({ charWidth: 7, charHeight: 12, atlasCellSize: 64, atlasSize: 1024 }),
  large: Object.freeze({ charWidth: 10, charHeight: 18, atlasCellSize: 64, atlasSize: 1024 }),
  dynamic: Object.freeze({ dynamic: true, atlasCellSize: 64, atlasSize: 1024 })
});

/**
 * Maximum look angle above and below the horizon.
 *
 * Pitch is stored and serialised in grid rows, but the camera converts it to an
 * angle by dividing by the grid height, so a flat row clamp gave a different
 * look range at every resolution: 33.3 degrees at 720p, 27.8 at 1080p and only
 * 20.8 at 1440p. This is the 1080p value, which is what the game shipped
 * feeling like; the row limit is now derived from it per resolution instead.
 */
export const MAX_PITCH_RADIANS = 0.4848;

export function resolvePitchLimitRows(gridHeight, fov = Math.PI / 3) {
  const height = Math.max(1, Number(gridHeight) || 1);
  const effectiveFov = Number.isFinite(fov) && fov > 0.01 ? fov : Math.PI / 3;
  return (MAX_PITCH_RADIANS / effectiveFov) * height;
}

/**
 * The cell an install runs when nothing in a profile says otherwise.
 *
 * Ged, 2026-08-25: *"Native resolution, Legacy Glyph this is the best look,
 * hands down, this needs to be the default and what everyone plays in."*
 *
 * **There is exactly one answer to "what does this game look like unconfigured",
 * and it is this constant read through `normalizeResolutionMode` below.** The
 * fallback used to be `'max'`, so an ABSENT stored mode and a CORRUPT one
 * landed on the grid while the initialisers landed wherever they were written -
 * two defaults for one question, which STATUS.md's `spawnSettings` recurrence
 * names precisely: *a default that differs from production is a fixture whether
 * or not anybody meant to write one.* The correction there was to make the
 * production default BE the fallback, so getting it wrong stops being possible,
 * and that is what this is.
 */
export const DEFAULT_RESOLUTION_MODE = 'native';

export function normalizeResolutionMode(mode) {
  return Object.prototype.hasOwnProperty.call(RESOLUTION_CONTRACTS, mode)
    ? mode
    : DEFAULT_RESOLUTION_MODE;
}

export function getResolutionContract(mode) {
  return RESOLUTION_CONTRACTS[normalizeResolutionMode(mode)];
}

export function resolveRendererLayout({
  viewportWidth,
  viewportHeight,
  mode = DEFAULT_RESOLUTION_MODE,
  isMenu = false,
  isSmallCapsule = false,
  bypassAspectRatio = false,
  screenshotMode = false
}) {
  const width = Math.max(1, Number(viewportWidth) || 1);
  const height = Math.max(1, Number(viewportHeight) || 1);
  const normalizedMode = normalizeResolutionMode(mode);
  const contract = getResolutionContract(normalizedMode);
  const targetRatio = 16 / 9;

  let renderWidth = width;
  let renderHeight = height;
  if (!bypassAspectRatio) {
    if (width / height > targetRatio) {
      renderWidth = height * targetRatio;
    } else {
      renderHeight = width / targetRatio;
    }
  }

  const scaleFactor = Math.max(1, Math.sqrt(renderHeight / 450));
  let charWidth;
  let charHeight;

  if (isSmallCapsule) {
    charWidth = 5;
    charHeight = 9;
  } else if (isMenu) {
    charWidth = 10;
    charHeight = 18;
  } else if (contract.dynamic) {
    charHeight = Math.max(6, Math.min(24, Math.floor(renderHeight / 80)));
    charWidth = Math.max(4, Math.min(14, Math.floor(charHeight * 0.58)));
  } else {
    charWidth = contract.charWidth;
    charHeight = contract.charHeight;
  }

  // Whether the cell settled above is the CONTRACT's at all. `isSmallCapsule`
  // and `isMenu` each state their own and never read it, and that is what makes
  // the two exemptions below conditional rather than absolute.
  const cellIsFromContract = !isMenu && !isSmallCapsule;

  // The boost keeps the column count roughly constant as the window grows, so it
  // is skipped by the two modes whose definition is about the cell instead:
  // `dynamic` sizes its own from the window above, and a pinned cell that got
  // multiplied would simply be the next mode down - at 1080p the 1.55x factor
  // turns 1x2 into 2x3, which is `max`, and the rung would not exist.
  //
  // Both of those reasons are statements about the CONTRACT's cell, so neither
  // survives a branch that did not use it. Tested against `contract.dynamic` and
  // `contract.pinned` alone - which is how this shipped - a MENU under `native`
  // or `dynamic` kept its raw 10x18 while every other mode grew to 18x32 at
  // 1440p. That is the same front end at half the linear size: menus are laid
  // out in cells, so twice the columns is half the picture, and on a 3440x1440
  // display it read as a small box in the middle of a large black screen. The
  // grid clamp below already had this right; this is that same condition,
  // written once so the two cannot drift apart again.
  const cellResistsScaling = isSmallCapsule
    || (cellIsFromContract && (contract.dynamic || contract.pinned));
  if (!cellResistsScaling) {
    charWidth = Math.max(charWidth, Math.round(charWidth * scaleFactor));
    charHeight = Math.max(charHeight, Math.round(charHeight * scaleFactor));
  }

  if (isMenu && Math.floor(renderHeight / charHeight) < 42) {
    charHeight = Math.max(6, Math.floor(renderHeight / 42));
    charWidth = Math.max(4, Math.round(charHeight * (10 / 18)));
  }

  const rawGridWidth = Math.max(1, Math.floor(renderWidth / charWidth));
  const rawGridHeight = Math.max(1, Math.floor(renderHeight / charHeight));
  let gridWidth = rawGridWidth;
  let gridHeight = rawGridHeight;

  // A pinned mode answers to the engine's ceiling instead of the game's, for the
  // reason `PINNED_CELL_BUDGET` gives. Clamping it here as well would put a
  // 1920-column grid back to 800 and stretch the canvas over the window, which
  // is individually legible cells arrived at by accident - the deresolution
  // effect the mode exists to leave behind.
  //
  // `isMenu` and `isSmallCapsule` set their own cell above and never used the
  // contract's, so a pinned mode is not pinned in either of them and takes the
  // ordinary clamp with everything else - which is the same reason the boost
  // above applies there, and the same condition.
  const cellIsPinned = contract.pinned && cellIsFromContract;
  if (cellIsPinned) {
    const cells = gridWidth * gridHeight;
    if (!screenshotMode && cells > PINNED_CELL_BUDGET) {
      const cellScale = Math.sqrt(PINNED_CELL_BUDGET / cells);
      gridWidth = Math.max(40, Math.floor(gridWidth * cellScale));
      gridHeight = Math.max(30, Math.floor(gridHeight * cellScale));
    }
  } else if (!isMenu && !screenshotMode &&
      (gridWidth > RENDERER_GRID_LIMITS.width || gridHeight > RENDERER_GRID_LIMITS.height)) {
    const gridScale = Math.min(
      RENDERER_GRID_LIMITS.width / gridWidth,
      RENDERER_GRID_LIMITS.height / gridHeight
    );
    gridWidth = Math.max(40, Math.floor(gridWidth * gridScale));
    gridHeight = Math.max(30, Math.floor(gridHeight * gridScale));
  }

  const displayWidth = rawGridWidth * charWidth;
  const displayHeight = rawGridHeight * charHeight;
  return Object.freeze({
    mode: normalizedMode,
    charWidth,
    charHeight,
    gridWidth,
    gridHeight,
    rawGridWidth,
    rawGridHeight,
    canvasWidth: gridWidth * charWidth,
    canvasHeight: gridHeight * charHeight,
    displayWidth,
    displayHeight,
    left: Math.floor((width - displayWidth) / 2),
    top: Math.floor((height - displayHeight) / 2),
    renderWidth,
    renderHeight,
    scaleFactor,
    atlasCellSize: contract.atlasCellSize,
    atlasSize: contract.atlasSize,
    capped: gridWidth !== rawGridWidth || gridHeight !== rawGridHeight
  });
}

export function resolveRendererBudgets({ mode = DEFAULT_RESOLUTION_MODE, mapWidth = 20, mapHeight = 18 } = {}) {
  const normalizedMode = normalizeResolutionMode(mode);
  const areaScale = Math.max(1, (Math.max(1, mapWidth) * Math.max(1, mapHeight)) / (20 * 18));
  const facilityScale = Math.max(0.68, Math.min(1, 1 / Math.sqrt(areaScale)));
  // `native` sits with the dense pair rather than falling through to 1. The
  // fallthrough would have given the densest grid in the table the *largest*
  // effect budget, which is the ladder backwards at the rung least able to
  // afford it.
  const resolutionScale = ['native', 'max', 'hyper'].includes(normalizedMode) ? 0.78
    : ['ultra', 'tiny'].includes(normalizedMode) ? 0.88
      : 1;
  const effectScale = Math.max(0.58, Math.min(1, facilityScale * resolutionScale));

  return Object.freeze({
    mode: normalizedMode,
    effectScale,
    maxBillboards: RENDERER_MAX_BILLBOARDS,
    maxLights: 41,
    maxReactiveSurfaces: Math.max(7, Math.round(12 * effectScale))
  });
}
