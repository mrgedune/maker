import AsciiRendererWebGL from './renderer/AsciiRendererWebGL.js';
import { RendererCapabilityError } from './renderer/AsciiRendererWebGL.js';
import { RENDERER_STATIC_ATLAS_SLOTS } from './renderer/RendererScalability.js';
import { HudGlyphLayer } from './renderer/HudGlyphLayer.js';
import { canDrawGlyph, firstInkDisplayLuminance, glyphIndexForChar } from './renderer/GlyphPipeline.js';
import { normalizeSceneSnapshot } from './core/SceneSnapshot.js';
import { stairProfile, stairCellBoxes } from './core/StairCells.js';
import { cellSpans } from './core/CellSpans.js';
import { DEREZ_CELL_TYPE, buildDerezCellMesh, readCellDerez } from './renderer/DerezCells.js';
import {
  ENTITY_MESH_ARCHETYPES,
  ENTITY_MESH_ARCHETYPE_NAMES,
  MESH_ACCENT_CHARS,
  MESH_ACCENT_EMISSION_FLOOR,
  applyEntityMeshPresentation
} from './renderer/EntityArchetypes.js';

const ENGINE_FLOOR_Z = 0.5;
// Grid cell value 9 is reserved by SceneGeometry, so slot 8 is skipped.
const WALL_SLOT_START = 9;

// Per-entity `scale` bounds. Deliberately wider than the renderer's
// renderScale clamp ([0.25, 2], a Liminal presentation guard) because facade
// scenes own their scale story; the registration-level knob is validated
// separately and multiplies on top.
const MESH_ENTITY_MIN_SCALE = 0.05;
const MESH_ENTITY_MAX_SCALE = 8;

// The options object handed to archetype builders on the renderer's 30 Hz
// entity tick. Module scratch, reused per build: builders read it
// synchronously and never retain it. colorResolver is NEVER the renderer's
// sprite-template resolver — that override (which Liminal's tiers use) would
// let a same-name billboard-fallback sprite silently repaint a mesh. It is
// either null (no palette registered, no accent on the entity: builds stay
// byte-identical to the pre-palette engine) or the registration's own
// palette/accent resolver, set per build in buildRegisteredMesh.
// paletteResolver mirrors that: true exactly when colorResolver is a
// registration's palette/accent resolver, which is what unlocks the
// builders' paletteOnly resolveMaterial call sites (hunter mechanism/hull/
// hazard) — chars that must never route through a sprite-template resolver.
const MESH_BUILDER_OPTIONS = { viewerDistance: Infinity, colorResolver: null, paletteResolver: false };

const MESH_ACCENT_CHAR_SET = new Set(MESH_ACCENT_CHARS);

// LOD transition presentation the facade always engages (the renderer's
// default stays off, keeping direct consumers byte-identical — the decision
// and its reason live on setEntityLodTransition): ~0.75 world units of
// demote-side hysteresis so strafing on a LOD boundary cannot strobe tiers
// at the 30 Hz entity tick, and a 0.25 s triangle-dissolve handoff across
// the mesh<->billboard boundary instead of a frame-discrete swap (the
// billboard pops in under the dissolving mesh — accepted).
const MESH_LOD_HYSTERESIS_WORLD = 0.75;
const MESH_LOD_DISSOLVE_MS = 250;

/**
 * Browser-facing facade for the WebGL ASCII renderer.
 *
 * It owns the conversion between the portable SceneSnapshot coordinate system
 * (X/Y horizontal, Z up) and the preserved renderer internals (X/Y horizontal,
 * Z down). Games call this class; they never need to reach renderer globals.
 */
export class AsciiEngine {
  /**
   * @param {object} options
   * @param {number} [options.shadowFadeWidth=0] Optional display-luminance fade
   *   above a density ramp's first visible glyph. Zero preserves its hard cutoff.
   * @param {object} [options.contextAttributes] Extra WebGL2 context
   *   attributes, merged over the renderer's own defaults. Optional and
   *   omitted by every existing consumer, so behaviour is unchanged without
   *   it. `powerPreference: 'high-performance'` is the case this exists for -
   *   on a hybrid laptop the browser may otherwise pick the integrated GPU,
   *   and the choice can only be made at context creation.
   * @param {object} [options.spriteAtlas] Opt-in sprite atlas upgrades, all off
   *   when omitted: `recycle: true` hands the cells of images no longer on
   *   screen to new ones, so a scene can draw any number of different sprite
   *   images over time (not 224 for the engine's life) and any number of
   *   sprites per frame; `mirror: true` lets an entity's `mirror: true` draw
   *   its sprite flipped left to right from the same image; `cellSize: 256`
   *   (or 64, 128) sets the atlas cell size, the pixel detail each sprite keeps.
   *   See docs/sprite-atlas.md.
   */
  /** Asynchronous startup, reusing programs linked on this canvas's own context. */
  static async create(options = {}) {
    if (!options.canvas) throw new TypeError('AsciiEngine requires a canvas.');
    const discard = await AsciiRendererWebGL.prepare(options.canvas, options);
    try { return new this(options); }
    finally { discard(); }
  }

  constructor({
    canvas, gridWidth = 96, gridHeight = 54, glyphPipeline = 'balanced', shadowFadeWidth = 0, incrementalGrid = false,
    diagnostics = null, contextAttributes = undefined, staticAtlasSlots = undefined,
    darkWorldGlyphs = false, deterministic = false, spriteAtlas = undefined,
  } = {}) {
    if (!canvas) throw new TypeError('AsciiEngine requires a canvas.');

    this.canvas = canvas;
    this.diagnostics = diagnostics;
    this.materials = new Map();
    this.materialSlots = new Map();
    this.nextMaterialSlot = WALL_SLOT_START;
    this.materialRevision = 0;
    // Volumetric mesh entities: the registered archetype uses, the content
    // pack installed over renderer.setEntityContent once the first one exists,
    // and the persistent per-id renderer entities. The pool is the amortization
    // contract: EntityAnimation keys its per-entity tracks on OBJECT IDENTITY
    // (a WeakMap), so a snapshot entity id must map to the same mutable object
    // frame after frame — fresh objects would reset gait, state transitions
    // and the 650 ms spawn ramp every frame.
    this.meshArchetypes = new Map();
    this.meshEntityPool = new Map();
    this.meshFrameStamp = 0;
    this.meshContent = null;
    this.meshLodDistances = null;
    this.meshLodScratch = { full: 12, simplified: 19 };
    this.meshLodTransitionScratch = { hysteresis: 0, dissolveMs: MESH_LOD_DISSOLVE_MS };
    // Static scene preparation (renderer map, box features, material table) is
    // cached by the normalized grid object. Entities and lights are re-prepared
    // every render call - they are the cheap, per-frame half of a scene - so a
    // game can rebuild its snapshot each frame around one stable grid without
    // triggering a static mesh or light-visibility rebuild.
    this.staticSceneCache = new WeakMap();
    this.lastScene = null;
    this.lastPrepared = null;
    this.cellWidth = 8;
    this.cellHeight = 13;
    this.disposed = false;

    this.renderer = new AsciiRendererWebGL(canvas, gridWidth, gridHeight, { contextAttributes, staticAtlasSlots, darkWorldGlyphs });
    this.deterministic = deterministic === true;
    if (this.deterministic) this.renderer.setDeterministic(true);
    this.renderer.setGlyphPipelineMode(glyphPipeline);
    // Optional display-luminance interval above first ink; zero preserves legacy contrast.
    this.renderer.shadowFadeWidth = Math.max(0, Math.min(0.3, finiteOr(shadowFadeWidth, 0)));
    this.renderer.setViewmodelEnabled(false);
    // Facade scenes want the best 8 airlight lights, not the first 8.
    this.renderer.setVolumetricMeritSelection(true);
    this.spriteMirroring = false;
    if (spriteAtlas !== undefined && spriteAtlas !== null) {
      if (typeof spriteAtlas !== 'object') throw new TypeError('spriteAtlas must be an object.');
      if (spriteAtlas.recycle === true) this.renderer.setSpriteCellRecycling(true);
      if (spriteAtlas.mirror === true) {
        this.spriteMirroring = true;
        this.renderer.setSpriteMirroring(true);
      }
      // Before the first resize below, which is where it takes effect.
      if (spriteAtlas.cellSize !== undefined) this.renderer.setAtlasCellSize(spriteAtlas.cellSize);
    }
    if (incrementalGrid === true) this.setIncrementalGrid(true);
    this.resize({ gridWidth, gridHeight, cellWidth: this.cellWidth, cellHeight: this.cellHeight });
  }

  registerMaterial(id, definition = {}) {
    this.assertLive();
    if (id === null || id === undefined || id === '') throw new TypeError('Material id is required.');
    const color = colorToRgb(definition.color, [160, 170, 178]);
    const glyph = typeof definition.glyph === 'string' && definition.glyph.length > 0 ? definition.glyph[0] : '█';
    const properties = {
      roughness: finiteOr(definition.roughness, 0.65),
      reflectivity: finiteOr(definition.reflectivity, 0),
      emission: finiteOr(definition.emission, 0),
      lightResponse: finiteOr(definition.lightResponse, 0.7)
    };
    // Geometry-side tiling the texture opts into (courseHeight /
    // courseVariation / street doorEvery). Null — every material that sets
    // none of them — keeps wall geometry on its historical per-unit course
    // path, byte-identical.
    const courseOptions = materialCourseOptions(definition.texture);
    this.materials.set(id, { id, color, glyph, properties, courseOptions });
    this.ensureMaterialSlot(id);
    const texture = createMaterialTexture(definition.texture, color, properties);
    this.renderer.registerMaterial(id, texture ? {
      getColor: texture.getColor,
      getChar: () => glyph,
      getProperties: texture.getProperties
    } : {
      getColor: () => color,
      getChar: () => glyph,
      getProperties: () => properties
    });
    this.materialRevision++;
    this.staticSceneCache = new WeakMap();
    return this;
  }

  /**
   * The engine-rendered HUD layer: a coarse glyph grid composited over the
   * finished frame by the final shader pass, so interface text stays ASCII
   * and stays readable at every resolution contract. The layer resizes with
   * the canvas; draw into it each frame (clear/set/text/bar) and render()
   * uploads it when it changed. Returns the same layer on repeat calls.
   */
  getHudLayer(options = {}) {
    this.assertLive();
    if (!this.hudLayer) {
      this.hudLayer = new HudGlyphLayer(options);
      this.hudLayer.resize(this.canvas.width, this.canvas.height);
    }
    return this.hudLayer;
  }

  /** Detach and disable the HUD layer. */
  clearHudLayer() {
    this.hudLayer = null;
    this.renderer.setHudCells(null);
    return this;
  }

  /**
   * A picture of the caller's own over the finished frame, composited by the
   * final pass with the HUD (after bloom, tone and fog, so none of them
   * washes it out) and over the HUD's glyph cells: a reticle drawn in lines
   * finer than the HUD's cells, say. `source` is anything texImage2D takes
   * (a canvas, an ImageBitmap), drawn one texel a pixel with its top left at
   * (x, y) in canvas pixels; its alpha is straight. It is uploaded at the
   * next render(), so draw into it and call this again every frame it
   * changes. It is in readPixels() like the rest of the frame. Pass null to
   * remove it.
   */
  setHudImage(source, { x = 0, y = 0 } = {}) {
    this.assertLive();
    this.renderer.setHudImage(source, { x, y });
    return this;
  }

  /**
   * The effective first-ink display luminance of the ACTIVE glyph ramp: the
   * lowest GLYPH_LUMA_SCALE rung whose glyph is not blank, computed from the
   * renderer's live luminance scale exactly the way buildRampIndices maps it
   * to the shader each frame. Below this display luminance a cell renders as
   * EMPTY — the ramp's blank cliff — so authored night minima (ambient
   * floors, sky gradients meant to stay visible) should be pinned to this
   * number, not to a rediscovered constant. 0.22 for the engine's default
   * 'blocks' ramp.
   */
  getFirstInkLuminance() {
    this.assertLive();
    return firstInkDisplayLuminance(this.renderer.luminanceScale);
  }

