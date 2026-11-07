// Core contracts and physics are intentionally renderer-independent.
export {
  DEFAULT_WORLD_METRICS,
  WorldMetrics,
  normalizeWorldMetrics,
  createWorldMetrics,
  isFiniteNumber
} from './core/WorldMetrics.js';

export {
  SceneSnapshot,
  SceneSnapshotValidationError,
  normalizeSceneSnapshot,
  createSceneSnapshot,
  validateSceneSnapshot
} from './core/SceneSnapshot.js';

export { stairProfile, stairSurfaceAt, stairCellBoxes } from './core/StairCells.js';
export { cellSpans } from './core/CellSpans.js';

export { EngineDiagnostics } from './core/EngineDiagnostics.js';

export {
  defaultIsPassable,
  getGridCells,
  getGridDimensions,
  isGridCellInBounds,
  getGridCell,
  isGridCellPassable,
  testGridCircle,
  moveWithGridCollision,
  resolveGridMovement
} from './physics/GridCollision.js';

export { Raycaster } from './physics/Raycaster.js';

export * as GridCollision from './physics/GridCollision.js';

export { AsciiEngine, RendererCapabilityError } from './AsciiEngine.js';
export {
  ENTITY_MESH_ARCHETYPES,
  ENTITY_MESH_ARCHETYPE_NAMES,
  MESH_ACCENT_CHARS,
  MESH_ACCENT_EMISSION_FLOOR,
  // Placement conventions stated as data rather than as prose, so the game's
  // placement code imports the rule instead of re-deriving it from a
  // screenshot. `.` is this package's only export path, so a constant that is
  // not re-exported here does not exist as far as a consumer is concerned.
  //
  // `arc_bolt` needs two of them because neither of its useful anchors is a
  // corner of its own bounding box: REACH is where the bolt TERMINATES (the
  // box runs past it, so scaling against nativeFootprint leaves every bolt
  // short of what it hit) and AXIS_HEIGHT is where the bolt's LINE sits above
  // the box's underside (the box has no foot, so `z` alone would put a
  // chest-height discharge on the pavement).
  ARC_BOLT_AXIS_HEIGHT,
  ARC_BOLT_REACH,
  // `corp_guard` carries a lamp the ENGINE draws and the GAME lights, because
  // only the game knows its own light budget. The offset is where the emitter
  // goes; the drift is how far the lens ever wanders from it across poses, so
  // a game can decide whether one static offset is good enough (it is) without
  // measuring the mesh itself.
  CORP_GUARD_LAMP_DRIFT,
  CORP_GUARD_LAMP_OFFSET,
  STREET_FURNITURE_FACING_HEADING_OFFSET,
  STREET_LAMP_ARM_HEADING_OFFSET
} from './renderer/EntityArchetypes.js';
export { HudGlyphLayer, HUD_PLATE_BIT } from './renderer/HudGlyphLayer.js';

// Display-contract exports: the engine's own resolution and glyph-ramp
// numbers, so a game derives its window-fit grid and its authored night
// minima from the contract instead of restating magic constants. All pure —
// no GL, no DOM.
export {
  GLYPH_LUMA_SCALE,
  MAX_SCENE_TEXELS,
  MAX_SAMPLES_PER_AXIS,
  firstInkDisplayLuminance,
  resolveSceneResolution,
  // The drawable character set. A game writing into the HUD glyph layer needs
  // this: HudGlyphLayer.set maps an unknown character to index 0, so an
  // em-dash or a curly quote in HUD copy silently renders as a BLANK CELL
  // rather than failing. Exported so consumers can validate their own text.
  GLYPH_CHARS,
  canDrawGlyph,
  // The ramp mapping itself, for a game that installs its own character set
  // over AsciiEngine.setLuminanceScale. A set of exactly GLYPH_RAMP_STEPS
  // characters is an identity mapping onto the rungs, so these are what let a
  // consumer ASSERT the two properties its ramp must hold — that the blank
  // cliff has not moved, and that the ordered dither still refuses to promote
  // out of a blank cell — in its own suite, against the same functions the
  // renderer hands the shader every frame rather than a restatement of them.
  GLYPH_RAMP_STEPS,
  BLANK_GLYPH_INDEX,
  buildRampIndices,
  ditherMayPromote,
  glyphIndexForChar
} from './renderer/GlyphPipeline.js';
export {
  PINNED_CELL_BUDGET,
  RENDERER_GRID_LIMITS,
  resolveAtlasLayout
} from './renderer/RendererScalability.js';
export { default as AsciiRendererWebGL, probeRendererCapabilities, describeAdapter, DEFAULT_CONTEXT_ATTRIBUTES } from './renderer/AsciiRendererWebGL.js';
export { applyAsciiDerez } from './renderer/AsciiDerez.js';
export { normalizeViewmodelDrawRanges, MAX_VIEWMODEL_DRAW_RANGES } from './renderer/ViewmodelDrawRanges.js';
export { default as SceneGeometry } from './renderer/SceneGeometry.js';
