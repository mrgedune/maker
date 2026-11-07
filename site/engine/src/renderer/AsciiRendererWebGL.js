/**  
 * AsciiRendererWebGL.js - GPU-Resident Deferred ASCII Rendering Pipeline Engine
 * Uses WebGL 2, Multi-Render-Targets (MRT) with Float textures, and post-processing shaders 
 * to execute raycasting, rasterization, lighting, and ASCII mapping entirely on the GPU.
 */  

import { normalizeViewmodelDrawRanges, normalizeViewmodelTransform, isValidViewmodelGeometry } from './ViewmodelDrawRanges.js';
import { cameraBasis, cameraSpriteQuad } from './CameraSprite.js';
import { hudImageRect, hudImageState } from './HudImage.js';
import { preparePrograms, takePreparedPrograms } from './PreparedPrograms.js';
import { updateScreenFlash, createScreenFlashState } from './ScreenFlash.js';
import {
  geomVS,
  geomFS,
  entityVS,
  entityFS,
  lightVS,
  lightFS,
  surfaceVS,
  surfaceFS,
  particleVS,
  particleFS,
  asciiVS,
  asciiFS,
  cellVS,
  cellFS,
  glyphVS,
  glyphFS,
  bloomVS,
  bloomPrefilterFS,
  bloomBlurFS,
  shadowGeomVS,
  shadowGeomFS,
  shadowEntityVS,
  shadowEntityFS,
  MAX_LIGHTS,
  MAX_HAZARD_ZONES
} from './ShaderSources.js';
import {
  DEFAULT_GLYPH_PIPELINE_MODE,
  FONT_ATLAS,
  GLYPH_CHARS,
  PROCEDURAL_BLOCK_COVERAGE,
  PROCEDURAL_QUADRANT_MASKS,
  QUADRANT_BITS,
  QUADRANT_GLYPH_INDICES,
  buildRampIndices,
  normalizeGlyphPipelineMode,
  resolveSceneResolution
} from './GlyphPipeline.js';
import TextureAtlasManager, {
  STATIC_SLOT_BAKED, STATIC_SLOT_EMPTY, STATIC_SLOT_UNREGISTERED
} from './TextureAtlasManager.js';
import SceneGeometry from './SceneGeometry.js';
import { startupTrace } from './StartupTrace.js';
import { buildLightVisibilityAtlas, createLightVisibilityCache, getLightVisibilityFingerprint } from './LightVisibilityAtlas.js';
import { WORLD_CEILING_Z, WORLD_FLOOR_Z } from './WorldZ.js';
import { resolveAtmosphereProfile } from './AtmosphereProfiles.js';
import { ENVIRONMENT_PARTICLE_STRIDE, MAX_FOG_VOLUMES, buildEnvironmentalEffects, getEnvironmentalEffectsFingerprint } from './EnvironmentalEffects.js';
import { MAX_REACTIVE_SURFACES, buildReactiveSurfaces, getReactiveSurfacesFingerprint } from './ReactiveSurfaces.js';
import { ENTITY_VERTEX_STRIDE, buildEntityGeometry } from './EntityGeometry.js';
import { setEntityAnimationSteadyState } from './EntityAnimation.js';
// First-person viewmodels are supplied by an optional game extension, not the core engine.
import {
  MAX_VOLUMETRIC_LIGHT_SLOTS,
  resolveFlashlightProjection,
  resolveProjectedLight,
  selectVolumetricLightIndices
} from './ProjectedLighting.js';
import {
  RENDERER_ATLAS_COLUMNS,
  RENDERER_MAX_BILLBOARDS,
  RENDERER_STATIC_ATLAS_SLOTS,
  resolveAtlasLayout,
  RENDERER_TOTAL_ATLAS_SLOTS,
  getResolutionContract,
  normalizeResolutionMode,
  resolveRendererBudgets
} from './RendererScalability.js';
import { SpriteCellPool } from './SpriteCellPool.js';

const CHARS = GLYPH_CHARS;

/**
 * How far the camera must travel before cullable fixture lights are reselected,
 * in world units, and how far past a fixture's own range it stays eligible.
 *
 * The distance exists to bound how often the light visibility bake is rebuilt;
 * the margin stops a fixture right on its range boundary from flickering in and
 * out as the player edges around it.
 */
const CULLABLE_LIGHT_REEVALUATE_DISTANCE = 1.5;
const CULLABLE_LIGHT_MARGIN = 1.0;

/**
 * Radius around the eye that holds the operative's own equipment.
 *
 * Only the first-person viewmodel is ever this close - ViewmodelGeometry builds
 * the arms and instruments within roughly 0.6m of the camera - so this is a
 * viewmodel mask expressed as a distance rather than a new G-buffer channel.
 * World geometry the operative is pressed against is treated the same way,
 * which is a fair trade for not having the operative's own arms glow into the
 * room.
 *
 * IT MASKS TWO THINGS SINCE 2026-08-26. The bloom bright pass, as before; and
 * the deferred light pass's `emissiveForm` and its fog, which are dot products
 * against FIXED WORLD directions and therefore brightness dials the operative
 * turns by looking around, because the rig's normals are the camera's. See the
 * note in `ShaderSources`' self-luminous branch.
 *
 * THE MARGIN IS THIN AND IT IS GUARDED. The whole viewmodel sits 0.543-0.772 m
 * from the eye across the shipped FOV range - four percent of headroom at the
 * far corner - and if anything ever crosses this line the mask makes a hard
 * seam mid-instrument rather than a fade. `test/wrist_scope.test.js` asserts
 * the distance rather than leaving it to somebody noticing in a screenshot.
 */
const VIEWMODEL_BLOOM_EXCLUDE_RADIUS = 0.8;

/**
 * How often the whole roster is re-tessellated, in milliseconds.
 *
 * 30 Hz, and this is the number the game runs on rather than a copy of it - the
 * constructor reads it and so does the case that counts rebuilds, so a change
 * here reaches both. It was a literal in the constructor, and a literal is a
 * number a test can only agree with by having been told it separately: setting
 * it to zero left `test/entity_geometry_emit.test.js` perfectly green, because
 * the case was driving its own interval and was never asking what the game had.
 *
 * The rebuild has no cross-frame cache and measurement says it cannot usefully
 * get one - of the meshes a floor-150 roster emits on one frame, ZERO are
 * byte-identical to another entity's - so this interval is the only thing
 * standing between the game and paying for the whole roster at the display's
 * refresh rate. At 165 Hz that is five and a half times the work.
 */
export const ENTITY_REBUILD_INTERVAL_MS = 1000 / 30;

/**
 * The model matrix entity meshes draw through. Entities author world-space
 * vertices, so their transform is the identity - one shared constant, because
 * a WebGL uniform left unset is ZERO, not identity, and a zeroed model matrix
 * collapses every entity into the origin.
 */
const GBUFFER_CLEAR_FLOAT = new Float32Array(4);
const GBUFFER_CLEAR_UINT = new Uint32Array(4);

// The render targets sized by the grid, by the renderer's own field names:
// what a size kept by setSceneTargetCache holds and swaps back in.
const SCENE_TARGET_FIELDS = [
  'gbufFBO', 'gbufAlbedo', 'gbufNormal', 'gbufPosition', 'gbufVisibilityCell', 'gbufDepthStencil',
  'lightFBO', 'lightTexture', 'surfaceFBO', 'surfaceTexture',
  'bloomFBOs', 'bloomTextures', 'cellFBOs', 'cellTargets'
];

const IDENTITY_MODEL_MATRIX = new Float32Array([
  1, 0, 0, 0,
  0, 1, 0, 0,
  0, 0, 1, 0,
  0, 0, 0, 1
]);

// Matrix helper utility library for MVP calculations
const Mat4 = {
  identity: () => new Float32Array([
    1, 0, 0, 0,
    0, 1, 0, 0,
    0, 0, 1, 0,
    0, 0, 0, 1
  ]),
  
  perspective: (fovy, aspect, near, far, out = new Float32Array(16)) => {
    const f = 1.0 / Math.tan(fovy / 2);
    const nf = 1.0 / (near - far);
    out[0] = f / aspect; out[1] = 0; out[2] = 0; out[3] = 0;
    out[4] = 0; out[5] = f; out[6] = 0; out[7] = 0;
    out[8] = 0; out[9] = 0; out[10] = (far + near) * nf; out[11] = -1;
    out[12] = 0; out[13] = 0; out[14] = 2 * far * near * nf; out[15] = 0;
    return out;
  },
  
  lookAt: (eye, center, up, out = new Float32Array(16)) => {
    const eyex = eye[0], eyey = eye[1], eyez = eye[2];
    const upx = up[0], upy = up[1], upz = up[2];
    const zx = eyex - center[0], zy = eyey - center[1], zz = eyez - center[2];
    const len = 1.0 / Math.sqrt(zx*zx + zy*zy + zz*zz) || 1e-10;
    const zxn = zx * len, zyn = zy * len, zzn = zz * len;
    
    const uxn = upy * zzn - upz * zyn;
    const uyn = upz * zxn - upx * zzn;
    const uzn = upx * zyn - upy * zxn;
    const len2 = 1.0 / Math.sqrt(uxn*uxn + uyn*uyn + uzn*uzn) || 1e-10;
    const xx = uxn * len2, xy = uyn * len2, xz = uzn * len2;
    
    const yx = zyn * xz - zzn * xy;
    const yy = zzn * xx - zxn * xz;
    const yz = zxn * xy - zyn * xx;
    
    out[0] = xx; out[1] = yx; out[2] = zxn; out[3] = 0;
    out[4] = xy; out[5] = yy; out[6] = zyn; out[7] = 0;
    out[8] = xz; out[9] = yz; out[10] = zzn; out[11] = 0;
    out[12] = -(xx*eyex + xy*eyey + xz*eyez);
    out[13] = -(yx*eyex + yy*eyey + yz*eyez);
    out[14] = -(zxn*eyex + zyn*eyey + zzn*eyez);
    out[15] = 1;
    return out;
  }
};

/** Free cameras opt in to a full-sphere view (see cameraBasis). */
function isFreeCamera(player) {
  return player?.freeLook === true || (Number.isFinite(player?.roll) && player.roll !== 0);
}

function projectPoint(x, y, z, view, projection) {
  const ex = view[0]*x + view[4]*y + view[8]*z + view[12];
  const ey = view[1]*x + view[5]*y + view[9]*z + view[13];
  const ez = view[2]*x + view[6]*y + view[10]*z + view[14];
  const ew = view[3]*x + view[7]*y + view[11]*z + view[15];

  const cx = projection[0]*ex + projection[4]*ey + projection[8]*ez + projection[12]*ew;
  const cy = projection[1]*ex + projection[5]*ey + projection[9]*ez + projection[13]*ew;
  const cz = projection[2]*ex + projection[6]*ey + projection[10]*ez + projection[14]*ew;
  const cw = projection[3]*ex + projection[7]*ey + projection[11]*ez + projection[15]*ew;

  if (cw === 0) return null;

  return {
    x: cx / cw,
    y: cy / cw,
    z: cz / cw,
    w: cw,
    eyeZ: ez
  };
}

// Reject a quad only when every corner is outside the same clip plane. Testing
// divided screen coordinates or only its center loses wide and near-spanning
// signs. compile publishes the same matrices before rebuilding sprite geometry.
/** cells.every(code => code <= count), without a call per vertex. */
function everyCodeWithin(cells, count) {
  for (let i = 0; i < cells.length; i++) if (cells[i] > count) return false;
  return true;
}

function quadOutsideFrustum(p1, p2, p3, p4, view, projection) {
  if (!view || !projection || view.length !== 16 || projection.length !== 16) return false;
  let outside = 63;
  for (const point of [p1, p2, p3, p4]) {
    // The VBO uploads float32 positions; cull the corners actually drawn.
    const x = Math.fround(point[0]), y = Math.fround(point[1]), z = Math.fround(point[2]);
    const ex = view[0]*x + view[4]*y + view[8]*z + view[12];
    const ey = view[1]*x + view[5]*y + view[9]*z + view[13];
    const ez = view[2]*x + view[6]*y + view[10]*z + view[14];
    const ew = view[3]*x + view[7]*y + view[11]*z + view[15];
    const cx = projection[0]*ex + projection[4]*ey + projection[8]*ez + projection[12]*ew;
    const cy = projection[1]*ex + projection[5]*ey + projection[9]*ez + projection[13]*ew;
    const cz = projection[2]*ex + projection[6]*ey + projection[10]*ez + projection[14]*ew;
    const cw = projection[3]*ex + projection[7]*ey + projection[11]*ez + projection[15]*ew;
    if (!Number.isFinite(cx) || !Number.isFinite(cy) || !Number.isFinite(cz) || !Number.isFinite(cw)) return false;
    // Retain a small boundary margin for CPU/GPU float arithmetic differences.
    const margin = 1e-6 * Math.max(1, Math.abs(cw));
    const mask = (cx < -cw - margin ? 1 : 0) | (cx > cw + margin ? 2 : 0)
      | (cy < -cw - margin ? 4 : 0) | (cy > cw + margin ? 8 : 0)
      | (cz < -cw - margin ? 16 : 0) | (cz > cw + margin ? 32 : 0);
    outside &= mask;
    if (outside === 0) return false;
  }
  return outside !== 0;
}

const REQUIRED_WEBGL_EXTENSIONS = Object.freeze([
  'EXT_color_buffer_float',
  'OES_texture_float_linear'
]);

export class RendererCapabilityError extends Error {
  constructor(reason, code = 'renderer-unsupported') {
    super(reason);
    this.name = 'RendererCapabilityError';
    this.code = code;
  }
}

/**
 * Probe the exact baseline used by the deferred renderer before allocating any
 * GPU resource. A failed probe is a supported startup state, never a partially
 * initialized AsciiRendererWebGL instance.
 */
/**
 * The context attributes this renderer has always asked for.
 *
 * Named and exported so a consumer that wants to ADD one - `powerPreference`
 * being the case this was written for - can spread these rather than restate
 * them and silently drop one.
 */
export const DEFAULT_CONTEXT_ATTRIBUTES = Object.freeze({
  alpha: false,
  antialias: false
});

export function probeRendererCapabilities(canvas, contextAttributes) {
  if (!canvas || typeof canvas.getContext !== 'function') {
    return Object.freeze({ supported: false, reason: 'Graphics canvas is unavailable' });
  }

  /**
   * OPT-IN, AND DEFAULTED TO WHAT WAS ALWAYS SENT.
   *
   * A caller that passes nothing gets the exact object this function has
   * always passed, so every existing consumer is byte-identical. The reason
   * this became a parameter at all: on a hybrid laptop - an Optimus machine
   * with an integrated GPU beside a discrete one - a WebGL context created
   * with no `powerPreference` may be handed the integrated adapter, and the
   * page has no way to ask for the other one afterwards.
   *
   * ONE CONTEXT PER CANVAS, AND THE FIRST ONE WINS. A second `getContext` on a
   * canvas that already has one returns the SAME object and DISCARDS the new
   * attributes - measured in Electron 31.7.7, where `getContextAttributes()`
   * still reported `powerPreference: "default"` after `'high-performance'` was
   * requested. So a consumer that probes on the real canvas first and then
   * constructs a renderer on it has already spent its one chance, and any
   * attributes it passes later are a guaranteed silent no-op.
   */
  const attributes = contextAttributes
    ? { ...DEFAULT_CONTEXT_ATTRIBUTES, ...contextAttributes }
    : DEFAULT_CONTEXT_ATTRIBUTES;

  let gl;
  try {
    gl = canvas.getContext('webgl2', attributes);
  } catch (error) {
    const detail = String(error?.message || error || 'unknown error').slice(0, 256);
    return Object.freeze({
      supported: false,
      reason: `WebGL 2 context creation failed: ${detail}`
    });
  }
  if (!gl) {
    return Object.freeze({ supported: false, reason: 'WebGL 2 is unavailable' });
  }

  let missingExtensions;
  let limits;
  try {
    missingExtensions = REQUIRED_WEBGL_EXTENSIONS.filter(name => !gl.getExtension(name));
    limits = Object.freeze({
      maxTextureSize: Number(gl.getParameter(gl.MAX_TEXTURE_SIZE)) || 0,
      maxDrawBuffers: Number(gl.getParameter(gl.MAX_DRAW_BUFFERS)) || 0,
      maxColorAttachments: Number(gl.getParameter(gl.MAX_COLOR_ATTACHMENTS)) || 0
    });
  } catch (error) {
    const detail = String(error?.message || error || 'unknown error').slice(0, 256);
    return Object.freeze({
      supported: false,
      reason: `Graphics capability query failed: ${detail}`
    });
  }
  if (missingExtensions.length > 0) {
    return Object.freeze({
      supported: false,
      reason: `Missing graphics extensions: ${missingExtensions.join(', ')}`
    });
  }

  const insufficient = [];
  if (limits.maxTextureSize < 2048) insufficient.push('MAX_TEXTURE_SIZE < 2048');
  if (limits.maxDrawBuffers < 4) insufficient.push('MAX_DRAW_BUFFERS < 4');
  if (limits.maxColorAttachments < 4) insufficient.push('MAX_COLOR_ATTACHMENTS < 4');
  if (insufficient.length > 0) {
    return Object.freeze({
      supported: false,
      reason: `Insufficient graphics limits: ${insufficient.join(', ')}`,
      limits
    });
  }

  return Object.freeze({ supported: true, gl, limits, adapter: describeAdapter(gl) });
}

/**
 * WHICH GPU IS ACTUALLY DRAWING THIS - as far as the browser will say.
 *
 * `gl.getParameter(gl.RENDERER)` is masked to something useless ("WebKit
 * WebGL") for fingerprinting reasons, so the only way to learn the real
 * adapter is the `WEBGL_debug_renderer_info` extension, which a browser may
 * decline to provide. Everything here is therefore best-effort and every
 * field is optional - a caller must be able to render without any of it.
 *
 * Purely diagnostic: nothing in the renderer branches on this. It exists
 * because a hybrid laptop silently running on its integrated GPU and a
 * discrete GPU that is genuinely too slow produce the same symptom, and no
 * amount of frame-time measurement can tell them apart from inside the page.
 */
export function describeAdapter(gl) {
  const out = { renderer: null, vendor: null, masked: null, attributes: null };
  if (!gl) return Object.freeze(out);
  try {
    out.masked = String(gl.getParameter(gl.RENDERER) || '') || null;
    const info = gl.getExtension('WEBGL_debug_renderer_info');
    if (info) {
      out.renderer = String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL) || '') || null;
      out.vendor = String(gl.getParameter(info.UNMASKED_VENDOR_WEBGL) || '') || null;
    }
    // What the driver actually granted, which is not always what was asked
    // for - the whole point of reporting it.
    const granted = typeof gl.getContextAttributes === 'function'
      ? gl.getContextAttributes() : null;
    if (granted) {
      out.attributes = {
        powerPreference: granted.powerPreference ?? null,
        alpha: granted.alpha ?? null,
        antialias: granted.antialias ?? null,
      };
    }
  } catch {
    // A browser refusing to answer is a supported outcome, not a failure.
  }
  return Object.freeze(out);
}

export default class AsciiRendererWebGL {  
  /**  
   * @param {HTMLCanvasElement} canvas - The target canvas for WebGL rendering  
   * @param {number} width - Horizontal grid resolution (columns)  
   * @param {number} height - Vertical grid resolution (rows)  
   */  
  static async prepare(canvas, options = {}) {
    const capability = probeRendererCapabilities(canvas, options.contextAttributes);
    if (!capability.supported) throw new RendererCapabilityError(capability.reason);
    return preparePrograms(capability.gl, { signal: options.signal });
  }

  constructor(canvas, width, height, options = {}) {  
    this.atlasLayout = resolveAtlasLayout(options.staticAtlasSlots);
    this.darkWorldGlyphs = options.darkWorldGlyphs === true;
    this.canvas = canvas;  
    this.width = width;  
    this.height = height;  
    this.cellSize = 64;
    this.atlasSize = 1024;
    
    // Optional and defaulted - see probeRendererCapabilities. A consumer that
    // passes nothing creates exactly the context this renderer always created.
    const capability = probeRendererCapabilities(canvas, options.contextAttributes);
    if (!capability.supported) {
      throw new RendererCapabilityError(capability.reason);
    }
    this.gl = capability.gl;
    this.rendererLimits = capability.limits;
    /** Best-effort description of the GPU actually serving this context. */
    this.adapter = capability.adapter || null;
    this.contextLost = false;
    this.operational = false;
    this.installContextLifecycleHandlers();

    // Upgrade 83: the 3D scene renders at an integer multiple of the glyph
    // grid so each character cell owns an exact NxN block of scene texels.
    // Before this the two were the same surface, giving one world sample per
    // glyph and leaving no sub-cell detail for the glyph pass to resolve.
    this.maxTextureSize = this.rendererLimits.maxTextureSize;
    this.glyphPipelineMode = DEFAULT_GLYPH_PIPELINE_MODE;
    this.sceneContract = resolveSceneResolution({
      gridWidth: width,
      gridHeight: height,
      mode: this.glyphPipelineMode,
      maxTextureSize: this.maxTextureSize
    });
    this.sceneWidth = this.sceneContract.sceneWidth;
    this.sceneHeight = this.sceneContract.sceneHeight;
    // Grid sizes whose targets are kept (setSceneTargetCache): off until a
    // consumer opts in, and every resize reallocates in place.
    this.sceneTargetSets = null;
    this.activeSceneTargets = null;
    this.sceneTargetLimit = 1;
    this.structuralGlyphs = true;
    this.edgeThreshold = 0.18;
    this.ditherEnabled = true;
    // How far a cell leans from its box average toward its brightest sample.
    // 0 is a strict average, which is correct but sinks thin bright detail
    // toward black; 1 restores the peak-driven look of the single-sample path
    // without its instability.
    this.highlightPreservation = 0.45;
    // Upgrade 84: per-cell foreground and background colour. A cell only takes
    // the two-colour path when its samples are genuinely bimodal, so smooth
    // shading keeps the density ramp instead of posterising into blocks.
    this.subCellColor = true;
    this.subCellContrast = 0.16;
    // Minimum separation, in cell widths, between the bright and dark sample
    // centroids before a cell is treated as a boundary rather than texture.
    this.subCellCoherence = 0.3;
    // Upgrade 86: how decisively a differing candidate must win before a cell
    // is allowed to change glyph, and how strongly near-identical cells are
    // smoothed in time.
    this.glyphHysteresis = 0.35;
    this.colorHysteresis = 0.5;
    // Luminance rise that releases the hold outright, so appearing detail is
    // never suppressed no matter how marginal its glyph decision looks.
    this.signalReleaseThreshold = 0.02;
    this.shadowFadeWidth = 0;
    this.screenFlash = createScreenFlashState();
    // Upgrade 87 flashlight shadows.
    this.flashlightShadowsEnabled = true;
    this.shadowNormalBias = 0.045;
    this.shadowDepthBias = 0.0016;
    this.quadrantGlyphIndices = new Int32Array(QUADRANT_GLYPH_INDICES);

    // Shader config properties
    this.maxDepth = 30.0;  
    this.luminanceScale = ' ░▒▓█';  
    this.characterSetId = 'blocks';
    this.spriteLuminanceScale = '·.,-~:;=!*#$@';
    this.spriteCharacterSetId = 'classic';
    // Neutral until a world installs its dimensions and names one. The engine
    // has no atmosphere of its own to fall back to but the identity grade.
    this.atmosphereProfiles = null;
    this.atmosphere = resolveAtmosphereProfile(null);
    // Likewise for what the static atlas slots hold: null until a world says.
    this.staticMaterialSlots = null;
    this.reportedAtlasSlotUses = new Set();
    this.environmentalEffectsFingerprint = '';
    this.environmentalParticleCount = 0;
    this.environmentalFogVolumes = [];
    this.reactiveSurfacesFingerprint = '';
    this.reactiveSurfacePatches = [];
    this.activeBillboardCount = 0;
    // Sprite atlas opt-ins, all off by default (see setSpriteCellRecycling,
    // setSpriteMirroring and setAtlasCellSize).
    this.spriteCellRecycling = false;
    this.spriteCellPool = null;
    this.spriteMirroring = false;
    this.atlasCellSizeOverride = null;
    this.resolutionMode = 'max';
    this.scalabilityBudgets = resolveRendererBudgets();

    // Registries for dynamic game loop coupling
    this.spriteTemplates = new Map();
    this.materials = new Map();
    this.lights = [];

    // Track active map state to rebuild geometry only on changes
    this.currentMapHash = "";
    this.lightVisibilityFingerprint = "";
    // Each shadow-casting light's layer, kept so a change of the set retraces
    // only the lights new to it (LightVisibilityAtlas.js).
    this.lightVisibilityCache = createLightVisibilityCache();
    this.lightVisibilityMapWidth = 1;
    this.lightVisibilityMapHeight = 1;
    this.lightVisibilityLayerCount = 1;
    this.staticFeatureHash = "";
    this.dynamicFeatureHash = "";
    this.uploadedDynamicFeatureHash = "";
    this.sceneGeometry = new SceneGeometry();
    this.authoredSceneGeometry = null;
    this.currentMapReference = null;
    this.mapReferenceVersion = 0;
    this.dynamicSceneFeatures = [];
    this.geometryVertexCount = 0;
    this.dynamicGeometryVertexCount = 0;
    // The phase pass: cells that are mid-dissolve, drawn in a call of their own
    // so `u_dissolve` can address them without reaching the rest of the
    // facility. Empty and inert except for the fraction of a second a phase
    // shift is resolving.
    this.phaseGeometryVertexCount = 0;
    // A number, deliberately not named `phaseDissolve` - GameLoop's field of
    // that name is the running dissolve's STATE object, and one of these copied
    // across to the other reads fine and is always truthy.
    this.phaseDissolveAmount = 1.0;
    this.geometryUploadStats = {
      staticUploads: 0,
      dynamicUploads: 0,
      phaseUploads: 0,
      // How many times the whole roster has been re-tessellated. Read against
      // wall time it is the throttle's own answer to whether it is throttling,
      // which is a question no source assertion can put to a running game.
      entityRebuilds: 0
    };
    this.entityMeshesEnabled = true;
    // Null everywhere but facade scenes: buildEntityGeometry falls back to
    // ENTITY_LOD_DISTANCES, so direct renderer consumers keep the historical
    // LOD bands untouched.
    this.entityLodDistances = null;
    // Null everywhere but facade scenes too: hard LOD thresholds and
    // frame-discrete mesh<->billboard swaps, exactly as before. See
    // setEntityLodTransition.
    this.entityLodTransition = null;
    // Null in the engine: the roster of entities that have a mesh at all, and
    // the meshes themselves, are a world's. The game installs the facility's.
    this.entityContent = null;
    // Null in the game: entity meshes come from the installed content pack.
    // Gore and Creature Studio install a builder ahead of it.
    this.entityMeshBuilder = null;
    this.entityMeshExtraTypes = null;
    // Null in the engine: a containment capsule is a cage until a game says what
    // is caged. The game installs the roster it cycles through one.
    this.specimenResolver = null;
    // A game may install a first-person mesh builder, but the standalone engine
    // deliberately ships without a protagonist, equipment, or HUD geometry.
    this.viewmodelEnabled = false;
    this.viewmodelBuilder = null;
    this.entityVertexCount = 0;
    this.viewmodelVertexCount = 0;
    this.viewmodelPose = 'idle';
    this.viewmodelMotion = null;
    // The rig-to-world matrix the cached viewmodel mesh is drawn through, and
    // the arm-tier array currently resident in the VBO. Animation moves the
    // matrix; the mesh re-uploads only when the articulation re-tessellated.
    this.viewmodelTransform = null;
    this.viewmodelDrawRanges = null;
    this.viewmodelUploadedArms = null;
    this.entityMeshEntities = new Set();
    this.entityRenderStats = {
      full: 0,
      simplified: 0,
      billboard: 0,
      vertexCount: 0
    };
    this.dynamicBufferCapacities = Object.create(null);
    this.lastDynamicGeometryUpdate = -Infinity;
    this.lastEntityGeometryFrameTime = -Infinity;
    this.lastEntityGeometryMap = null;
    this.lastEntityGeometryMapHash = null;
    this.lastEntityGeometryScene = null;
    this.dynamicGeometryIntervalMs = ENTITY_REBUILD_INTERVAL_MS;
    this.activeLightsScratch = [];
    this.shadowLightsScratch = [];
    this.volumetricIndexScratch = new Int32Array(MAX_VOLUMETRIC_LIGHT_SLOTS);
    // Per-frame, world-owned metadata. The renderer never reaches into a host
    // application's globals: the facade supplies effects and revision numbers
    // explicitly through this small state object.
    this.sceneState = Object.freeze({
      revision: 0,
      corrodedCells: null,
      portal: null,
      effects: Object.freeze({})
    });
    // Cullable fixture-light selection. Recomputed on camera movement rather
    // than per frame; see selectCullableLights for why the cadence matters.
    this.cullableSelection = [];
    this.cullableSelectionValid = false;
    this.cullableOriginX = 0;
    this.cullableOriginY = 0;
    this.cullableBudget = -1;
    this.cullableCandidateCount = -1;
    this.projectionMatrix = new Float32Array(16);
    this.viewMatrix = new Float32Array(16);
    this.cameraEye = [0, 0, 0];
    this.cameraCenter = [0, 0, 0];
    this.cameraUp = [0, 0, -1];

    // Initialize full pipeline
    this.initGL();
    this.operational = true;
  }  