  /**
   * Install the density ramp's character set: which glyph the reduce pass
   * draws at each of the thirteen GLYPH_LUMA_SCALE rungs.
   *
   * ADDITIVE AND OPT-IN. The renderer's default is unchanged (' ░▒▓█') and a
   * consumer that never calls this renders byte-identically to the engine
   * before the setter existed. Nothing in GLSL changed to make it work — the
   * ramp has always been a per-frame uniform (buildRampIndices ->
   * u_charIndices); it simply had no public way in.
   *
   * ### What it is for: the shape of the bottom of the ramp
   *
   * A SET OF EXACTLY THIRTEEN CHARACTERS IS AN IDENTITY MAPPING onto the
   * rungs, because buildRampIndices takes position = floor(i / 12 * length).
   * That is the reason this setter is worth having: at thirteen it stops
   * being "pick a texture" and becomes per-rung control, which is the only
   * lever that reaches the ramp's one visible discontinuity.
   *
   * That discontinuity is the blank cliff. With the shipped five-character
   * set, rungs 0-2 draw space and rung 3 draws the light shade, so a cell
   * crossing display luminance 0.22 goes from painting nothing to painting
   * its whole area. Measured against the baked atlas: at every cell size the
   * engine ships, the shade glyphs minify past GLYPH_COVERAGE_THRESHOLD and
   * draw SOLID (their ink is itself a four-pixel dither, which dies at mip
   * level 2 - any cell narrower than 8px or shorter than 16px). So all four
   * of the shade rungs paint an identical full cell, every interior rung
   * boundary is worth zero, and 100% of the ramp's visible quantisation sits
   * in that single step - 56/255 of it, at a fixed iso-luminance contour. On
   * a smooth sky gradient that contour is a hard horizontal line.
   *
   * The quadrant glyphs do not have that problem. Their ink is one contiguous
   * rectangle, drawn procedurally so its coverage is exact rather than
   * dependent on a font face, so it survives minification: '▖' measures 30%
   * of the cell at 5x8, 50% at 1x2, and only goes solid at 1x1 where a cell
   * is a single pixel and nothing can be partial. Putting one on rung 3
   * halves the step without moving the cliff:
   *
   *   set                cell     first ink   hard edge at 0.22
   *   ' ░▒▓█'            5x8      0.22        56/255
   *   '   ▖░▒▒▒▓▓███'    5x8      0.22        17/255
   *   ' ░▒▓█'            1x2      0.22        56/255
   *   '   ▖░▒▒▒▓▓███'    1x2      0.22        28/255
   *
   * THE CLIFF ITSELF MUST NOT MOVE, and this does not move it: rungs 0-2 stay
   * blank, firstInkDisplayLuminance still answers 0.22, and every cell below
   * it paints exactly what it painted before. A ramp that inks lower would
   * ink shadowed walls, which sit at 0.15-0.22 - see ditherMayPromote for the
   * measurement. Above the cliff the reshaped ramp paints strictly LESS ink
   * than the shipped one, never more, so a dark scene's pure-black pixel
   * count can only rise.
   *
   * The cost is that rung 3 is now ink, so the ordered dither may promote out
   * of it (ditherMayPromote turns on the lower rung's glyph, and '▖' is not
   * blank). Across 0.22-0.30 the dither therefore blends half-cells into full
   * cells, one cell in sixteen at a time - a 38/255 per-cell step at 1x2. That
   * is the dither doing its ordinary job on a rung where it was previously a
   * no-op, and it is scattered on the Bayer lattice rather than aligned into a
   * contour. It is NOT the blank-cell promotion ditherMayPromote forbids: that
   * rule is untouched and still refuses to ink a blank cell at any luminance.
   *
   * The right set is cell-size dependent, which is why this is a setter and
   * not a new default. At 1x1 no glyph in the atlas is partial, so no ramp
   * helps and the shipped set is correct. Throws rather than silently blanking
   * the world if the atlas cannot draw a character - glyphIndexForChar answers
   * 0 (space) for anything it does not know, so an unnoticed typo would raise
   * the cliff instead of lowering it.
   */
  setLuminanceScale(characterSet) {
    this.assertLive();
    if (typeof characterSet !== 'string' || characterSet.length === 0) {
      throw new TypeError('setLuminanceScale requires a non-empty character-set string.');
    }
    const undrawable = [...characterSet].filter((char) => !canDrawGlyph(char));
    if (undrawable.length > 0) {
      throw new TypeError(
        `setLuminanceScale: the glyph atlas cannot draw ${JSON.stringify(undrawable.join(''))}.`
      );
    }
    this.renderer.luminanceScale = characterSet;
    // The temporal glyph hysteresis holds glyph INDICES from the previous
    // frame. Those indices addressed the old ramp; keeping them would hold
    // stale marks until each cell's luminance moved enough to release.
    this.renderer.invalidateCellHistory?.();
    return this;
  }

  /**
   * Opt-in incremental grid edits (also the constructor's incrementalGrid
   * option, and switched on by the first updateCells call). The static mesh
   * is then assembled from cached per-cell, floor and per-feature fragments,
   * so a grid that differs from the last one by a few cells rebuilds only
   * those cells and their neighbours. The mesh is identical to a full build.
   * Returns the engine.
   */
  setIncrementalGrid(enabled) {
    this.assertLive();
    this.renderer.sceneGeometry?.setFragmentCaching?.(enabled === true);
    this.incrementalGrid = enabled === true;
    return this;
  }

  /**
   * A copy of a grid with some cells replaced, for the next scene snapshot:
   *
   *   grid = engine.updateCells(grid, [{ x, y, cell }, ...]);
   *
   * grid is a normalized snapshot grid (scene.grid) or a cells[y][x] array.
   * Only the edited rows are copied; the others are shared, and the source is
   * never changed. cell is any grid cell value (0 opens it). Turns on
   * incremental grid edits, so drawing the result rebuilds only the edited
   * cells and their neighbours. Throws on an edit outside the grid.
   */
  updateCells(grid, edits) {
    this.assertLive();
    const source = Array.isArray(grid) ? { cells: grid, revision: 0 } : grid;
    if (!source || !Array.isArray(source.cells) || source.cells.length === 0) {
      throw new TypeError('updateCells requires a grid (scene.grid or a cells[y][x] array).');
    }
    if (!Array.isArray(edits)) throw new TypeError('updateCells requires an array of { x, y, cell } edits.');
    const height = source.cells.length;
    const width = source.cells[0].length;
    const rows = source.cells.slice();
    const copied = new Set();
    for (const edit of edits) {
      const x = edit?.x, y = edit?.y;
      if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x >= width || y >= height) {
        throw new RangeError(`updateCells: (${x}, ${y}) is outside the ${width}x${height} grid.`);
      }
      if (!copied.has(y)) { rows[y] = [...rows[y]]; copied.add(y); }
      rows[y][x] = edit.cell ?? 0;
    }
    if (!this.incrementalGrid) this.setIncrementalGrid(true);
    return Object.freeze({
      cells: Object.freeze(rows.map(row => (Object.isFrozen(row) ? row : Object.freeze([...row])))),
      width,
      height,
      revision: Number.isInteger(source.revision) && source.revision >= 0 ? source.revision : 0
    });
  }

  /**
   * Switch the glyph pipeline at runtime ('legacy', 'balanced', 'high',
   * 'ultra'). This is the main quality dial after construction.
   */
  setGlyphPipeline(mode) {
    this.assertLive();
    this.renderer.setGlyphPipelineMode(mode);
    this.renderer.invalidateCellHistory?.();
    return this;
  }

  /**
   * Register a sprite type. Two forms:
   *
   * Single glyph (the original contract, unchanged):
   *   { glyph, color, emission, size, roughness, lightResponse }
   *   — one solid square of `color`.
   *
   * Pixel art:
   *   { art, palette?, color, emission, size, roughness, lightResponse }
   *   — `art` is an array of strings, one character per pixel, space =
   *   transparent. Ragged rows are padded with spaces HERE, at registration,
   *   so the renderer's bake always sees a rectangle. `palette` maps a
   *   character to { color, emission?, roughness?, lightResponse? };
   *   characters missing from the palette fall back to the sprite's
   *   top-level color and material. Per-character emission rides the
   *   material texture (getProperties), not the binary isSelfLuminous flag,
   *   so an accent character can genuinely glow brighter than the body.
   *
   * Both forms also take:
   *   preserveArt — opt-in for authored screen lettering. Keep the lit pixel
   *     art through glyph reduction instead of rebuilding it as edge strokes.
   *     Projection, occlusion and material lighting still apply. Default false.
   *   aspect — quad width as a multiple of its height (default 1, square).
   *     Entities can override it per instance via `entity.aspect`.
   *   plane — 'billboard' (default, camera-facing), 'flat' (laid horizontally
   *     at the entity's z, lifted 0.02 world units so it never z-fights the
   *     floor), or 'upright' (standing vertically and facing a FIXED world
   *     direction instead of the camera — a sign bolted to a wall, nudged
   *     0.02 out along its normal for the same anti-z-fight reason).
   *   'camera' aligns to the complete camera plane, including pitch, for
   *   attached instrument displays; its art can opt into preserveArt.
   *   heading — default facing for `plane: 'upright'`, radians; 0 faces +x
   *     and positive turns toward +y, identical to camera.yaw and to a mesh
   *     entity's heading. Entities override it per instance via
   *     `entity.heading`, which is the usual case: one registered sign
   *     template gets mounted on walls facing all four ways. Ignored by the
   *     other two planes.
   */
  registerSprite(id, definition = {}) {
    this.assertLive();
    if (id === null || id === undefined || id === '') throw new TypeError('Sprite id is required.');
    const color = colorToRgb(definition.color, [255, 255, 255]);
    const emission = finiteOr(definition.emission, 0);
    const size = Math.max(0.05, finiteOr(definition.size, 0.65));

    const art = normalizeSpriteArt(definition.art);
    let template;
    if (!art) {
      const glyph = typeof definition.glyph === 'string' && definition.glyph.length > 0 ? definition.glyph[0] : '◆';
      template = {
        art: [glyph],
        sizeScale: size,
        zOffset: 0,
        // Facade sprites are a fixed glyph and color; the atlas can cache their
        // cells instead of re-rasterizing them every frame.
        static: true,
        isSelfLuminous: () => emission > 0,
        getBaseColor: () => color,
        getProperties: () => ({
          roughness: finiteOr(definition.roughness, 0.45),
          emission,
          lightResponse: finiteOr(definition.lightResponse, 0.72)
        })
      };
    } else {
      // Pixel-art form. The palette is resolved to per-character Maps once,
      // here, so the atlas bake stays a plain lookup per texel.
      const baseProperties = {
        roughness: finiteOr(definition.roughness, 0.45),
        emission,
        lightResponse: finiteOr(definition.lightResponse, 0.72)
      };
      const paletteColors = new Map();
      const paletteProperties = new Map();
      if (definition.palette && typeof definition.palette === 'object') {
        for (const [char, entry] of Object.entries(definition.palette)) {
          if (!entry || typeof entry !== 'object' || char.length === 0) continue;
          paletteColors.set(char, colorToRgb(entry.color, [color.r, color.g, color.b]));
          paletteProperties.set(char, {
            roughness: finiteOr(entry.roughness, baseProperties.roughness),
            emission: finiteOr(entry.emission, emission),
            lightResponse: finiteOr(entry.lightResponse, baseProperties.lightResponse)
          });
        }
      }
      template = {
        art,
        sizeScale: size,
        zOffset: 0,
        // Art and palette are fixed at registration, so the per-type atlas cell
        // cache applies exactly as it does to the single-glyph form.
        static: true,
        // Always false for art sprites: the binary whole-sprite flag would
        // flatten every character to the same full glow and defeat the
        // palette. Emission — top-level and per-character — reaches the
        // deferred pass per texel through the material texture instead.
        isSelfLuminous: () => false,
        getBaseColor: (_sprite, _texY, _t, _texX, char) => paletteColors.get(char) || color,
        getProperties: (_sprite, _texY, _t, _texX, char) => paletteProperties.get(char) || baseProperties
      };
    }

    // Quad shape: `aspect` widens the quad (width = height * aspect, entities
    // can override per instance), `plane: 'flat'` lays it horizontally at the
    // entity's z — a decal, a rug, a shadow blob — and `plane: 'upright'`
    // stands it vertically facing `heading` instead of the camera. Attached
    // only when the registration asks for them, so templates registered
    // without any of them keep their historical shape byte-for-byte.
    if (definition.aspect !== undefined) {
      template.aspect = Math.max(0.05, finiteOr(definition.aspect, 1));
    }
    if (definition.plane !== undefined) {
      template.plane = definition.plane === 'flat' || definition.plane === 'upright' || definition.plane === 'camera'
        ? definition.plane
        : 'billboard';
    }
    if (definition.heading !== undefined) {
      template.heading = finiteOr(definition.heading, 0);
    }
    // Opt-in exact albedo for a sprite sharing a mesh palette. Old art keeps
    // the historical atlas gain when this field is omitted.
    if (Number.isFinite(definition.colorBoost)) template.colorBoost = Math.max(0, Math.min(4, definition.colorBoost));
    if (definition.preserveArt === true) template.preserveArt = true;
    this.renderer.registerSprite(id, template);
    return this;
  }

  /**
   * Register a volumetric mesh archetype use. Scene entities select it with
   * `{ mesh: id, ... }` (see prepareMeshEntities for the entity fields).
   *
   *   id                  — the name snapshot entities reference.
   *   definition.archetype — built-in archetype to bind; defaults to `id`
   *     itself, so `registerMeshArchetype('warden')` just works. Unknown
   *     names throw, listing what exists — a typo fails at registration,
   *     not as an invisible enemy.
   *   definition.scale    — the ONE registration-level scale knob. The
   *     archetypes are authored at Liminal interior scale (a humanoid is
   *     ~1 renderer cell tall; see getMeshArchetypes() for measured native
   *     sizes); this adapts one to this game's world without touching
   *     archetype data. Uniform, about the floor contact point.
   *   definition.tint     — default RGB multiplier tint for every entity of
   *     this use (same forms as material colors: '#rrggbb', {r,g,b} 0-255,
   *     [r,g,b] 0-1). Per-entity `tint` overrides it.
   *   definition.palette  — material overrides keyed by the char hints the
   *     archetype builders pass to resolveMaterial ('█' body — the default
   *     hint every unhinted material gets — '☼' optic, '=' visor/signal,
   *     '◆' core, '!' warning, '#' undersuit/shell, 'O' armor; which hints
   *     an archetype uses is authored per builder). Each entry is
   *     { color?, emission?, roughness?, lightResponse? }: color replaces
   *     the authored color EXACTLY (no tint-style brightness rescue, unlike
   *     `tint` this can brighten), the scalars replace the per-vertex
   *     material floats the G-buffer receives. The archetypes author every
   *     material at emission 1, which takes the deferred shader's binary
   *     pure-emissive branch (lightFS: isSelfLuminous > 0.95 — albedo only,
   *     no lights); a body entry with emission ~0.15 drops the mesh into the
   *     lit path, which is what makes a machine sit IN the scene's light.
   *     Chars without an entry keep their authored material; no palette
   *     keeps builds byte-identical to the pre-palette engine.
   *
   * Per-entity `accent` (see prepareMeshEntities) recolors only the
   * high-emission optic/signal chars (MESH_ACCENT_CHARS: ☼ = ◆ !) and only
   * while their effective emission — the palette's if an entry overrides it,
   * the authored 1 otherwise — stays >= 0.9, so a palette that dims an optic
   * below that floor opts it out of accent too.
   *
   * Registering the same id again replaces the use. The first registration
   * installs the engine's content pack over renderer.setEntityContent; with
   * none registered the renderer keeps its neutral no-entity-content state
   * and facade output is byte-identical to before this API existed.
   */
  registerMeshArchetype(id, definition = {}) {
    this.assertLive();
    if (id === null || id === undefined || id === '') throw new TypeError('Mesh archetype id is required.');
    const archetype = definition.archetype ?? id;
    const descriptor = ENTITY_MESH_ARCHETYPES[archetype];
    if (!descriptor) {
      throw new RangeError(
        `Unknown mesh archetype '${archetype}'. Built-in archetypes: ${ENTITY_MESH_ARCHETYPE_NAMES.join(', ')}.`
      );
    }
    const scale = definition.scale === undefined ? 1 : definition.scale;
    if (!Number.isFinite(scale) || scale <= 0) {
      throw new RangeError(`Mesh archetype scale must be a positive number; got ${scale}.`);
    }
    const palette = normalizeMeshPalette(definition.palette);
    this.meshArchetypes.set(String(id), {
      id: String(id),
      archetype,
      descriptor,
      scale,
      tint: tintToMultiplier(definition.tint),
      palette,
      colorResolver: createMeshColorResolver(palette)
    });
    this.installMeshContent();
    return this;
  }

  /**
   * The built-in archetypes a registration can bind: name, selectable poses,
   * locomotion, measured native height/footprint in renderer cells (multiply
   * by the scene's metrics.cellSize for world units), and a description. All
   * archetypes face +x at heading 0. Frozen descriptors, safe to hold.
   */
  getMeshArchetypes() {
    return ENTITY_MESH_ARCHETYPE_NAMES.map(name => {
      const descriptor = ENTITY_MESH_ARCHETYPES[name];
      return Object.freeze({
        name,
        poses: descriptor.poses,
        locomotion: descriptor.locomotion,
        nativeHeight: descriptor.nativeHeight,
        nativeFootprint: descriptor.nativeFootprint,
        description: descriptor.description
      });
    });
  }

  /**
   * Distance bands for entity mesh LOD, in WORLD units from the camera:
   * `{ full, simplified }` — full detail inside `full`, reduced tessellation
   * inside `simplified`, and beyond that no mesh at all (the entity falls
   * back to a billboard if a sprite is registered under the same name as the
   * mesh archetype use, and otherwise is not drawn). Defaults to the
   * renderer's historical 12 / 19 cells. Pass null to restore the default.
   */
  setMeshLodDistances(distances) {
    this.assertLive();
    if (distances === null || distances === undefined) {
      this.meshLodDistances = null;
      return this;
    }
    const full = distances.full;
    const simplified = distances.simplified;
    if (!Number.isFinite(full) || full <= 0 || !Number.isFinite(simplified) || simplified < full) {
      throw new RangeError('setMeshLodDistances requires { full > 0, simplified >= full } in world units.');
    }
    this.meshLodDistances = { full, simplified };
    return this;
  }

  resize({ gridWidth, gridHeight, cellWidth, cellHeight } = {}) {
    this.assertLive();
    const width = positiveInteger(gridWidth, this.renderer.width);
    const height = positiveInteger(gridHeight, this.renderer.height);
    this.cellWidth = positiveInteger(cellWidth, this.cellWidth);
    this.cellHeight = positiveInteger(cellHeight, this.cellHeight);
    // Only on a change: setting a canvas's size, even to the size it has,
    // resets it. A grid of bigger cells over the same canvas (a coarse view)
    // leaves the canvas alone.
    const canvasWidth = width * this.cellWidth;
    const canvasHeight = height * this.cellHeight;
    if (this.canvas.width !== canvasWidth) this.canvas.width = canvasWidth;
    if (this.canvas.height !== canvasHeight) this.canvas.height = canvasHeight;
    this.renderer.resize(width, height, {
      mode: 'native',
      map: this.lastPrepared?.lightMap || null
    });
    this.hudLayer?.resize(this.canvas.width, this.canvas.height);
    return this;
  }

  /**
   * Opt-in: keep the render targets of up to `sizes` grid sizes, so a resize
   * back to a size kept swaps its targets in instead of reallocating them and
   * waiting on the GPU (AsciiRendererWebGL#setSceneTargetCache). For a game
   * that flips between grids, such as a coarse view and the full one: 2 keeps
   * both. The frames are the same either way; the cost is the memory of the
   * sizes kept. 1, the default, reallocates in place. Returns the engine.
   */
  setSceneTargetCache(sizes) {
    this.assertLive();
    this.renderer.setSceneTargetCache?.(sizes);
    return this;
  }

  /**
   * Opt-in deterministic rendering (also the constructor's deterministic
   * option): each frame depends only on its inputs and render({ time }), so a
   * frame drawn alone matches the same frame drawn in sequence. Meant for
   * offline capture, exact re-renders, rendering slices in parallel and
   * visual-regression stills. See AsciiRendererWebGL#setDeterministic for what
   * it turns off. Returns the engine.
   */
  setDeterministic(enabled) {
    this.assertLive();
    this.deterministic = enabled === true;
    this.renderer.setDeterministic?.(this.deterministic);
    return this;
  }

  /**
   * The last rendered frame as top-down RGBA bytes: { width, height, data }
   * with data a Uint8ClampedArray (ImageData-ready). Call it right after
   * render() in the same task, or create the engine with
   * contextAttributes: { preserveDrawingBuffer: true }; otherwise the browser
   * may already have cleared the drawing buffer. Pass a Uint8ClampedArray of
   * width * height * 4 bytes as target to reuse it across frames.
   */
  readPixels(target = null) {
    this.assertLive();
    const gl = this.renderer.gl;
    const width = gl.drawingBufferWidth;
    const height = gl.drawingBufferHeight;
    const size = width * height * 4;
    const data = target instanceof Uint8ClampedArray && target.length === size ? target : new Uint8ClampedArray(size);
    const previous = gl.getParameter(gl.READ_FRAMEBUFFER_BINDING);
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
    const raw = new Uint8Array(data.buffer, data.byteOffset, size);
    gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, raw);
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, previous);
    // WebGL rows run bottom-up; swap them in place to top-down.
    const row = width * 4;
    const scratch = new Uint8Array(row);
    for (let top = 0, bottom = height - 1; top < bottom; top++, bottom--) {
      const a = top * row, b = bottom * row;
      scratch.set(raw.subarray(a, a + row));
      raw.copyWithin(a, b, b + row);
      raw.set(scratch, b);
    }
    return { width, height, data };
  }

  render({ camera, scene, display = {}, effects = {}, time = performance.now() / 1000 } = {}) {
    this.assertLive();
    const snapshot = normalizeSceneSnapshot(scene || {});
    const prepared = this.prepareStaticScene(snapshot);
    const sprites = this.prepareSprites(snapshot);
    this.prepareMeshEntities(snapshot, sprites);
    this.prepareDerezCells(snapshot, prepared, sprites);
    const lights = this.prepareLights(snapshot);
    if (this.meshLodDistances) {
      // World units -> renderer cells, into a reused scratch object the
      // renderer holds by reference.
      this.meshLodScratch.full = this.meshLodDistances.full / snapshot.metrics.cellSize;
      this.meshLodScratch.simplified = this.meshLodDistances.simplified / snapshot.metrics.cellSize;
      this.renderer.setEntityLodDistances(this.meshLodScratch);
    } else {
      this.renderer.setEntityLodDistances(null);
    }
    // Facade scenes always run LOD hysteresis + the dissolve handoff; the
    // world-unit hysteresis converts per snapshot like the distances do.
    this.meshLodTransitionScratch.hysteresis = MESH_LOD_HYSTERESIS_WORLD / snapshot.metrics.cellSize;
    // Deterministic frames take pure distance LOD: hysteresis and the
    // dissolve handoff both depend on earlier frames.
    this.renderer.setEntityLodTransition(this.deterministic ? null : this.meshLodTransitionScratch);
    const frameCamera = this.toRendererCamera(camera || snapshot.camera, snapshot.metrics);
    const frameEffects = { ...snapshot.effects, ...effects };
    this.renderer.setScreenFlash(frameEffects.screenFlash);
    this.renderer.setStrokeGlyphs?.(display.strokeGlyphs === true);

    if (Number.isFinite(display.drawDistance) && display.drawDistance > 0) {
      this.renderer.setMaxDepth(display.drawDistance / snapshot.metrics.cellSize);
    }
    if (this.hudLayer && this.hudLayer.dirty) {
      this.hudLayer.dirty = false;
      this.renderer.setHudCells(this.hudLayer.snapshot());
    }
    this.renderer.setSceneGeometryOptions({
      zFloor: ENGINE_FLOOR_Z,
      zCeiling: toRendererZ(snapshot.metrics.ceilingHeight, snapshot.metrics),
      ceilings: snapshot.features.sky !== true,
      roundedCorners: display.roundedCorners !== false
    });
    this.renderer.setStaticSceneFeatures(prepared.features);
    this.renderer.setLights(lights);
    this.renderer.setGlitchStyle?.(glitchStyle(frameEffects));
    this.renderer.setAtmosphereProfile(
      null,
      atmosphereOptions(snapshot.atmosphere, frameEffects, snapshot.features)
    );
    this.renderer.setSceneState({
      revision: snapshot.effects.mapRevision,
      corrodedCells: cellReferenceSet(snapshot.effects.corrodedCells),
      portal: toRendererPortal(frameEffects.portal, snapshot.metrics),
      effects: toRendererEffects(frameEffects, snapshot.metrics)
    });

    this.renderer.compile(
      null,
      sprites,
      { ...frameCamera, map: prepared.lightMap, renderMap: prepared.drawMap },
      null,
      this.cellWidth,
      this.cellHeight,
      this.cellHeight,
      1,
      finiteOr(frameEffects.glitch, 0),
      Number.isFinite(time) ? time : performance.now() / 1000,
      // Deterministic frames run the renderer on the scene clock instead of
      // performance.now(), the hook capture tools already use.
      this.deterministic && Number.isFinite(time) ? { renderTimeMs: time * 1000 } : null
    );

    this.lastScene = snapshot;
    this.lastPrepared = prepared;
    this.diagnostics?.record?.('render', {
      scene: snapshot.id,
      grid: [snapshot.grid?.width || 0, snapshot.grid?.height || 0],
      renderer: this.renderer.getScalabilityStats?.()
    });
    return this;
  }

  getStats() {
    return Object.freeze({
      renderer: this.renderer.getScalabilityStats?.() || {},
      geometry: this.renderer.getGeometryUploadStats?.() || {},
      materials: this.materials.size,
      sceneId: this.lastScene?.id || null
    });
  }

  dispose() {
    this.disposed = true;
    this.materials.clear();
    this.materialSlots.clear();
    this.meshArchetypes.clear();
    this.meshEntityPool.clear();
    this.meshContent = null;
    this.lastPrepared = null;
    this.lastScene = null;
  }

  assertLive() {
    if (this.disposed) throw new Error('AsciiEngine has been disposed.');
  }

  ensureMaterialSlot(id) {
    if (this.materialSlots.has(id)) return this.materialSlots.get(id);
    const capacity = this.renderer.atlasLayout?.staticSlots ?? RENDERER_STATIC_ATLAS_SLOTS;
    if (this.nextMaterialSlot >= capacity) {
      throw new RangeError(`The static material atlas supports ${capacity - WALL_SLOT_START} wall materials in this configuration.`);
    }
    const slot = this.nextMaterialSlot++;
    this.materialSlots.set(id, slot);
    return slot;
  }

  prepareStaticScene(snapshot) {
    if (!snapshot.grid) throw new TypeError('AsciiEngine.render requires a scene with grid.cells.');
    const { grid, metrics } = snapshot;
    // Floor/ceiling/corroded ids are per-snapshot, not per-grid, so they take
    // part in cache validation - swapping any must rebuild the table.
    const floorMaterial = snapshot.materials.floorMaterial || firstMaterialId(this.materials);
    const ceilingMaterial = snapshot.materials.ceilingMaterial || floorMaterial;
    const corrodedMaterial = snapshot.materials.corrodedMaterial || null;

    const cached = this.staticSceneCache.get(grid);
    if (cached &&
      cached.materialRevision === this.materialRevision &&
      cached.floorMaterial === floorMaterial &&
      cached.ceilingMaterial === ceilingMaterial &&
      cached.corrodedMaterial === corrodedMaterial &&
      metricsMatch(cached.metrics, metrics)) {
      // The material slot table is renderer state that other prepares of other
      // grids may have replaced; reinstall is cheap and idempotent.
      this.renderer.setStaticMaterialSlots(cached.materialTable);
      return cached;
    }

    // Grids that carry derez fields usually change every frame (the progress
    // moves), so a grid identity miss is the normal case. Their static scene
    // depends only on WHICH cells are disintegrating, not how far along, so it
    // is cached on that content and a new grid with the same layout reuses it:
    // no static mesh rebuild, no light-visibility rebake. Grids without the
    // field never reach this and keep the identity cache alone.
    const derezKey = derezContentKey(grid);
    if (derezKey !== null) {
      const reuse = this.derezStaticCache?.get(derezKey);
      if (reuse &&
        reuse.materialRevision === this.materialRevision &&
        reuse.floorMaterial === floorMaterial &&
        reuse.ceilingMaterial === ceilingMaterial &&
        reuse.corrodedMaterial === corrodedMaterial &&
        metricsMatch(reuse.metrics, metrics)) {
        this.staticSceneCache.set(grid, reuse);
        this.renderer.setStaticMaterialSlots(reuse.materialTable);
        return reuse;
      }
    }

    const materialFor = value => materialIdForCell(value);
    // Any cell with a non-default height, or a raised base (an overpass, a
    // bridge, a floating sign), moves the whole grid to per-cell box features.
    const hasVariableHeight = grid.cells.some(row => row.some(cell =>
      cell && typeof cell === 'object' && (
        (Number.isFinite(cell.height) && Math.abs(cell.height - metrics.wallHeight) > 0.001) ||
        (Number.isFinite(cell.base) && cell.base > 0) || stairProfile(cell) ||
        cell.spans != null || cell.holes != null
      )
    ));

    // The renderer distinguishes the grid the mesh is DRAWN from (renderMap)
    // from the grid lighting, effects and entities consult (map). In the
    // variable-height path the mesh comes entirely from box features, so the
    // drawn map is empty - but the light map keeps ground-standing cells so
    // buildings still occlude the 2D light-visibility atlas and environmental
    // effects still know where the streets are. Cells raised off the ground
    // (base > 0) are open at street level and stay out of the light map.
    const lightMap = grid.cells.map((row, y) => row.map((cell, x) => {
      const material = materialFor(cell);
      if (!material) return 0;
      // A cell with spans occludes like its lowest span: ground-standing and
      // tall enough, it blocks light even with a slit above.
      const spans = cellSpans(cell, metrics.wallHeight, x, y);
      if (spans) {
        const ground = spans[0];
        return ground && ground[0] <= 0 && ground[1] >= 1.5 ? this.ensureMaterialSlot(material) + 1 : 0;
      }
      const base = typeof cell === 'object' && Number.isFinite(cell.base) ? cell.base : 0;
      if (base > 0 || stairProfile(cell)) return 0;
      // Street furniture below knee height (planter medians, curbs) neither
      // blocks bodies nor light: the 2D atlas is a full-height occluder map,
      // and a 0.45 planter casting a tower-length shadow reads as a bug.
      const height = typeof cell === 'object' && Number.isFinite(cell.height) ? cell.height : metrics.wallHeight;
      if (height < 1.5) return 0;
      return this.ensureMaterialSlot(material) + 1;
    }));
    // Disintegrating cells leave the drawn mesh (the entity path draws them)
    // but stay in the light map, so starting an effect never rebakes light
    // visibility; a cell removed from the grid stops occluding as usual.
    const derezCells = [];
    grid.cells.forEach((row, y) => row.forEach((cell, x) => {
      if (materialFor(cell) && readCellDerez(cell, x, y)) derezCells.push({ x, y });
    }));
    const drawMap = hasVariableHeight
      ? grid.cells.map(row => row.map(() => 0))
      : derezCells.length > 0
        ? lightMap.map((row, y) => row.map((value, x) => (readCellDerez(grid.cells[y][x], x, y) ? 0 : value)))
        : lightMap;

    const features = [];
    if (hasVariableHeight) {
      grid.cells.forEach((row, y) => row.forEach((cell, x) => {
        const material = materialFor(cell);
        if (!material) return;
        const height = typeof cell === 'object' && Number.isFinite(cell.height)
          ? cell.height
          : metrics.wallHeight;
        const base = typeof cell === 'object' && Number.isFinite(cell.base)
          ? Math.max(0, cell.base)
          : 0;
        const spans = cellSpans(cell, metrics.wallHeight, x, y);
        if (!spans && height <= base) return;
        if (readCellDerez(cell, x, y)) return;
        const slot = this.ensureMaterialSlot(material);
        // Opt-in per-material course tiling rides the feature into
        // SceneGeometry, converted from world units to renderer grid units
        // here because this is where the metrics are. Materials without the
        // options attach nothing, keeping the feature shape — and the wall
        // geometry — exactly historical.
        const courseOptions = this.materials.get(material)?.courseOptions || null;
        // Sub-cell boxes share the same height definition as player support.
        const boxes = cellBoxes(cell, height, base, spans);
        for (const box of boxes) features.push({
          type: 'box',
          x: x + box.x,
          y: y + box.y,
          sizeX: box.sizeX,
          sizeY: box.sizeY,
          zMin: toRendererZ(metrics.floorHeight + box.height, metrics),
          zMax: box.base > 0 ? toRendererZ(metrics.floorHeight + box.base, metrics) : ENGINE_FLOOR_Z,
          atlasIndex: slot,
          // Only ground-standing atlas occluders own wall-facing open cells.
          // Raised objects and low furniture retain ordinary world sampling.
          ...(lightMap[y][x] ? { visibilityFaces: {
            width: lightMap[0].length,
            height: lightMap.length,
            codes: [[x, y - 1], [x + 1, y], [x, y + 1], [x - 1, y]].map(([cx, cy]) =>
              cy >= 0 && cy < lightMap.length && cx >= 0 && cx < lightMap[0].length && lightMap[cy][cx] === 0
                ? cy * lightMap[0].length + cx + 1 : 0)
          } } : {}),
          ...(courseOptions ? {
            course: {
              height: courseOptions.height !== null ? courseOptions.height / metrics.cellSize : 1,
              width: courseOptions.width !== null ? courseOptions.width / metrics.cellSize : 1,
              variation: courseOptions.variation,
              columns: courseOptions.columns,
              seed: courseOptions.seed
            }
          } : {})
        });
      }));
    }
    Object.freeze(features);

    const materialTable = new Array(this.renderer.atlasLayout?.staticSlots ?? RENDERER_STATIC_ATLAS_SLOTS).fill(null);
    for (const [id, slot] of this.materialSlots) materialTable[slot] = id;
    if (floorMaterial) materialTable[4] = floorMaterial;
    if (ceilingMaterial) materialTable[5] = ceilingMaterial;
    // Slot 6 is the renderer's alternate floor tile, selected per cell by
    // effects.corrodedCells - a second ground material (turf, dirt, water).
    if (corrodedMaterial) materialTable[6] = corrodedMaterial;
    this.renderer.setStaticMaterialSlots(materialTable);

    const prepared = Object.freeze({
      lightMap,
      drawMap,
      features,
      materialTable,
      floorMaterial,
      ceilingMaterial,
      corrodedMaterial,
      metrics: metricsKey(metrics),
      materialRevision: this.materialRevision,
      ...(derezCells.length > 0 ? { derezCells: Object.freeze(derezCells) } : {})
    });
    this.staticSceneCache.set(grid, prepared);
    if (derezKey !== null) {
      this.derezStaticCache ??= new Map();
      this.derezStaticCache.set(derezKey, prepared);
      // A handful of layouts is plenty: a video cycles through tear states,
      // it does not revisit hundreds.
      if (this.derezStaticCache.size > 8) this.derezStaticCache.delete(this.derezStaticCache.keys().next().value);
    }
    return prepared;
  }

  prepareSprites(snapshot) {
    const { metrics } = snapshot;
    return snapshot.entities
      // An entity with a `mesh` field is a mesh entity even if it also names a
      // sprite; that sprite is not a second entity representation but the
      // billboard its beyond-LOD fallback draws with (with the sprite
      // registered under the mesh use's own name as the fallback's fallback).
      .filter(entity => entity.visible !== false && !entity.mesh && (entity.sprite || entity.type === 'sprite'))
      .map(entity => ({
        type: entity.sprite || entity.id,
        x: toRendererHorizontalX(entity.x, metrics),
        y: toRendererHorizontalY(entity.y, metrics),
        zOffset: toRendererZ(entity.z, metrics),
        sizeScale: finiteOr(entity.size, undefined),
        aspect: finiteOr(entity.aspect, undefined),
        // Read only by `plane: 'upright'` templates, and forwarded unchanged:
        // the facade->renderer horizontal mapping does not flip an axis, so a
        // sprite heading means the same thing on both sides of it, exactly as
        // a mesh entity's does. Undefined leaves the template's own default in
        // charge, the same way an unset `aspect` does.
        heading: finiteOr(entity.heading, undefined),
        // spriteAtlas.mirror: draw this sprite's image flipped left to right.
        // Only added when opted in, so default sprite objects keep their shape.
        ...(this.spriteMirroring && entity.mirror === true ? { mirror: true } : {})
      }));
  }

  /**
   * Converts the snapshot's mesh entities into the renderer's entity space and
   * appends them to the frame's entity list, alongside sprites.
   *
   * Snapshot form (facade space: world units, z up, radians):
   *
   *   { mesh: '<registered id>', x, y, z?, heading?, pose?, scale?, tint?,
   *     accent?, sprite?, opacity?, params?, id, visible? }
   *
   *   sprite  — the registered sprite template the entity's beyond-LOD
   *             billboard fallback draws with. Mesh wins inside LOD range
   *             (the entity is never drawn twice); beyond `simplified` the
   *             entity draws as THIS sprite. Absent — or naming a template
   *             that is not registered — the historical lookup under the
   *             mesh use's own name applies, and with neither registered the
   *             entity is not drawn at all.
   *
   *   mesh    — a use registered via registerMeshArchetype. Unknown names
   *             throw: a typo must be a loud failure, not an absent enemy.
   *   x, y    — world position (same conversion as sprites and lights).
   *   z       — height of the feet above the scene floor, world units;
   *             omitted/0 stands the entity on the floor.
   *   heading — facing, radians; 0 faces +x, increasing turns toward +y —
   *             identical to camera.yaw, and forwarded unchanged because the
   *             facade->renderer horizontal mapping does not flip an axis.
   *   pose    — animation state from the archetype's pose list (see
   *             getMeshArchetypes()); unknown poses throw. Omitted: the
   *             archetype's default resolution (which for some archetypes
   *             infers walk/sprint from actual movement).
   *   scale   — per-entity uniform scale about the floor contact, clamped to
   *             [0.05, 8], multiplied with the registration's scale knob.
   *   tint    — RGB multiplier over the authored palette (color forms as
   *             everywhere in the facade); overrides the registration tint.
   *   accent  — recolor of the archetype's HIGH-EMISSION optic/signal
   *             materials only (the '☼' '=' '◆' '!' char hints, while their
   *             effective emission stays >= 0.9 — see registerMeshArchetype).
   *             An eye, a visor, a warning lamp changes color per state; the
   *             hull does not move. Color forms as everywhere in the facade.
   *   opacity — 0..1 surface presence (the deferred path's dissolve, not
   *             alpha): triangles are removed evenly across the body.
   *   params  — a plain object of per-entity SHAPE parameters, forwarded to
   *             the archetype builder as `entity.params` (null when absent).
   *             This is the generic channel for parametric archetypes — ones
   *             whose geometry is a function of something only the game
   *             knows per entity and per frame, which `scale`, `pose` and
   *             `heading` cannot say. `tether` reads `reach`, `rise`,
   *             `slack` and `hook` from it; the non-parametric archetypes
   *             ignore it. The snapshot froze a shallow copy, so what the
   *             builder sees is the frame's own params and not the game's
   *             live object. Reassigned on EVERY frame (see below), not only
   *             when the pool entry is created, because the same id is reused
   *             frame after frame and a winch line changes length on all of
   *             them.
   *
   * Entities are pooled by snapshot id: the same id gets the SAME mutable
   * renderer entity object every frame, updated in place, which is what keeps
   * EntityAnimation's WeakMap tracks (gait, transitions, spawn ramp) alive
   * across frames and lets the renderer's 30 Hz entity throttle amortize
   * rebuilds. Ids must therefore be unique per snapshot and stable across
   * frames for as long as the entity lives. Pool entries whose id is absent
   * from the current snapshot are evicted.
   */
  prepareMeshEntities(snapshot, out) {
    const { metrics } = snapshot;
    this.meshFrameStamp++;
    const stamp = this.meshFrameStamp;
    let sawMeshEntity = false;
    for (const entity of snapshot.entities) {
      if (entity.mesh === undefined || entity.mesh === null) continue;
      sawMeshEntity = true;
      if (entity.visible === false) continue;
      const registration = this.meshArchetypes.get(entity.mesh);
      if (!registration) {
        throw new RangeError(
          `No mesh archetype registered as '${entity.mesh}'. Registered: ${
            this.meshArchetypes.size > 0 ? [...this.meshArchetypes.keys()].join(', ') : '(none)'
          }. Register one with registerMeshArchetype(); built-ins: ${ENTITY_MESH_ARCHETYPE_NAMES.join(', ')}.`
        );
      }
      const descriptor = registration.descriptor;
      let pose = entity.pose;
      if (pose === undefined || pose === null) {
        pose = null;
      } else if (!descriptor.poseSet.has(pose)) {
        throw new RangeError(
          `Unknown pose '${pose}' for mesh archetype '${registration.archetype}'. Poses: ${descriptor.poses.join(', ')}.`
        );
      }
      let pooled = this.meshEntityPool.get(entity.id);
      if (!pooled || pooled.type !== registration.id) {
        // A new id — or the same id rebound to a different use, which is a
        // different body and correctly restarts its animation track.
        pooled = {
          id: entity.id,
          type: registration.id,
          x: 0,
          y: 0,
          angle: 0,
          state: null,
          active: false,
          calibration: 0,
          zOffset: 0,
          // A mesh entity's z is ground contact, not centre height, so its
          // fallback billboard hangs from its feet. See the renderer's cz.
          billboardFeetAnchor: true,
          meshScale: 1,
          meshLift: 0,
          meshTint: null,
          meshAccent: null,
          billboard: null,
          renderOpacity: 1,
          params: null,
          lastSeenStamp: 0
        };
        this.meshEntityPool.set(entity.id, pooled);
      }
      pooled.lastSeenStamp = stamp;
      pooled.x = toRendererHorizontalX(entity.x, metrics);
      pooled.y = toRendererHorizontalY(entity.y, metrics);
      // For the billboard fallback (same-name sprite template beyond mesh LOD
      // range). This is the entity's GROUND CONTACT plane, the same one
      // meshLift below is measured from — the renderer anchors the fallback
      // quad's bottom edge here rather than its centre, which is what
      // billboardFeetAnchor asks for. Set on every pooled entry (including
      // ones pooled before this existed, hence the assignment rather than
      // relying on the initializer).
      pooled.zOffset = toRendererZ(entity.z, metrics);
      pooled.billboardFeetAnchor = true;
      pooled.angle = finiteOr(entity.heading, 0);
      // Upright fallback sprites use heading; meshes use angle. Preserve the
      // same facing through LOD changes and overwrite it on every pooled use.
      pooled.heading = pooled.angle;
      if (descriptor.applyPose) descriptor.applyPose(pooled, pose);
      else pooled.state = pose;
      const entityScale = Number.isFinite(entity.scale)
        ? Math.min(MESH_ENTITY_MAX_SCALE, Math.max(MESH_ENTITY_MIN_SCALE, entity.scale))
        : 1;
      pooled.meshScale = registration.scale * entityScale;
      pooled.meshLift = (entity.z - metrics.floorHeight) / metrics.cellSize;
      pooled.meshTint = entity.tint !== undefined ? tintToMultiplier(entity.tint) : registration.tint;
      pooled.meshAccent = entity.accent !== undefined && entity.accent !== null
        ? colorToRgb(entity.accent, [255, 255, 255])
        : null;
      // The beyond-LOD billboard draws as THIS sprite when the entity names
      // one (state-aware fallback); the registration-name lookup remains the
      // fallback's fallback for absent or unregistered names.
      pooled.billboard = entity.sprite !== undefined && entity.sprite !== null
        ? entity.sprite
        : null;
      pooled.renderOpacity = Number.isFinite(entity.opacity)
        ? Math.max(0, Math.min(1, entity.opacity))
        : 1;
      // Per-entity shape parameters, by reference to the snapshot's frozen
      // copy. Assigned every frame like every other field here — the pool
      // entry outlives the frame and a parametric archetype's params are the
      // one input that changes on every one of them (a winch line pays out).
      // An entity that drops the field goes back to null rather than keeping
      // last frame's shape.
      pooled.params = entity.params ?? null;
      pooled.renderDerez = Number.isFinite(entity.derez) ? Math.max(0, Math.min(1, entity.derez)) : 0;
      pooled.renderDerezOptions = entity.derezPalette ? { palette: entity.derezPalette } : null;
      out.push(pooled);
    }
    // Evict ids the snapshot no longer carries so tracks and pool entries do
    // not leak. Map iteration allocates nothing and tolerates deletes.
    if (sawMeshEntity || this.meshEntityPool.size > 0) {
      for (const [id, pooled] of this.meshEntityPool) {
        if (pooled.lastSeenStamp !== stamp) this.meshEntityPool.delete(id);
      }
    }
    return out;
  }

  /**
   * The content pack's buildMesh: dispatch to the registered archetype's
   * builder, then apply the facade presentation (scale, lift, tint) in one
   * in-place walk. Runs on the renderer's 30 Hz entity tick only — never per
   * display frame — which is the whole-roster amortization Liminal's path
   * established and this API inherits unchanged.
   */
  buildRegisteredMesh(entity, currentTime, lod, options) {
    if (entity.type === DEREZ_CELL_TYPE) return buildDerezCellMesh(entity, lod);
    const registration = this.meshArchetypes.get(entity.type);
    if (!registration) return null;
    MESH_BUILDER_OPTIONS.viewerDistance = options && Number.isFinite(options.viewerDistance)
      ? options.viewerDistance
      : Infinity;
    // The registration's own palette/accent resolver, and never the renderer's
    // sprite-template one. Null when nothing would override anything, so a
    // registration without a palette builds byte-identical meshes.
    MESH_BUILDER_OPTIONS.colorResolver = (registration.palette !== null || entity.meshAccent)
      ? registration.colorResolver
      : null;
    MESH_BUILDER_OPTIONS.paletteResolver = MESH_BUILDER_OPTIONS.colorResolver !== null;
    const mesh = registration.descriptor.build(entity, currentTime, lod, MESH_BUILDER_OPTIONS);
    return applyEntityMeshPresentation(mesh, entity);
  }

  /**
   * Installs (or refreshes) the facade's entity content pack. The pack object
   * and its types Set are stable across registrations — the renderer holds
   * them by reference — and it goes through setEntityContent, the same slot a
   * game's own world module uses, leaving setEntityMeshBuilder (the override
   * slot gore/Studio use in Liminal) free for direct renderer consumers.
   */
  installMeshContent() {
    if (!this.meshContent) {
      this.meshContent = {
        types: new Set(),
        buildMesh: (entity, currentTime, lod, options) =>
          this.buildRegisteredMesh(entity, currentTime, lod, options)
      };
      this.renderer.setEntityContent(this.meshContent);
    }
    this.meshContent.types.clear();
    for (const id of this.meshArchetypes.keys()) this.meshContent.types.add(id);
    if (this.derezCellPool) this.meshContent.types.add(DEREZ_CELL_TYPE);
  }

  /**
   * Grid cells with derez progress, as pooled entities for the entity path
   * (see DerezCells.js). The static scene already left them out of the drawn
   * mesh. Pooled by cell, so the renderer's per-entity state persists across
   * frames; cells that stop disintegrating are evicted. Nothing happens, and
   * no content pack is installed, until a grid first carries one.
   */
  prepareDerezCells(snapshot, prepared, out) {
    const positions = prepared.derezCells;
    if (!positions && !this.derezCellPool) return;
    if (!this.derezCellPool) {
      this.derezCellPool = new Map();
      this.installMeshContent();
    }
    const { grid, metrics } = snapshot;
    this.derezCellStamp = (this.derezCellStamp || 0) + 1;
    const stamp = this.derezCellStamp;
    for (const { x, y } of positions || []) {
      const cell = grid.cells[y][x];
      const derez = readCellDerez(cell, x, y);
      if (!derez) continue;
      const key = `${x},${y}`;
      let pooled = this.derezCellPool.get(key);
      if (!pooled) {
        pooled = { id: `derez-cell:${key}`, type: DEREZ_CELL_TYPE, angle: 0, heading: 0, active: false,
          state: null, renderOpacity: 1, billboard: null, zOffset: ENGINE_FLOOR_Z };
        this.derezCellPool.set(key, pooled);
      }
      pooled.stamp = stamp;
      pooled.x = x + 0.5;
      pooled.y = y + 0.5;
      const material = this.materials.get(materialIdForCell(cell));
      const color = material?.color || { r: 160, g: 170, b: 178 };
      const rgb = [color.r / 255, color.g / 255, color.b / 255];
      pooled.derezMaterial = {
        color: rgb,
        roughness: material?.properties?.roughness ?? 0.65,
        emission: material?.properties?.emission ?? 0,
        lightResponse: material?.properties?.lightResponse ?? 0.7
      };
      const height = Number.isFinite(cell.height) ? cell.height : metrics.wallHeight;
      const base = Number.isFinite(cell.base) ? Math.max(0, cell.base) : 0;
      const boxes = cellBoxes(cell, height, base, cellSpans(cell, metrics.wallHeight, x, y));
      pooled.derezBoxes = boxes.map(box => ({
        x0: x + box.x - box.sizeX / 2,
        y0: y + box.y - box.sizeY / 2,
        x1: x + box.x + box.sizeX / 2,
        y1: y + box.y + box.sizeY / 2,
        zTop: toRendererZ(metrics.floorHeight + box.height, metrics),
        zBottom: box.base > 0 ? toRendererZ(metrics.floorHeight + box.base, metrics) : ENGINE_FLOOR_Z,
        raised: box.base > 0
      }));
      pooled.renderDerez = derez.progress;
      // Fragments default to the wall's own colour rather than white.
      pooled.renderDerezOptions = { palette: derez.palette || [rgb] };
      out.push(pooled);
    }
    for (const [key, pooled] of this.derezCellPool) {
      if (pooled.stamp !== stamp) this.derezCellPool.delete(key);
    }
  }

  prepareLights(snapshot) {
    const { metrics } = snapshot;
    return snapshot.lights
      .filter(light => light.active !== false)
      .map(light => {
        const color = colorToRgb(light.color, [255, 255, 255]);
        return {
          x: toRendererHorizontalX(light.x, metrics),
          y: toRendererHorizontalY(light.y, metrics),
          z: toRendererZ(light.z, metrics),
          r: color.r,
          g: color.g,
          b: color.b,
          range: Math.max(0.1, finiteOr(light.radius ?? light.range, 5) / metrics.cellSize),
          currentIntensity: finiteOr(light.intensity, 1),
          active: true,
          cullable: light.cullable === true,
          // A light that moves must opt out of the CPU shadow atlas, whose
          // rebuild cost assumes lights hold still. `dynamic: true` is the
          // scene-level spelling; castsShadows === false is what the renderer
          // reads.
          castsShadows: (light.dynamic === true || light.castsShadows === false) ? false : undefined,
          // Facade directions are z-up; the renderer's z axis points down.
          direction: Array.isArray(light.direction)
            ? [light.direction[0], light.direction[1], -(light.direction[2] || 0)]
            : light.direction,
          // Optional world-space projector apex; the physical source remains
          // at light.position for attenuation, light selection and shadows.
          projectionOrigin: light.projectionOrigin
            && ['x', 'y', 'z'].every(k => Number.isFinite(light.projectionOrigin[k]))
            ? [toRendererHorizontalX(light.projectionOrigin.x, metrics),
              toRendererHorizontalY(light.projectionOrigin.y, metrics),
              toRendererZ(light.projectionOrigin.z, metrics)] : undefined,
          shape: light.shape,
          innerConeDegrees: light.innerConeDegrees,
          outerConeDegrees: light.outerConeDegrees,
          floorInfluence: light.floorInfluence,
          volumetricInfluence: light.volumetricInfluence
        };
      });
  }

  toRendererCamera(camera, metrics) {
    const input = camera?.position ? { ...camera.position, ...camera } : (camera || {});
    const fov = finiteOr(input.fov, Math.PI / 3);
    const radians = fov > Math.PI ? fov * Math.PI / 180 : fov;
    const pitchRadians = finiteOr(input.pitch, 0);
    const roll = finiteOr(input.roll, 0);
    // Free cameras are opt-in: a nonzero roll, or free: true for a full-sphere
    // pitch (straight down, straight up, past vertical). Without either the
    // renderer camera has exactly its historical fields.
    const free = input.free === true || roll !== 0;
    return {
      ...(free ? { freeLook: true, roll } : {}),
      x: toRendererHorizontalX(finiteOr(input.x, 0), metrics),
      y: toRendererHorizontalY(finiteOr(input.y, 0), metrics),
      cameraZ: toRendererZ(finiteOr(input.z, metrics.floorHeight + metrics.wallHeight * 0.5), metrics),
      angle: finiteOr(input.yaw ?? input.angle, 0),
      pitch: (pitchRadians / radians) * this.renderer.height,
      fov: radians,
      flashlightOn: input.flashlightOn === true,
      // Facade cameras opt in to eye-height flashlight projection; direct
      // renderer consumers keep the historical z=0 plane.
      flashlightTracksEye: true,
      flashlightAtEye: input.flashlightAtEye === true
    };
  }
}