  installContextLifecycleHandlers() {
    this.canvas.addEventListener('webglcontextlost', event => {
      event.preventDefault();
      this.contextLost = true;
      this.operational = false;
      this.dispatchRendererFailure(
        'Graphics context was lost. Saveable run state will be preserved; restart is required.',
        'context-lost'
      );
    });
    this.canvas.addEventListener('webglcontextrestored', () => {
      // Restoration without recreating every program, target, atlas, VAO and
      // cached uniform is unsafe. Keep rendering stopped and require restart.
      this.contextLost = true;
      this.operational = false;
      this.dispatchRendererFailure(
        'Graphics context returned, but GPU resources must be rebuilt by restarting the renderer.',
        'context-restored-restart-required'
      );
    });
  }

  dispatchRendererFailure(message, code) {
    const ViewCustomEvent = this.canvas.ownerDocument?.defaultView?.CustomEvent
      || globalThis.CustomEvent;
    if (typeof ViewCustomEvent === 'function') {
      this.canvas.dispatchEvent(new ViewCustomEvent('ascii-engine-renderer-failure', {
        detail: Object.freeze({ message, code, restartRequired: true })
      }));
    }
  }

  assertOperational() {
    const driverReportsLoss = Boolean(this.gl.isContextLost?.());
    if (driverReportsLoss && !this.contextLost) {
      this.contextLost = true;
      this.operational = false;
      this.dispatchRendererFailure(
        'Graphics context became unavailable. Saveable run state will be preserved; restart is required.',
        'context-lost'
      );
    }
    if (!this.operational || this.contextLost || driverReportsLoss) {
      throw new RendererCapabilityError(
        'Graphics rendering is unavailable until the application is restarted.',
        'renderer-context-lost'
      );
    }
  }

  requireGpuResource(resource, label, code = 'renderer-resource-allocation-failed') {
    if (resource) return resource;
    const message = `Unable to allocate ${label}`;
    this.operational = false;
    this.dispatchRendererFailure(
      `${message}. Rendering has stopped; restart is required.`,
      code
    );
    throw new RendererCapabilityError(message, code);
  }

  assertCurrentFramebufferComplete(label) {
    const status = this.gl.checkFramebufferStatus(this.gl.FRAMEBUFFER);
    if (status !== this.gl.FRAMEBUFFER_COMPLETE) {
      const message = `${label} framebuffer is incomplete (status ${status})`;
      this.operational = false;
      this.dispatchRendererFailure(
        `${message}. Rendering has stopped; restart is required.`,
        'renderer-framebuffer-incomplete'
      );
      throw new RendererCapabilityError(message, 'renderer-framebuffer-incomplete');
    }
  }