export { RendererCapabilityError };
/** @internal exported for tests */
export { glitchStyle as glitchStyleForTests };

/**
 * Procedural per-texel material textures. The renderer bakes each material
 * into a 64-128px atlas tile by calling getColor/getProperties per texel, and
 * wall geometry tiles that texture in one-unit courses - so a 'windows' tile
 * repeats per storey and a tower facade reads as floors of lit windows.
 *
 * definition.texture:
 *   { style: 'windows', seed?, columns?, rows?, litFraction?, litColor?,
 *     darkColor?, frameColor?, litEmission?, insetX?, insetY?,
 *     litClustering? }
 *   { style: 'street', seed?, doorEvery?, doorWidth?, litFraction?,
 *     glassColor?, spillColor?, doorColor?, frameColor?, litEmission? }
 *   { style: 'panels', seed?, bands?, variance? }
 *   { style: 'noise', seed?, amount? }
 *
 * Three texture options are GEOMETRY contracts rather than bake inputs, read
 * by materialCourseOptions and carried to SceneGeometry on the material's box
 * features (they change how walls tile the tile, which the bake cannot):
 *
 *   courseHeight (world units, default 1): the tile spans this many units
 *     vertically, so one tile bakes several DISTINCT storeys before the
 *     facade repeats. Pair with rows: a courseHeight-3 tile with rows 3 is
 *     three one-unit storeys of independent lit windows.
 *   bayWidth (world units, default 1): the same, HORIZONTALLY. The tile spans
 *     this many units across, so `columns` windows are spread over it rather
 *     than crammed into a single grid cell. Pair with columns the way
 *     courseHeight pairs with rows: bayWidth 4.8 with columns 3 is three
 *     1.6-unit window bays. Geometry keys U on world position, so the rhythm
 *     stays phase-continuous across the 1-unit faces of adjacent cells.
 *   courseVariation (0..1, default 0): each storey course samples the tile
 *     at a deterministic hashed U offset, quantized to whole window columns,
 *     so stacked courses stop repeating the identical lit stamp.
 *
 * 'street' spells its horizontal span doorEvery instead, because for a
 * shopfront the span IS the door rhythm. All of them default to the historical
 * per-unit tiling; a material that sets none builds byte-identical geometry.
 */
export function createMaterialTexture(texture, baseColor, baseProperties) {
  if (!texture || typeof texture !== 'object') return null;
  const seed = finiteOr(texture.seed, 1) | 0;

  if (texture.style === 'windows') {
    const columns = Math.max(1, Math.round(finiteOr(texture.columns, 4)));
    const rows = Math.max(1, Math.round(finiteOr(texture.rows, 5)));
    const litFraction = Math.max(0, Math.min(1, finiteOr(texture.litFraction, 0.32)));
    const litColor = colorToRgb(texture.litColor, [255, 197, 120]);
    const darkColor = colorToRgb(texture.darkColor, [24, 30, 48]);
    const frameColor = colorToRgb(texture.frameColor, [baseColor.r, baseColor.g, baseColor.b]);
    const litEmission = finiteOr(texture.litEmission, 0.98);
    // Window aspect: the historical fixed 0.18 inset on both axes stays the
    // default; insetX/insetY let a material author wide low ribbon windows
    // (small insetX, large insetY) or tall slots (the reverse).
    const insetX = Math.max(0, Math.min(0.45, finiteOr(texture.insetX, 0.18)));
    const insetY = Math.max(0, Math.min(0.45, finiteOr(texture.insetY, 0.18)));
    // litClustering (0..1, default 0 = the historical independent per-window
    // hash): quantizes the lit-hash key to horizontal runs of windows, so lit
    // windows come in bands the way office floors light together. At 1 the
    // run is the whole row. Run length 1 hashes exactly the historical key.
    const litClustering = Math.max(0, Math.min(1, finiteOr(texture.litClustering, 0)));
    const runLength = Math.max(1, Math.round(1 + litClustering * (columns - 1)));
    // Bake broad interior shade and a centre mullion into lit pane colors.
    // This is opt-in and changes no texel properties, geometry or frame work.
    const paneDetail = texture.paneDetail === true;
    const litProperties = { ...baseProperties, emission: litEmission, roughness: 0.25 };
    const darkProperties = { ...baseProperties, emission: 0, roughness: 0.2, reflectivity: 0.3 };
    const isWindowTexel = (x, y) => {
      const cellX = (x * columns) % 1;
      const cellY = (y * rows) % 1;
      return cellX > insetX && cellX < 1 - insetX && cellY > insetY && cellY < 1 - insetY;
    };
    const isLitWindow = (x, y) => {
      const windowX = Math.min(columns - 1, Math.floor(x * columns));
      const windowY = Math.min(rows - 1, Math.floor(y * rows));
      const runX = runLength > 1 ? Math.floor(windowX / runLength) : windowX;
      return texelHash(runX, windowY, seed) < litFraction;
    };
    return {
      getColor: (x, y) => {
        if (!isWindowTexel(x, y)) {
          const shade = 0.9 + texelHash(Math.floor(x * 64), Math.floor(y * 64), seed ^ 0x9e37) * 0.2;
          return { r: frameColor.r * shade, g: frameColor.g * shade, b: frameColor.b * shade };
        }
        if (isLitWindow(x, y)) {
          const warm = 0.85 + texelHash(Math.floor(x * columns), Math.floor(y * rows), seed ^ 0x51ed) * 0.3;
          if (paneDetail) {
            const u = ((x * columns) % 1 - insetX) / (1 - 2 * insetX);
            const v = ((y * rows) % 1 - insetY) / (1 - 2 * insetY);
            // Large, stable bands survive the baked atlas and native glyphs.
            const shade = Math.abs(u - .5) < .055 ? .32
              : v < .23 ? .55 : u < .13 || u > .87 ? .76 : 1;
            return { r: litColor.r * warm * shade, g: litColor.g * warm * shade, b: litColor.b * shade };
          }
          return { r: litColor.r * warm, g: litColor.g * warm, b: litColor.b };
        }
        return darkColor;
      },
      getProperties: (x, y) => {
        if (!isWindowTexel(x, y)) return baseProperties;
        return isLitWindow(x, y) ? litProperties : darkProperties;
      }
    };
  }

  if (texture.style === 'street') {
    // A shopfront/lobby ground course: a glass band with warm interior spill,
    // and a recessed door with a slight frame every doorEvery world units.
    // The tile's x axis spans doorEvery units (the geometry keys U on world
    // position via the course record, so the pattern stays phase-continuous
    // across adjacent 1-unit faces); y runs top-of-storey (0) to street (1).
    // Bands are broad on purpose - this must read at 1-2px glyph cells.
    const doorEvery = Math.max(0.5, finiteOr(texture.doorEvery, 2));
    const doorWidth = Math.max(0.1, Math.min(doorEvery * 0.8, finiteOr(texture.doorWidth, 0.35)));
    const litFraction = Math.max(0, Math.min(1, finiteOr(texture.litFraction, 0.55)));
    const glassColor = colorToRgb(texture.glassColor, [40, 56, 78]);
    const spillColor = colorToRgb(texture.spillColor, [255, 205, 140]);
    const doorColor = colorToRgb(texture.doorColor, [14, 16, 22]);
    const frameColor = colorToRgb(texture.frameColor, [baseColor.r, baseColor.g, baseColor.b]);
    const litEmission = finiteOr(texture.litEmission, 0.98);
    const fasciaBottom = 0.16;      // signage/fascia band across the top
    const doorTop = 0.24;           // doors run from here down to the street
    const frameWidth = 0.07;        // jamb/lintel thickness, world units
    const doorCenter = doorEvery * 0.5;
    const halfDoor = doorWidth * 0.5;
    const paneCount = Math.max(1, Math.round(doorEvery * 2)); // ~half-unit panes
    const paneWidth = doorEvery / paneCount;
    const spillProperties = { ...baseProperties, emission: litEmission, roughness: 0.2 };
    const glassProperties = { ...baseProperties, emission: 0, roughness: 0.16, reflectivity: 0.35 };
    const doorProperties = { ...baseProperties, emission: 0, roughness: 0.78 };
    const inDoor = (worldX, y) => y >= doorTop && Math.abs(worldX - doorCenter) < halfDoor;
    const inDoorFrame = (worldX, y) => y >= doorTop - frameWidth &&
      Math.abs(worldX - doorCenter) < halfDoor + frameWidth;
    const litPane = (worldX) =>
      texelHash(Math.min(paneCount - 1, Math.floor(worldX / paneWidth)), 0, seed) < litFraction;
    return {
      getColor: (x, y) => {
        const worldX = x * doorEvery;
        if (y < fasciaBottom) {
          const shade = 0.82 + texelHash(Math.floor(x * 64), 3, seed ^ 0x9e37) * 0.22;
          return { r: frameColor.r * shade, g: frameColor.g * shade, b: frameColor.b * shade };
        }
        if (inDoor(worldX, y)) {
          // Darker toward the centreline so the opening reads recessed even
          // when the whole door is two glyph cells wide.
          const depth = 0.5 + 0.5 * Math.min(1, Math.abs(worldX - doorCenter) / halfDoor);
          return { r: doorColor.r * depth, g: doorColor.g * depth, b: doorColor.b * depth };
        }
        if (inDoorFrame(worldX, y)) {
          return { r: frameColor.r * 1.08, g: frameColor.g * 1.08, b: frameColor.b * 1.08 };
        }
        const paneX = (worldX / paneWidth) % 1;
        if (paneX < 0.06) {
          // Mullion between panes; averages away at coarse cells, structures
          // the band at fine ones.
          return { r: frameColor.r * 0.8, g: frameColor.g * 0.8, b: frameColor.b * 0.8 };
        }
        const grain = texelHash(Math.floor(x * 96), Math.floor(y * 24), seed ^ 0x51ed);
        if (litPane(worldX)) {
          // Spill pools toward the street: slightly brighter at the bottom.
          const warm = (0.82 + grain * 0.28) * (0.9 + 0.2 * y);
          return { r: spillColor.r * warm, g: spillColor.g * warm, b: spillColor.b };
        }
        const shade = 0.85 + grain * 0.25;
        return { r: glassColor.r * shade, g: glassColor.g * shade, b: glassColor.b * shade };
      },
      getProperties: (x, y) => {
        const worldX = x * doorEvery;
        if (y < fasciaBottom) return baseProperties;
        if (inDoor(worldX, y)) return doorProperties;
        if (inDoorFrame(worldX, y)) return baseProperties;
        if ((worldX / paneWidth) % 1 < 0.06) return baseProperties;
        return litPane(worldX) ? spillProperties : glassProperties;
      }
    };
  }

  if (texture.style === 'panels') {
    const bands = Math.max(1, Math.round(finiteOr(texture.bands, 6)));
    const variance = Math.max(0, Math.min(0.6, finiteOr(texture.variance, 0.22)));
    return {
      getColor: (x, y) => {
        const band = Math.min(bands - 1, Math.floor(y * bands));
        const bandY = (y * bands) % 1;
        const seam = bandY < 0.08 ? 0.62 : 1;
        const shade = (1 - variance / 2 + texelHash(band, Math.floor(x * 3), seed) * variance) * seam;
        const grain = 0.94 + texelHash(Math.floor(x * 48), Math.floor(y * 48), seed ^ 0x2b7e) * 0.12;
        return { r: baseColor.r * shade * grain, g: baseColor.g * shade * grain, b: baseColor.b * shade * grain };
      },
      getProperties: () => baseProperties
    };
  }

  if (texture.style === 'noise') {
    const amount = Math.max(0, Math.min(0.8, finiteOr(texture.amount, 0.25)));
    return {
      getColor: (x, y) => {
        const shade = 1 - amount / 2 + texelHash(Math.floor(x * 96), Math.floor(y * 96), seed) * amount;
        return { r: baseColor.r * shade, g: baseColor.g * shade, b: baseColor.b * shade };
      },
      getProperties: () => baseProperties
    };
  }

  return null;
}