  initGL() {
    const gl = this.gl;
    if (!gl) return;

    // 1. Compile Shader Programs
    startupTrace.span('webgl.initShaders', () => this.initShaders());

    // 2. Initialize Framebuffers and Buffers
    this.initGBuffer();
    this.initLightBuffer();
    this.initSurfaceBuffer();
    this.initCellBuffer();
    this.initBloomBuffers();
    this.initShadowBuffer();
    this.initFullScreenQuad();

    // 3. Initialize scene meshes
    this.geometryVAO = gl.createVertexArray();
    this.geometryVBO = gl.createBuffer();
    this.geometryVisibilityVBO = gl.createBuffer();
    this.setupGeometryVAO(this.geometryVAO, this.geometryVBO);

    this.dynamicGeometryVAO = gl.createVertexArray();
    this.dynamicGeometryVBO = gl.createBuffer();
    this.setupGeometryVAO(this.dynamicGeometryVAO, this.dynamicGeometryVBO);

    this.phaseGeometryVAO = gl.createVertexArray();
    this.phaseGeometryVBO = gl.createBuffer();
    this.phaseGeometryVisibilityVBO = gl.createBuffer();
    this.setupGeometryVAO(this.phaseGeometryVAO, this.phaseGeometryVBO);

    this.spriteVAO = gl.createVertexArray();
    this.spriteVBO = gl.createBuffer();
    this.setupGeometryVAO(this.spriteVAO, this.spriteVBO);

    this.entityVAO = gl.createVertexArray();
    this.entityVBO = gl.createBuffer();
    this.setupEntityVAO(this.entityVAO, this.entityVBO);

    this.viewmodelVAO = gl.createVertexArray();
    this.viewmodelVBO = gl.createBuffer();
    this.setupEntityVAO(this.viewmodelVAO, this.viewmodelVBO);

    this.environmentParticleVAO = gl.createVertexArray();
    this.environmentParticleVBO = gl.createBuffer();
    this.setupEnvironmentalParticleVAO();

    // 4. Create and upload character Font Texture Atlas
    startupTrace.span('webgl.initFontAtlas', () => this.initFontAtlas());

    // 5. Create dynamic diffuse texture atlas
    this.diffuseTexture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.diffuseTexture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.materialTexture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.materialTexture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    this.lightVisibilityTexture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.lightVisibilityTexture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, 1, 1, 0, gl.RED, gl.UNSIGNED_BYTE, new Uint8Array([255]));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    // Engine-rendered HUD cell grid; content arrives via setHudCells.
    this.hudTexture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.hudTexture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    // The HUD image over it, one texel a pixel; content via setHudImage.
    this.hudImageTexture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.hudImageTexture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);


    // Initialize TextureAtlasManager
    this.atlasManager = new TextureAtlasManager(gl, this.diffuseTexture, this.materialTexture, this.materials, this.spriteTemplates, {staticAtlasSlots:this.atlasLayout.staticSlots});
    // A caller may install the world's slot table before the GL context exists.
    this.atlasManager.setStaticMaterialSlots(this.staticMaterialSlots);
  }

  uploadDynamicBuffer(buffer, data, capacityKey) {
    const gl = this.gl;
    const requiredBytes = data.byteLength;
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    let capacity = this.dynamicBufferCapacities[capacityKey] || 0;
    if (requiredBytes > capacity) {
      capacity = Math.max(1024, 2 ** Math.ceil(Math.log2(requiredBytes)));
      gl.bufferData(gl.ARRAY_BUFFER, capacity, gl.DYNAMIC_DRAW);
      this.dynamicBufferCapacities[capacityKey] = capacity;
    }
    if (requiredBytes > 0) gl.bufferSubData(gl.ARRAY_BUFFER, 0, data);
  }

  /**
   * Locations for the shared tone stage, which the reduce pass and the legacy
   * single-pass shader both interpolate from the same GLSL source.
   */
  collectToneUniforms(program) {
    const gl = this.gl;
    return {
      bloomTexture: gl.getUniformLocation(program, "u_bloomTexture"),
      bloomIntensity: gl.getUniformLocation(program, "u_bloomIntensity"),
      exposure: gl.getUniformLocation(program, "u_exposure"),
      gradeLift: gl.getUniformLocation(program, "u_gradeLift"),
      gradeGain: gl.getUniformLocation(program, "u_gradeGain"),
      gradeGamma: gl.getUniformLocation(program, "u_gradeGamma"),
      gradeSaturation: gl.getUniformLocation(program, "u_gradeSaturation"),
      highlightDesaturation: gl.getUniformLocation(program, "u_highlightDesaturation"),
      gradeBlackPoint: gl.getUniformLocation(program, "u_gradeBlackPoint"),
      toneKnee: gl.getUniformLocation(program, "u_toneKnee")
    };
  }

  /**
   * Upload the tone stage for whichever program is currently bound. The bloom
   * texture always occupies the supplied unit so callers keep their own unit
   * assignments intact.
   */
  applyToneUniforms(tone, textureUnit) {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0 + textureUnit);
    gl.bindTexture(gl.TEXTURE_2D, this.bloomTexture);
    gl.uniform1i(tone.bloomTexture, textureUnit);
    gl.uniform1f(tone.bloomIntensity, this.atmosphere.bloomIntensity);
    gl.uniform1f(tone.exposure, this.atmosphere.exposure);
    gl.uniform3fv(tone.gradeLift, this.atmosphere.gradeLift);
    gl.uniform3fv(tone.gradeGain, this.atmosphere.gradeGain);
    gl.uniform1f(tone.gradeGamma, this.atmosphere.gradeGamma);
    gl.uniform1f(tone.gradeSaturation, this.atmosphere.gradeSaturation);
    gl.uniform1f(tone.highlightDesaturation, this.atmosphere.highlightDesaturation);
    gl.uniform1f(tone.gradeBlackPoint, this.atmosphere.gradeBlackPoint);
    gl.uniform1f(tone.toneKnee, this.atmosphere.toneKnee);
  }

  initShaders() {
    const gl = this.gl;

    const prepared = takePreparedPrograms(gl);
    if (prepared) Object.assign(this, prepared);
    else {
    // Compile programs
    const geomVSObj = this.compileShader(gl.VERTEX_SHADER, geomVS);
    const geomFSObj = this.compileShader(gl.FRAGMENT_SHADER, geomFS);
    this.geomProgram = this.linkProgram(geomVSObj, geomFSObj);

    const entityVSObj = this.compileShader(gl.VERTEX_SHADER, entityVS);
    const entityFSObj = this.compileShader(gl.FRAGMENT_SHADER, entityFS);
    this.entityProgram = this.linkProgram(entityVSObj, entityFSObj);

    const lightVSObj = this.compileShader(gl.VERTEX_SHADER, lightVS);
    const lightFSObj = this.compileShader(gl.FRAGMENT_SHADER, lightFS);
    this.lightProgram = this.linkProgram(lightVSObj, lightFSObj);

    const surfaceVSObj = this.compileShader(gl.VERTEX_SHADER, surfaceVS);
    const surfaceFSObj = this.compileShader(gl.FRAGMENT_SHADER, surfaceFS);
    this.surfaceProgram = this.linkProgram(surfaceVSObj, surfaceFSObj);

    const particleVSObj = this.compileShader(gl.VERTEX_SHADER, particleVS);
    const particleFSObj = this.compileShader(gl.FRAGMENT_SHADER, particleFS);
    this.particleProgram = this.linkProgram(particleVSObj, particleFSObj);

    const asciiVSObj = this.compileShader(gl.VERTEX_SHADER, asciiVS);
    const asciiFSObj = this.compileShader(gl.FRAGMENT_SHADER, asciiFS);
    this.asciiProgram = this.linkProgram(asciiVSObj, asciiFSObj);

    const cellVSObj = this.compileShader(gl.VERTEX_SHADER, cellVS);
    const cellFSObj = this.compileShader(gl.FRAGMENT_SHADER, cellFS);
    this.cellProgram = this.linkProgram(cellVSObj, cellFSObj);

    const glyphVSObj = this.compileShader(gl.VERTEX_SHADER, glyphVS);
    const glyphFSObj = this.compileShader(gl.FRAGMENT_SHADER, glyphFS);
    this.glyphProgram = this.linkProgram(glyphVSObj, glyphFSObj);

    const bloomVSObj = this.compileShader(gl.VERTEX_SHADER, bloomVS);
    const bloomPrefilterFSObj = this.compileShader(gl.FRAGMENT_SHADER, bloomPrefilterFS);
    this.bloomPrefilterProgram = this.linkProgram(bloomVSObj, bloomPrefilterFSObj);

    const bloomBlurVSObj = this.compileShader(gl.VERTEX_SHADER, bloomVS);
    const bloomBlurFSObj = this.compileShader(gl.FRAGMENT_SHADER, bloomBlurFS);
    this.bloomBlurProgram = this.linkProgram(bloomBlurVSObj, bloomBlurFSObj);

    const shadowGeomVSObj = this.compileShader(gl.VERTEX_SHADER, shadowGeomVS);
    const shadowGeomFSObj = this.compileShader(gl.FRAGMENT_SHADER, shadowGeomFS);
    this.shadowGeomProgram = this.linkProgram(shadowGeomVSObj, shadowGeomFSObj);

    const shadowEntityVSObj = this.compileShader(gl.VERTEX_SHADER, shadowEntityVS);
    const shadowEntityFSObj = this.compileShader(gl.FRAGMENT_SHADER, shadowEntityFS);
    this.shadowEntityProgram = this.linkProgram(shadowEntityVSObj, shadowEntityFSObj);
    }

    // Pre-query and cache uniform locations
    this.geomUniforms = {
      visibilityCellsEnabled: gl.getUniformLocation(this.geomProgram, "u_visibilityCellsEnabled"),
      view: gl.getUniformLocation(this.geomProgram, "u_view"),
      projection: gl.getUniformLocation(this.geomProgram, "u_projection"),
      diffuseTexture: gl.getUniformLocation(this.geomProgram, "u_diffuseTexture"),
      materialTexture: gl.getUniformLocation(this.geomProgram, "u_materialTexture"),
      selfLuminous: gl.getUniformLocation(this.geomProgram, "u_selfLuminous"),
      isSprite: gl.getUniformLocation(this.geomProgram, "u_isSprite"),
      dissolve: gl.getUniformLocation(this.geomProgram, "u_dissolve")
    };

    this.entityUniforms = {
      view: gl.getUniformLocation(this.entityProgram, "u_view"),
      projection: gl.getUniformLocation(this.entityProgram, "u_projection"),
      model: gl.getUniformLocation(this.entityProgram, "u_model"),
      // 1.0 for world geometry, 0.0 for the first-person rig. Set per pass.
      formShading: gl.getUniformLocation(this.entityProgram, "u_formShading")
    };

    this.lightUniforms = {
      gbufNormal: gl.getUniformLocation(this.lightProgram, "u_gbufNormal"),
      gbufVisibilityCell: gl.getUniformLocation(this.lightProgram, "u_gbufVisibilityCell"),
      gbufDepthLuma: gl.getUniformLocation(this.lightProgram, "u_gbufDepthLuma"),
      gbufAlbedo: gl.getUniformLocation(this.lightProgram, "u_gbufAlbedo"),
      lightVisibility: gl.getUniformLocation(this.lightProgram, "u_lightVisibility"),
      lightVisibilityMapSize: gl.getUniformLocation(this.lightProgram, "u_lightVisibilityMapSize"),
      lightVisibilityLayerCount: gl.getUniformLocation(this.lightProgram, "u_lightVisibilityLayerCount"),
      castShadowsEnabled: gl.getUniformLocation(this.lightProgram, "u_castShadowsEnabled"),
      shadowFloor: gl.getUniformLocation(this.lightProgram, "u_shadowFloor"),
      cameraPos: gl.getUniformLocation(this.lightProgram, "u_cameraPos"),
      flashlightOrigin: gl.getUniformLocation(this.lightProgram, "u_flashlightOrigin"),
      flashlightDir: gl.getUniformLocation(this.lightProgram, "u_flashlightDir"),
      flashlightOn: gl.getUniformLocation(this.lightProgram, "u_flashlightOn"),
      batteryFactor: gl.getUniformLocation(this.lightProgram, "u_batteryFactor"),
      flashlightHorizontalOuterTan: gl.getUniformLocation(this.lightProgram, "u_flashlightHorizontalOuterTan"),
      flashlightVerticalOuterTan: gl.getUniformLocation(this.lightProgram, "u_flashlightVerticalOuterTan"),
      flashlightRange: gl.getUniformLocation(this.lightProgram, "u_flashlightRange"),
      hasPortal: gl.getUniformLocation(this.lightProgram, "u_hasPortal"),
      portalPos: gl.getUniformLocation(this.lightProgram, "u_portalPos"),
      portalColor: gl.getUniformLocation(this.lightProgram, "u_portalColor"),
      portalRange: gl.getUniformLocation(this.lightProgram, "u_portalRange"),
      time: gl.getUniformLocation(this.lightProgram, "u_time"),
      numLights: gl.getUniformLocation(this.lightProgram, "u_numLights"),
      volumetricIndices: gl.getUniformLocation(this.lightProgram, "u_volumetricIndices"),
      numVolumetricLights: gl.getUniformLocation(this.lightProgram, "u_numVolumetricLights"),
      numPitchBlackZones: gl.getUniformLocation(this.lightProgram, "u_numPitchBlackZones"),
      numJammingFields: gl.getUniformLocation(this.lightProgram, "u_numJammingFields"),
      cellGrid: gl.getUniformLocation(this.lightProgram, "u_cellGrid"),
      interferenceScale: gl.getUniformLocation(this.lightProgram, "u_interferenceScale"),
      contactShadowsEnabled: gl.getUniformLocation(this.lightProgram, "u_contactShadowsEnabled"),
      aoStep: gl.getUniformLocation(this.lightProgram, "u_aoStep"),
      ambientOcclusionStrength: gl.getUniformLocation(this.lightProgram, "u_ambientOcclusionStrength"),
      ambientFactor: gl.getUniformLocation(this.lightProgram, "u_ambientFactor"),
      lowLightAdaptation: gl.getUniformLocation(this.lightProgram, "u_lowLightAdaptation"),
      visibilityFloor: gl.getUniformLocation(this.lightProgram, "u_visibilityFloor"),
      shadowLift: gl.getUniformLocation(this.lightProgram, "u_shadowLift"),
      shadowTint: gl.getUniformLocation(this.lightProgram, "u_shadowTint"),
      specularStrength: gl.getUniformLocation(this.lightProgram, "u_specularStrength"),
      emissiveIntensity: gl.getUniformLocation(this.lightProgram, "u_emissiveIntensity"),
      viewmodelRadius: gl.getUniformLocation(this.lightProgram, "u_viewmodelRadius"),
      toneExposure: gl.getUniformLocation(this.lightProgram, "u_toneExposure"),
      flashlightShadowMap: gl.getUniformLocation(this.lightProgram, "u_flashlightShadowMap"),
      flashlightViewProjection: gl.getUniformLocation(this.lightProgram, "u_flashlightViewProjection"),
      flashlightShadowsEnabled: gl.getUniformLocation(this.lightProgram, "u_flashlightShadowsEnabled"),
      shadowTexelSize: gl.getUniformLocation(this.lightProgram, "u_shadowTexelSize"),
      shadowNormalBias: gl.getUniformLocation(this.lightProgram, "u_shadowNormalBias"),
      shadowDepthBias: gl.getUniformLocation(this.lightProgram, "u_shadowDepthBias"),
      fogColor: gl.getUniformLocation(this.lightProgram, "u_fogColor"),
      fogDensity: gl.getUniformLocation(this.lightProgram, "u_fogDensity"),
      fogHeightFalloff: gl.getUniformLocation(this.lightProgram, "u_fogHeightFalloff"),
      skyEnabled: gl.getUniformLocation(this.lightProgram, "u_skyEnabled"),
      skyTopColor: gl.getUniformLocation(this.lightProgram, "u_skyTopColor"),
      skyHorizonColor: gl.getUniformLocation(this.lightProgram, "u_skyHorizonColor"),
      skyGlowColor: gl.getUniformLocation(this.lightProgram, "u_skyGlowColor"),
      skyGlowDir: gl.getUniformLocation(this.lightProgram, "u_skyGlowDir"),
      skyGlowStrength: gl.getUniformLocation(this.lightProgram, "u_skyGlowStrength"),
      skyGlowSharpness: gl.getUniformLocation(this.lightProgram, "u_skyGlowSharpness"),
      skyCameraForward: gl.getUniformLocation(this.lightProgram, "u_skyCameraForward"),
      skyCameraRight: gl.getUniformLocation(this.lightProgram, "u_skyCameraRight"),
      skyCameraUp: gl.getUniformLocation(this.lightProgram, "u_skyCameraUp"),
      starDensity: gl.getUniformLocation(this.lightProgram, "u_starDensity"),
      starBrightness: gl.getUniformLocation(this.lightProgram, "u_starBrightness"),
      fogDither: gl.getUniformLocation(this.lightProgram, "u_fogDither"),
      fogPlanar: gl.getUniformLocation(this.lightProgram, "u_fogPlanar"),
      skylineStrength: gl.getUniformLocation(this.lightProgram, "u_skylineStrength"),
      skylineSeed: gl.getUniformLocation(this.lightProgram, "u_skylineSeed"),
      environmentalFxEnabled: gl.getUniformLocation(this.lightProgram, "u_environmentalFxEnabled"),
      volumetricStrength: gl.getUniformLocation(this.lightProgram, "u_volumetricStrength"),
      numFogVolumes: gl.getUniformLocation(this.lightProgram, "u_numFogVolumes"),
      pitchBlackZones: [],
      jammingFields: [],
      fogVolumes: [],
      lights: []
    };
    for (let i = 0; i < MAX_HAZARD_ZONES; i++) {
      this.lightUniforms.pitchBlackZones.push({
        position: gl.getUniformLocation(this.lightProgram, `u_pitchBlackZones[${i}].position`),
        radius: gl.getUniformLocation(this.lightProgram, `u_pitchBlackZones[${i}].radius`)
      });
      this.lightUniforms.jammingFields.push({
        position: gl.getUniformLocation(this.lightProgram, `u_jammingFields[${i}].position`),
        radius: gl.getUniformLocation(this.lightProgram, `u_jammingFields[${i}].radius`)
      });
    }
    for (let i = 0; i < MAX_FOG_VOLUMES; i++) {
      this.lightUniforms.fogVolumes.push({
        position: gl.getUniformLocation(this.lightProgram, `u_fogVolumes[${i}].position`),
        color: gl.getUniformLocation(this.lightProgram, `u_fogVolumes[${i}].color`),
        radius: gl.getUniformLocation(this.lightProgram, `u_fogVolumes[${i}].radius`),
        density: gl.getUniformLocation(this.lightProgram, `u_fogVolumes[${i}].density`)
      });
    }
    for (let i = 0; i < MAX_LIGHTS; i++) {
      this.lightUniforms.lights.push({
        position: gl.getUniformLocation(this.lightProgram, `u_lights[${i}].position`),
        color: gl.getUniformLocation(this.lightProgram, `u_lights[${i}].color`),
        range: gl.getUniformLocation(this.lightProgram, `u_lights[${i}].range`),
        intensity: gl.getUniformLocation(this.lightProgram, `u_lights[${i}].intensity`),
        floorInfluence: gl.getUniformLocation(this.lightProgram, `u_lights[${i}].floorInfluence`),
        volumetricInfluence: gl.getUniformLocation(this.lightProgram, `u_lights[${i}].volumetricInfluence`),
        direction: gl.getUniformLocation(this.lightProgram, `u_lights[${i}].direction`),
        innerConeCos: gl.getUniformLocation(this.lightProgram, `u_lights[${i}].innerConeCos`),
        outerConeCos: gl.getUniformLocation(this.lightProgram, `u_lights[${i}].outerConeCos`),
        spotBlend: gl.getUniformLocation(this.lightProgram, `u_lights[${i}].spotBlend`),
        projectionOrigin: gl.getUniformLocation(this.lightProgram, `u_lights[${i}].projectionOrigin`)
      });
    }

    this.surfaceUniforms = {
      accumulatedColor: gl.getUniformLocation(this.surfaceProgram, "u_accumulatedColor"),
      gbufNormal: gl.getUniformLocation(this.surfaceProgram, "u_gbufNormal"),
      gbufDepthLuma: gl.getUniformLocation(this.surfaceProgram, "u_gbufDepthLuma"),
      view: gl.getUniformLocation(this.surfaceProgram, "u_view"),
      projection: gl.getUniformLocation(this.surfaceProgram, "u_projection"),
      cameraPos: gl.getUniformLocation(this.surfaceProgram, "u_cameraPos"),
      resolution: gl.getUniformLocation(this.surfaceProgram, "u_resolution"),
      time: gl.getUniformLocation(this.surfaceProgram, "u_time"),
      enabled: gl.getUniformLocation(this.surfaceProgram, "u_reactiveSurfacesEnabled"),
      reflectionStrength: gl.getUniformLocation(this.surfaceProgram, "u_reflectionStrength"),
      reflectionReach: gl.getUniformLocation(this.surfaceProgram, "u_reflectionReach"),
      distortion: gl.getUniformLocation(this.surfaceProgram, "u_surfaceDistortion"),
      tint: gl.getUniformLocation(this.surfaceProgram, "u_surfaceTint"),
      skyReflectColor: gl.getUniformLocation(this.surfaceProgram, "u_skyReflectColor"),
      numSurfaces: gl.getUniformLocation(this.surfaceProgram, "u_numReactiveSurfaces"),
      surfaces: []
    };
    for (let i = 0; i < MAX_REACTIVE_SURFACES; i++) {
      this.surfaceUniforms.surfaces.push({
        position: gl.getUniformLocation(this.surfaceProgram, `u_reactiveSurfaces[${i}].position`),
        radius: gl.getUniformLocation(this.surfaceProgram, `u_reactiveSurfaces[${i}].radius`),
        intensity: gl.getUniformLocation(this.surfaceProgram, `u_reactiveSurfaces[${i}].intensity`),
        phase: gl.getUniformLocation(this.surfaceProgram, `u_reactiveSurfaces[${i}].phase`)
      });
    }

    this.particleUniforms = {
      view: gl.getUniformLocation(this.particleProgram, "u_view"),
      projection: gl.getUniformLocation(this.particleProgram, "u_projection"),
      cameraPos: gl.getUniformLocation(this.particleProgram, "u_cameraPos"),
      resolution: gl.getUniformLocation(this.particleProgram, "u_resolution"),
      time: gl.getUniformLocation(this.particleProgram, "u_time"),
      gbufNormal: gl.getUniformLocation(this.particleProgram, "u_gbufNormal"),
      gbufDepthLuma: gl.getUniformLocation(this.particleProgram, "u_gbufDepthLuma")
    };
    this.asciiUniforms = {
      accumulatedColor: gl.getUniformLocation(this.asciiProgram, "u_accumulatedColor"),
      gbufNormal: gl.getUniformLocation(this.asciiProgram, "u_gbufNormal"),
      fontAtlas: gl.getUniformLocation(this.asciiProgram, "u_fontAtlas"),
      resolution: gl.getUniformLocation(this.asciiProgram, "u_resolution"),
      cellSize: gl.getUniformLocation(this.asciiProgram, "u_cellSize"),
      strokeGlyphs: gl.getUniformLocation(this.asciiProgram, "u_strokeGlyphs"),
      atlasSize: gl.getUniformLocation(this.asciiProgram, "u_atlasSize"),
      glitchFactor: gl.getUniformLocation(this.asciiProgram, "u_glitchFactor"),
      glitchStyle: this.collectGlitchStyleUniforms(this.asciiProgram),
      time: gl.getUniformLocation(this.asciiProgram, "u_time"),
      charIndices: gl.getUniformLocation(this.asciiProgram, "u_charIndices"),
      darkWorldGlyphs: gl.getUniformLocation(this.asciiProgram, "u_darkWorldGlyphs"),
      shadowFadeWidth: gl.getUniformLocation(this.asciiProgram, "u_shadowFadeWidth"),
      spriteCharIndices: gl.getUniformLocation(this.asciiProgram, "u_spriteCharIndices"),
      skyEnabled: gl.getUniformLocation(this.asciiProgram, "u_skyEnabled"),
      tone: this.collectToneUniforms(this.asciiProgram),
      hud: this.collectHudUniforms(this.asciiProgram),
      screenFlash: this.collectScreenFlashUniforms(this.asciiProgram)
    };

    this.cellUniforms = {
      accumulatedColor: gl.getUniformLocation(this.cellProgram, "u_accumulatedColor"),
      gbufNormal: gl.getUniformLocation(this.cellProgram, "u_gbufNormal"),
      gridResolution: gl.getUniformLocation(this.cellProgram, "u_gridResolution"),
      samplesPerAxis: gl.getUniformLocation(this.cellProgram, "u_samplesPerAxis"),
      charIndices: gl.getUniformLocation(this.cellProgram, "u_charIndices"),
      darkWorldGlyphs: gl.getUniformLocation(this.cellProgram, "u_darkWorldGlyphs"),
      shadowFadeWidth: gl.getUniformLocation(this.cellProgram, "u_shadowFadeWidth"),
      spriteCharIndices: gl.getUniformLocation(this.cellProgram, "u_spriteCharIndices"),
      quadrantGlyphs: gl.getUniformLocation(this.cellProgram, "u_quadrantGlyphs"),
      structuralGlyphs: gl.getUniformLocation(this.cellProgram, "u_structuralGlyphs"),
      subCellColor: gl.getUniformLocation(this.cellProgram, "u_subCellColor"),
      subCellContrast: gl.getUniformLocation(this.cellProgram, "u_subCellContrast"),
      subCellCoherence: gl.getUniformLocation(this.cellProgram, "u_subCellCoherence"),
      previousCell: gl.getUniformLocation(this.cellProgram, "u_previousCell"),
      previousCellBackground: gl.getUniformLocation(this.cellProgram, "u_previousCellBackground"),
      historyValid: gl.getUniformLocation(this.cellProgram, "u_historyValid"),
      glyphHysteresis: gl.getUniformLocation(this.cellProgram, "u_glyphHysteresis"),
      colorHysteresis: gl.getUniformLocation(this.cellProgram, "u_colorHysteresis"),
      signalReleaseThreshold: gl.getUniformLocation(this.cellProgram, "u_signalReleaseThreshold"),
      edgeThreshold: gl.getUniformLocation(this.cellProgram, "u_edgeThreshold"),
      highlightPreservation: gl.getUniformLocation(this.cellProgram, "u_highlightPreservation"),
      tone: this.collectToneUniforms(this.cellProgram),
      ditherEnabled: gl.getUniformLocation(this.cellProgram, "u_ditherEnabled"),
      glitchFactor: gl.getUniformLocation(this.cellProgram, "u_glitchFactor"),
      glitchStyle: this.collectGlitchStyleUniforms(this.cellProgram),
      time: gl.getUniformLocation(this.cellProgram, "u_time"),
      skyEnabled: gl.getUniformLocation(this.cellProgram, "u_skyEnabled")
    };

    this.bloomPrefilterUniforms = {
      source: gl.getUniformLocation(this.bloomPrefilterProgram, "u_source"),
      texelSize: gl.getUniformLocation(this.bloomPrefilterProgram, "u_texelSize"),
      threshold: gl.getUniformLocation(this.bloomPrefilterProgram, "u_threshold"),
      softKnee: gl.getUniformLocation(this.bloomPrefilterProgram, "u_softKnee"),
      gbufDepthLuma: gl.getUniformLocation(this.bloomPrefilterProgram, "u_gbufDepthLuma"),
      cameraPos: gl.getUniformLocation(this.bloomPrefilterProgram, "u_cameraPos"),
      nearExclude: gl.getUniformLocation(this.bloomPrefilterProgram, "u_nearExclude")
    };

    this.bloomBlurUniforms = {
      source: gl.getUniformLocation(this.bloomBlurProgram, "u_source"),
      direction: gl.getUniformLocation(this.bloomBlurProgram, "u_direction")
    };

    this.shadowGeomUniforms = {
      lightViewProjection: gl.getUniformLocation(this.shadowGeomProgram, "u_lightViewProjection"),
      diffuseTexture: gl.getUniformLocation(this.shadowGeomProgram, "u_diffuseTexture"),
      dissolve: gl.getUniformLocation(this.shadowGeomProgram, "u_dissolve")
    };
    this.shadowEntityUniforms = {
      lightViewProjection: gl.getUniformLocation(this.shadowEntityProgram, "u_lightViewProjection")
    };

    this.glyphUniforms = {
      cellData: gl.getUniformLocation(this.glyphProgram, "u_cellData"),
      cellBackground: gl.getUniformLocation(this.glyphProgram, "u_cellBackground"),
      fontAtlas: gl.getUniformLocation(this.glyphProgram, "u_fontAtlas"),
      cellSize: gl.getUniformLocation(this.glyphProgram, "u_cellSize"),
      strokeGlyphs: gl.getUniformLocation(this.glyphProgram, "u_strokeGlyphs"),
      atlasSize: gl.getUniformLocation(this.glyphProgram, "u_atlasSize"),
      hud: this.collectHudUniforms(this.glyphProgram),
      screenFlash: this.collectScreenFlashUniforms(this.glyphProgram)
    };
  }

  // RGBA stop channels are 0..1; missing effects reset to a neutral frame.
  /**
   * Opt-in per-pixel stroke and shade glyphs (see StrokeGlyphs.js). Off by
   * default, which keeps every glyph sampled from the font atlas.
   */
  setStrokeGlyphs(enabled) {
    this.strokeGlyphs = enabled === true;
  }

  setScreenFlash(flash) {
    updateScreenFlash(this.screenFlash, flash);
  }

  collectScreenFlashUniforms(program) {
    const gl = this.gl;
    return Object.fromEntries(['Opacity', 'MiddleStop', 'Resolution', 'Inner', 'Middle', 'Outer']
      .map(name => [name, gl.getUniformLocation(program, 'u_screenFlash' + name)]));
  }

  applyScreenFlashUniforms(uniforms) {
    const gl = this.gl, flash = this.screenFlash;
    gl.uniform1f(uniforms.Opacity, flash.opacity);
    if (!flash.opacity) return;
    gl.uniform1f(uniforms.MiddleStop, flash.middleStop);
    gl.uniform2f(uniforms.Resolution, gl.canvas.width, gl.canvas.height);
    gl.uniform4fv(uniforms.Inner, flash.inner);
    gl.uniform4fv(uniforms.Middle, flash.middle);
    gl.uniform4fv(uniforms.Outer, flash.outer);
  }

  collectHudUniforms(program) {
    const gl = this.gl;
    return {
      enabled: gl.getUniformLocation(program, "u_hudEnabled"),
      cells: gl.getUniformLocation(program, "u_hudCells"),
      cellSize: gl.getUniformLocation(program, "u_hudCellSize"),
      grid: gl.getUniformLocation(program, "u_hudGrid"),
      imageEnabled: gl.getUniformLocation(program, "u_hudImageEnabled"),
      image: gl.getUniformLocation(program, "u_hudImage"),
      imageRect: gl.getUniformLocation(program, "u_hudImageRect")
    };
  }

  /**
   * The HUD image (AsciiEngine#setHudImage): `source` composited over the
   * frame and the HUD's cells by the final passes, its top left at (x, y) in
   * canvas pixels, one texel a pixel. The source is uploaded at the next
   * render, so draw into it, then call this, every frame it changes. Pass
   * null to remove it.
   */
  setHudImage(source, options = {}) {
    this.hudImage = hudImageState(source, options);
    this.hudImageDirty = this.hudImage !== null;
    return this;
  }

  applyHudImageUniforms(uniforms, textureUnit) {
    const gl = this.gl;
    const image = this.hudImage;
    gl.uniform1i(uniforms.imageEnabled, image ? 1 : 0);
    // The sampler keeps its unit, and the unit its texture, with no image
    // too: earlier passes leave other kinds of texture on that unit, and a
    // sampler pointed at one fails the whole draw (INVALID_OPERATION).
    gl.activeTexture(gl.TEXTURE0 + textureUnit);
    gl.bindTexture(gl.TEXTURE_2D, this.hudImageTexture);
    gl.uniform1i(uniforms.image, textureUnit);
    if (!image) return;
    if (this.hudImageDirty) {
      this.hudImageDirty = false;
      // Bottom row first, as gl_FragCoord runs; straight alpha, as the
      // shader mixes it. Both restored: every other upload expects defaults.
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image.source);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    }
    gl.uniform4f(uniforms.imageRect, ...hudImageRect(image, gl.drawingBufferHeight));
  }

  /**
   * The engine-rendered HUD: hands the final passes a coarse glyph-cell grid
   * to composite over the frame. `cells` is Uint8Array(columns*rows*4) with
   * rgb = glyph color and a = glyph index (0 = empty); row 0 is the TOP row
   * (this call flips it into GL's bottom-up orientation). `cellWidth/Height`
   * are pixels per HUD cell. Pass null to disable.
   */
  setHudCells(hud) {
    if (!hud || !hud.cells || !hud.columns || !hud.rows) {
      this.hudState = null;
      return this;
    }
    this.hudState = {
      columns: hud.columns,
      rows: hud.rows,
      cellWidth: hud.cellWidth || 9,
      cellHeight: hud.cellHeight || 16,
      cells: hud.cells
    };
    this.hudDirty = true;
    return this;
  }

  uploadHudTexture() {
    if (!this.hudDirty || !this.hudState) return;
    this.hudDirty = false;
    const gl = this.gl;
    const { columns, rows, cells } = this.hudState;
    // Flip rows: callers author top-down, texelFetch reads bottom-up.
    if (!this.hudFlipBuffer || this.hudFlipBuffer.length !== cells.length) {
      this.hudFlipBuffer = new Uint8Array(cells.length);
    }
    const stride = columns * 4;
    for (let row = 0; row < rows; row++) {
      this.hudFlipBuffer.set(
        cells.subarray(row * stride, (row + 1) * stride),
        (rows - 1 - row) * stride
      );
    }
    gl.bindTexture(gl.TEXTURE_2D, this.hudTexture);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, columns, rows, 0, gl.RGBA, gl.UNSIGNED_BYTE, this.hudFlipBuffer);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
  }

  applyHudUniforms(uniforms, textureUnit, imageUnit = 5) {
    const gl = this.gl;
    this.applyHudImageUniforms(uniforms, imageUnit);
    const active = this.hudState != null;
    gl.uniform1i(uniforms.enabled, active ? 1 : 0);
    if (!active) return;
    // Select OUR unit before the upload: texture uploads bind on whatever
    // unit is active, and clobbering the pass's font-atlas binding on unit 2
    // corrupts every glyph in the frame.
    gl.activeTexture(gl.TEXTURE0 + textureUnit);
    this.uploadHudTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.hudTexture);
    gl.uniform1i(uniforms.cells, textureUnit);
    gl.uniform2f(uniforms.cellSize, this.hudState.cellWidth, this.hudState.cellHeight);
    gl.uniform2i(uniforms.grid, this.hudState.columns, this.hudState.rows);
  }

  initGBuffer() {
    const gl = this.gl;
    if (!gl) return;

    this.gbufFBO = this.requireGpuResource(
      gl.createFramebuffer(),
      'G-buffer framebuffer',
      'renderer-framebuffer-create-failed'
    );
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.gbufFBO);

    // 1. Diffuse (Albedo) attachment
    this.gbufAlbedo = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.gbufAlbedo);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, this.sceneWidth, this.sceneHeight, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.gbufAlbedo, 0);

    // 2. Normals attachment
    this.gbufNormal = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.gbufNormal);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, this.sceneWidth, this.sceneHeight, 0, gl.RGBA, gl.HALF_FLOAT, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT1, gl.TEXTURE_2D, this.gbufNormal, 0);

    // 3. Position and Luma attachment
    this.gbufPosition = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.gbufPosition);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, this.sceneWidth, this.sceneHeight, 0, gl.RGBA, gl.HALF_FLOAT, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT2, gl.TEXTURE_2D, this.gbufPosition, 0);

    // Exact surface cell provenance; R16UI covers maps of up to 65,535 cells.
    // Larger maps select R32UI before geometry upload, using the same sampler.
    this.gbufVisibilityCell = gl.createTexture();
    this.visibilityCellWide = false;
    gl.bindTexture(gl.TEXTURE_2D, this.gbufVisibilityCell);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R16UI, this.sceneWidth, this.sceneHeight, 0, gl.RED_INTEGER, gl.UNSIGNED_SHORT, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT3, gl.TEXTURE_2D, this.gbufVisibilityCell, 0);

    // 5. Depth/Stencil attachment (Renderbuffer)
    this.gbufDepthStencil = gl.createRenderbuffer();
    gl.bindRenderbuffer(gl.RENDERBUFFER, this.gbufDepthStencil);
    gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH24_STENCIL8, this.sceneWidth, this.sceneHeight);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_STENCIL_ATTACHMENT, gl.RENDERBUFFER, this.gbufDepthStencil);

    // Bind MRTs
    gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1, gl.COLOR_ATTACHMENT2, gl.COLOR_ATTACHMENT3]);

    this.assertCurrentFramebufferComplete('G-buffer');

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  initLightBuffer() {
    const gl = this.gl;
    if (!gl) return;

    this.lightFBO = this.requireGpuResource(
      gl.createFramebuffer(),
      'light framebuffer',
      'renderer-framebuffer-create-failed'
    );
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.lightFBO);

    this.lightTexture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.lightTexture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, this.sceneWidth, this.sceneHeight, 0, gl.RGBA, gl.HALF_FLOAT, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    // The wrap mode has to match surfaceTexture's, because this buffer now
    // stands in for it as the composite whenever the surface pass is skipped
    // (see PASS 2b). WebGL 2 defaults a sampler to REPEAT, and the cell
    // reduce's 3x3 neighbour gather deliberately samples half a cell outside
    // [0,1] on every border cell - under REPEAT those taps wrap to the
    // opposite edge of the frame and change the glyph chosen on all
    // 2*(gridWidth+gridHeight) border cells.
    //
    // Setting it here is a no-op for the path that shipped: the only sampler
    // that has ever read this texture is the surface shader, and both of its
    // fetches stay inside the unit square - one uses the full-screen quad's
    // v_uv, the other is explicitly clamped to [0.001, 0.999].
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.lightTexture, 0);

    this.assertCurrentFramebufferComplete('Light buffer');

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  initSurfaceBuffer() {
    const gl = this.gl;
    if (!gl) return;

    this.surfaceFBO = this.requireGpuResource(
      gl.createFramebuffer(),
      'surface framebuffer',
      'renderer-framebuffer-create-failed'
    );
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.surfaceFBO);

    this.surfaceTexture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.surfaceTexture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, this.sceneWidth, this.sceneHeight, 0, gl.RGBA, gl.HALF_FLOAT, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.surfaceTexture, 0);

    // Which texture the composite readers bind. render() re-resolves it every
    // frame; this is only the value before a first frame has run.
    this.compositeTexture = this.surfaceTexture;

    this.assertCurrentFramebufferComplete('Surface buffer');

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  /**
   * Per-cell resolve target, one texel per glyph cell.
   *
   * Attachment 0 carries the foreground colour with the glyph index packed as
   * an exact byte in alpha; attachment 1 carries the background colour. Two
   * colours per cell is what makes the quadrant glyphs meaningful - the cell
   * can then describe a boundary rather than an average.
   *
   * Resolving here rather than in the glyph raster keeps the per-cell gather
   * off the output resolution, where every pixel of a cell would repeat it.
   */
  initCellBuffer() {
    const gl = this.gl;
    if (!gl) return;

    // Upgrade 86: an alternating pair, so the reduce pass can read the cells it
    // resolved last frame. Glyph selection is a chain of discrete branches -
    // quadrant against structural against ramp, the cluster split, the dither
    // step - and every one of them can flip on nearly identical input. Holding
    // the previous decision unless a new one wins clearly is what stops that
    // reading as noise.
    this.cellFBOs = [];
    this.cellTargets = [];
    for (let i = 0; i < 2; i++) {
      const framebuffer = this.requireGpuResource(
        gl.createFramebuffer(),
        `cell framebuffer ${i}`,
        'renderer-framebuffer-create-failed'
      );
      gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
      const foreground = this.createCellAttachment(gl.COLOR_ATTACHMENT0);
      const background = this.createCellAttachment(gl.COLOR_ATTACHMENT1);
      gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1]);

      this.assertCurrentFramebufferComplete(`Cell buffer ${i}`);
      this.cellFBOs.push(framebuffer);
      this.cellTargets.push({ foreground, background });
    }

    this.cellHistoryIndex = 0;
    this.cellHistoryValid = false;
    this.cellTexture = this.cellTargets[0].foreground;
    this.cellBackgroundTexture = this.cellTargets[0].background;

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  /**
   * History is meaningless once the cell grid changes shape or the pipeline
   * switches, so it is invalidated rather than reprojected.
   */
  invalidateCellHistory() {
    this.cellHistoryValid = false;
  }

  /**
   * Depth-only target for the flashlight shadow map.
   *
   * Comparison sampling is enabled on the texture so each fetch is a hardware
   * 2x2 filtered depth test; the shader takes nine of those for the soft edge.
   */
  initShadowBuffer() {
    const gl = this.gl;
    if (!gl) return;

    this.shadowMapSize = 1024;
    this.shadowFBO = this.requireGpuResource(
      gl.createFramebuffer(),
      'shadow framebuffer',
      'renderer-framebuffer-create-failed'
    );
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.shadowFBO);

    this.shadowTexture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.shadowTexture);
    gl.texImage2D(
      gl.TEXTURE_2D, 0, gl.DEPTH_COMPONENT24,
      this.shadowMapSize, this.shadowMapSize, 0,
      gl.DEPTH_COMPONENT, gl.UNSIGNED_INT, null
    );
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    // Clamping to edge would smear the border depth across the whole map;
    // the shader treats anything outside the frustum as unshadowed instead.
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_COMPARE_MODE, gl.COMPARE_REF_TO_TEXTURE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_COMPARE_FUNC, gl.LEQUAL);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, this.shadowTexture, 0);

    // Depth only. Without this the framebuffer is incomplete for draw.
    gl.drawBuffers([gl.NONE]);
    gl.readBuffer(gl.NONE);

    this.assertCurrentFramebufferComplete('Shadow buffer');

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.shadowViewProjection = new Float32Array(16);
    this.shadowProjection = new Float32Array(16);
    this.shadowView = new Float32Array(16);
    this.flashlightShadowsActive = false;
  }

  /**
   * Quarter-resolution ping-pong pair for the HDR bloom chain.
   *
   * LINEAR filtering is required: the prefilter relies on bilinear corner taps
   * to average sixteen source texels per output texel, and the blur folds a
   * nine-tap Gaussian into five bilinear fetches.
   */
  initBloomBuffers() {
    const gl = this.gl;
    if (!gl) return;

    this.bloomFBOs = [];
    this.bloomTextures = [];
    for (let i = 0; i < 2; i++) {
      const framebuffer = this.requireGpuResource(
        gl.createFramebuffer(),
        `bloom framebuffer ${i}`,
        'renderer-framebuffer-create-failed'
      );
      gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
      const texture = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
      this.bloomFBOs.push(framebuffer);
      this.bloomTextures.push(texture);
    }
    this.bloomTexture = this.bloomTextures[0];
    this.resizeBloomTargets();

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  resizeBloomTargets() {
    const gl = this.gl;
    if (!gl || !this.bloomTextures) return;
    this.bloomWidth = Math.max(1, Math.floor(this.sceneWidth / 4));
    this.bloomHeight = Math.max(1, Math.floor(this.sceneHeight / 4));
    // Reallocating discards whatever the chain held, so renderBloom's disabled
    // path owes one clear again. Note the direction: an allocation re-arms the
    // flag, the flag never causes an allocation. Only a resize or a glyph
    // pipeline mode change reaches in here, never an effect toggle.
    this.bloomChainDirty = true;
    for (let i = 0; i < this.bloomTextures.length; i++) {
      const texture = this.bloomTextures[i];
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texImage2D(
        gl.TEXTURE_2D, 0, gl.RGBA16F,
        this.bloomWidth, this.bloomHeight, 0,
        gl.RGBA, gl.HALF_FLOAT, null
      );
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.bloomFBOs[i]);
      this.assertCurrentFramebufferComplete(`Bloom buffer ${i}`);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  createCellAttachment(attachment) {
    const gl = this.gl;
    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, this.width, this.height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, attachment, gl.TEXTURE_2D, texture, 0);
    return texture;
  }

  initFullScreenQuad() {
    const gl = this.gl;
    const vertices = new Float32Array([
      -1, -1,   0, 0,
       1, -1,   1, 0,
      -1,  1,   0, 1,
       1,  1,   1, 1
    ]);
    
    this.fsQuadVAO = gl.createVertexArray();
    gl.bindVertexArray(this.fsQuadVAO);

    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.STATIC_DRAW);

    // location 0: quad position (vec2)
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 4 * 4, 0);

    // location 1: quad UV (vec2)
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 4 * 4, 2 * 4);

    gl.bindVertexArray(null);
  }

  setupGeometryVAO(vao, vbo) {
    const gl = this.gl;
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);

    const stride = 8 * 4; // 8 floats * 4 bytes

    // location 0: position (vec3)
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, stride, 0);

    // location 1: normal (vec3)
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 3, gl.FLOAT, false, stride, 3 * 4);

    // location 2: UV coords (vec2)
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 2, gl.FLOAT, false, stride, 6 * 4);

    // Untagged features and sprites explicitly write zero over any wall behind.
    gl.disableVertexAttribArray(3);
    gl.vertexAttribI4ui(3, 0, 0, 0, 0);
    gl.bindVertexArray(null);
  }

  configureVisibilityCellTarget(map) {
    const gl = this.gl;
    const width = Array.isArray(map) && Array.isArray(map[0]) ? map[0].length : 0;
    const count = width * (map ? map.length : 0);
    const wide = count > 65535;
    if (this.visibilityCellWide !== wide) {
      this.visibilityCellWide = wide;
      gl.bindTexture(gl.TEXTURE_2D, this.gbufVisibilityCell);
      gl.texImage2D(gl.TEXTURE_2D, 0, wide ? gl.R32UI : gl.R16UI,
        this.sceneWidth, this.sceneHeight, 0, gl.RED_INTEGER,
        wide ? gl.UNSIGNED_INT : gl.UNSIGNED_SHORT, null);
      const previous = gl.getParameter(gl.FRAMEBUFFER_BINDING);
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.gbufFBO);
      this.assertCurrentFramebufferComplete('G-buffer surface cells');
      gl.bindFramebuffer(gl.FRAMEBUFFER, previous);
      if (this.activeSceneTargets) this.activeSceneTargets.wide = wide;
    }
  }

  uploadVisibilityCells(vao, buffer, mesh, map) {
    const gl = this.gl;
    const width = map[0].length;
    const count = width * map.length;
    const cells = mesh.visibilityCells;
    const valid = (cells instanceof Uint16Array || cells instanceof Uint32Array)
      && cells.length === mesh.vertexCount && mesh.visibilityMapWidth === width
      && mesh.visibilityMapHeight === map.length && everyCodeWithin(cells, count);
    gl.bindVertexArray(vao);
    if (valid) {
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      gl.bufferData(gl.ARRAY_BUFFER, cells, gl.STATIC_DRAW);
      gl.vertexAttribIPointer(3, 1, cells instanceof Uint16Array ? gl.UNSIGNED_SHORT : gl.UNSIGNED_INT, cells.BYTES_PER_ELEMENT, 0);
      gl.enableVertexAttribArray(3);
    } else {
      // Authored mesh builders may omit provenance. Never inherit stale tags.
      gl.disableVertexAttribArray(3);
      gl.vertexAttribI4ui(3, 0, 0, 0, 0);
    }
    gl.bindVertexArray(null);
    return valid ? width : 0;
  }

  setupEntityVAO(vao = this.entityVAO, vbo = this.entityVBO) {
    const gl = this.gl;
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);

    const stride = ENTITY_VERTEX_STRIDE * 4;
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, stride, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 3, gl.FLOAT, false, stride, 3 * 4);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 3, gl.FLOAT, false, stride, 6 * 4);
    gl.enableVertexAttribArray(3);
    gl.vertexAttribPointer(3, 3, gl.FLOAT, false, stride, 9 * 4);

    gl.bindVertexArray(null);
  }

  setupEnvironmentalParticleVAO() {
    const gl = this.gl;
    gl.bindVertexArray(this.environmentParticleVAO);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.environmentParticleVBO);
    gl.bufferData(gl.ARRAY_BUFFER, 0, gl.STATIC_DRAW);

    const stride = ENVIRONMENT_PARTICLE_STRIDE * 4;
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, stride, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 3, gl.FLOAT, false, stride, 3 * 4);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 4, gl.FLOAT, false, stride, 6 * 4);
    gl.bindVertexArray(null);
  }
  /**
   * Draw a block-element glyph as an exact ordered-dither pattern.
   *
   * The density ramp depends on these four glyphs having calibrated coverage,
   * which a font face does not guarantee. The pattern period is four pixels, so
   * it averages to precisely the requested coverage from mip level two onward.
   */
  drawBlockGlyph(ctx, originX, originY, glyphWidth, glyphHeight, coverage) {
    if (coverage >= 1) {
      ctx.fillRect(originX, originY, glyphWidth, glyphHeight);
      return;
    }
    // Fill order runs diagonally so the 50% step is a checkerboard rather than
    // two adjacent cells, which would read as stripes under minification.
    const fillRank = [0, 2, 3, 1];
    const filled = coverage * 4;
    for (let y = 0; y < glyphHeight; y += 2) {
      for (let x = 0; x < glyphWidth; x += 2) {
        const quadrant = (((y >> 1) & 1) * 2) + ((x >> 1) & 1);
        if (fillRank[quadrant] < filled) ctx.fillRect(originX + x, originY + y, 2, 2);
      }
    }
  }

  /**
   * Draw a quadrant block glyph as exact half-cell fills.
   *
   * The glyph raster flips V, so after that flip the atlas' top half is the
   * cell's upper half and these rectangles map directly.
   */
  drawQuadrantGlyph(ctx, originX, originY, glyphWidth, glyphHeight, mask) {
    const halfWidth = glyphWidth / 2;
    const halfHeight = glyphHeight / 2;
    if (mask & QUADRANT_BITS.upperLeft) ctx.fillRect(originX, originY, halfWidth, halfHeight);
    if (mask & QUADRANT_BITS.upperRight) ctx.fillRect(originX + halfWidth, originY, halfWidth, halfHeight);
    if (mask & QUADRANT_BITS.lowerLeft) ctx.fillRect(originX, originY + halfHeight, halfWidth, halfHeight);
    if (mask & QUADRANT_BITS.lowerRight) {
      ctx.fillRect(originX + halfWidth, originY + halfHeight, halfWidth, halfHeight);
    }
  }

  initFontAtlas() {
    const gl = this.gl;
    if (!gl) return;

    const atlasCols = FONT_ATLAS.columns;
    const atlasRows = FONT_ATLAS.rows;
    const glyphWidth = FONT_ATLAS.glyphWidth;
    const glyphHeight = FONT_ATLAS.glyphHeight;

    const atlasCanvas = document.createElement('canvas');
    atlasCanvas.width = FONT_ATLAS.width;
    atlasCanvas.height = FONT_ATLAS.height;
    const ctx = atlasCanvas.getContext('2d');

    ctx.fillStyle = '#000000';
    ctx.fillRect(0, 0, atlasCanvas.width, atlasCanvas.height);

    ctx.fillStyle = '#ffffff';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';

    // Fit the face to the glyph cell rather than assuming it fits. The previous
    // atlas drew a 32px Consolas face into a 16x32 cell, so every glyph was
    // clipped by its own advance width before it ever reached the GPU.
    const probeSize = glyphHeight;
    ctx.font = `${probeSize}px Consolas, monospace`;
    const probeAdvance = ctx.measureText('M').width || probeSize * 0.55;
    const probeExtent = ctx.measureText('MgjpqW|_');
    const probeAscent = probeExtent.actualBoundingBoxAscent || probeSize * 0.8;
    const probeDescent = probeExtent.actualBoundingBoxDescent || probeSize * 0.22;
    const fitScale = Math.min(
      glyphWidth / probeAdvance,
      glyphHeight / (probeAscent + probeDescent),
      1
    );
    const fontSize = Math.max(6, Math.floor(probeSize * fitScale));

    ctx.font = `${fontSize}px Consolas, monospace`;
    const advance = ctx.measureText('M').width || fontSize * 0.55;
    const extent = ctx.measureText('MgjpqW|_');
    const ascent = extent.actualBoundingBoxAscent || fontSize * 0.8;
    const descent = extent.actualBoundingBoxDescent || fontSize * 0.22;
    const baselineOffset = ascent + (glyphHeight - (ascent + descent)) / 2;
    const advanceOffset = (glyphWidth - advance) / 2;

    for (let i = 0; i < CHARS.length; i++) {
      const char = CHARS[i];
      const originX = (i % atlasCols) * glyphWidth;
      const originY = Math.floor(i / atlasCols) * glyphHeight;

      const blockCoverage = PROCEDURAL_BLOCK_COVERAGE[char];
      if (blockCoverage !== undefined) {
        this.drawBlockGlyph(ctx, originX, originY, glyphWidth, glyphHeight, blockCoverage);
        continue;
      }

      const quadrantMask = PROCEDURAL_QUADRANT_MASKS[char];
      if (quadrantMask !== undefined) {
        this.drawQuadrantGlyph(ctx, originX, originY, glyphWidth, glyphHeight, quadrantMask);
        continue;
      }

      ctx.fillText(char, originX + advanceOffset, originY + baselineOffset);
    }

    this.fontTexture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.fontTexture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, atlasCanvas);
    // Alignment keeps mip texels within one glyph only up to log2 of its
    // narrower dimension. The scene raster clamps both LOD and the filter
    // footprint to that glyph; fractional one-pixel cells must not read the
    // coarser levels that combine neighbouring characters.
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    this.atlasCols = atlasCols;
    this.atlasRows = atlasRows;
  }

  compileShader(type, source) {
    const gl = this.gl;
    const shader = this.requireGpuResource(
      gl.createShader(type),
      'shader object',
      'renderer-shader-create-failed'
    );
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      const info = String(gl.getShaderInfoLog(shader) || 'Unknown shader compiler error').slice(0, 4096);
      gl.deleteShader(shader);
      throw new RendererCapabilityError(
        `Shader compilation failed: ${info}`,
        'renderer-shader-compile-failed'
      );
    }
    return shader;
  }

  linkProgram(vs, fs) {
    const gl = this.gl;
    const program = this.requireGpuResource(
      gl.createProgram(),
      'shader program',
      'renderer-program-create-failed'
    );
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      const info = String(gl.getProgramInfoLog(program) || 'Unknown program linker error').slice(0, 4096);
      gl.deleteProgram(program);
      throw new RendererCapabilityError(
        `Shader program link failed: ${info}`,
        'renderer-program-link-failed'
      );
    }
    return program;
  }

  registerSprite(type, template) {
    // A replaced static template keeps its atlas slot, but its pixels must be
    // baked again. Readers and other mutable signs reuse a bounded set of IDs.
    const cell = this.staticTypeCellIndices?.get(type);
    if (cell !== undefined) this.atlasManager?.dynamicCellContent.delete(cell);
    this.spriteTemplates.set(type, {
      getArt: template.getArt || (() => template.art),
      sizeScale: template.sizeScale !== undefined ? template.sizeScale : 1.0,
      zOffset: template.zOffset !== undefined ? template.zOffset : 0.0,
      // Quad shape. `aspect` widens the quad (width = height * aspect) and a
      // per-sprite `aspect` field overrides it; plane 'flat' lays the quad
      // horizontally at the sprite's z instead of facing the camera, and plane
      // 'upright' stands it vertically facing a FIXED world direction instead
      // of the camera. Templates that predate these fields keep the exact
      // historical square camera-facing billboard (aspect 1, plane
      // 'billboard'), and anything that is not one of the two opt-in strings
      // resolves to 'billboard' — an unknown plane must not silently reorient
      // a shipped sprite.
      aspect: Number.isFinite(template.aspect) && template.aspect > 0 ? template.aspect : 1.0,
      plane: ['flat','upright','camera'].includes(template.plane) ? template.plane : 'billboard',
      // Default facing for plane 'upright', in radians; a per-sprite `heading`
      // overrides it. Read ONLY by the upright branch, so it is inert on every
      // other template. 0 faces +x and positive turns toward +y — the same
      // convention `createBasis` gives mesh entities and `camera.yaw` uses.
      heading: Number.isFinite(template.heading) ? template.heading : 0,
      // Never-animating art lets the dynamic atlas cache this type's cells.
      static: template.static === true,
      preserveArt: template.preserveArt === true,
      colorBoost: Number.isFinite(template.colorBoost) ? Math.max(0, Math.min(4, template.colorBoost)) : 1.35,
      isSelfLuminous: typeof template.isSelfLuminous === 'function' 
        ? template.isSelfLuminous 
        : (() => !!template.isSelfLuminous),
      getBaseColor: template.getBaseColor || (() => ({ r: 255, g: 255, b: 255 })),
      getProperties: template.getProperties || (() => ({ roughness: 0.45, emission: 0, lightResponse: 0.65 }))
    });
  }

  registerMaterial(id, material) {
    this.materials.set(id, {
      getColor: material.getColor || (() => ({ r: 100, g: 100, b: 100 })),
      getChar: material.getChar || (() => null),
      getProperties: material.getProperties || (() => material.properties || {})
    });
    if (this.atlasManager) {
      this.atlasManager.invalidateStaticMaterials();
    }
    // A slot reported as holding nothing may hold this material now, so the
    // report is allowed to be made again rather than being stuck on the old one.
    this.reportedAtlasSlotUses.clear();
  }

  /**
   * Reports scene geometry that addresses a static atlas slot holding nothing.
   *
   * This is the failure with no symptom. The descriptor is well formed, the UVs
   * are in range, the triangles are drawn, and the surface samples an atlas cell
   * that was cleared and never written - so it renders as nothing at all, with
   * no error and no warning anywhere in the pipeline. It is reported once per
   * distinct problem rather than once per rebuild, and again after anything
   * happens that could have fixed it.
   */
  auditAddressedAtlasSlots(mesh, source) {
    if (!this.atlasManager || !mesh || !Array.isArray(mesh.atlasSlots)) return;
    for (const index of mesh.atlasSlots) {
      const status = this.atlasManager.getStaticSlotStatus(index);
      if (status === STATIC_SLOT_BAKED) continue;
      const key = `${index}:${status}`;
      if (this.reportedAtlasSlotUses.has(key)) continue;
      this.reportedAtlasSlotUses.add(key);

      const preamble = `[SceneGeometry] ${source} draws from static atlas slot ${index}, which is empty`;
      if (status === STATIC_SLOT_UNREGISTERED) {
        const materialId = this.atlasManager.getStaticSlotMaterialId(index);
        console.warn(`${preamble}: the installed table assigns it material ` +
          `'${String(materialId)}', which was never passed to registerMaterial. Those surfaces draw nothing.`);
      } else if (status === STATIC_SLOT_EMPTY) {
        console.warn(`${preamble}: no installed material table fills it. ` +
          'Name it in the table passed to setStaticMaterialSlots, or those surfaces draw nothing.');
      } else {
        console.warn(`[SceneGeometry] ${source} draws from atlas slot ${index}, which is past the ` +
          `${this.atlasLayout?.staticSlots ?? RENDERER_STATIC_ATLAS_SLOTS} static slots and holds a dynamic sprite cell, not a material.`);
      }
    }
  }

  /**
   * Installs which material each static atlas slot bakes.
   *
   * Scene features address the static half of the atlas by slot index, and what
   * a slot means is content - this facility's zone walls and diagnostic panels
   * are not an engine's business. Install the table once at startup, the way
   * `setAtmosphereProfiles` is installed; see WALL_MATERIAL_ATLAS_SLOTS in
   * world/WorldAssets.js. With none installed the engine bakes the identity
   * table, slot N drawing material N, and a scene still renders.
   *
   * An entry is a material id, or `{ material, bakeIntensity }` where
   * bakeIntensity is the third argument handed to getChar while the cell is
   * baked - a wall reads it as a side and ignores it, a floor reads it as an
   * average light level. Any of the 32 slots may be named. Four of them are
   * spoken for if you use the grid builder rather than authored features; see
   * SceneGeometry.buildGrid for which and why.
   */
  setStaticMaterialSlots(slots) {
    this.staticMaterialSlots = slots && typeof slots === 'object' ? slots : null;
    this.reportedAtlasSlotUses.clear();
    if (this.atlasManager) {
      this.atlasManager.setStaticMaterialSlots(this.staticMaterialSlots);
    }
    return this;
  }

  /**
   * Bakes the static atlas half now, instead of on the frame that first needs it.
   *
   * Call it once the display contract has settled and before frames are being
   * presented - `resize` picks the atlas cell size, and every mode but the two
   * smallest quadruples it from the constructor's default, so a bake taken
   * before the first resize is both the wrong size and thrown away. In this
   * game that moment is the top of `startGameLoop`, right after the first
   * `resizeTerminal`.
   *
   * The bake is 130-300ms of the materials' own texel maths and it has to
   * happen once. It used to happen on the first frame of a floor, where it was
   * the bulk of a one-second freeze a few seconds into every session. Nothing
   * depends on this being called: `updateTextureAtlas` still bakes lazily.
   */
  prewarmStaticAtlas() {
    return this.atlasManager ? this.atlasManager.refreshStaticMaterials() : false;
  }

  /**
   * Rebakes the static atlas half because its materials paint differently now.
   *
   * The engine has no opinion about why they do. A consumer that changes what
   * an already-registered material returns - this game's colour schemes are the
   * only such thing in it - has changed the atlas without touching the atlas,
   * and this is how it says so. See TextureAtlasManager.rebakeStaticAtlas for
   * what it costs and for why it declines to do anything during load.
   */
  rebakeStaticAtlas() {
    return this.atlasManager ? this.atlasManager.rebakeStaticAtlas() : false;
  }

  /**
   * Supplies an authored scene object with build(map, layout), allowing
   * non-grid architecture while gameplay still uses the logical grid.
   */
  setSceneGeometry(scene) {
    const nextScene = scene && typeof scene.build === 'function' ? scene : null;
    if (nextScene === this.authoredSceneGeometry) return this;

    this.authoredSceneGeometry = nextScene;
    this.currentMapHash = "";
    return this;
  }

  /**
   * Installs frame-owned scene metadata used by optional visual effects. It is
   * data-only so games can render without a global game loop dependency.
   */
  setSceneState(state = {}) {
    const effects = state.effects && typeof state.effects === 'object' ? state.effects : {};
    this.sceneState = {
      revision: Number.isFinite(state.revision) ? state.revision : 0,
      corrodedCells: state.corrodedCells || effects.corrodedCells || null,
      portal: state.portal || effects.portal || null,
      effects
    };
    return this;
  }


  /**
   * Backwards-compatible alias for static architecture features.
   */
  setSceneFeatures(features) {
    return this.setStaticSceneFeatures(features);
  }

  setStaticSceneFeatures(features = []) {
    // CONTRACT: passing the SAME frozen array asserts its CONTENTS are also
    // unchanged - the freeze is shallow, so a caller that mutates feature
    // objects inside a frozen array must pass a new array (or an unfrozen
    // one) to invalidate. The facade always rebuilds the array with fresh
    // feature objects, so its path is safe; direct renderer consumers own
    // this guarantee themselves. The fast path skips the O(n) serialize a
    // large city feature list would otherwise pay every frame.
    if (Array.isArray(features) && Object.isFrozen(features) && features === this.staticFeatureReference) {
      return this;
    }
    this.staticFeatureReference = Array.isArray(features) && Object.isFrozen(features) ? features : null;
    const nextFeatures = Array.isArray(features) ? [...features] : [];
    const nextHash = JSON.stringify(nextFeatures);
    if (nextHash === this.staticFeatureHash) return this;

    this.sceneGeometry.setFeatures(nextFeatures);
    this.staticFeatureHash = nextHash;
    this.currentMapHash = "";
    return this;
  }

  setDynamicSceneFeatures(features = []) {
    const nextFeatures = Array.isArray(features) ? [...features] : [];
    const nextHash = JSON.stringify(nextFeatures);
    if (nextHash === this.dynamicFeatureHash) return this;

    this.dynamicSceneFeatures = nextFeatures;
    this.dynamicFeatureHash = nextHash;
    return this;
  }

  /**
   * Hands the renderer the cells that are mid-phase, and the grid they are solid
   * in - which for a shift is always the Stable one, in both directions.
   *
   * Their walls go into a buffer of their own rather than the static mesh,
   * because the static mesh is drawn from the Void grid for the whole dissolve
   * and would otherwise have to be rebuilt twice a shift. It is rebuilt once, as
   * it always was: on the way out at the keypress, on the way in when the
   * dissolve lands. The measured cost of a rebuild is why - see the phase
   * dissolve's entry in STATUS.md.
   */
  setPhaseCells(map, cells) {
    const requested = Array.isArray(cells) ? cells : [];
    if (!map || requested.length === 0) {
      this.phaseGeometryVertexCount = 0;
      return this;
    }
    const mesh = this.sceneGeometry.buildCells(map, requested, {
      cellSize: this.cellSize,
      atlasSize: this.atlasSize
    });
    if (!mesh || !(mesh.vertices instanceof Float32Array) || !Number.isFinite(mesh.vertexCount)) {
      console.error('[SceneGeometry] Phase cell mesh builder returned invalid geometry.');
      this.phaseGeometryVertexCount = 0;
      return this;
    }
    this.auditAddressedAtlasSlots(mesh, 'a phasing bulkhead');
    this.uploadDynamicBuffer(this.phaseGeometryVBO, mesh.vertices, 'phase');
    this.phaseVisibilityMapWidth = this.uploadVisibilityCells(this.phaseGeometryVAO, this.phaseGeometryVisibilityVBO, mesh, map);
    this.phaseVisibilityMapHeight = this.phaseVisibilityMapWidth ? map.length : 0;
    this.phaseGeometryVertexCount = mesh.vertexCount;
    this.geometryUploadStats.phaseUploads++;
    return this;
  }

  /**
   * How much of the phasing cells' own surface is still drawn, in [0,1].
   *
   * Linear in surface on purpose, exactly as `renderOpacity` is: the mechanism
   * states what it does and the content shapes the curve. GameLoop's
   * `resolvePhasePresence` is what eases it.
   */
  setPhaseDissolve(amount) {
    const numeric = Number(amount);
    this.phaseDissolveAmount = Number.isFinite(numeric) ? Math.max(0, Math.min(1, numeric)) : 1;
    return this;
  }

  clearPhaseGeometry() {
    this.phaseGeometryVertexCount = 0;
    this.phaseDissolveAmount = 1.0;
    return this;
  }

  setSceneGeometryOptions(options) {
    // Re-asserting unchanged options must not invalidate the static mesh - a
    // facade that sets them every frame was otherwise rebuilding the whole
    // world mesh every frame. Only scalar option bags are comparable; anything
    // richer conservatively invalidates as before.
    const cacheable = options && typeof options === 'object' &&
      Object.values(options).every(value => value === null ||
        typeof value === 'number' || typeof value === 'string' ||
        typeof value === 'boolean' || typeof value === 'undefined');
    const optionsKey = cacheable ? JSON.stringify(options) : null;
    if (optionsKey !== null && optionsKey === this.sceneGeometryOptionsKey) return this;
    this.sceneGeometryOptionsKey = optionsKey;
    this.sceneGeometry.setOptions(options);
    this.currentMapHash = "";
    this.uploadedDynamicFeatureHash = "";
    return this;
  }

  getGeometryUploadStats() {
    return {
      ...this.geometryUploadStats,
      staticVertices: this.geometryVertexCount,
      dynamicVertices: this.dynamicGeometryVertexCount,
      phaseVertices: this.phaseGeometryVertexCount
    };
  }

  setEntityMeshesEnabled(enabled) {
    this.entityMeshesEnabled = enabled !== false;
    return this;
  }

  /**
   * Overrides the distance bands entity LOD is selected from, in renderer
   * cells: `{ full, simplified }`, camera-to-entity. Anything else restores
   * the historical ENTITY_LOD_DISTANCES defaults (12 / 19). The stored object
   * is read by reference on each entity rebuild, so a caller may mutate and
   * re-set the same object without allocating.
   */
  setEntityLodDistances(distances) {
    this.entityLodDistances = distances &&
      Number.isFinite(distances.full) && distances.full > 0 &&
      Number.isFinite(distances.simplified) && distances.simplified >= distances.full
      ? distances
      : null;
    return this;
  }

  /**
   * LOD transition presentation for the entity path:
   * `{ hysteresis, dissolveMs }` — hysteresis in renderer cells (a tier keeps
   * its entity that far past the boundary it entered through, so strafing on
   * a boundary cannot strobe tiers at the 30 Hz tick), dissolveMs the
   * mesh<->billboard handoff (the mesh dissolves out/in through
   * applyMeshOpacity instead of swapping in one frame; the billboard pops in
   * under the dissolving mesh — accepted).
   *
   * Null — the default, and what every direct renderer consumer keeps by
   * never calling this — is the exact historical behavior: hard thresholds,
   * frame-discrete swaps, and no state fields written onto roster entities
   * (both features key their state on the persistent per-id entity objects,
   * which only the facade's pool guarantees engine ownership of; the facade
   * sets this every render). The stored object is read by reference each
   * entity rebuild, so a caller may mutate and re-set the same object.
   */
  /**
   * Opt-in deterministic rendering for offline capture: a frame depends only on
   * its inputs and the scene clock, not on the frames drawn before it. While
   * on, the renderer drops its cross-frame state: glyph hysteresis is reset
   * every frame, entity geometry rebuilds every frame instead of on the 30 Hz
   * wall clock, cullable lights are reselected every frame, and entity
   * animation is evaluated at its steady state (see EntityAnimation). The
   * facade also drives the scene clock from render({ time }) and turns off LOD
   * hysteresis and dissolves. Off by default.
   */
  setDeterministic(enabled) {
    this.deterministic = enabled === true;
    if (this.deterministic) this.invalidateCellHistory();
    return this;
  }

  /**
   * Opt in to sprite atlas cells that are handed back. Off (the default), each
   * distinct static sprite image keeps its cell for the renderer's life and,
   * once the sprite half of the atlas is full, any image it has not seen before
   * is skipped; a frame also stops at 224 sprites. On, the least recently used
   * image's cell goes to the new one (see SpriteCellPool), and the per-frame
   * limit is the number of different images on screen at once, not the number
   * of sprites: any number of sprites sharing an image share its cell.
   */
  setSpriteCellRecycling(enabled) {
    const next = enabled === true;
    if (next === this.spriteCellRecycling) return this;
    this.spriteCellRecycling = next;
    this.spriteCellPool = null;
    // The default allocator assumes its cells are the top of the atlas with no
    // gaps; after recycling they need not be, so it starts again from empty.
    // Cells whose image does not change are not baked again.
    if (!next) this.staticTypeCellIndices = new Map();
    return this;
  }

  /**
   * Opt in to `sprite.mirror === true` drawing the sprite's image flipped left
   * to right, from the same atlas cell: no second image, no second cell. Off
   * by default, so a sprite object that already carries a `mirror` field for
   * its own reasons draws as it always has.
   */
  setSpriteMirroring(enabled) {
    this.spriteMirroring = enabled === true;
    return this;
  }

  /**
   * Pixel size of every atlas cell (64, 128 or 256), applied at the next
   * resize() in place of the resolution mode's own (128 in the facade's mode).
   * Sprites are resampled into one cell each, so 256 keeps four times the
   * detail of a large sprite. The atlas is always 16 cells across, so it is 16
   * times the cell: 4096 pixels square at 256, about four times the memory of
   * the default, and the static material slots bake at the same size. Clamped
   * down to what MAX_TEXTURE_SIZE allows; getScalabilityStats().atlasCellSize
   * reports what was used. Null goes back to the mode's own size.
   */
  setAtlasCellSize(cellSize) {
    if (cellSize === null || cellSize === undefined) {
      this.atlasCellSizeOverride = null;
      return this;
    }
    if (![64, 128, 256].includes(cellSize)) {
      throw new RangeError('Atlas cell size must be 64, 128 or 256 pixels.');
    }
    let size = cellSize;
    while (size > 64 && this.maxTextureSize > 0 && size * RENDERER_ATLAS_COLUMNS > this.maxTextureSize) size /= 2;
    this.atlasCellSizeOverride = size;
    return this;
  }

  getSpriteAtlasStats() {
    const pool = this.spriteCellPool;
    return {
      recycling: this.spriteCellRecycling === true,
      mirroring: this.spriteMirroring === true,
      cellSize: this.cellSize,
      sprites: this.activeSpriteIndices?.length ?? 0,
      heldImages: this.staticTypeCellIndices?.size ?? 0,
      cellsInUse: pool ? pool.cellsInUse : null,
      recycledCells: pool ? pool.recycledCells : 0,
      skippedSprites: pool ? pool.skippedSprites : null
    };
  }

  /**
   * The seed dust, fog volumes and wet-street patches are scattered from.
   * Normally the static map hash, which counts map objects this renderer has
   * seen, so the same layout reseeds whenever a new map object arrives. A
   * deterministic renderer seeds from the map's content instead, so a frame's
   * effects do not depend on how many maps came before it.
   */
  effectsMapKey(map) {
    if (this.deterministic !== true) return this.currentMapHash;
    if (map === this.effectsKeyMap) return this.effectsKey;
    let hash = 0x811c9dc5;
    for (const row of map) {
      for (const value of row) {
        const n = Number(value) || 0;
        hash = Math.imul(hash ^ (n & 0xffff), 0x01000193);
        hash = Math.imul(hash ^ (n >>> 16), 0x01000193);
      }
      hash = Math.imul(hash ^ 0x2f, 0x01000193);
    }
    this.effectsKeyMap = map;
    this.effectsKey = `content-${map[0]?.length || 0}x${map.length}_${(hash >>> 0).toString(16)}_r${this.sceneState?.revision ?? 0}`;
    return this.effectsKey;
  }

  setEntityLodTransition(transition) {
    this.entityLodTransition = transition && typeof transition === 'object' ? transition : null;
    return this;
  }

  /**
   * Opt-in glitch style: which glyphs a glitched cell swaps to (atlas indices,
   * up to 8) and which colours it draws in (0..1 RGB triples, up to 4, picked
   * per cell). Null or empty lists keep the historical glyph set and the cyan
   * shift.
   */
  setGlitchStyle(style = null) {
    const glyphs = Array.isArray(style?.glyphs) ? style.glyphs.filter(Number.isInteger).slice(0, 8) : [];
    const colors = Array.isArray(style?.colors)
      ? style.colors.filter(c => Array.isArray(c) && c.length >= 3 && c.slice(0, 3).every(Number.isFinite)).slice(0, 4)
      : [];
    this.glitchStyle = { glyphs, colors: colors.map(c => c.slice(0, 3).map(v => Math.max(0, Math.min(1, v)))) };
    return this;
  }

  collectGlitchStyleUniforms(program) {
    const gl = this.gl;
    return {
      glyphCount: gl.getUniformLocation(program, 'u_glitchGlyphCount'),
      glyphs: gl.getUniformLocation(program, 'u_glitchGlyphs'),
      colorCount: gl.getUniformLocation(program, 'u_glitchColorCount'),
      colors: gl.getUniformLocation(program, 'u_glitchColors')
    };
  }

  applyGlitchStyle(uniforms) {
    if (!uniforms) return;
    const gl = this.gl;
    const style = this.glitchStyle || { glyphs: [], colors: [] };
    gl.uniform1i(uniforms.glyphCount, style.glyphs.length);
    if (style.glyphs.length) gl.uniform1iv(uniforms.glyphs, style.glyphs);
    gl.uniform1i(uniforms.colorCount, style.colors.length);
    if (style.colors.length) gl.uniform3fv(uniforms.colors, style.colors.flat());
  }

  /**
   * Installs the entity content this renderer draws: which types are volumetric,
   * what builds their meshes, and how they are placed.
   *
   * See `resolveEntityContent` in EntityGeometry for the four slots. Install it
   * once at startup, the way `setAtmosphereProfiles` is installed - this is the
   * world, not a per-frame override. Without one the renderer draws no
   * volumetric entities at all, which is the honest answer for an engine that
   * has not been told what game it is running.
   */
  setEntityContent(content) {
    this.entityContent = content && typeof content === 'object' ? content : null;
    return this;
  }

  /**
   * Installs an entity mesh builder ahead of the installed content pack.
   *
   * The builder receives `(entity, currentTime, lod, options)` and returns a
   * mesh, or null to defer to the content pack for that entity. `extraTypes`
   * admits entity types the installed world does not contain, which is how gore
   * renders and how an unreleased creature previews before it is wired in.
   *
   * This is the override slot and it replaces on every call - Creature Studio
   * reinstalls a fresh closure per frame. The world goes in through
   * `setEntityContent`, or the next caller of this would wipe it.
   */
  setEntityMeshBuilder(builder, extraTypes = null) {
    this.entityMeshBuilder = typeof builder === 'function' ? builder : null;
    this.entityMeshExtraTypes = extraTypes;
    return this;
  }

  /**
   * Installs the specimen roster a containment capsule cycles through.
   *
   * The resolver receives `(currentTime, startedAt)` and returns
   * `{ type, state, reveal }`. Fields already on the entity win over it, so a
   * caller may stamp the entity instead and never install one. Without either,
   * capsules render as empty cages.
   */
  setSpecimenResolver(resolver) {
    this.specimenResolver = typeof resolver === 'function' ? resolver : null;
    return this;
  }

  setViewmodelEnabled(enabled) {
    this.viewmodelEnabled = enabled !== false && typeof this.viewmodelBuilder === 'function';
    return this;
  }

  /**
   * Installs a game's own first-person mesh builder. The callback returns
   * `{ vertices, vertexCount, transform?, drawRanges?, motion?, overlayVertices? }`.
   */
  setViewmodelMeshBuilder(builder) {
    this.viewmodelBuilder = typeof builder === 'function' ? builder : null;
    this.viewmodelEnabled = this.viewmodelBuilder !== null;
    return this;
  }

  getEntityRenderStats() {
    return { ...this.entityRenderStats };
  }

  getScalabilityStats() {
    const activeLights = this.lights.filter(light => light.active !== false).length;
    return {
      mode: this.resolutionMode,
      gridWidth: this.width,
      gridHeight: this.height,
      atlasCellSize: this.cellSize,
      atlasSize: this.atlasSize,
      glyphPipeline: this.getGlyphPipelineStats(),
      activeBillboards: this.activeBillboardCount,
      maxBillboards: this.atlasLayout?.maxBillboards ?? RENDERER_MAX_BILLBOARDS,
      // Only when an opt-in is on, so default stats keep their exact shape.
      ...(this.spriteCellRecycling || this.spriteMirroring || this.atlasCellSizeOverride
        ? { spriteAtlas: this.getSpriteAtlasStats() } : {}),
      activeLights: Math.min(activeLights, MAX_LIGHTS),
      maxLights: MAX_LIGHTS,
      particles: this.environmentalParticleCount,
      reactiveSurfaces: this.reactiveSurfacePatches.length,
      maxReactiveSurfaces: this.scalabilityBudgets.maxReactiveSurfaces,
      entity: this.getEntityRenderStats()
    };
  }

  /**
   * Installs the table of dimensions this renderer can be switched between.
   *
   * Keyed by dimension name; the values are complete atmosphere profiles, as
   * `world/FacilityAtmosphere.js` builds them. Which dimensions exist is the
   * loaded world's to say, so whoever installs the table also names the one to
   * start in. With none installed every name resolves to the engine's neutral
   * grade and the scene still renders.
   */
  setAtmosphereProfiles(profiles) {
    this.atmosphereProfiles = profiles && typeof profiles === 'object' ? profiles : null;
    return this;
  }

  setAtmosphereProfile(dimension, options = {}) {
    this.atmosphere = resolveAtmosphereProfile(dimension, options, this.atmosphereProfiles);
    return this;
  }

  getAtmosphereProfile() {
    return {
      ...this.atmosphere,
      fogColor: [...this.atmosphere.fogColor],
      shadowTint: [...this.atmosphere.shadowTint],
      surfaceTint: [...this.atmosphere.surfaceTint]
    };
  }

  setLights(lights) {
    this.lights = lights;
  }

  /**
   * Far-plane distance in world (grid) units. The projection reads it each
   * frame, so a game can drive draw distance from its quality settings.
   */
  setMaxDepth(value) {
    if (Number.isFinite(value) && value > 1.0) this.maxDepth = value;
    return this;
  }

  /**
   * Fill the remaining light slots with the nearest cullable fixture lights.
   *
   * Two properties are load-bearing, both for the same reason.
   * getLightVisibilityFingerprint hashes the active set as an *ordered* list of
   * positions, and a fingerprint change rebuilds the CPU visibility bake. Since
   * 2026-10-26 a rebuild retraces only the lights new to the set (the rest come
   * from lightVisibilityCache), but it still assembles and uploads the whole
   * atlas. So:
   *
   *   - Selection is recomputed only once the camera has moved past a
   *     threshold, not every frame.
   *   - Survivors are emitted in registration order, never distance order, so
   *     walking around a fixture cannot reorder the set and force a rebuild.
   *
   * The net effect is that the bake is rebuilt when the player crosses into a
   * new pocket of fixtures, which is the same cost class as loading a floor.
   */
  appendCullableLights(activeLights, candidates, player) {
    const budget = MAX_LIGHTS - activeLights.length;
    if (budget <= 0) return;

    const originX = player && Number.isFinite(player.x) ? player.x : 0;
    const originY = player && Number.isFinite(player.y) ? player.y : 0;
    const movedSq = (originX - this.cullableOriginX) ** 2 + (originY - this.cullableOriginY) ** 2;
    const stale = this.deterministic === true || !this.cullableSelectionValid ||
      this.cullableBudget !== budget ||
      this.cullableCandidateCount !== candidates.length ||
      movedSq > CULLABLE_LIGHT_REEVALUATE_DISTANCE * CULLABLE_LIGHT_REEVALUATE_DISTANCE;

    if (stale) {
      const ranked = candidates
        .map((light, order) => ({
          light,
          order,
          distanceSq: (light.x - originX) ** 2 + (light.y - originY) ** 2
        }))
        // Out-of-range fixtures contribute nothing but still consume a slot.
        .filter(entry => entry.distanceSq <= (entry.light.range + CULLABLE_LIGHT_MARGIN) ** 2)
        .sort((a, b) => a.distanceSq - b.distanceSq)
        .slice(0, budget)
        .sort((a, b) => a.order - b.order);

      this.cullableSelection.length = 0;
      for (let i = 0; i < ranked.length; i++) this.cullableSelection.push(ranked[i].light);
      this.cullableSelectionValid = true;
      this.cullableOriginX = originX;
      this.cullableOriginY = originY;
      this.cullableBudget = budget;
      this.cullableCandidateCount = candidates.length;
    }

    for (let i = 0; i < this.cullableSelection.length; i++) {
      activeLights.push(this.cullableSelection[i]);
    }
  }

  updateLightVisibilityAtlas(map, activeLights) {
    if (!map || !map.length || !map[0].length) return;

    const fingerprint = getLightVisibilityFingerprint(this.currentMapHash, activeLights, MAX_LIGHTS);
    if (fingerprint === this.lightVisibilityFingerprint) return;

    const atlas = buildLightVisibilityAtlas(map, activeLights, MAX_LIGHTS, {
      cache: this.lightVisibilityCache,
      mapKey: `${this.currentMapHash}|${this.sceneState?.revision ?? 0}`
    });
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.lightVisibilityTexture);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.R8,
      atlas.width,
      atlas.mapHeight * atlas.layerCount,
      0,
      gl.RED,
      gl.UNSIGNED_BYTE,
      atlas.data
    );
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);

    this.lightVisibilityFingerprint = fingerprint;
    this.lightVisibilityMapWidth = atlas.width;
    this.lightVisibilityMapHeight = atlas.mapHeight;
    this.lightVisibilityLayerCount = atlas.layerCount;
  }

  updateEnvironmentalEffects(map, activeLights, player = null) {
    if (!map || !map.length || !map[0]?.length) return;
    const enabled = this.atmosphere.environmentalFx !== false;
    const density = this.atmosphere.particleDensity * this.scalabilityBudgets.effectScale;
    const dustColor = this.atmosphere.dustColor;
    const precipitation = this.atmosphere.precipitation;
    const particleBudget = this.atmosphere.particleBudget;
    const precipitationBudget = this.atmosphere.precipitationBudget;
    // Camera focus, quantized to the same 16-cell sectors the reactive
    // surfaces use: the particle set stays deterministic across a whole
    // sector and the VBO is rebuilt only on a crossing, not per frame.
    const focused = enabled && this.atmosphere.particleFocus === 'camera'
      && Number.isFinite(player?.x) && Number.isFinite(player?.y);
    const sectorX = focused ? Math.floor(player.x / 16) : 0;
    const sectorY = focused ? Math.floor(player.y / 16) : 0;
    // Density/color/precipitation/budgets enter the fingerprint (rounded) so a
    // world changing them rebuilds once per change — worlds should hold them
    // constant per scene, not lerp them per frame.
    const variant = `${(+density || 0).toFixed(2)}`
      + `:${Array.isArray(dustColor) ? dustColor.map(channel => (+channel || 0).toFixed(2)).join(',') : ''}`
      + `:${(+precipitation || 0).toFixed(2)}`
      + (Number.isFinite(particleBudget) ? `:b${particleBudget}` : '')
      + (Number.isFinite(precipitationBudget) ? `:p${precipitationBudget}` : '')
      + (focused ? `:f${sectorX},${sectorY},${(+this.atmosphere.particleFocusRadius || 0).toFixed(1)}` : '');
    const effectsKey = this.effectsMapKey(map);
    const fingerprint = getEnvironmentalEffectsFingerprint(
      effectsKey,
      this.atmosphere.name,
      activeLights,
      enabled,
      variant
    );
    if (fingerprint === this.environmentalEffectsFingerprint) return;

    const effects = buildEnvironmentalEffects(map, activeLights, {
      enabled,
      mapHash: effectsKey,
      profileName: this.atmosphere.name,
      particleDensity: density,
      dustColor,
      precipitation,
      particleBudget,
      precipitationBudget,
      focusX: focused ? (sectorX + 0.5) * 16 : undefined,
      focusY: focused ? (sectorY + 0.5) * 16 : undefined,
      focusRadius: focused ? this.atmosphere.particleFocusRadius : undefined
    });
    this.environmentalEffectsFingerprint = fingerprint;
    this.environmentalParticleCount = effects.particleCount;
    this.environmentalFogVolumes = effects.fogVolumes;

    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.environmentParticleVBO);
    gl.bufferData(gl.ARRAY_BUFFER, effects.particles, gl.STATIC_DRAW);
  }

  updateReactiveSurfaces(map, player) {
    if (!map || !map.length || !map[0]?.length) return;
    const enabled = this.atmosphere.reactiveSurfaces !== false;
    // Camera focus is quantized to 16-cell sectors: the pick stays
    // deterministic across a whole sector and rebuilds only on crossing.
    const focused = enabled && this.atmosphere.reactiveSurfaceFocus === 'camera'
      && Number.isFinite(player?.x) && Number.isFinite(player?.y);
    const sectorX = focused ? Math.floor(player.x / 16) : 0;
    const sectorY = focused ? Math.floor(player.y / 16) : 0;
    const effectsKey = this.effectsMapKey(map);
    const fingerprint = getReactiveSurfacesFingerprint(
      effectsKey,
      this.atmosphere.name,
      enabled,
      `${this.atmosphere.reactiveSurfaceDensity}:${this.atmosphere.fullFloorReflection ? 1 : 0}${focused ? `:${sectorX},${sectorY}` : ''}`
    );
    if (fingerprint === this.reactiveSurfacesFingerprint) return;

    const surfaces = buildReactiveSurfaces(map, {
      enabled,
      mapHash: effectsKey,
      profileName: this.atmosphere.name,
      density: this.atmosphere.reactiveSurfaceDensity * this.scalabilityBudgets.effectScale,
      fullCoverage: this.atmosphere.fullFloorReflection,
      focusX: focused ? (sectorX + 0.5) * 16 : undefined,
      focusY: focused ? (sectorY + 0.5) * 16 : undefined
    });
    this.reactiveSurfacesFingerprint = fingerprint;
    this.reactiveSurfacePatches = surfaces.patches.slice(0, this.scalabilityBudgets.maxReactiveSurfaces);
  }

  resize(newWidth, newHeight, layout = null) {
    this.assertOperational();
    this.width = newWidth;
    this.height = newHeight;
    const requestedMode = layout?.mode || this.resolutionMode || 'max';
    this.resolutionMode = normalizeResolutionMode(requestedMode);
    const contract = getResolutionContract(this.resolutionMode);
    // setAtlasCellSize's override yields to a layout that names its own size.
    const cellOverride = layout?.atlasCellSize ? null : this.atlasCellSizeOverride;
    const newCellSize = cellOverride || layout?.atlasCellSize || contract.atlasCellSize;
    const newAtlasSize = cellOverride ? cellOverride * RENDERER_ATLAS_COLUMNS : layout?.atlasSize || contract.atlasSize;
    const budgetMap = layout?.map || this.currentMapReference;
    const mapHeight = budgetMap?.length || 18;
    const mapWidth = budgetMap?.[0]?.length || 20;
    this.scalabilityBudgets = resolveRendererBudgets({
      mode: this.resolutionMode,
      mapWidth,
      mapHeight
    });
    this.environmentalEffectsFingerprint = '';
    this.reactiveSurfacesFingerprint = '';
    
    if (newCellSize !== this.cellSize || newAtlasSize !== this.atlasSize) {
      this.cellSize = newCellSize;
      this.atlasSize = newAtlasSize;
      this.currentMapHash = "";
      this.uploadedDynamicFeatureHash = "";
      if (this.atlasManager) {
        this.atlasManager.onAtlasSizeChanged(newCellSize, newAtlasSize);
      }
    }
    
    const gl = this.gl;
    if (!gl) return;

    this.reallocateSceneTargets();
  }

  /**
   * Re-resolve the scene/grid resolution contract and resize every target that
   * depends on it. Called on display resize and whenever the pipeline mode
   * changes.
   */
  reallocateSceneTargets() {
    this.assertOperational();
    const gl = this.gl;
    if (!gl) return;

    this.sceneContract = resolveSceneResolution({
      gridWidth: this.width,
      gridHeight: this.height,
      mode: this.glyphPipelineMode,
      maxTextureSize: this.maxTextureSize
    });
    this.sceneWidth = this.sceneContract.sceneWidth;
    this.sceneHeight = this.sceneContract.sceneHeight;
    if (this.sceneTargetSets) {
      this.swapSceneTargets();
      return;
    }

    gl.bindTexture(gl.TEXTURE_2D, this.gbufAlbedo);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, this.sceneWidth, this.sceneHeight, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);

    gl.bindTexture(gl.TEXTURE_2D, this.gbufNormal);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, this.sceneWidth, this.sceneHeight, 0, gl.RGBA, gl.HALF_FLOAT, null);

    gl.bindTexture(gl.TEXTURE_2D, this.gbufPosition);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, this.sceneWidth, this.sceneHeight, 0, gl.RGBA, gl.HALF_FLOAT, null);

    gl.bindTexture(gl.TEXTURE_2D, this.gbufVisibilityCell);
    gl.texImage2D(gl.TEXTURE_2D, 0, this.visibilityCellWide ? gl.R32UI : gl.R16UI,
      this.sceneWidth, this.sceneHeight, 0, gl.RED_INTEGER,
      this.visibilityCellWide ? gl.UNSIGNED_INT : gl.UNSIGNED_SHORT, null);

    gl.bindRenderbuffer(gl.RENDERBUFFER, this.gbufDepthStencil);
    gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH24_STENCIL8, this.sceneWidth, this.sceneHeight);

    gl.bindTexture(gl.TEXTURE_2D, this.lightTexture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, this.sceneWidth, this.sceneHeight, 0, gl.RGBA, gl.HALF_FLOAT, null);

    gl.bindTexture(gl.TEXTURE_2D, this.surfaceTexture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, this.sceneWidth, this.sceneHeight, 0, gl.RGBA, gl.HALF_FLOAT, null);

    this.resizeBloomTargets();

    for (const target of this.cellTargets || []) {
      for (const texture of [target.foreground, target.background]) {
        gl.bindTexture(gl.TEXTURE_2D, texture);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, this.width, this.height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      }
    }
    const framebufferChecks = [
      [this.gbufFBO, 'G-buffer'],
      [this.lightFBO, 'Light buffer'],
      [this.surfaceFBO, 'Surface buffer'],
      ...(this.cellFBOs || []).map((framebuffer, index) => [framebuffer, `Cell buffer ${index}`])
    ];
    for (const [framebuffer, label] of framebufferChecks) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
      this.assertCurrentFramebufferComplete(label);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.invalidateCellHistory();
  }

  /**
   * Opt-in: keep the grid-sized render targets (G-buffer, light, surface,
   * bloom and cell targets) of up to `sizes` grid sizes. A resize to a size
   * still kept swaps its targets back in, cleared to what a fresh allocation
   * holds, where it would otherwise reallocate every target and check every
   * framebuffer, which waits on the GPU: a game that flips between two grids
   * (a coarse view and the full one) stops stalling on each flip. The frames
   * are the same either way; the cost is the memory of the sizes kept, the
   * least recently used freed first. 1, the default, reallocates in place and
   * frees every kept size but the current one. Returns the renderer.
   */
  setSceneTargetCache(sizes) {
    this.assertOperational();
    const limit = Number.isFinite(sizes) ? Math.max(1, Math.floor(sizes)) : 1;
    if (!this.gl) return this;
    if (limit === 1) {
      for (const set of this.sceneTargetSets?.values() ?? []) {
        if (set !== this.activeSceneTargets) this.deleteSceneTargets(set);
      }
      this.sceneTargetSets = null;
      this.activeSceneTargets = null;
      this.sceneTargetLimit = 1;
      return this;
    }
    this.sceneTargetLimit = limit;
    if (!this.sceneTargetSets) {
      const current = this.captureSceneTargets();
      this.sceneTargetSets = new Map([[current.key, current]]);
      this.activeSceneTargets = current;
    }
    this.evictSceneTargets();
    return this;
  }

  sceneTargetKey() {
    return `${this.sceneWidth}x${this.sceneHeight}:${this.width}x${this.height}`;
  }

  captureSceneTargets(key = this.sceneTargetKey()) {
    const set = { key, wide: this.visibilityCellWide };
    for (const field of SCENE_TARGET_FIELDS) set[field] = this[field];
    return set;
  }

  /**
   * reallocateSceneTargets with sizes kept: the kept targets for this size,
   * or a new set of them, swapped in. It leaves the renderer as reallocating
   * in place would: every target empty, the bloom chain owed its clear, the
   * cell history invalid, and the textures the passes last pointed at
   * (composite, bloom, cell) the same roles in the new set.
   */
  swapSceneTargets() {
    const gl = this.gl;
    const previous = this.activeSceneTargets;
    const compositeIsLight = this.compositeTexture === previous.lightTexture;
    const bloomIndex = Math.max(0, previous.bloomTextures.indexOf(this.bloomTexture));
    const historyIndex = this.cellHistoryIndex;
    const wide = this.visibilityCellWide;
    const key = this.sceneTargetKey();
    let next = this.sceneTargetSets.get(key);
    if (next) {
      this.sceneTargetSets.delete(key);
      this.clearSceneTargets(next);
    } else {
      next = this.buildSceneTargets(key);
    }
    this.matchVisibilityCellFormat(next, wide);
    // Re-inserted, so the Map runs least recently used first.
    this.sceneTargetSets.set(key, next);
    for (const field of SCENE_TARGET_FIELDS) this[field] = next[field];
    this.activeSceneTargets = next;
    this.visibilityCellWide = wide;
    this.compositeTexture = compositeIsLight ? next.lightTexture : next.surfaceTexture;
    this.bloomTexture = next.bloomTextures[bloomIndex];
    this.bloomWidth = Math.max(1, Math.floor(this.sceneWidth / 4));
    this.bloomHeight = Math.max(1, Math.floor(this.sceneHeight / 4));
    this.bloomChainDirty = true;
    this.cellHistoryIndex = historyIndex;
    this.cellTexture = next.cellTargets[historyIndex].foreground;
    this.cellBackgroundTexture = next.cellTargets[historyIndex].background;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.invalidateCellHistory();
    this.evictSceneTargets();
  }

  /**
   * A new set of grid-sized targets at the current sizes. The init functions
   * build them into the renderer's own fields, checking each framebuffer once
   * for the size; swapSceneTargets restores the state they reset.
   */
  buildSceneTargets(key) {
    this.initGBuffer();
    this.initLightBuffer();
    this.initSurfaceBuffer();
    this.initCellBuffer();
    this.initBloomBuffers();
    return this.captureSceneTargets(key);
  }

  /**
   * A kept set back to what a fresh allocation holds, as WebGL zero-fills a
   * new target: colour 0, depth 1, stencil 0. Every pass already writes what
   * it reads first, so this only makes the equivalence exact.
   */
  clearSceneTargets(set) {
    const gl = this.gl;
    // Every pass that tests depth sets its own mask before it draws.
    gl.depthMask(true);
    gl.bindFramebuffer(gl.FRAMEBUFFER, set.gbufFBO);
    gl.clearBufferfv(gl.COLOR, 0, GBUFFER_CLEAR_FLOAT);
    gl.clearBufferfv(gl.COLOR, 1, GBUFFER_CLEAR_FLOAT);
    gl.clearBufferfv(gl.COLOR, 2, GBUFFER_CLEAR_FLOAT);
    gl.clearBufferuiv(gl.COLOR, 3, GBUFFER_CLEAR_UINT);
    gl.clearBufferfi(gl.DEPTH_STENCIL, 0, 1, 0);
    for (const framebuffer of [set.lightFBO, set.surfaceFBO, ...set.bloomFBOs]) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
      gl.clearBufferfv(gl.COLOR, 0, GBUFFER_CLEAR_FLOAT);
    }
    for (const framebuffer of set.cellFBOs) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
      gl.clearBufferfv(gl.COLOR, 0, GBUFFER_CLEAR_FLOAT);
      gl.clearBufferfv(gl.COLOR, 1, GBUFFER_CLEAR_FLOAT);
    }
  }

  // A set's surface-cell target in the format the current map needs
  // (configureVisibilityCellTarget's reallocation, for a set coming in).
  matchVisibilityCellFormat(set, wide) {
    if (set.wide === wide) return;
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, set.gbufVisibilityCell);
    gl.texImage2D(gl.TEXTURE_2D, 0, wide ? gl.R32UI : gl.R16UI,
      this.sceneWidth, this.sceneHeight, 0, gl.RED_INTEGER,
      wide ? gl.UNSIGNED_INT : gl.UNSIGNED_SHORT, null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, set.gbufFBO);
    this.assertCurrentFramebufferComplete('G-buffer surface cells');
    set.wide = wide;
  }

  evictSceneTargets() {
    for (const [key, set] of this.sceneTargetSets) {
      if (this.sceneTargetSets.size <= this.sceneTargetLimit) break;
      if (set === this.activeSceneTargets) continue;
      this.sceneTargetSets.delete(key);
      this.deleteSceneTargets(set);
    }
  }

  deleteSceneTargets(set) {
    const gl = this.gl;
    for (const framebuffer of [set.gbufFBO, set.lightFBO, set.surfaceFBO, ...set.bloomFBOs, ...set.cellFBOs]) {
      gl.deleteFramebuffer(framebuffer);
    }
    const cellTextures = set.cellTargets.flatMap(target => [target.foreground, target.background]);
    for (const texture of [
      set.gbufAlbedo, set.gbufNormal, set.gbufPosition, set.gbufVisibilityCell,
      set.lightTexture, set.surfaceTexture, ...set.bloomTextures, ...cellTextures
    ]) {
      gl.deleteTexture(texture);
    }
    gl.deleteRenderbuffer(set.gbufDepthStencil);
  }

  /**
   * Select the glyph pipeline. 'legacy' keeps the single-sample path that
   * shipped; the supersampled modes drive the two-pass cell/glyph path.
   */
  setGlyphPipelineMode(mode) {
    const normalized = normalizeGlyphPipelineMode(mode);
    if (normalized === this.glyphPipelineMode) return this.sceneContract;
    this.glyphPipelineMode = normalized;
    this.reallocateSceneTargets();
    this.invalidateCellHistory();
    return this.sceneContract;
  }

  setStructuralGlyphsEnabled(enabled) {
    this.structuralGlyphs = enabled !== false;
  }

  setSubCellColorEnabled(enabled) {
    this.subCellColor = enabled !== false;
  }

  /**
   * The ordered Bayer dither in the reduce pass's density ramp - the menu calls
   * it Glyph Screening.
   *
   * It lives inside the RAMP branch of `cellFS` and nowhere else, so it cannot
   * touch a cell that resolved to a structural glyph. That is not a detail: it
   * is why turning this off leaves walls alone. Measured 2026-08-23 across four
   * variants of the same posed frame (`.visual-qa/dither-ab-2026-08-23/`) - the
   * left wall came back pixel-for-pixel identical with the dither off, and the
   * whole change landed on about 2% of the frame, almost all of it the
   * operative's own first-person gear. The wall's halftone look is the
   * supersample itself (`.visual-qa/structural-ab-2026-08-23/`: legacy inks
   * 6.9% of the left wall, ultra 23.2%), which no toggle here moves.
   *
   * Where it does show is close, evenly-lit surfaces, and the arms are the
   * largest one on screen. Cell-to-cell luma step on the viewmodel panel at
   * ultra: 5.89 mean with it on, 2.02 with it off, against 0.93 for legacy -
   * a ~66% drop, confirmed by duplicate runs, with no banding cost anywhere
   * (the widest flashlight gradient was numerically identical either way).
   *
   * `legacy` never reaches this branch at all, so the flag is inert there and
   * the menu greys the control rather than pretending otherwise.
   */
  setDitherEnabled(enabled) {
    this.ditherEnabled = enabled !== false;
  }

  setFlashlightShadowsEnabled(enabled) {
    this.flashlightShadowsEnabled = enabled !== false;
  }

  getGlyphPipelineStats() {
    return {
      mode: this.glyphPipelineMode,
      sceneScale: this.sceneContract.sceneScale,
      requestedScale: this.sceneContract.requestedScale,
      clamped: this.sceneContract.clamped,
      sceneWidth: this.sceneWidth,
      sceneHeight: this.sceneHeight,
      samplesPerCell: this.sceneContract.samplesPerAxis ** 2,
      twoPass: this.sceneContract.twoPass,
      structural: this.sceneContract.structural && this.structuralGlyphs,
      subCellColor: this.sceneContract.twoPass && this.subCellColor
    };
  }

  updateSceneGeometry(map) {
    const gl = this.gl;
    if (!map) return;
    if (this.sceneGeometry) {
      if (map !== this.currentMapReference) {
        this.currentMapReference = map;
        this.mapReferenceVersion++;
        this.currentMapHash = '';
      }
      const mapHeight = map.length;
      const mapWidth = map[0].length;
      const corrodedCells = this.sceneState.corrodedCells;
      const activeScene = this.authoredSceneGeometry;
      const sceneRevision = activeScene && activeScene.revision !== undefined ? activeScene.revision : 'grid';
      const mapRevision = this.sceneState.revision;
      const mapHash = `scene-v3_${mapWidth}x${mapHeight}_m${this.mapReferenceVersion}_r${mapRevision}_${sceneRevision}`;
      if (mapHash === this.currentMapHash && this.geometryVertexCount > 0) {
        return;
      }

      const geometryLayout = {
        cellSize: this.cellSize,
        atlasSize: this.atlasSize,
        corrodedCells
      };
      let mesh;
      try {
        mesh = activeScene && typeof activeScene.build === 'function'
          ? activeScene.build(map, geometryLayout)
          : this.sceneGeometry.buildGrid(map, geometryLayout);
      } catch (error) {
        console.error('[SceneGeometry] Authored mesh build failed; using the grid-compatible curved mesh.', error);
        mesh = this.sceneGeometry.buildGrid(map, geometryLayout);
      }

      if (!mesh || !(mesh.vertices instanceof Float32Array) || !Number.isFinite(mesh.vertexCount)) {
        console.error('[SceneGeometry] Mesh builder returned invalid geometry.');
        return;
      }
      this.auditAddressedAtlasSlots(mesh, 'the static scene mesh');

      gl.bindBuffer(gl.ARRAY_BUFFER, this.geometryVBO);
      gl.bufferData(gl.ARRAY_BUFFER, mesh.vertices, gl.STATIC_DRAW);
      this.geometryVisibilityMapWidth = this.uploadVisibilityCells(this.geometryVAO, this.geometryVisibilityVBO, mesh, map);
      this.geometryVisibilityMapHeight = this.geometryVisibilityMapWidth ? map.length : 0;
      this.geometryVertexCount = mesh.vertexCount;
      this.geometryUploadStats.staticUploads++;
      this.currentMapHash = mapHash;
      return;
    }

    
    // Hash map size and key blocks to avoid rebuilding static buffers on every frame
    const mapHeight = map.length;
    const mapWidth = map[0].length;
    let mapSum = 0;
    for (let y = 0; y < mapHeight; y++) {
      for (let x = 0; x < mapWidth; x++) {
        mapSum += map[y][x] * (x + y * 7);
      }
    }
    
    let corrosionSum = 0;
    if (this.sceneState.corrodedCells) {
      for (const cellKey of this.sceneState.corrodedCells) {
        const parts = cellKey.split(',');
        const cx = parseInt(parts[0], 10) || 0;
        const cy = parseInt(parts[1], 10) || 0;
        corrosionSum += (cx + cy * 13);
      }
    }
    
    const mapHash = `${mapWidth}x${mapHeight}_${mapSum}_c${corrosionSum}`;
    if (mapHash === this.currentMapHash && this.geometryVertexCount > 0) {
      return; // Already uploaded
    }
    this.currentMapHash = mapHash;

    const vertices = [];
    
    const addQuad = (p1, p2, p3, p4, n, u1, v1, u2, v2) => {
      vertices.push(...p1, ...n, u1, v1);
      vertices.push(...p2, ...n, u2, v1);
      vertices.push(...p3, ...n, u2, v2);
      vertices.push(...p1, ...n, u1, v1);
      vertices.push(...p3, ...n, u2, v2);
      vertices.push(...p4, ...n, u1, v2);
    };

    const zCeil = WORLD_CEILING_Z;
    const zFloor = WORLD_FLOOR_Z;

    // Wall faces are laid in unit courses so the atlas tile tiles up a wall
    // taller than one unit instead of stretching; the top course is cut to
    // fit and samples the lower fraction of the tile, like a course cut at
    // the ceiling line. At height 1.0 this emits exactly the old single quad.
    const addWallCourses = (a, b, n, uMin, uMax, vMin, vMax) => {
      let bottom = zFloor;
      while (bottom - zCeil > 1e-6) {
        const top = Math.max(zCeil, bottom - 1);
        const vTop = vMax - (vMax - vMin) * (bottom - top);
        addQuad(
          [a[0], a[1], bottom],
          [b[0], b[1], bottom],
          [b[0], b[1], top],
          [a[0], a[1], top],
          n, uMin, vMax, uMax, vTop
        );
        bottom = top;
      }
    };

    for (let y = 0; y < mapHeight; y++) {
      for (let x = 0; x < mapWidth; x++) {
        const cell = map[y][x];
        if (cell > 0) {
          let col, row;
          if (cell === 5) {
            col = 7;
            row = 0;
          } else {
            const matIdx = cell - 1;
            col = matIdx % 16;
            row = Math.floor(matIdx / 16);
          }
          const uMin = (col * this.cellSize) / this.atlasSize;
          const uMax = ((col + 1) * this.cellSize) / this.atlasSize;
          const vMin = 0.0;
          const vMax = this.cellSize / this.atlasSize;

          // East Face
          if (x + 1 < mapWidth && map[y][x + 1] === 0) {
            addWallCourses([x + 1, y], [x + 1, y + 1], [1, 0, 0], uMin, uMax, vMin, vMax);
          }
          // West Face
          if (x - 1 >= 0 && map[y][x - 1] === 0) {
            addWallCourses([x, y + 1], [x, y], [-1, 0, 0], uMin, uMax, vMin, vMax);
          }
          // South Face
          if (y + 1 < mapHeight && map[y + 1][x] === 0) {
            addWallCourses([x + 1, y + 1], [x, y + 1], [0, 1, 0], uMin, uMax, vMin, vMax);
          }
          // North Face
          if (y - 1 >= 0 && map[y - 1][x] === 0) {
            addWallCourses([x, y], [x + 1, y], [0, -1, 0], uMin, uMax, vMin, vMax);
          }
        }
      }
    }

    // Floor and Ceiling tiled cell-by-cell
    const floorUMin = (4 * this.cellSize) / this.atlasSize;
    const floorUMax = (5 * this.cellSize) / this.atlasSize;
    const ceilUMin = (5 * this.cellSize) / this.atlasSize;
    const ceilUMax = (6 * this.cellSize) / this.atlasSize;
    const corrUMin = (6 * this.cellSize) / this.atlasSize;
    const corrUMax = (7 * this.cellSize) / this.atlasSize;

    for (let y = 0; y < mapHeight; y++) {
      for (let x = 0; x < mapWidth; x++) {
        if (map[y][x] === 0) {
          const isCorroded = this.sceneState.corrodedCells && this.sceneState.corrodedCells.has(`${x},${y}`);
          const uMin = isCorroded ? corrUMin : floorUMin;
          const uMax = isCorroded ? corrUMax : floorUMax;

          // Floor cell
          addQuad(
            [x,     y + 1, zFloor],
            [x + 1, y + 1, zFloor],
            [x + 1, y,     zFloor],
            [x,     y,     zFloor],
            [0, 0, -1],
            uMin, this.cellSize / this.atlasSize, uMax, 0.0
          );

          // Ceiling cell
          addQuad(
            [x,     y,     zCeil],
            [x + 1, y,     zCeil],
            [x + 1, y + 1, zCeil],
            [x,     y + 1, zCeil],
            [0, 0, 1],
            ceilUMin, 0.0, ceilUMax, this.cellSize / this.atlasSize
          );
        }
      }
    }

    gl.bindBuffer(gl.ARRAY_BUFFER, this.geometryVBO);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(vertices), gl.STATIC_DRAW);
    this.geometryVisibilityMapWidth = this.uploadVisibilityCells(this.geometryVAO, this.geometryVisibilityVBO, { vertexCount: vertices.length / 8 }, map);
    this.geometryVisibilityMapHeight = 0;
    this.geometryVertexCount = vertices.length / 8;
    this.geometryUploadStats.staticUploads++;
  }

  updateDynamicSceneGeometry() {
    if (this.dynamicFeatureHash === this.uploadedDynamicFeatureHash) return;

    const mesh = this.sceneGeometry.buildFeatures(this.dynamicSceneFeatures, {
      cellSize: this.cellSize,
      atlasSize: this.atlasSize
    });
    if (!mesh || !(mesh.vertices instanceof Float32Array) || !Number.isFinite(mesh.vertexCount)) {
      console.error('[SceneGeometry] Dynamic feature mesh builder returned invalid geometry.');
      return;
    }
    this.auditAddressedAtlasSlots(mesh, 'a dynamic scene feature');

    this.uploadDynamicBuffer(this.dynamicGeometryVBO, mesh.vertices, 'scene');
    this.dynamicGeometryVertexCount = mesh.vertexCount;
    this.uploadedDynamicFeatureHash = this.dynamicFeatureHash;
    this.geometryUploadStats.dynamicUploads++;
  }

  /**
   * The 30 Hz cadence, with immediate refresh on scene changes or clock rewind.
   *
   * Everything under this call rebuilds from scratch for the whole roster -
   * `buildEntityGeometry` has no cross-frame cache and cannot usefully have one
   * (measured 2026-08-26: of the meshes a floor-150 roster emits on one frame,
   * ZERO are byte-identical to another entity's, and 3% are byte-identical to
   * what the same entity produced 33 ms earlier). So the cadence is not a
   * tuning knob, it is the difference between paying for the roster thirty
   * times a second and paying for it at the display's refresh rate. At 165 Hz
   * the slot shrinks from 33.3 ms to 6.1 ms, and since the rebuild's cost is
   * linear in emitted vertices, the depth at which it stops fitting falls from
   * about floor 300 to about floor 45.
   *
   * It lives in a method of its own so that something can DRIVE it. It was six
   * lines inside `compile`, which needs a GL context, so nothing in the suite
   * could ask how often it fired - and a throttle nobody counts is a throttle
   * that can quietly stop throttling. `test/entity_geometry_emit.test.js` runs a
   * real display-frame sequence through this and counts the rebuilds;
   * `entityRebuilds` below is the same count read off a live game, which is the
   * half that stands on the runtime's side of the question.
   */
  updateThrottledEntityGeometry(sprites, player, currentTime, map = null) {
    // A new room must present its own meshes, billboards and atlas together,
    // even inside the normal 30 Hz window. Collision-map identity also covers
    // phase callers whose drawn map stays fixed while collision cells change.
    const sceneChanged = map !== this.lastEntityGeometryMap ||
      this.currentMapHash !== this.lastEntityGeometryMapHash ||
      this.authoredSceneGeometry !== this.lastEntityGeometryScene;
    const timeRewound = currentTime < this.lastEntityGeometryFrameTime;
    this.lastEntityGeometryFrameTime = currentTime;
    if (!sceneChanged && !timeRewound && this.deterministic !== true &&
        currentTime - this.lastDynamicGeometryUpdate < this.dynamicGeometryIntervalMs) {
      // Instrument quads track the display camera without raising actor ticks.
      if(sprites.some(sprite=>this.spriteTemplates?.get(sprite.type)?.plane==='camera')) {
        this.updateSpriteGeometry(sprites,player,currentTime);
        // A recycled cell may have just changed hands; bake it before it draws
        // the previous image. Unchanged cells skip their bake.
        if (this.spriteCellRecycling === true) this.updateTextureAtlas(sprites, currentTime);
      }
      return false;
    }
    this.lastDynamicGeometryUpdate = currentTime;
    this.lastEntityGeometryMap = map;
    this.lastEntityGeometryMapHash = this.currentMapHash;
    this.lastEntityGeometryScene = this.authoredSceneGeometry;
    startupTrace.span('gl.updateEntityGeometry',
      () => this.updateEntityGeometry(sprites, player, currentTime, map));
    this.updateSpriteGeometry(sprites, player, currentTime);
    startupTrace.span('gl.updateTextureAtlas', () => this.updateTextureAtlas(sprites, currentTime));
    return true;
  }

  updateEntityGeometry(sprites, player, currentTime, map = null) {
    this.geometryUploadStats.entityRebuilds++;
    if (this.deterministic === true) setEntityAnimationSteadyState(true);
    let result;
    try {
    result = buildEntityGeometry(sprites, player, currentTime, {
      enabled: this.entityMeshesEnabled,
      map,
      distances: this.entityLodDistances || undefined,
      lodHysteresis: this.entityLodTransition ? this.entityLodTransition.hysteresis : undefined,
      lodDissolveMs: this.entityLodTransition ? this.entityLodTransition.dissolveMs : undefined,
      content: this.entityContent,
      meshBuilder: this.entityMeshBuilder,
      extraTypes: this.entityMeshExtraTypes,
      specimenResolver: this.specimenResolver,
      colorResolver: (entity, sampleY, sampleX, char) => {
        const template = this.spriteTemplates.get(entity.type);
        return template ? template.getBaseColor(entity, sampleY, currentTime, sampleX, char) : null;
      }
    });
    } finally {
      setEntityAnimationSteadyState(false);
    }
    this.entityMeshEntities = result.convertedEntities;
    this.entityRenderStats = result.stats;
    this.entityVertexCount = result.vertexCount;

    if (result.vertexCount > 0) {
      this.uploadDynamicBuffer(this.entityVBO, result.vertices, 'entity');
    }
  }

  updateViewmodelGeometry(player, state, currentTime) {
    if (!this.viewmodelEnabled || typeof this.viewmodelBuilder !== 'function' || state?.enabled === false) {
      this.viewmodelVertexCount = 0;
      this.viewmodelPose = 'idle';
      this.viewmodelMotion = null;
      this.viewmodelTransform = null;
      this.viewmodelInstruments = null;
      this.viewmodelDrawRanges = null;
      return;
    }

    const result = this.viewmodelBuilder(player, state, currentTime, {
      renderHeight: this.height,
      simplified: this.width * this.height > 280000
    });
    if (!isValidViewmodelGeometry(result)) {
      this.viewmodelVertexCount = 0;
      this.viewmodelPose = 'idle';
      this.viewmodelMotion = null;
      this.viewmodelTransform = null;
      this.viewmodelInstruments = null;
      this.viewmodelDrawRanges = null;
      return;
    }
    this.viewmodelVertexCount = result.vertexCount;
    this.viewmodelPose = result.pose || 'custom';
    this.viewmodelMotion = result.motion || null;
    this.viewmodelTransform = normalizeViewmodelTransform(result.transform);
    this.viewmodelDrawRanges = normalizeViewmodelDrawRanges(result.drawRanges, result.vertexCount);
    this.viewmodelInstruments = result.instruments || null;
    if (result.vertexCount > 0) this.uploadViewmodelGeometry(result);

  }
  /** Draw optional articulation and restore shared entity shader state. */
  drawViewmodelGeometry(view, projection) {
    if (this.viewmodelVertexCount <= 0) return;
    const gl = this.gl;
    gl.useProgram(this.entityProgram);
    gl.uniformMatrix4fv(this.entityUniforms.view, false, view);
    gl.uniformMatrix4fv(this.entityUniforms.projection, false, projection);
    gl.uniform1f(this.entityUniforms.formShading, 0);
    gl.bindVertexArray(this.viewmodelVAO);
    try {
      if (this.viewmodelDrawRanges) {
        for (const range of this.viewmodelDrawRanges) {
          gl.uniformMatrix4fv(this.entityUniforms.model, false, range.transform);
          gl.drawArrays(gl.TRIANGLES, range.first, range.count);
        }
      } else {
        gl.uniformMatrix4fv(this.entityUniforms.model, false, this.viewmodelTransform || IDENTITY_MODEL_MATRIX);
        gl.drawArrays(gl.TRIANGLES, 0, this.viewmodelVertexCount);
      }
    } finally {
      gl.uniform1f(this.entityUniforms.formShading, 1);
      gl.uniformMatrix4fv(this.entityUniforms.model, false, IDENTITY_MODEL_MATRIX);
      gl.bindVertexArray(null);
    }
  }

  /**
   * The viewmodel VBO holds two ranges: the cached arm tier at offset zero and
   * the per-frame instrument overlay directly after it. The arm tier is what
   * used to be re-uploaded every frame - it now goes up only when the
   * articulation actually re-tessellated (or the buffer was re-allocated,
   * which discards it). The overlay is a few hundred vertices and only exists
   * while an instrument is raised.
   */
  uploadViewmodelGeometry(result) {
    const gl = this.gl;
    const armBytes = result.vertices.byteLength;
    const overlayBytes = result.overlayVertices ? result.overlayVertices.byteLength : 0;
    const requiredBytes = armBytes + overlayBytes;

    gl.bindBuffer(gl.ARRAY_BUFFER, this.viewmodelVBO);
    let capacity = this.dynamicBufferCapacities.viewmodel || 0;
    let reallocated = false;
    if (requiredBytes > capacity) {
      capacity = Math.max(1024, 2 ** Math.ceil(Math.log2(requiredBytes)));
      gl.bufferData(gl.ARRAY_BUFFER, capacity, gl.DYNAMIC_DRAW);
      this.dynamicBufferCapacities.viewmodel = capacity;
      reallocated = true;
    }
    if (armBytes > 0 && (reallocated || this.viewmodelUploadedArms !== result.vertices)) {
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, result.vertices);
      this.viewmodelUploadedArms = result.vertices;
    }
    if (overlayBytes > 0) {
      gl.bufferSubData(gl.ARRAY_BUFFER, armBytes, result.overlayVertices);
    }
  }

  updateSpriteGeometry(sprites, player, _currentTime) {
    if (!sprites || sprites.length === 0) {
      this.spriteVertexCount = 0;
      this.activeSpriteIndices = [];
      this.atlasBakeEntries = [];
      this.activeBillboardCount = 0;
      return;
    }

    const vertices = [];
    const addQuad = (p1, p2, p3, p4, n, u1, v1, u2, v2) => {
      vertices.push(...p1, ...n, u1, v1);
      vertices.push(...p2, ...n, u2, v1);
      vertices.push(...p3, ...n, u2, v2);
      vertices.push(...p1, ...n, u1, v1);
      vertices.push(...p3, ...n, u2, v2);
      vertices.push(...p4, ...n, u1, v2);
    };

    const px = player ? player.x : 0;
    const py = player ? player.y : 0;

    // Two lists with two jobs. activeSpriteIndices is the DRAW list: one
    // entry per accepted sprite, in exact lockstep with the quads addQuad
    // pushes, so the G-buffer loop's sequential 6-vertex draws pair each
    // entry with its own quad. atlasBakeEntries is the atlas manager's
    // list: static templates appear once per TYPE (their shared cell bakes
    // once), animated ones once per instance. Conflating the two drew the
    // wrong quads (and dropped the tail) whenever a static type had 2+
    // visible instances.
    this.activeSpriteIndices = [];
    this.atlasBakeEntries = [];
    // Static templates never animate, so every instance of a type shares one
    // atlas cell with a STABLE index - allocated once per type from the top
    // of the atlas downward. Without this, visibility-order indices shuffle
    // as sprites enter and leave the frustum and the per-cell redraw cache
    // never holds. Animated templates keep per-instance cells from the
    // bottom up, exactly as before.
    if (!this.staticTypeCellIndices) this.staticTypeCellIndices = new Map();
    const staticCellFloor = () => RENDERER_TOTAL_ATLAS_SLOTS - this.staticTypeCellIndices.size;
    const typesListedThisFrame = new Set();
    // Opt-in (setSpriteCellRecycling): cells are handed back instead of held.
    let pool = null;
    if (this.spriteCellRecycling === true) {
      if (!this.spriteCellPool || this.spriteCellPool.assignments !== this.staticTypeCellIndices) {
        this.spriteCellPool = new SpriteCellPool({
          firstCell: this.atlasLayout?.staticSlots ?? RENDERER_STATIC_ATLAS_SLOTS,
          totalCells: RENDERER_TOTAL_ATLAS_SLOTS,
          assignments: this.staticTypeCellIndices
        });
      }
      pool = this.spriteCellPool;
      pool.beginFrame();
    }

    let activeCount = 0;
    let instanceCellCursor = 0;
    for (let i = 0; i < sprites.length; i++) {
      const sprite = sprites[i];
      if (this.entityMeshEntities.has(sprite)) continue;
      // An entity may name the sprite template its billboard draws with
      // (`billboard` — the facade routes a mesh entity's per-entity `sprite`
      // here, so a beyond-LOD fallback can be state-chosen). An absent or
      // unregistered name falls back to the type lookup, which is every
      // direct consumer's path, byte-identical.
      const templateType = sprite.billboard !== undefined && sprite.billboard !== null
        && this.spriteTemplates.has(sprite.billboard)
        ? sprite.billboard
        : sprite.type;
      const template = this.spriteTemplates.get(templateType);
      if (!template) continue;

      if (sprite.type === 'escape_hatch' && !sprite.active) {
        continue;
      }

      const sizeScale = sprite.sizeScale !== undefined ? sprite.sizeScale : template.sizeScale;
      const zOffset = sprite.zOffset !== undefined ? sprite.zOffset : template.zOffset;
      const aspect = sprite.aspect !== undefined ? sprite.aspect : template.aspect;

      const hw = 0.5 * sizeScale * aspect;
      const hh = 0.5 * sizeScale;

      // Floor art occupies an area around its center. A center-only test drops
      // the entire rug when walking over it or looking past one edge. Use its
      // bounding circle for conservative culling; the GPU clips the quad.
      // Upright bounds include their width and the existing wall-face offset;
      // their actual quad is tested against the camera frustum below.
      const radius = template.plane === 'flat' || template.plane === 'camera' ? Math.hypot(hw, hh)
        : template.plane === 'upright' ? Math.abs(hw) + 0.02 : 0;
      const dx = sprite.x - px;
      const dy = sprite.y - py;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist < 0.1 && template.plane === 'billboard') continue;

      // 1. Distance culling, just inside the far plane so a sprite fades into
      // fog rather than popping at the projection boundary.
      if (dist - radius > Math.max(25.0, this.maxDepth * 0.92)) continue;

      // 2. Preserve the existing flat/billboard view-cone tests. Upright
      // signs use their drawn corners and the actual projection below. The
      // cone is horizontal, which is wrong for a camera looking steeply down or
      // rolled, so free cameras skip it and leave clipping to the GPU.
      if (player && !isFreeCamera(player) && template.plane !== 'upright' && template.plane !== 'camera') {
        const dirX = Math.cos(player.angle);
        const dirY = Math.sin(player.angle);
        
        // Perpendicular distance along look vector (positive if in front of player)
        const perpDist = dx * dirX + dy * dirY;
        const halfFov = (player.fov || (Math.PI / 3)) * 1.35 * 0.5;
        if (template.plane === 'flat') {
          if (perpDist < -radius) continue;
          const sideDist = Math.abs(dx * dirY - dy * dirX);
          // Signed distance to the nearest side of the horizontal view cone.
          if (sideDist * Math.cos(halfFov) - perpDist * Math.sin(halfFov) > radius) continue;
        } else {
          if (perpDist <= 0) continue;
          if (perpDist / dist < Math.cos(halfFov)) continue;
        }
      }

      // Calculate camera-facing billboard plane
      const hx = dist > 0 ? -dy / dist : 0;
      const hy = dist > 0 ? dx / dist : 0;


      const cx = sprite.x;
      const cy = sprite.y;
      // WHERE ON THE QUAD THE SPRITE'S z LANDS.
      //
      // Historically, always the CENTRE. That is right for a billboard whose
      // z was authored as "where the middle of this thing is" — which is
      // every direct renderer consumer, and the reason the default template
      // zOffset of 0 works: renderer z points down with the floor at +0.5, so
      // a unit-tall sprite centred on 0 has its bottom edge exactly on the
      // floor.
      //
      // It is WRONG for a mesh entity's beyond-LOD fallback. A mesh entity's
      // z is its ground contact — the facade lifts the mesh by
      // (z - floorHeight), and every archetype is authored with its own
      // bottom on that plane — so centring the billboard on it buried half of
      // every grounded prop under the floor. Anchoring at the feet puts the
      // quad's bottom edge on the entity's z, which is the same plane the
      // mesh it replaces stands on.
      //
      // Opt-in per sprite, and only prepareMeshEntities ever sets it, so
      // Liminal's rigs — which write these sprite objects themselves and
      // never carry the field — keep the centre anchor bit-identically. Flat
      // quads are excluded: they are ground-plane art already, with no
      // vertical extent to anchor.
      const feetAnchored = sprite.billboardFeetAnchor === true && template.plane !== 'flat';
      const cz = feetAnchored ? zOffset - hh : zOffset;

      let p1, p2, p3, p4, n;
      if(template.plane==='camera') {
        ({p1,p2,p3,p4,n}=cameraSpriteQuad([cx,cy,cz],hw,hh,player?.angle||0,
          (player?.pitch||0)/this.height*(player?.fov||Math.PI/3),
          isFreeCamera(player) && Number.isFinite(player.roll) ? player.roll : 0));
      } else if (template.plane === 'flat') {
        // Horizontal quad at the sprite's z, lifted 0.02 world units off the
        // surface below so it never z-fights the floor plane. Renderer z
        // points down, so the lift subtracts. Art top row (v = vMin) faces
        // -y. The normal points up ([0,0,-1] in this z-down world): the
        // camera is always above the floor, and the deferred diffuse term
        // (dot(N, L)) would black the quad under every overhead light if it
        // faced down. Like camera-facing billboards, flat quads live in the
        // sprite VBO, which the flashlight shadow pass never draws.
        const fz = cz - 0.02;
        p1 = [cx - hw, cy - hh, fz];
        p2 = [cx + hw, cy - hh, fz];
        p3 = [cx + hw, cy + hh, fz];
        p4 = [cx - hw, cy + hh, fz];
        n = [0, 0, -1];
      } else if (template.plane === 'upright') {
        // UPRIGHT, HEADING-LOCKED. A vertical quad that faces a fixed world
        // direction instead of the camera — the mode a sign bolted to a facade
        // needs, because a camera-facing one swivels to track the player and
        // reads as a cardboard cutout hovering off the wall.
        //
        // `heading` is the direction the FACE points: its outward normal. 0
        // faces +x, positive turns toward +y, which is the same convention
        // mesh entities and camera.yaw already use, so a game that already
        // computes a wall normal has nothing to convert.
        const heading = sprite.heading !== undefined ? sprite.heading : template.heading;
        const nx = Math.cos(heading);
        const ny = Math.sin(heading);
        // The quad's horizontal axis is the normal turned -90 degrees. That
        // handedness is not arbitrary: it is the one for which a sign viewed
        // head-on carries EXACTLY the left/right orientation the camera-facing
        // billboard would have carried at the same spot, so switching a
        // template to 'upright' never mirrors its art.
        const ux = ny;
        const uy = -nx;
        // Nudged 0.02 out along the normal, the same offset (and the same
        // reason) as the flat plane's lift off the floor: a sign authored
        // exactly in its wall's plane would z-fight it.
        const ox = nx * 0.02;
        const oy = ny * 0.02;
        p1 = [cx - ux * hw + ox, cy - uy * hw + oy, cz - hh];
        p2 = [cx + ux * hw + ox, cy + uy * hw + oy, cz - hh];
        p3 = [cx + ux * hw + ox, cy + uy * hw + oy, cz + hh];
        p4 = [cx - ux * hw + ox, cy - uy * hw + oy, cz + hh];
        n = [nx, ny, 0];
      } else {
        // Camera-facing billboard: Bottom-Left, Bottom-Right, Top-Right, Top-Left
        p1 = [cx - hx * hw, cy - hy * hw, cz - hh];
        p2 = [cx + hx * hw, cy + hy * hw, cz - hh];
        p3 = [cx + hx * hw, cy + hy * hw, cz + hh];
        p4 = [cx - hx * hw, cy - hy * hw, cz + hh];
        n = [-dx / dist, -dy / dist, 0];
      }

      if ((template.plane === 'upright' || template.plane === 'camera')
        && quadOutsideFrustum(p1, p2, p3, p4, this.lastView, this.lastProjection)) continue;

      // Rows 0-1 are reserved for static world materials. Atlas cells key on
      // the TEMPLATE name, not the entity type, so two mesh uses sharing a
      // fallback sprite share one cell (templateType === sprite.type for
      // everything that predates `billboard`).
      let cellIdx;
      if (pool !== null) {
        if (template.static === true) {
          cellIdx = pool.claimStatic(templateType);
          if (cellIdx < 0) continue;
          if (!typesListedThisFrame.has(templateType)) {
            typesListedThisFrame.add(templateType);
            this.atlasBakeEntries.push({ sprite, atlasIndex: cellIdx, templateType });
          }
          this.activeSpriteIndices.push({ sprite, atlasIndex: cellIdx, templateType });
        } else {
          cellIdx = pool.claimInstance();
          if (cellIdx < 0) continue;
          const entry = { sprite, atlasIndex: cellIdx, templateType };
          this.atlasBakeEntries.push(entry);
          this.activeSpriteIndices.push(entry);
        }
      } else if (template.static === true) {
        cellIdx = this.staticTypeCellIndices.get(templateType);
        if (cellIdx === undefined) {
          cellIdx = RENDERER_TOTAL_ATLAS_SLOTS - 1 - this.staticTypeCellIndices.size;
          if (cellIdx < (this.atlasLayout?.staticSlots ?? RENDERER_STATIC_ATLAS_SLOTS) + instanceCellCursor) continue;
          this.staticTypeCellIndices.set(templateType, cellIdx);
        }
        if (!typesListedThisFrame.has(templateType)) {
          typesListedThisFrame.add(templateType);
          this.atlasBakeEntries.push({ sprite, atlasIndex: cellIdx, templateType });
        }
        this.activeSpriteIndices.push({ sprite, atlasIndex: cellIdx, templateType });
      } else {
        cellIdx = (this.atlasLayout?.staticSlots ?? RENDERER_STATIC_ATLAS_SLOTS) + instanceCellCursor;
        if (cellIdx >= staticCellFloor()) continue;
        instanceCellCursor++;
        const entry = { sprite, atlasIndex: cellIdx, templateType };
        this.atlasBakeEntries.push(entry);
        this.activeSpriteIndices.push(entry);
      }

      const col = cellIdx % RENDERER_ATLAS_COLUMNS;
      const row = Math.floor(cellIdx / RENDERER_ATLAS_COLUMNS);

      let uMin = (col * this.cellSize) / this.atlasSize;
      let uMax = ((col + 1) * this.cellSize) / this.atlasSize;
      const vMin = (row * this.cellSize) / this.atlasSize;
      const vMax = ((row + 1) * this.cellSize) / this.atlasSize;
      // Opt-in mirror (setSpriteMirroring): swapping the u range flips the
      // image on the quad. The shading normal is the quad's, so lighting is
      // unchanged.
      if (this.spriteMirroring === true && sprite.mirror === true) [uMin, uMax] = [uMax, uMin];

      // Map V coordinates correctly without double-flipping, passing vMin as top and vMax as bottom to render upright
      addQuad(p1, p2, p3, p4, n, uMin, vMin, uMax, vMax);

      activeCount++;
      // With recycling the limit is cells, which the pool already enforces.
      if (pool === null && activeCount >= (this.atlasLayout?.maxBillboards ?? RENDERER_MAX_BILLBOARDS)) break;
    }

    if (vertices.length > 0) {
      this.uploadDynamicBuffer(this.spriteVBO, new Float32Array(vertices), 'sprite');
      this.spriteVertexCount = vertices.length / 8;
    } else {
      this.spriteVertexCount = 0;
    }
  }

  /**
   * Opt in to merit-based volumetric slot selection (intensity x proximity
   * past the 8-slot cap). Off = the historical first-8 positional cap; the
   * facade opts in for its scenes, direct consumers stay bit-identical.
   */
  setVolumetricMeritSelection(enabled) {
    this.volumetricMeritSelection = enabled === true;
    return this;
  }

  updateTextureAtlas(sprites, currentTime) {
    this.activeBillboardCount = this.activeSpriteIndices.length;
    this.atlasManager.updateTextureAtlas(this.atlasBakeEntries || this.activeSpriteIndices, currentTime);
  }

  project(x, y, z) {
    if (!this.lastView || !this.lastProjection) return null;
    return projectPoint(x, y, z, this.lastView, this.lastProjection);
  }

  compile(_rayFrame, sprites = [], player = null, _ctx = null, charWidth = 0, charHeight = 0, _fontSize = 12, batteryFactor = 1.0, glitchFactor = 0.0, playTime = 0.0, viewmodelState = null) {
    this.assertOperational();
    const gl = this.gl;

    // Calculate view and projection matrices first so they are available for 2D overlay projection
    const cellRatio = (charWidth && charHeight) ? (charHeight / charWidth) : 1.714;
    const aspect = (this.width / this.height) / cellRatio;
    const playerFov = player ? player.fov : Math.PI / 3;
    const viewProj = player ? Mat4.perspective(playerFov, aspect, 0.05, this.maxDepth, this.projectionMatrix) : null;
    
    let view = null;
    let lookX = 0.0;
    let lookY = 0.0;
    let lookZ = 0.0;
    if (player) {
      const pitchAngle = player.pitch ? (player.pitch / this.height) * playerFov : 0.0;
      lookX = Math.cos(player.angle) * Math.cos(pitchAngle);
      lookY = Math.sin(player.angle) * Math.cos(pitchAngle);
      lookZ = Math.sin(pitchAngle);
      
      const cameraZ = Number.isFinite(player.cameraZ) ? player.cameraZ : 0.0;
      const eye = this.cameraEye;
      eye[0] = player.x; eye[1] = player.y; eye[2] = cameraZ;
      const center = this.cameraCenter;
      if (isFreeCamera(player)) {
        // Free cameras (opt-in: roll, or free: true on the facade camera) take
        // their up axis from the camera itself, so straight down, straight up,
        // past vertical and rolled views are all well defined. Everyone else
        // keeps the fixed world-up lookAt below, bit for bit.
        const basis = cameraBasis(player.angle, pitchAngle, Number.isFinite(player.roll) ? player.roll : 0);
        lookX = basis.forward[0]; lookY = basis.forward[1]; lookZ = basis.forward[2];
        center[0] = player.x + lookX; center[1] = player.y + lookY; center[2] = cameraZ + lookZ;
        view = Mat4.lookAt(eye, center, basis.up, this.viewMatrix);
      } else {
        center[0] = player.x + lookX; center[1] = player.y + lookY; center[2] = cameraZ + lookZ;
        view = Mat4.lookAt(eye, center, this.cameraUp, this.viewMatrix);
      }
    }

    this.lastView = view;
    this.lastProjection = viewProj;

    // Developer capture tools may provide a fixed scene clock. Normal gameplay
    // omits this value and continues to use the live monotonic clock.
    const currentTime = Number.isFinite(viewmodelState?.renderTimeMs)
      ? viewmodelState.renderTimeMs
      : performance.now();

    if (!player) return;

    // 2. Build Scene VBOs (Walls, floors, ceilings, billboards) and dynamic texture atlas
    //
    // The build-and-upload stages carry startup brackets because they are the
    // ones whose first call does work every later call skips, and that is the
    // shape a startup freeze has. The atlas bake below was 860ms of a 1.0s one
    // and was invisible until it was bracketed. StartupTrace drops any span
    // under 20ms, so an ordinary frame records nothing.
    const map = player.map || null;
    // The grid the world is DRAWN from, which is allowed to lag the grid it
    // collides on for the length of a phase dissolve and at no other time. Only
    // the static mesh reads it: lighting, entities and reactive surfaces stay on
    // the collision grid, so what the room does still matches what it is.
    //
    // This is what keeps a shift at ONE static rebuild, the count it has always
    // had. Both dimensions differ only in their bulkheads, so drawing from the
    // Void grid for the dissolve means the outbound shift rebuilds at the
    // keypress and the inbound one rebuilds when the dissolve lands - never
    // both.
    const drawnMap = player.renderMap || map;
    if (drawnMap) {
      startupTrace.span('gl.updateSceneGeometry', () => this.updateSceneGeometry(drawnMap));
    }
    this.updateDynamicSceneGeometry();
    // The first-person arms sit close to the camera, where the 30 Hz world
    // geometry throttle is visibly stepped. Keep their animation synchronized
    // with the display frame while retaining the heavier scene/entity throttle.
    this.updateViewmodelGeometry(player, viewmodelState || {}, currentTime);
    this.updateThrottledEntityGeometry(sprites, player, currentTime, map);
    const activeLights = this.activeLightsScratch;
    activeLights.length = 0;
    // Authored lights claim their slots first. Emissive fixtures are marked
    // cullable and compete for whatever is left, because the flame budget alone
    // can reach FACILITY_MAX_LIGHT_FIXTURES (30) against MAX_LIGHTS of 41.
    //
    // Lights with castsShadows === false are moving lights (a drone's lamp, a
    // weapon flash). They are appended AFTER every shadow-casting light so the
    // visibility-atlas layer indices line up with the light slots, and they are
    // excluded from the atlas fingerprint - a moving light must never thrash
    // the CPU visibility bake, whose rebuild is a loading-screen-class cost.
    let cullableCandidates = null;
    let dynamicLights = null;
    for (let i = 0; i < this.lights.length; i++) {
      const light = this.lights[i];
      if (light.active === false) continue;
      if (light.castsShadows === false) {
        if (dynamicLights === null) dynamicLights = [];
        dynamicLights.push(light);
      } else if (light.cullable) {
        if (cullableCandidates === null) cullableCandidates = [];
        cullableCandidates.push(light);
      } else if (activeLights.length < MAX_LIGHTS) {
        activeLights.push(light);
      }
    }
    if (cullableCandidates !== null) {
      this.appendCullableLights(activeLights, cullableCandidates, player);
    }
    const shadowLights = this.shadowLightsScratch;
    shadowLights.length = 0;
    for (let i = 0; i < activeLights.length; i++) shadowLights.push(activeLights[i]);
    if (dynamicLights !== null) {
      for (let i = 0; i < dynamicLights.length && activeLights.length < MAX_LIGHTS; i++) {
        activeLights.push(dynamicLights[i]);
      }
    }
    startupTrace.span('gl.updateLightVisibilityAtlas',
      () => this.updateLightVisibilityAtlas(map, shadowLights));
    this.updateEnvironmentalEffects(map, shadowLights, player);
    this.updateReactiveSurfaces(map, player);

    // 3. Matrix Math Uniforms (already calculated at start of compile())

    // ----------------------------------------------------
    // PASS 1: Geometry Rendering Pass -> Write to G-Buffer FBO
    // ----------------------------------------------------
    // ----------------------------------------------------
    // PASS 0: Flashlight shadow depth -> shadowFBO
    // ----------------------------------------------------
    const shadowFlashlightPlayer = viewmodelState?.flashlightPlayer || player;
    const shadowFlashlight = resolveFlashlightProjection(
      shadowFlashlightPlayer,
      this.height,
      this.viewmodelMotion
    );
    this.renderFlashlightShadow(
      shadowFlashlight,
      this.flashlightShadowsEnabled && !!shadowFlashlightPlayer.flashlightOn
    );

    this.configureVisibilityCellTarget(map);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.gbufFBO);
    gl.viewport(0, 0, this.sceneWidth, this.sceneHeight);
    gl.enable(gl.DEPTH_TEST);
    gl.depthMask(true);

    // Mixed float/integer attachments require clears matching each data type.
    gl.clearBufferfv(gl.COLOR, 0, GBUFFER_CLEAR_FLOAT);
    gl.clearBufferfv(gl.COLOR, 1, GBUFFER_CLEAR_FLOAT);
    gl.clearBufferfv(gl.COLOR, 2, GBUFFER_CLEAR_FLOAT);
    gl.clearBufferuiv(gl.COLOR, 3, GBUFFER_CLEAR_UINT);
    gl.clear(gl.DEPTH_BUFFER_BIT);

    gl.useProgram(this.geomProgram);
    gl.uniformMatrix4fv(this.geomUniforms.view, false, view);
    gl.uniformMatrix4fv(this.geomUniforms.projection, false, viewProj);
    
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.diffuseTexture);
    gl.uniform1i(this.geomUniforms.diffuseTexture, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.materialTexture);
    gl.uniform1i(this.geomUniforms.materialTexture, 1);


    // 1a. Draw Walls, Floors, Ceilings
    gl.uniform1f(this.geomUniforms.selfLuminous, 0.0);
    gl.uniform1f(this.geomUniforms.isSprite, 0.0);
    // Set every frame rather than once: the facility must never inherit a
    // dissolve from the draw call after it, and a program keeps its uniforms.
    gl.uniform1f(this.geomUniforms.dissolve, 1.0);
    gl.uniform1i(this.geomUniforms.visibilityCellsEnabled, this.geometryVisibilityMapWidth > 0 && this.geometryVisibilityMapWidth === this.lightVisibilityMapWidth && this.geometryVisibilityMapHeight === this.lightVisibilityMapHeight ? 1 : 0);
    gl.bindVertexArray(this.geometryVAO);
    gl.drawArrays(gl.TRIANGLES, 0, this.geometryVertexCount);

    // 1b. Draw dynamic architecture without rebuilding the static environment.
    if (this.dynamicGeometryVertexCount > 0) {
      gl.bindVertexArray(this.dynamicGeometryVAO);
      gl.drawArrays(gl.TRIANGLES, 0, this.dynamicGeometryVertexCount);
    }

    // 1b-ii. Draw the bulkheads a phase shift is resolving, at whatever is left
    // of their own surface. The static mesh above is drawn from the Void grid
    // for the length of the dissolve, so this is the only call that carries
    // them and nothing is drawn twice.
    if (this.phaseGeometryVertexCount > 0 && this.phaseDissolveAmount > 0) {
      gl.uniform1f(this.geomUniforms.dissolve, this.phaseDissolveAmount);
      gl.uniform1i(this.geomUniforms.visibilityCellsEnabled, this.phaseVisibilityMapWidth > 0 && this.phaseVisibilityMapWidth === this.lightVisibilityMapWidth && this.phaseVisibilityMapHeight === this.lightVisibilityMapHeight ? 1 : 0);
      gl.bindVertexArray(this.phaseGeometryVAO);
      gl.drawArrays(gl.TRIANGLES, 0, this.phaseGeometryVertexCount);
      gl.uniform1f(this.geomUniforms.dissolve, 1.0);
    }
    gl.uniform1i(this.geomUniforms.visibilityCellsEnabled, 0);

    // 1c. Draw procedural entity meshes with true depth and stable emissive form shading.
    if (this.entityVertexCount > 0) {
      gl.useProgram(this.entityProgram);
      gl.uniformMatrix4fv(this.entityUniforms.view, false, view);
      gl.uniformMatrix4fv(this.entityUniforms.projection, false, viewProj);
      gl.uniformMatrix4fv(this.entityUniforms.model, false, IDENTITY_MODEL_MATRIX);
      // World geometry is sculpted by its own world normals, as it always was.
      gl.uniform1f(this.entityUniforms.formShading, 1.0);
      gl.bindVertexArray(this.entityVAO);
      gl.drawArrays(gl.TRIANGLES, 0, this.entityVertexCount);

      gl.useProgram(this.geomProgram);
      gl.uniformMatrix4fv(this.geomUniforms.view, false, view);
      gl.uniformMatrix4fv(this.geomUniforms.projection, false, viewProj);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.diffuseTexture);
      gl.uniform1i(this.geomUniforms.diffuseTexture, 0);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, this.materialTexture);
      gl.uniform1i(this.geomUniforms.materialTexture, 1);
    }

    // 1d. Draw Billboard Sprites (some may be self-luminous)
    if (this.spriteVertexCount > 0) {
      gl.bindVertexArray(this.spriteVAO);
      gl.uniform1f(this.geomUniforms.isSprite, 1.0);
      
      // AN UPRIGHT SPRITE HAS A BACK, and until this it did not.
      //
      // `plane: 'upright'` builds a quad facing a FIXED world direction, and
      // that half works exactly as designed - the quad is bit-identical from
      // every camera angle, verified against the live vertex buffer. But
      // CULL_FACE is enabled in precisely one place in this renderer, the
      // flashlight shadow depth pass, and disabled again at its end, so the
      // G-buffer drew every upright quad from BOTH sides with the same lit
      // art.
      //
      // A sign you can read from behind is a sign with no back, and a
      // zero-thickness rectangle with no back is indistinguishable from one
      // that turned to follow you - which is exactly how it was reported:
      // "a flat poster that turns to face me still". Walk through its plane
      // and it reads face-on, edge-on, face-on again.
      //
      // ONLY UPRIGHT QUADS. Flat decals are meant to be seen from above and
      // below, and camera-facing billboards can never present their back by
      // construction, so both keep their current behaviour byte-for-byte -
      // the state is toggled per run of upright sprites and restored after
      // the loop.
      let vertexOffset = 0;
      let culling = false;
      for (let i = 0; i < this.activeSpriteIndices.length; i++) {
        const { sprite, templateType } = this.activeSpriteIndices[i];
        const template = this.spriteTemplates.get(templateType !== undefined ? templateType : sprite.type);
        const selfLuminous = template && template.isSelfLuminous(sprite, 0.5) ? 1.0 : 0.0;
        const wantsCull = Boolean(template && template.plane === 'upright');
        if (wantsCull !== culling) {
          // FRONT, NOT BACK, and the sign of this is not a guess.
          //
          // The upright quad's horizontal axis is the normal turned -90
          // (`ux = ny, uy = -nx`), and with the vertex order addQuad emits,
          // cross(p2-p1, p3-p1) works out to exactly `-4 * hh * hw * n` for
          // ANY heading - the winding normal is the OPPOSITE of the declared
          // shading normal. So GL's front face is the sign's BACK, and
          // culling BACK would have culled the side the player reads.
          //
          // That would have shipped as "the sign disappeared", which is a
          // worse bug than the one being fixed, and it is invisible in a test
          // that only checks the flag is set.
          if (wantsCull) { gl.enable(gl.CULL_FACE); gl.cullFace(gl.FRONT); }
          else gl.disable(gl.CULL_FACE);
          culling = wantsCull;
        }

        // 0 = geometry, 1 = ordinary sprite, 2 = authored screen pixels.
        gl.uniform1f(this.geomUniforms.isSprite, template?.preserveArt ? 2.0 : 1.0);
        gl.uniform1f(this.geomUniforms.selfLuminous, selfLuminous);
        gl.drawArrays(gl.TRIANGLES, vertexOffset, 6);
        vertexOffset += 6;
      }
      if (culling) gl.disable(gl.CULL_FACE);
    }

    // 1e. Draw the local operative last in the G-buffer. It is real geometry,
    // not a HUD layer, so it receives scene lighting and ASCII treatment while
    // the depth buffer naturally keeps it in front of the world.
    this.drawViewmodelGeometry(view, viewProj);
    gl.bindVertexArray(null);

    // ----------------------------------------------------
    // PASS 2: Lighting shading pass -> Write to lightFBO
    // ----------------------------------------------------
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.lightFBO);
    gl.viewport(0, 0, this.sceneWidth, this.sceneHeight);
    gl.disable(gl.DEPTH_TEST);
    gl.depthMask(false);

    gl.useProgram(this.lightProgram);

    // Bind G-Buffer outputs as input textures
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.gbufNormal);
    gl.uniform1i(this.lightUniforms.gbufNormal, 0);

    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.gbufPosition);
    gl.uniform1i(this.lightUniforms.gbufDepthLuma, 1);

    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, this.gbufAlbedo);
    gl.uniform1i(this.lightUniforms.gbufAlbedo, 2);

    gl.activeTexture(gl.TEXTURE5);
    gl.bindTexture(gl.TEXTURE_2D, this.gbufVisibilityCell);
    gl.uniform1i(this.lightUniforms.gbufVisibilityCell, 5);

    gl.activeTexture(gl.TEXTURE3);
    gl.bindTexture(gl.TEXTURE_2D, this.lightVisibilityTexture);
    gl.uniform1i(this.lightUniforms.lightVisibility, 3);
    gl.uniform2i(this.lightUniforms.lightVisibilityMapSize, this.lightVisibilityMapWidth, this.lightVisibilityMapHeight);
    gl.uniform1i(this.lightUniforms.lightVisibilityLayerCount, this.lightVisibilityLayerCount);
    gl.uniform1i(this.lightUniforms.castShadowsEnabled, this.atmosphere.contactShadows ? 1 : 0);
    gl.uniform1f(this.lightUniforms.shadowFloor, this.atmosphere.shadowFloor);

    // Bind player/camera uniforms
    const cameraZ = Number.isFinite(player.cameraZ) ? player.cameraZ : 0.0;
    gl.uniform3f(this.lightUniforms.cameraPos, player.x, player.y, cameraZ);
    // Retained for the bloom prefilter, which needs the same eye position to
    // reject the viewmodel from the bright pass.
    this.lastCameraPos = [player.x, player.y, cameraZ];
    const flashlightPlayer = viewmodelState?.flashlightPlayer || player;
    const flashlight = resolveFlashlightProjection(flashlightPlayer, this.height, this.viewmodelMotion);
    gl.uniform3fv(this.lightUniforms.flashlightOrigin, flashlight.origin);
    gl.uniform3fv(this.lightUniforms.flashlightDir, flashlight.direction);
    gl.uniform1i(this.lightUniforms.flashlightOn, flashlightPlayer.flashlightOn ? 1 : 0);
    gl.activeTexture(gl.TEXTURE4);
    gl.bindTexture(gl.TEXTURE_2D, this.shadowTexture);
    gl.uniform1i(this.lightUniforms.flashlightShadowMap, 4);
    gl.uniformMatrix4fv(this.lightUniforms.flashlightViewProjection, false, this.shadowViewProjection);
    gl.uniform1i(this.lightUniforms.flashlightShadowsEnabled, this.flashlightShadowsActive ? 1 : 0);
    gl.uniform2f(
      this.lightUniforms.shadowTexelSize,
      1 / this.shadowMapSize,
      1 / this.shadowMapSize
    );
    gl.uniform1f(this.lightUniforms.shadowNormalBias, this.shadowNormalBias);
    gl.uniform1f(this.lightUniforms.shadowDepthBias, this.shadowDepthBias);
    gl.uniform1f(this.lightUniforms.batteryFactor, batteryFactor);
    gl.uniform1f(this.lightUniforms.flashlightHorizontalOuterTan, flashlight.horizontalOuterTan);
    gl.uniform1f(this.lightUniforms.flashlightVerticalOuterTan, flashlight.verticalOuterTan);
    gl.uniform1f(this.lightUniforms.flashlightRange, flashlight.range);
    gl.uniform1i(this.lightUniforms.contactShadowsEnabled, this.atmosphere.contactShadows ? 1 : 0);
    gl.uniform1i(this.lightUniforms.aoStep, this.sceneContract.sceneScale);
    gl.uniform1f(this.lightUniforms.ambientOcclusionStrength, this.atmosphere.ambientOcclusionStrength);
    gl.uniform1f(this.lightUniforms.ambientFactor, this.atmosphere.ambientFactor);
    gl.uniform1f(this.lightUniforms.lowLightAdaptation, this.atmosphere.lowLightAdaptation);
    // 1 / 0 = the historical perceptual shadow floor with no extra dim-band
    // recovery. Resolved profiles that predate these two fields still land
    // here, because the resolver defaults them.
    gl.uniform1f(this.lightUniforms.visibilityFloor,
      Number.isFinite(this.atmosphere.visibilityFloor) ? this.atmosphere.visibilityFloor : 1);
    gl.uniform1f(this.lightUniforms.shadowLift,
      Number.isFinite(this.atmosphere.shadowLift) ? this.atmosphere.shadowLift : 0);
    gl.uniform3fv(this.lightUniforms.shadowTint, this.atmosphere.shadowTint);
    gl.uniform1f(this.lightUniforms.specularStrength, this.atmosphere.specularStrength);
    gl.uniform1f(this.lightUniforms.emissiveIntensity, this.atmosphere.emissiveIntensity);
    gl.uniform1f(this.lightUniforms.viewmodelRadius, VIEWMODEL_BLOOM_EXCLUDE_RADIUS);
    // The shadow floor is authored in display luminance and divides this out.
    gl.uniform1f(this.lightUniforms.toneExposure, this.atmosphere.exposure);
    gl.uniform3fv(this.lightUniforms.fogColor, this.atmosphere.fogColor);
    gl.uniform1f(this.lightUniforms.fogDensity, this.atmosphere.fogDensity);
    gl.uniform1f(this.lightUniforms.fogHeightFalloff, this.atmosphere.fogHeightFalloff);
    gl.uniform1f(this.lightUniforms.fogDither, this.atmosphere.fogDither);
    gl.uniform1i(this.lightUniforms.fogPlanar, this.atmosphere.fogPlanar === true ? 1 : 0);
    const skyOn = this.atmosphere.skyEnabled === true && view !== null;
    gl.uniform1i(this.lightUniforms.skyEnabled, skyOn ? 1 : 0);
    if (skyOn) {
      gl.uniform1f(this.lightUniforms.starDensity, this.atmosphere.starDensity);
      gl.uniform1f(this.lightUniforms.starBrightness, this.atmosphere.starBrightness);
      gl.uniform1f(this.lightUniforms.skylineStrength, this.atmosphere.skylineStrength);
      gl.uniform1f(this.lightUniforms.skylineSeed, this.atmosphere.skylineSeed);
      gl.uniform3fv(this.lightUniforms.skyTopColor, this.atmosphere.skyTopColor);
      gl.uniform3fv(this.lightUniforms.skyHorizonColor, this.atmosphere.skyHorizonColor);
      gl.uniform3fv(this.lightUniforms.skyGlowColor, this.atmosphere.skyGlowColor);
      gl.uniform2f(
        this.lightUniforms.skyGlowDir,
        Math.cos(this.atmosphere.skyGlowAzimuth),
        Math.sin(this.atmosphere.skyGlowAzimuth)
      );
      gl.uniform1f(this.lightUniforms.skyGlowStrength, this.atmosphere.skyGlowStrength);
      gl.uniform1f(this.lightUniforms.skyGlowSharpness, this.atmosphere.skyGlowSharpness);
      // The camera frustum basis, premultiplied so the shader reconstructs a
      // fragment's world ray with two multiply-adds. The view matrix columns
      // hold the camera axes; forward is the negated z axis.
      const tanV = Math.tan(playerFov * 0.5);
      const tanH = tanV * aspect;
      gl.uniform3f(this.lightUniforms.skyCameraForward, -view[2], -view[6], -view[10]);
      gl.uniform3f(this.lightUniforms.skyCameraRight, view[0] * tanH, view[4] * tanH, view[8] * tanH);
      gl.uniform3f(this.lightUniforms.skyCameraUp, view[1] * tanV, view[5] * tanV, view[9] * tanV);
    }
    gl.uniform1i(this.lightUniforms.environmentalFxEnabled, this.atmosphere.environmentalFx ? 1 : 0);
    gl.uniform1f(this.lightUniforms.volumetricStrength, this.atmosphere.volumetricStrength);
    const fogVolumeCount = Math.min(MAX_FOG_VOLUMES, this.environmentalFogVolumes.length);
    gl.uniform1i(this.lightUniforms.numFogVolumes, fogVolumeCount);
    for (let i = 0; i < fogVolumeCount; i++) {
      const volume = this.environmentalFogVolumes[i];
      const uniforms = this.lightUniforms.fogVolumes[i];
      gl.uniform3f(uniforms.position, volume.x, volume.y, volume.z);
      gl.uniform3fv(uniforms.color, volume.color);
      gl.uniform1f(uniforms.radius, volume.radius);
      gl.uniform1f(uniforms.density, volume.density);
    }
    gl.uniform1f(this.lightUniforms.time, currentTime);

    const portal = this.sceneState.portal;
    const hasPortal = Boolean(portal && Number.isFinite(portal.x) && Number.isFinite(portal.y));
    const portalX = hasPortal ? portal.x : 0.0;
    const portalY = hasPortal ? portal.y : 0.0;
    const portalColor = Array.isArray(portal?.color) ? portal.color : [0.0, 220.0 / 255.0, 1.0];
    gl.uniform1i(this.lightUniforms.hasPortal, hasPortal ? 1 : 0);
    if (hasPortal) {
      gl.uniform2f(this.lightUniforms.portalPos, portalX, portalY);
      gl.uniform3f(this.lightUniforms.portalColor, portalColor[0], portalColor[1], portalColor[2]);
      gl.uniform1f(this.lightUniforms.portalRange, Number.isFinite(portal.range) ? portal.range : 4.5);
    }

    // Dynamic dynamic point lights allocation
    let activeLightCount = 0;
    for (let i = 0; i < activeLights.length; i++) {
      const light = activeLights[i];
      // A flame with no z of its own hangs at the fixture band, a fixed drop
      // below the ceiling — anchored there so a raised ceiling lifts the light
      // with the sprite it belongs to (0.38 below -0.5 is the historical -0.12).
      const lightZ = Number.isFinite(light.z) ? light.z : 0.0;
      const intensity = 1.2 * (light.currentIntensity !== undefined ? light.currentIntensity : 1.0);
      const projected = resolveProjectedLight({ ...light, z: lightZ });

      const uLight = this.lightUniforms.lights[activeLightCount];
      gl.uniform3f(uLight.position, light.x, light.y, lightZ);
      gl.uniform3f(uLight.color, light.r / 255.0, light.g / 255.0, light.b / 255.0);
      gl.uniform1f(uLight.range, light.range);
      gl.uniform1f(uLight.intensity, intensity);
      gl.uniform1f(uLight.floorInfluence, projected.floorInfluence);
      gl.uniform1f(uLight.volumetricInfluence, projected.volumetricInfluence);
      gl.uniform3fv(uLight.direction, projected.direction);
      gl.uniform1f(uLight.innerConeCos, projected.innerCos);
      gl.uniform1f(uLight.outerConeCos, projected.outerCos);
      gl.uniform1f(uLight.spotBlend, projected.spotBlend);
      gl.uniform4f(uLight.projectionOrigin, projected.projectionOrigin[0],
        projected.projectionOrigin[1], projected.projectionOrigin[2], projected.projectionDepth);

      activeLightCount++;
    }
    gl.uniform1i(this.lightUniforms.numLights, activeLightCount);

    // Volumetric slot selection: which lights the scattering loop considers.
    // Merit only engages past MAX_VOLUMETRIC_LIGHT_SLOTS volumetric-capable
    // lights, AND only when a consumer opted in (the facade always does).
    // Direct consumers that set nothing keep the historical first-8
    // positional cap even in 9+-light scenes, so Liminal's visual baselines
    // never move. The camera here is the exact eye u_cameraPos carries.
    const volumetricIndices = this.volumetricMeritSelection === true
      ? selectVolumetricLightIndices(activeLights, { x: player.x, y: player.y, z: cameraZ })
      : selectVolumetricLightIndices(
        activeLights.slice(0, MAX_VOLUMETRIC_LIGHT_SLOTS),
        { x: player.x, y: player.y, z: cameraZ }
      );
    const volumetricCount = Math.min(volumetricIndices.length, this.volumetricIndexScratch.length);
    for (let i = 0; i < this.volumetricIndexScratch.length; i++) {
      this.volumetricIndexScratch[i] = i < volumetricCount ? volumetricIndices[i] : 0;
    }
    gl.uniform1i(this.lightUniforms.numVolumetricLights, volumetricCount);
    gl.uniform1iv(this.lightUniforms.volumetricIndices, this.volumetricIndexScratch);

    // THE TWO HAZARDS THAT ARE NOT OBJECTS.
    //
    // Sparks and rifts are lit geometry and need nothing from this block: a
    // spark's glow is 2.75x its harm radius and a rift ships its own fog volume
    // wider than its own. These two are geometryless circles, and until
    // 2026-08-26 their only display anywhere was the retired T-LINK panel's
    // RAD/JAM blips. They are world-space cues now - see lightFS's
    // pitchBlackDarkness and applyCarrierLoss - which means the SHADER is the
    // reader, and this is the wire between the manager and the shader.
    //
    // Both arrays stay at length 0 outside Endless, which is why nothing in the
    // release gate moved: no visual-QA scene runs Endless, so every baselined
    // capture takes the `jam <= 0.002` and `pitchBlack == 0.0` fast paths.
    let numPBZones = 0;
    let numJamFields = 0;
    const sceneEffects = this.sceneState.effects || {};
    const pbZones = Array.isArray(sceneEffects.pitchBlackZones) ? sceneEffects.pitchBlackZones : [];
    numPBZones = Math.min(MAX_HAZARD_ZONES, pbZones.length);
    for (let i = 0; i < numPBZones; i++) {
      const zone = pbZones[i];
      gl.uniform2f(this.lightUniforms.pitchBlackZones[i].position, zone.x, zone.y);
      gl.uniform1f(this.lightUniforms.pitchBlackZones[i].radius, zone.radius);
    }
    const jamFields = Array.isArray(sceneEffects.jammingFields) ? sceneEffects.jammingFields : [];
    numJamFields = Math.min(MAX_HAZARD_ZONES, jamFields.length);
    for (let i = 0; i < numJamFields; i++) {
      const field = jamFields[i];
      gl.uniform2f(this.lightUniforms.jammingFields[i].position, field.x, field.y);
      gl.uniform1f(this.lightUniforms.jammingFields[i].radius, field.radius);
    }
    gl.uniform1i(this.lightUniforms.numPitchBlackZones, numPBZones);
    gl.uniform1i(this.lightUniforms.numJammingFields, numJamFields);
    // The cell grid, so carrier loss can be coherent across a cell rather than
    // averaging itself away in the reduce's sixteen sub-samples.
    gl.uniform2f(this.lightUniforms.cellGrid, this.width, this.height);
    // The SAME field the HUD glitch scales by, not a second knob beside it.
    // Photosensitive is 0.15 and readable 0.55, and a flickering dropout is
    // exactly what those profiles exist to hold down.
    const interferenceScale = Number.isFinite(sceneEffects.interferenceScale)
      ? Math.max(0, Math.min(1, sceneEffects.interferenceScale)) : 1.0;
    gl.uniform1f(this.lightUniforms.interferenceScale, interferenceScale);

    // Draw full-screen lighting pass quad
    gl.bindVertexArray(this.fsQuadVAO);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

    // ----------------------------------------------------
    // PASS 2b: Selective reflective/reactive surfaces -> surfaceFBO
    // ----------------------------------------------------
    // Whenever the surface shader takes its early-out this pass is a straight
    // identity copy of the light buffer into a second full-resolution RGBA16F
    // target - one fetch and one 8-byte write per scene texel, at the
    // supersampled scene size, for a frame nobody has altered. At scene scale
    // 4 on a 160x50 grid that is a 640x200 blit, ~2 MB of round-tripped
    // bandwidth per frame plus a program switch, three texture binds and
    // sixteen uniform uploads. So skip it and let the composite readers bind
    // the light buffer directly.
    //
    // The identity test is the SAME predicate as the early-out in surfaceFS,
    // term for term and in the same comparison direction, so the two cannot
    // drift apart - including under NaN, where each term evaluates alike on
    // both sides. Keying it on the reactiveSurfaces flag alone would have
    // missed the common case of the flag being on with no eligible patches.
    //
    // The skip also requires PASS 2c to be idle. That pass blends particles
    // additively into surfaceFBO and relies on PASS 2b having seeded it with
    // this frame's lit scene first; skipping the seed would accumulate the
    // particles onto whatever the target held last frame, a feedback smear.
    //
    // No render target is allocated, resized or freed by any of this - the
    // decision is per-frame state, and both textures stay allocated exactly as
    // before. An effect flag must never reach reallocateSceneTargets.
    const reactiveSurfaceCount = Math.min(MAX_REACTIVE_SURFACES, this.reactiveSurfacePatches.length);
    const surfaceIsIdentity = !this.atmosphere.reactiveSurfaces
      || reactiveSurfaceCount <= 0
      || this.atmosphere.reflectionStrength <= 0.001;
    const particlesDraw = this.atmosphere.environmentalFx && this.environmentalParticleCount > 0;
    const skipSurfacePass = surfaceIsIdentity && !particlesDraw;

    // Resolved once per frame so the three composite bind sites downstream
    // stay single-line binds instead of each carrying its own conditional.
    // Both candidates are NEAREST, CLAMP_TO_EDGE, RGBA16F and the same size,
    // and every reader takes only .rgb, so the substitution is exact - see
    // initLightBuffer for the wrap mode that makes it so.
    this.compositeTexture = skipSurfacePass ? this.lightTexture : this.surfaceTexture;

    if (!skipSurfacePass) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.surfaceFBO);
      gl.useProgram(this.surfaceProgram);

      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.lightTexture);
      gl.uniform1i(this.surfaceUniforms.accumulatedColor, 0);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, this.gbufNormal);
      gl.uniform1i(this.surfaceUniforms.gbufNormal, 1);
      gl.activeTexture(gl.TEXTURE2);
      gl.bindTexture(gl.TEXTURE_2D, this.gbufPosition);
      gl.uniform1i(this.surfaceUniforms.gbufDepthLuma, 2);

      gl.uniformMatrix4fv(this.surfaceUniforms.view, false, view);
      gl.uniformMatrix4fv(this.surfaceUniforms.projection, false, viewProj);
      gl.uniform3f(this.surfaceUniforms.cameraPos, player.x, player.y, cameraZ);
      gl.uniform2f(this.surfaceUniforms.resolution, this.sceneWidth, this.sceneHeight);
      gl.uniform1f(this.surfaceUniforms.time, currentTime);
      gl.uniform1i(this.surfaceUniforms.enabled, this.atmosphere.reactiveSurfaces ? 1 : 0);
      gl.uniform1f(this.surfaceUniforms.reflectionStrength, this.atmosphere.reflectionStrength);
      gl.uniform1f(this.surfaceUniforms.reflectionReach,
        Number.isFinite(this.atmosphere.reflectionReach) ? this.atmosphere.reflectionReach : 0);
      gl.uniform1f(this.surfaceUniforms.distortion, this.atmosphere.surfaceDistortion);
      gl.uniform3fv(this.surfaceUniforms.tint, this.atmosphere.surfaceTint);
      if (this.atmosphere.skyEnabled === true && Array.isArray(this.atmosphere.skyTopColor)) {
        const top = this.atmosphere.skyTopColor;
        const horizon = this.atmosphere.skyHorizonColor || top;
        gl.uniform3f(this.surfaceUniforms.skyReflectColor,
          (top[0] + horizon[0]) * 0.5, (top[1] + horizon[1]) * 0.5, (top[2] + horizon[2]) * 0.5);
      } else {
        gl.uniform3f(this.surfaceUniforms.skyReflectColor, 0, 0, 0);
      }

      gl.uniform1i(this.surfaceUniforms.numSurfaces, reactiveSurfaceCount);
      for (let i = 0; i < reactiveSurfaceCount; i++) {
        const surface = this.reactiveSurfacePatches[i];
        const uniforms = this.surfaceUniforms.surfaces[i];
        gl.uniform2f(uniforms.position, surface.x, surface.y);
        gl.uniform1f(uniforms.radius, surface.radius);
        gl.uniform1f(uniforms.intensity, surface.intensity);
        gl.uniform1f(uniforms.phase, surface.phase);
      }

      gl.bindVertexArray(this.fsQuadVAO);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }

    // ----------------------------------------------------
    // PASS 2c: Depth-aware environmental particles -> Add to surfaceFBO
    // ----------------------------------------------------
    if (particlesDraw) {
      gl.useProgram(this.particleProgram);
      gl.uniformMatrix4fv(this.particleUniforms.view, false, view);
      gl.uniformMatrix4fv(this.particleUniforms.projection, false, viewProj);
      gl.uniform3f(this.particleUniforms.cameraPos, player.x, player.y, cameraZ);
      gl.uniform2f(this.particleUniforms.resolution, this.sceneWidth, this.sceneHeight);
      gl.uniform1f(this.particleUniforms.time, currentTime);

      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.gbufNormal);
      gl.uniform1i(this.particleUniforms.gbufNormal, 0);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, this.gbufPosition);
      gl.uniform1i(this.particleUniforms.gbufDepthLuma, 1);

      gl.enable(gl.BLEND);
      gl.blendEquation(gl.FUNC_ADD);
      gl.blendFunc(gl.ONE, gl.ONE);
      gl.bindVertexArray(this.environmentParticleVAO);
      gl.drawArrays(gl.POINTS, 0, this.environmentalParticleCount);
      gl.disable(gl.BLEND);
    }

    // ----------------------------------------------------
    // PASS 2d: HDR bloom chain -> quarter-resolution ping-pong
    // ----------------------------------------------------
    this.renderBloom();

    // Build active character set density indices proportionally mapping to 13 slots
    const rampIndices = buildRampIndices(this.luminanceScale);
    const spriteRampIndices = buildRampIndices(this.spriteLuminanceScale, '·.,-~:;=!*#$@');

    if (this.sceneContract.twoPass) {
      this.renderGlyphPasses(charWidth, charHeight, glitchFactor, playTime, rampIndices, spriteRampIndices);
      return;
    }

    // ----------------------------------------------------
    // PASS 3: Post-processing ASCII translation -> Canvas output
    // ----------------------------------------------------
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, gl.canvas.width, gl.canvas.height);

    gl.useProgram(this.asciiProgram);

    // Bind composite light texture
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.compositeTexture);
    gl.uniform1i(this.asciiUniforms.accumulatedColor, 0);

    // Bind normals (for edge Sobel calculations)
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.gbufNormal);
    gl.uniform1i(this.asciiUniforms.gbufNormal, 1);

    // Bind font atlas mask
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, this.fontTexture);
    gl.uniform1i(this.asciiUniforms.fontAtlas, 2);

    // Screen and cell dimensions
    gl.uniform2f(this.asciiUniforms.resolution, gl.canvas.width, gl.canvas.height);
    gl.uniform2f(this.asciiUniforms.cellSize, charWidth, charHeight);
    gl.uniform1i(this.asciiUniforms.strokeGlyphs, this.strokeGlyphs ? 1 : 0);
    gl.uniform2f(this.asciiUniforms.atlasSize, this.atlasCols, this.atlasRows);
    
    // Play effects
    gl.uniform1f(this.asciiUniforms.glitchFactor, glitchFactor);
    this.applyGlitchStyle(this.asciiUniforms.glitchStyle);
    gl.uniform1f(this.asciiUniforms.time, playTime);
    gl.uniform1i(this.asciiUniforms.skyEnabled, this.atmosphere.skyEnabled === true ? 1 : 0);
    this.applyHudUniforms(this.asciiUniforms.hud, 4);
    this.applyScreenFlashUniforms(this.asciiUniforms.screenFlash);
    this.applyToneUniforms(this.asciiUniforms.tone, 3);

    gl.uniform1iv(this.asciiUniforms.charIndices, rampIndices);
    gl.uniform1i(this.asciiUniforms.darkWorldGlyphs, this.darkWorldGlyphs === true ? 1 : 0);
    gl.uniform1f(this.asciiUniforms.shadowFadeWidth, this.shadowFadeWidth);
    gl.uniform1iv(this.asciiUniforms.spriteCharIndices, spriteRampIndices);

    // Draw final post-processing pass
    gl.bindVertexArray(this.fsQuadVAO);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

    gl.bindVertexArray(null);

  }

  /**
   * Upgrade 87 flashlight shadow pass.
   *
   * Renders scene, dynamic architecture and entity meshes into a depth map from
   * the flashlight's point of view. Billboards and the first-person viewmodel
   * are deliberately excluded: billboards are camera-facing quads whose depth
   * from another viewpoint is meaningless, and the operative's own arms sit
   * close enough to the light that they would blanket the frame.
   */
  renderFlashlightShadow(flashlight, enabled) {
    const gl = this.gl;
    this.flashlightShadowsActive = false;
    if (!enabled || !flashlight) return;

    // Widen slightly beyond the cone so the PCF kernel at the beam edge still
    // samples inside the map.
    const margin = 1.15;
    const verticalTan = Math.max(flashlight.verticalOuterTan * margin, 0.05);
    const horizontalTan = Math.max(flashlight.horizontalOuterTan * margin, 0.05);
    const fovY = 2 * Math.atan(verticalTan);
    const aspect = horizontalTan / verticalTan;
    Mat4.perspective(fovY, aspect, 0.05, flashlight.range, this.shadowProjection);

    const origin = flashlight.origin;
    const direction = flashlight.direction;
    const center = [
      origin[0] + direction[0],
      origin[1] + direction[1],
      origin[2] + direction[2]
    ];
    // The world's up is -Z here. Looking straight along it degenerates the
    // lookAt basis, so swing the reference axis when the beam is near vertical.
    const up = Math.abs(direction[2]) > 0.99 ? [1, 0, 0] : [0, 0, -1];
    Mat4.lookAt(origin, center, up, this.shadowView);

    const view = this.shadowView;
    const projection = this.shadowProjection;
    const out = this.shadowViewProjection;
    for (let row = 0; row < 4; row++) {
      for (let column = 0; column < 4; column++) {
        out[column * 4 + row] =
          projection[0 * 4 + row] * view[column * 4 + 0] +
          projection[1 * 4 + row] * view[column * 4 + 1] +
          projection[2 * 4 + row] * view[column * 4 + 2] +
          projection[3 * 4 + row] * view[column * 4 + 3];
      }
    }

    gl.bindFramebuffer(gl.FRAMEBUFFER, this.shadowFBO);
    gl.viewport(0, 0, this.shadowMapSize, this.shadowMapSize);
    gl.enable(gl.DEPTH_TEST);
    gl.depthMask(true);
    gl.clear(gl.DEPTH_BUFFER_BIT);
    // Front-face culling during the depth pass pushes self-shadowing acne to
    // surfaces the light cannot see anyway.
    gl.enable(gl.CULL_FACE);
    gl.cullFace(gl.FRONT);

    gl.useProgram(this.shadowGeomProgram);
    gl.uniformMatrix4fv(this.shadowGeomUniforms.lightViewProjection, false, out);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.diffuseTexture);
    gl.uniform1i(this.shadowGeomUniforms.diffuseTexture, 0);
    gl.uniform1f(this.shadowGeomUniforms.dissolve, 1.0);

    gl.bindVertexArray(this.geometryVAO);
    gl.drawArrays(gl.TRIANGLES, 0, this.geometryVertexCount);
    if (this.dynamicGeometryVertexCount > 0) {
      gl.bindVertexArray(this.dynamicGeometryVAO);
      gl.drawArrays(gl.TRIANGLES, 0, this.dynamicGeometryVertexCount);
    }
    // The shadow thins with the surface, which the entity fade got for free by
    // drawing the same packed buffer. Here it has to be asked for, and it is not
    // optional: a solid shadow across a corridor the player can already walk
    // down is a worse read than the pop this replaces.
    if (this.phaseGeometryVertexCount > 0 && this.phaseDissolveAmount > 0) {
      gl.uniform1f(this.shadowGeomUniforms.dissolve, this.phaseDissolveAmount);
      gl.bindVertexArray(this.phaseGeometryVAO);
      gl.drawArrays(gl.TRIANGLES, 0, this.phaseGeometryVertexCount);
      gl.uniform1f(this.shadowGeomUniforms.dissolve, 1.0);
    }

    if (this.entityVertexCount > 0) {
      gl.useProgram(this.shadowEntityProgram);
      gl.uniformMatrix4fv(this.shadowEntityUniforms.lightViewProjection, false, out);
      gl.bindVertexArray(this.entityVAO);
      gl.drawArrays(gl.TRIANGLES, 0, this.entityVertexCount);
    }

    gl.disable(gl.CULL_FACE);
    gl.cullFace(gl.BACK);
    gl.bindVertexArray(null);
    this.flashlightShadowsActive = true;
  }

  /**
   * Upgrade 85 HDR bloom.
   *
   * Bright-pass and downsample to quarter resolution, then two separable
   * Gaussian round trips for a wider skirt than one pass gives. Runs on the
   * HDR light buffer, so the threshold is a real radiometric cut rather than a
   * fraction of an already-clipped value.
   */
  renderBloom() {
    const gl = this.gl;
    const disabled = !this.atmosphere.bloom || this.atmosphere.bloomIntensity <= 0.001;

    gl.viewport(0, 0, this.bloomWidth, this.bloomHeight);
    gl.bindVertexArray(this.fsQuadVAO);

    if (disabled) {
      // Clear rather than skip, so a stale chain cannot bleed into the frame
      // after bloom is turned off mid-session - the tone stage binds
      // bloomTexture and samples it every frame whatever the bloom setting is.
      //
      // Only the transition needs the clear, though, and that is what the
      // dirty flag tracks. bloomFBOs[0] has exactly three writers: the
      // prefilter and two of the four ping-pong passes below, all on the
      // enabled path, which re-arms the flag; and resizeBloomTargets, which
      // reallocates the pair and re-arms it too. So once this branch has
      // cleared the target black, nothing can dirty it again until bloom is
      // re-enabled, and every path that could has already re-armed the flag.
      // The stale-chain guarantee is therefore unchanged - an
      // enable/disable/enable sequence still clears on each disable - while a
      // session that runs with bloom off (the photosensitive and low-end
      // profiles do, from the first frame) stops paying a quarter-resolution
      // RGBA16F clear every frame for its whole length.
      //
      // The flag starts armed, so the first disabled frame still clears: a
      // freshly allocated target is zero-filled rather than the (0,0,0,1) this
      // branch guarantees, and matching the old first frame exactly costs one
      // clear.
      if (this.bloomChainDirty) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, this.bloomFBOs[0]);
        gl.clearColor(0, 0, 0, 1);
        gl.clear(gl.COLOR_BUFFER_BIT);
        this.bloomChainDirty = false;
      }
      this.bloomTexture = this.bloomTextures[0];
      gl.bindVertexArray(null);
      return;
    }

    // Past here the chain gets written, so a later disable owes a clear.
    this.bloomChainDirty = true;

    gl.bindFramebuffer(gl.FRAMEBUFFER, this.bloomFBOs[0]);
    gl.useProgram(this.bloomPrefilterProgram);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.compositeTexture);
    gl.uniform1i(this.bloomPrefilterUniforms.source, 0);
    gl.uniform2f(
      this.bloomPrefilterUniforms.texelSize,
      1 / Math.max(this.sceneWidth, 1),
      1 / Math.max(this.sceneHeight, 1)
    );
    gl.uniform1f(this.bloomPrefilterUniforms.threshold, this.atmosphere.bloomThreshold);
    gl.uniform1f(this.bloomPrefilterUniforms.softKnee, this.atmosphere.bloomSoftKnee);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.gbufPosition);
    gl.uniform1i(this.bloomPrefilterUniforms.gbufDepthLuma, 1);
    const eye = this.lastCameraPos || [0, 0, 0];
    gl.uniform3f(this.bloomPrefilterUniforms.cameraPos, eye[0], eye[1], eye[2]);
    gl.uniform1f(this.bloomPrefilterUniforms.nearExclude, VIEWMODEL_BLOOM_EXCLUDE_RADIUS);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.activeTexture(gl.TEXTURE0);

    gl.useProgram(this.bloomBlurProgram);
    const texelX = 1 / Math.max(this.bloomWidth, 1);
    const texelY = 1 / Math.max(this.bloomHeight, 1);
    let source = 0;
    for (let pass = 0; pass < 4; pass++) {
      const target = 1 - source;
      const horizontal = pass % 2 === 0;
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.bloomFBOs[target]);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.bloomTextures[source]);
      gl.uniform1i(this.bloomBlurUniforms.source, 0);
      gl.uniform2f(
        this.bloomBlurUniforms.direction,
        horizontal ? texelX : 0,
        horizontal ? 0 : texelY
      );
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      source = target;
    }

    this.bloomTexture = this.bloomTextures[source];
    gl.bindVertexArray(null);
  }

  /**
   * Upgrade 83 two-pass glyph translation.
   *
   * Pass 3a reduces the supersampled scene to one texel per glyph cell,
   * resolving colour, coverage and glyph identity. Pass 3b rasterises those
   * cells to the canvas. Splitting them keeps the per-cell gather off the
   * output resolution, where every pixel of a cell would otherwise repeat it.
   */
  renderGlyphPasses(charWidth, charHeight, glitchFactor, playTime, rampIndices, spriteRampIndices) {
    const gl = this.gl;

    // PASS 3a: cell reduce -> the inactive half of the cell pair, reading the
    // half resolved last frame so glyph decisions can be held steady.
    const historyIndex = this.cellHistoryIndex;
    const targetIndex = 1 - historyIndex;
    const history = this.cellTargets[historyIndex];
    const target = this.cellTargets[targetIndex];

    gl.bindFramebuffer(gl.FRAMEBUFFER, this.cellFBOs[targetIndex]);
    gl.viewport(0, 0, this.width, this.height);
    gl.useProgram(this.cellProgram);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.compositeTexture);
    gl.uniform1i(this.cellUniforms.accumulatedColor, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.gbufNormal);
    gl.uniform1i(this.cellUniforms.gbufNormal, 1);
    gl.activeTexture(gl.TEXTURE3);
    gl.bindTexture(gl.TEXTURE_2D, history.foreground);
    gl.uniform1i(this.cellUniforms.previousCell, 3);
    gl.activeTexture(gl.TEXTURE4);
    gl.bindTexture(gl.TEXTURE_2D, history.background);
    gl.uniform1i(this.cellUniforms.previousCellBackground, 4);
    gl.uniform1i(this.cellUniforms.historyValid, this.cellHistoryValid && this.deterministic !== true ? 1 : 0);
    gl.uniform1f(this.cellUniforms.glyphHysteresis, this.glyphHysteresis);
    gl.uniform1f(this.cellUniforms.colorHysteresis, this.colorHysteresis);
    gl.uniform1f(this.cellUniforms.signalReleaseThreshold, this.signalReleaseThreshold);

    gl.uniform2f(this.cellUniforms.gridResolution, this.width, this.height);
    gl.uniform1i(this.cellUniforms.samplesPerAxis, this.sceneContract.samplesPerAxis);
    gl.uniform1i(this.cellUniforms.structuralGlyphs,
      (this.sceneContract.structural && this.structuralGlyphs) ? 1 : 0);
    gl.uniform1f(this.cellUniforms.edgeThreshold, this.edgeThreshold);
    gl.uniform1f(this.cellUniforms.highlightPreservation, this.highlightPreservation);
    gl.uniform1i(this.cellUniforms.subCellColor, this.subCellColor ? 1 : 0);
    gl.uniform1f(this.cellUniforms.subCellContrast, this.subCellContrast);
    gl.uniform1f(this.cellUniforms.subCellCoherence, this.subCellCoherence);
    gl.uniform1iv(this.cellUniforms.quadrantGlyphs, this.quadrantGlyphIndices);
    this.applyToneUniforms(this.cellUniforms.tone, 2);
    gl.uniform1i(this.cellUniforms.ditherEnabled, this.ditherEnabled ? 1 : 0);
    gl.uniform1f(this.cellUniforms.glitchFactor, glitchFactor);
    this.applyGlitchStyle(this.cellUniforms.glitchStyle);
    gl.uniform1f(this.cellUniforms.time, playTime);
    gl.uniform1i(this.cellUniforms.skyEnabled, this.atmosphere.skyEnabled === true ? 1 : 0);
    gl.uniform1iv(this.cellUniforms.charIndices, rampIndices);
    gl.uniform1i(this.cellUniforms.darkWorldGlyphs, this.darkWorldGlyphs === true ? 1 : 0);
    gl.uniform1f(this.cellUniforms.shadowFadeWidth, this.shadowFadeWidth);
    gl.uniform1iv(this.cellUniforms.spriteCharIndices, spriteRampIndices);

    gl.bindVertexArray(this.fsQuadVAO);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

    // What was just written becomes next frame's history.
    this.cellHistoryIndex = targetIndex;
    this.cellHistoryValid = true;
    this.cellTexture = target.foreground;
    this.cellBackgroundTexture = target.background;

    // PASS 3b: glyph raster -> canvas
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, gl.canvas.width, gl.canvas.height);
    gl.useProgram(this.glyphProgram);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, target.foreground);
    gl.uniform1i(this.glyphUniforms.cellData, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, target.background);
    gl.uniform1i(this.glyphUniforms.cellBackground, 1);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, this.fontTexture);
    gl.uniform1i(this.glyphUniforms.fontAtlas, 2);

    gl.uniform2f(this.glyphUniforms.cellSize, charWidth, charHeight);
    gl.uniform1i(this.glyphUniforms.strokeGlyphs, this.strokeGlyphs ? 1 : 0);
    gl.uniform2f(this.glyphUniforms.atlasSize, this.atlasCols, this.atlasRows);
    this.applyHudUniforms(this.glyphUniforms.hud, 3);
    this.applyScreenFlashUniforms(this.glyphUniforms.screenFlash);

    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.bindVertexArray(null);
  }
}