/**
 * The geometry half of a material's texture options: how wall courses tile
 * the baked tile. Null - the answer for every material registered before
 * these options existed, and for any that sets none of them - attaches
 * nothing to the material's box features, keeping SceneGeometry on its
 * historical per-unit-course path.
 *
 * Units here are WORLD units (like entity z and cell heights); the facade
 * converts to renderer grid units where the metrics are known,
 * in prepareStaticScene.
 */
function materialCourseOptions(texture) {
  if (!texture || typeof texture !== 'object') return null;
  // null height/width mean "the historical one-grid-unit course" and are NOT
  // world units, so they survive the metrics conversion untouched; only
  // values an author actually set are world units to convert.
  const height = Number.isFinite(texture.courseHeight) ? Math.max(0.25, texture.courseHeight) : null;
  const variation = Math.max(0, Math.min(1, finiteOr(texture.courseVariation, 0)));
  // The horizontal span, which until now only 'street' could ask for.
  //
  // addCoursedWallSegment has always handled a course.width of any size - it
  // keys U on world position along the face so a pattern wider than one cell
  // stays phase-continuous, and splits at tile seams so the shared atlas never
  // bleeds. Only the way IN was style-specific: a 'windows' facade could set
  // how many world units it spanned VERTICALLY (courseHeight) but not
  // horizontally, so however many columns it baked, they were always crammed
  // into one grid unit. A facade wanting a wider window had no way to say so.
  //
  // `bayWidth` is that way. Named for the structural bay - the rhythm windows
  // sit in - because that is the thing being measured, and to leave doorEvery
  // meaning exactly what it means for shopfronts. Unset stays null, which is
  // the historical one-grid-unit tile, so every existing material builds
  // byte-identical geometry.
  const width = texture.style === 'street'
    ? Math.max(0.5, finiteOr(texture.doorEvery, 2))
    : (Number.isFinite(texture.bayWidth) ? Math.max(0.5, texture.bayWidth) : null);
  if (height === null && variation === 0 && width === null) return null;
  return {
    height,
    width,
    variation,
    // The quantization grid for courseVariation offsets: whole window
    // columns, so shifted storeys keep their windows on the column grid.
    columns: Math.max(1, Math.round(finiteOr(texture.columns, 4))),
    seed: finiteOr(texture.seed, 1) | 0
  };
}

function texelHash(x, y, seed) {
  let h = (x * 374761393 + y * 668265263 + seed * 2147483647) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/**
 * The static content of a grid that carries derez fields: every cell with its
 * derez progress reduced to "disintegrating or not". Null for a grid with no
 * derez field anywhere, which keeps the identity cache as the only cache.
 */
function derezContentKey(grid) {
  let any = false;
  const key = JSON.stringify(grid.cells, (name, value) => {
    if (value && typeof value === 'object' && !Array.isArray(value) && 'derez' in value) {
      any = true;
      const { derez, derezPalette, ...rest } = value;
      return { ...rest, derez: Number.isFinite(derez) && derez > 0 ? 1 : 0 };
    }
    return value;
  });
  return any ? key : null;
}

/**
 * A solid cell's boxes in cell-local fractions: stair steps, one box per span,
 * or the historical single box from base to height.
 */
function cellBoxes(cell, height, base, spans) {
  return stairCellBoxes(cell)
    || spans?.map(([bottom, top]) => ({ x: 0.5, y: 0.5, sizeX: 1, sizeY: 1, height: top, base: bottom }))
    || [{ x: 0.5, y: 0.5, sizeX: 1, sizeY: 1, height, base }];
}

function materialIdForCell(cell) {
  if (cell === null || cell === undefined || cell === false || cell === 0) return null;
  if (typeof cell === 'string' || typeof cell === 'number') return cell;
  return cell.material ?? cell.materialId ?? null;
}

/**
 * effects.glitchGlyphs (a string of atlas characters, up to 8) and
 * effects.glitchPalette (up to 4 colours in any facade colour form) as the
 * renderer's glitch style, or null when neither is given. Throws on a glyph
 * the atlas cannot draw, like setLuminanceScale.
 */
function glitchStyle(effects) {
  const glyphText = effects.glitchGlyphs;
  const palette = effects.glitchPalette;
  if ((glyphText === undefined || glyphText === null) && (palette === undefined || palette === null)) return null;
  let glyphs = [];
  if (glyphText !== undefined && glyphText !== null) {
    if (typeof glyphText !== 'string') throw new TypeError('effects.glitchGlyphs must be a string of glyphs.');
    const chars = [...glyphText].slice(0, 8);
    const undrawable = chars.filter(char => !canDrawGlyph(char));
    if (undrawable.length) throw new TypeError(`effects.glitchGlyphs: the glyph atlas cannot draw ${JSON.stringify(undrawable.join(''))}.`);
    glyphs = chars.map(char => glyphIndexForChar(char) || glyphIndexForChar(char.toUpperCase()));
  }
  let colors = [];
  if (palette !== undefined && palette !== null) {
    if (!Array.isArray(palette)) throw new TypeError('effects.glitchPalette must be an array of colours.');
    colors = palette.slice(0, 4).map(color => {
      const rgb = colorToRgb(color, [Number.NaN, Number.NaN, Number.NaN]);
      if (!Number.isFinite(rgb.r)) throw new TypeError(`effects.glitchPalette: ${JSON.stringify(color)} is not a colour.`);
      return [rgb.r / 255, rgb.g / 255, rgb.b / 255];
    });
  }
  return { glyphs, colors };
}

function firstMaterialId(materials) {
  return materials.keys().next().value || null;
}

function toRendererHorizontalX(value, metrics) {
  return (value - metrics.originX) / metrics.cellSize;
}

function toRendererHorizontalY(value, metrics) {
  return (value - metrics.originY) / metrics.cellSize;
}

function toRendererZ(value, metrics) {
  return ENGINE_FLOOR_Z - ((value - metrics.floorHeight) / metrics.cellSize);
}

function toRendererPortal(portal, metrics) {
  if (!portal || !Number.isFinite(portal.x) || !Number.isFinite(portal.y)) return null;
  const color = colorToRgb(portal.color, [0, 220, 255]);
  return {
    x: toRendererHorizontalX(portal.x, metrics),
    y: toRendererHorizontalY(portal.y, metrics),
    color: [color.r / 255, color.g / 255, color.b / 255],
    range: Number.isFinite(portal.range) ? portal.range / metrics.cellSize : undefined
  };
}

function toRendererEffects(effects, metrics) {
  const convertZones = source => Array.isArray(source)
    ? source.filter(zone => zone && Number.isFinite(zone.x) && Number.isFinite(zone.y)).map(zone => ({
      x: toRendererHorizontalX(zone.x, metrics),
      y: toRendererHorizontalY(zone.y, metrics),
      radius: Math.max(0, finiteOr(zone.radius, 0) / metrics.cellSize)
    }))
    : [];
  return {
    ...effects,
    pitchBlackZones: convertZones(effects.pitchBlackZones),
    jammingFields: convertZones(effects.jammingFields)
  };
}

function atmosphereOptions(atmosphere, effects, features = {}) {
  const fog = colorToRgb(atmosphere.fogColor ?? atmosphere.background, [0, 0, 0]);
  const fogColor = [fog.r / 255, fog.g / 255, fog.b / 255];
  const fogFar = finiteOr(atmosphere.fogFar, 0);
  const options = {
    fogColor,
    fogDensity: Number.isFinite(atmosphere.fogDensity) ? atmosphere.fogDensity : (fogFar > 0 ? 1 / fogFar : 0),
    ambientFactor: finiteOr(atmosphere.ambient, 0.2),
    exposure: finiteOr(atmosphere.exposure, 0.9),
    bloomScale: Math.max(0, finiteOr(effects.bloom, 1)),
    bloom: effects.bloom !== false,
    environmentalFx: effects.environmentalFx === true,
    reactiveSurfaces: effects.reactiveSurfaces === true
  };

  // Optional grading fields pass through only when supplied, so the resolved
  // profile keeps its defaults otherwise.
  if (Number.isFinite(atmosphere.fogHeightFalloff)) options.fogHeightFalloff = atmosphere.fogHeightFalloff;
  if (Number.isFinite(atmosphere.emissiveIntensity)) options.emissiveIntensity = atmosphere.emissiveIntensity;
  if (Number.isFinite(atmosphere.volumetricStrength)) options.volumetricStrength = atmosphere.volumetricStrength;
  if (Number.isFinite(atmosphere.gradeGamma)) options.gradeGamma = atmosphere.gradeGamma;
  if (Number.isFinite(atmosphere.gradeSaturation)) options.gradeSaturation = atmosphere.gradeSaturation;
  if (Array.isArray(atmosphere.gradeLift)) options.gradeLift = atmosphere.gradeLift;
  if (Array.isArray(atmosphere.gradeGain)) options.gradeGain = atmosphere.gradeGain;
  if (atmosphere.shadowTint !== undefined) {
    const tint = colorToRgb(atmosphere.shadowTint, [255, 255, 255]);
    options.shadowTint = [tint.r / 255, tint.g / 255, tint.b / 255];
  }

  // THE SHADING CONTRACT — how dark a world is allowed to be.
  //
  // These five were renderer-internal until now, tuned for facility interiors
  // where nothing is ever meant to be lost. An outdoor night city needs to
  // author its own floor, so each passes through only when supplied and the
  // resolved profile keeps the historical value otherwise.
  if (Number.isFinite(atmosphere.shadowFloor)) options.shadowFloor = atmosphere.shadowFloor;
  if (Number.isFinite(atmosphere.visibilityFloor)) options.visibilityFloor = atmosphere.visibilityFloor;
  if (Number.isFinite(atmosphere.shadowLift)) options.shadowLift = atmosphere.shadowLift;
  if (Number.isFinite(atmosphere.lowLightAdaptation)) {
    options.lowLightAdaptation = atmosphere.lowLightAdaptation;
  }
  if (Number.isFinite(atmosphere.ambientOcclusionStrength)) {
    options.ambientOcclusionStrength = atmosphere.ambientOcclusionStrength;
  }

  // Reactive-surface (wet street) fields ride the same per-frame channel; the
  // resolver zeroes them whenever effects.reactiveSurfaces is false.
  if (Number.isFinite(atmosphere.reflectionStrength)) options.reflectionStrength = atmosphere.reflectionStrength;
  if (Number.isFinite(atmosphere.reflectionReach)) options.reflectionReach = atmosphere.reflectionReach;
  if (Number.isFinite(atmosphere.reactiveSurfaceDensity)) options.reactiveSurfaceDensity = atmosphere.reactiveSurfaceDensity;
  if (Number.isFinite(atmosphere.surfaceDistortion)) options.surfaceDistortion = atmosphere.surfaceDistortion;
  if (atmosphere.surfaceTint !== undefined) {
    const tint = colorToRgb(atmosphere.surfaceTint, [255, 255, 255]);
    options.surfaceTint = [tint.r / 255, tint.g / 255, tint.b / 255];
  }
  if (atmosphere.fullFloorReflection === true) options.fullFloorReflection = true;
  if (atmosphere.reactiveSurfaceFocus === 'camera') options.reactiveSurfaceFocus = 'camera';
  if (Number.isFinite(atmosphere.starDensity)) options.starDensity = atmosphere.starDensity;
  if (Number.isFinite(atmosphere.starBrightness)) options.starBrightness = atmosphere.starBrightness;
  if (Number.isFinite(atmosphere.fogDither)) options.fogDither = atmosphere.fogDither;
  if (atmosphere.fogDistance === 'planar') options.fogPlanar = true;
  if (Number.isFinite(atmosphere.skylineStrength)) options.skylineStrength = atmosphere.skylineStrength;
  if (Number.isFinite(atmosphere.skylineSeed)) options.skylineSeed = atmosphere.skylineSeed;
  if (Number.isFinite(atmosphere.particleDensity)) options.particleDensity = atmosphere.particleDensity;
  if (Number.isFinite(atmosphere.precipitation)) options.precipitation = atmosphere.precipitation;
  // Particle CEILINGS and camera focus (gated by effects.environmentalFx like
  // every other particle field). Absent = the effect profile's own constants
  // and the historical whole-map seeding.
  if (Number.isFinite(atmosphere.particleBudget)) options.particleBudget = atmosphere.particleBudget;
  if (Number.isFinite(atmosphere.precipitationBudget)) {
    options.precipitationBudget = atmosphere.precipitationBudget;
  }
  if (atmosphere.particleFocus === 'camera') options.particleFocus = 'camera';
  if (Number.isFinite(atmosphere.particleFocusRadius)) {
    options.particleFocusRadius = atmosphere.particleFocusRadius;
  }
  if (atmosphere.dustColor !== undefined) {
    const dust = colorToRgb(atmosphere.dustColor, [255, 255, 255]);
    options.dustColor = [dust.r / 255, dust.g / 255, dust.b / 255];
  }

  // Open sky: features.sky removes the ceiling; supplying sky colors makes the
  // uncovered pixels render as a vertical gradient instead of black. skyGlow
  // paints an azimuthal horizon glow - a dawn line, a sunset, a city's halo.
  const hasSkyColors = atmosphere.skyTop !== undefined || atmosphere.skyHorizon !== undefined;
  if (features.sky === true && hasSkyColors) {
    const top = colorToRgb(atmosphere.skyTop ?? atmosphere.background ?? atmosphere.fogColor, [0, 0, 0]);
    const horizon = colorToRgb(atmosphere.skyHorizon ?? atmosphere.fogColor, [0, 0, 0]);
    options.skyEnabled = true;
    options.skyTopColor = [top.r / 255, top.g / 255, top.b / 255];
    options.skyHorizonColor = [horizon.r / 255, horizon.g / 255, horizon.b / 255];
    const glow = atmosphere.skyGlow;
    if (glow && typeof glow === 'object') {
      const glowColor = colorToRgb(glow.color, [255, 200, 130]);
      options.skyGlowColor = [glowColor.r / 255, glowColor.g / 255, glowColor.b / 255];
      options.skyGlowAzimuth = finiteOr(glow.azimuth, 0);
      options.skyGlowStrength = Math.max(0, finiteOr(glow.strength, 0));
      options.skyGlowSharpness = Math.max(0.5, finiteOr(glow.sharpness, 3));
    }
  }
  return options;
}

function metricsKey(metrics) {
  return {
    cellSize: metrics.cellSize,
    originX: metrics.originX,
    originY: metrics.originY,
    floorHeight: metrics.floorHeight,
    ceilingHeight: metrics.ceilingHeight
  };
}

function metricsMatch(key, metrics) {
  return key.cellSize === metrics.cellSize &&
    key.originX === metrics.originX &&
    key.originY === metrics.originY &&
    key.floorHeight === metrics.floorHeight &&
    key.ceilingHeight === metrics.ceilingHeight;
}

function cellReferenceSet(references) {
  return new Set((references || []).map(reference => `${reference.x},${reference.y}`));
}

/**
 * Normalizes pixel-art rows at registration: every row padded with trailing
 * spaces (transparent) to the widest row, so the atlas rasterizer — which
 * indexes `art[0].length` across every row — always sees a rectangle.
 * Returns null when the definition carries no usable art (absent, empty, or
 * all rows blank), which sends registerSprite down the single-glyph path.
 */
function normalizeSpriteArt(art) {
  if (!Array.isArray(art) || art.length === 0) return null;
  const rows = art.map(row => typeof row === 'string' ? row : String(row ?? ''));
  const width = rows.reduce((max, row) => Math.max(max, row.length), 0);
  if (width === 0) return null;
  return rows.map(row => row.padEnd(width, ' '));
}

function positiveInteger(value, fallback) {
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function finiteOr(value, fallback) {
  return Number.isFinite(value) ? value : fallback;
}

/**
 * A registration palette, resolved once into the shape resolveMaterial's
 * resolver contract wants: char -> { r?, g?, b?, emission?, roughness?,
 * lightResponse?, exact: true }. Color is optional per entry — an
 * emission-only body entry ("keep the authored color, leave the emissive
 * branch") is the lit-machines case. Null when nothing usable was given.
 */
function normalizeMeshPalette(palette) {
  if (!palette || typeof palette !== 'object') return null;
  const map = new Map();
  for (const [char, entry] of Object.entries(palette)) {
    if (!entry || typeof entry !== 'object' || char.length === 0) continue;
    const resolved = { exact: true };
    if (entry.color !== undefined) {
      const rgb = colorToRgb(entry.color, [255, 255, 255]);
      resolved.r = rgb.r;
      resolved.g = rgb.g;
      resolved.b = rgb.b;
    }
    if (Number.isFinite(entry.emission)) resolved.emission = entry.emission;
    if (Number.isFinite(entry.roughness)) resolved.roughness = entry.roughness;
    if (Number.isFinite(entry.lightResponse)) resolved.lightResponse = entry.lightResponse;
    if (resolved.r === undefined && resolved.emission === undefined &&
        resolved.roughness === undefined && resolved.lightResponse === undefined) continue;
    map.set(char, resolved);
  }
  return map.size > 0 ? map : null;
}

/**
 * One resolver per registration, serving both knobs:
 *
 *  - palette: exact per-char material overrides (see normalizeMeshPalette).
 *  - accent:  the per-entity optic recolor. It applies only to the
 *    MESH_ACCENT_CHARS char hints, and only while the char's EFFECTIVE
 *    emission — the palette's when an entry overrides it, the authored
 *    material's otherwise — is >= MESH_ACCENT_EMISSION_FLOOR. The accent
 *    replaces the color; every other material scalar still comes from the
 *    palette entry (or stays authored), so an accented optic keeps its glow.
 */
function createMeshColorResolver(palette) {
  return (entity, _sampleY, _sampleX, char, material) => {
    const entry = palette !== null ? (palette.get(char) || null) : null;
    const accent = entity.meshAccent;
    if (accent && MESH_ACCENT_CHAR_SET.has(char)) {
      const emission = entry !== null && Number.isFinite(entry.emission)
        ? entry.emission
        : (material ? material.emission : 1);
      if (emission >= MESH_ACCENT_EMISSION_FLOOR) {
        return {
          r: accent.r,
          g: accent.g,
          b: accent.b,
          emission: entry !== null ? entry.emission : undefined,
          roughness: entry !== null ? entry.roughness : undefined,
          lightResponse: entry !== null ? entry.lightResponse : undefined,
          exact: true
        };
      }
    }
    return entry;
  };
}

/**
 * A facade color, as an RGB multiplier triple in 0..1 — or null for identity
 * (absent, or resolving to white), so the presentation walk can skip it.
 */
function tintToMultiplier(value) {
  if (value === null || value === undefined) return null;
  const rgb = colorToRgb(value, [255, 255, 255]);
  if (rgb.r === 255 && rgb.g === 255 && rgb.b === 255) return null;
  return [rgb.r / 255, rgb.g / 255, rgb.b / 255];
}

function colorToRgb(value, fallback) {
  if (Array.isArray(value) && value.length >= 3) {
    const scale = value.every(part => Number.isFinite(part) && part <= 1) ? 255 : 1;
    return { r: clamp(value[0] * scale), g: clamp(value[1] * scale), b: clamp(value[2] * scale) };
  }
  if (value && typeof value === 'object') {
    return { r: clamp(value.r), g: clamp(value.g), b: clamp(value.b) };
  }
  if (typeof value === 'string') {
    const hex = value.trim().replace(/^#/, '');
    const normalized = hex.length === 3 ? [...hex].map(part => part + part).join('') : hex;
    if (/^[0-9a-fA-F]{6}$/.test(normalized)) {
      return { r: parseInt(normalized.slice(0, 2), 16), g: parseInt(normalized.slice(2, 4), 16), b: parseInt(normalized.slice(4, 6), 16) };
    }
  }
  return { r: fallback[0], g: fallback[1], b: fallback[2] };
}

function clamp(value) {
  return Math.max(0, Math.min(255, Number.isFinite(value) ? value : 0));
}
