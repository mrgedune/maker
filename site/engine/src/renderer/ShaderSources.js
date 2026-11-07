// ShaderSources.js
// Exported GLSL Vertex and Fragment Shaders for the WebGL 2 ASCII Renderer

import { MAX_VOLUMETRIC_LIGHT_SLOTS } from './ProjectedLighting.js';
import { STROKE_GLYPH_BLOCK } from './StrokeGlyphs.js';

export const MAX_LIGHTS = 41;

/**
 * How many of each environmental hazard volume the light pass can carry.
 *
 * Exported and interpolated into the GLSL rather than written twice.
 * `InfinitumManager.generateHazards` builds at most 5 of each - `min(5,
 * floor(floor/2) + 1)` - so 8 is headroom, and the uniform upload clamps to
 * this same constant instead of to a hand-copied literal that could drift past
 * the array it is indexing.
 */
export const MAX_HAZARD_ZONES = 8;

export const geomVS = `#version 300 es
  layout(location = 0) in vec3 a_position;
  layout(location = 1) in vec3 a_normal;
  layout(location = 2) in vec2 a_uv;
  layout(location = 3) in uint a_visibilityCell;

  uniform mat4 u_view;
  uniform mat4 u_projection;

  out vec3 v_worldPos;
  out vec3 v_worldNormal;
  out vec2 v_uv;
  flat out highp uint v_visibilityCell;
  uniform bool u_visibilityCellsEnabled;

  void main() {
    v_worldPos = a_position;
    v_worldNormal = a_normal;
    v_uv = a_uv;
    v_visibilityCell = u_visibilityCellsEnabled ? a_visibilityCell : 0u;
    gl_Position = u_projection * u_view * vec4(a_position, 1.0);
  }
`;

/**
 * How a bulkhead leaves the room, and comes back.
 *
 * `a84d5e4` gave an entity mesh a fade and the reasoning transfers here word for
 * word: this pass is DEFERRED, there is nothing to blend a normal or a world
 * position against, and dimming is measurably not a fade because cellFS reads
 * occupancy off `length(normalData.xyz)` and never off the colour - a dimmed
 * bulkhead still writes depth, still occludes the corridor behind it and is
 * still outlined, which is a doorway-shaped hole. What that pass does have is
 * COVERAGE: it counts occupied sub-samples, divides by the tap count and
 * multiplies the cell's luminance by the fraction, so a partly-filled cell
 * already resolves to a sparser glyph in the surface's own colour. A fade only
 * has to feed that.
 *
 * THE MECHANISM DOES NOT TRANSFER, ONLY THE TARGET. `renderOpacity` removes
 * whole triangles ranked by the radical inverse of the triangle index, which
 * works because a body is around two thousand of them and any prefix of that
 * order is spread finer than a glyph cell. A WALL FACE IS TWO TRIANGLES. There
 * is nothing to rank: dropping one is a diagonal wipe across half a doorway, and
 * subdividing the slab far enough to dither it would need tens of thousands of
 * quads for one door - a 1-unit face is about 277 columns by 108 rows at 1080p
 * with the 3x5 cell, measured off the shipping layout. So the wall path feeds
 * the same coverage term from the only place it can make sub-cell holes, which
 * is the fragment.
 *
 * IT COSTS NOTHING TO CARRY. `geomFS` has discarded since cutout geometry
 * existed - the alpha test three lines below - so this pass has never had an
 * early-Z fast path to lose, and every draw but the phasing one pays a single
 * compare against a uniform that is 1.0.
 *
 * The grain is OBJECT space, not screen space, and that is the one decision here
 * with a wrong answer. A player shifts as they reach the door and walks through
 * it at 3.5 units a second, so a screen-locked dither would hang in the air
 * while the slab slid underneath it. 128 grains a unit puts one grain at roughly
 * one glyph cell at two units, which is the range this is watched from; nearer,
 * the erosion reads as erosion, further out it falls under the cell and thins
 * the glyph instead, which is exactly what cellFS does for a fading body.
 *
 * Ordered rather than hashed, for the reason `renderOpacity` ranks by index: an
 * ordered threshold is monotone in the dissolve amount, so surface only ever
 * leaves and never comes back. A per-frame hash would boil against the cell
 * pass's own temporal hysteresis. `bayer4` is already the pattern the density
 * ramp uses in cellFS; this is the same table with a modulo that survives a
 * negative coordinate, which the ceiling at z = -0.5 supplies and cellFS's
 * screen-space version never sees.
 */
export const DISSOLVE_BLOCK = `
  uniform float u_dissolve;

  const float DISSOLVE_GRAINS_PER_UNIT = 128.0;

  float dissolveOrder(ivec2 grain) {
    int pattern[16] = int[](0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5);
    int index = int(mod(float(grain.y), 4.0)) * 4 + int(mod(float(grain.x), 4.0));
    return (float(pattern[index]) + 0.5) / 16.0;
  }

  bool dissolvedAway(vec3 worldPos, vec3 worldNormal) {
    if (u_dissolve >= 1.0) return false;
    if (u_dissolve <= 0.0) return true;
    // The two world axes that lie IN the surface. Ranking on all three would
    // stretch the grain into stripes running along the face's own normal.
    vec3 axis = abs(worldNormal);
    vec2 surface = axis.x > axis.y
      ? (axis.x > axis.z ? worldPos.yz : worldPos.xy)
      : (axis.y > axis.z ? worldPos.xz : worldPos.xy);
    return dissolveOrder(ivec2(floor(surface * DISSOLVE_GRAINS_PER_UNIT))) >= u_dissolve;
  }
`;

export const geomFS = `#version 300 es
  precision highp float;

  in vec3 v_worldPos;
  in vec3 v_worldNormal;
  in vec2 v_uv;
  flat in highp uint v_visibilityCell;

  layout(location = 0) out vec4 outAlbedo;
  layout(location = 1) out vec4 outNormal;
  layout(location = 2) out vec4 outDepthLuma;
  layout(location = 3) out highp uint outVisibilityCell;

  uniform sampler2D u_diffuseTexture;
  uniform sampler2D u_materialTexture;
  uniform float u_selfLuminous;
  uniform float u_isSprite;

${DISSOLVE_BLOCK}

  void main() {
    vec4 albedo = texture(u_diffuseTexture, v_uv);
    if (albedo.a < 0.1) {
      discard;
    }
    if (dissolvedAway(v_worldPos, v_worldNormal)) {
      discard;
    }

    vec3 material = texture(u_materialTexture, v_uv).rgb;
    float roughness = material.r;
    float materialEmission = material.g;
    float lightResponse = material.b;
    // Disjoint signed ranges retain roughness without another attachment:
    // geometry [0,1], ordinary sprites [-2,-1], preserved art [-4,-3].
    float packedRoughness = u_isSprite > 1.5 ? -(roughness + 3.0)
      : u_isSprite > 0.5 ? -(roughness + 1.0) : roughness;
    
    outAlbedo = vec4(albedo.rgb, lightResponse);
    outNormal = vec4(normalize(v_worldNormal), packedRoughness);
    outDepthLuma = vec4(v_worldPos, max(u_selfLuminous, materialEmission));
    outVisibilityCell = v_visibilityCell;
  }
`;

/**
 * Upgrade 87 shadow depth pass.
 *
 * Depth only, one program per vertex layout. Until now the only occlusion the
 * flashlight respected came from LightVisibilityAtlas, which is CPU
 * line-of-sight across the 2D map grid: it has no height dimension and knows
 * nothing about entities or props, so nothing in the world cast a shadow.
 */
export const shadowGeomVS = `#version 300 es
  layout(location = 0) in vec3 a_position;
  layout(location = 1) in vec3 a_normal;
  layout(location = 2) in vec2 a_uv;

  uniform mat4 u_lightViewProjection;

  out vec2 v_uv;
  // Carried for the dissolve alone. A phasing bulkhead that kept casting a solid
  // shadow while its own surface came apart would put a hard black slab across a
  // corridor the player can already walk down.
  out vec3 v_worldPos;
  out vec3 v_worldNormal;

  void main() {
    v_uv = a_uv;
    v_worldPos = a_position;
    v_worldNormal = a_normal;
    gl_Position = u_lightViewProjection * vec4(a_position, 1.0);
  }
`;

export const shadowGeomFS = `#version 300 es
  precision highp float;

  in vec2 v_uv;
  in vec3 v_worldPos;
  in vec3 v_worldNormal;
  uniform sampler2D u_diffuseTexture;

${DISSOLVE_BLOCK}

  void main() {
    // Cutout geometry has to cast the shape it actually draws, so the depth
    // pass repeats the geometry pass's alpha test - and, since a84d5e4, its
    // dissolve, so the shadow thins with the surface for free.
    if (texture(u_diffuseTexture, v_uv).a < 0.1) discard;
    if (dissolvedAway(v_worldPos, v_worldNormal)) discard;
  }
`;

export const shadowEntityVS = `#version 300 es
  layout(location = 0) in vec3 a_position;

  uniform mat4 u_lightViewProjection;

  void main() {
    gl_Position = u_lightViewProjection * vec4(a_position, 1.0);
  }
`;

export const shadowEntityFS = `#version 300 es
  precision highp float;
  void main() {}
`;

export const entityVS = `#version 300 es
  layout(location = 0) in vec3 a_position;
  layout(location = 1) in vec3 a_normal;
  layout(location = 2) in vec3 a_color;
  layout(location = 3) in vec3 a_material;

  uniform mat4 u_view;
  uniform mat4 u_projection;
  // Identity for entity meshes, whose vertices are authored in world space.
  // The first-person viewmodel is authored once in camera-local rig space and
  // carries its camera motion here, so animating it costs a uniform instead of
  // a re-tessellation. Orthonormal by construction, so mat3 covers normals.
  uniform mat4 u_model;

  out vec3 v_worldPos;
  out vec3 v_worldNormal;
  out vec3 v_color;
  out vec3 v_material;

  void main() {
    vec4 worldPosition = u_model * vec4(a_position, 1.0);
    v_worldPos = worldPosition.xyz;
    v_worldNormal = mat3(u_model) * a_normal;
    v_color = a_color;
    v_material = a_material;
    gl_Position = u_projection * u_view * worldPosition;
  }
`;

export const entityFS = `#version 300 es
  precision highp float;

  in vec3 v_worldPos;
  in vec3 v_worldNormal;
  in vec3 v_color;
  in vec3 v_material;

  // 1.0 for world geometry, 0.0 for the first-person rig. See main().
  uniform float u_formShading;

  layout(location = 0) out vec4 outAlbedo;
  layout(location = 1) out vec4 outNormal;
  layout(location = 2) out vec4 outDepthLuma;
  layout(location = 3) out highp uint outVisibilityCell;

  void main() {
    vec3 normal = normalize(v_worldNormal);
    vec3 sculptDirection = normalize(vec3(-0.42, 0.28, -0.86));
    float shapedLight = 0.8 + max(dot(normal, sculptDirection), 0.0) * 0.3;
    float rim = pow(1.0 - abs(normal.z), 3.0) * 0.16;

    // ## A HUD ELEMENT MAY NOT CHANGE BRIGHTNESS BECAUSE THE HEAD TURNED
    //
    // sculptDirection is a FIXED WORLD direction and normal is a world
    // normal - which for the first-person rig is the CAMERA'S, because
    // u_model is computeRigTransform, built straight from the camera
    // basis. So this dot product is a brightness dial the operative turns by
    // looking around, and on a self-luminous face it is the only term there
    // is. Measured over a 24-step yaw sweep at a fixed position: this term
    // alone swings 1.3131x, and together with lightFS's emissiveForm
    // 1.5184x.
    //
    // Ged, 2026-08-26: *"when I am looking around the map changes, the room
    // coloring and borders go away and come back"*, then *"sometimes all the
    // walls disappear and come back when I turn"*. The plan's geometry never
    // moved - proven by sweeping 24 headings at a fixed position for
    // byte-identical output. What moved was this multiplier, across the glyph
    // ramp's blank cliff, which cannot be dithered across.
    //
    // The rig keeps its sculpt on LIT geometry: the arms are real and want
    // form. It loses it only where the surface emits its own light, which is
    // the glass - v_material.y is the emission the deferred pass branches on
    // at 0.95, so this is the same test, made here.
    float hudGlass = (1.0 - u_formShading) * step(0.95, v_material.y);
    vec3 shapedColor = v_color * mix(shapedLight + rim, 1.0, hudGlass);

    outAlbedo = vec4(shapedColor, v_material.z);
    outNormal = vec4(normal, -(v_material.x + 1.0));
    outDepthLuma = vec4(v_worldPos, v_material.y);
    outVisibilityCell = 0u;
  }
`;

export const lightVS = `#version 300 es
  layout(location = 0) in vec2 a_quadPos;
  layout(location = 1) in vec2 a_quadUV;

  out vec2 v_uv;

  void main() {
    v_uv = a_quadUV;
    gl_Position = vec4(a_quadPos, 0.0, 1.0);
  }
`;

export const lightFS = `#version 300 es
  precision highp float;

  in vec2 v_uv;
  out vec4 outLightColor;

  uniform sampler2D u_gbufNormal;
  uniform highp usampler2D u_gbufVisibilityCell;
  uniform sampler2D u_gbufDepthLuma;
  uniform sampler2D u_gbufAlbedo;
  uniform sampler2D u_lightVisibility;
  uniform ivec2 u_lightVisibilityMapSize;
  uniform int u_lightVisibilityLayerCount;
  uniform bool u_castShadowsEnabled;
  uniform float u_shadowFloor;
  uniform bool u_contactShadowsEnabled;
  uniform int u_aoStep;
  uniform float u_ambientOcclusionStrength;
  uniform float u_ambientFactor;
  uniform float u_lowLightAdaptation;
  // How much of the unconditional perceptual shadow floor survives (1 = the
  // historical floor exactly, 0 = unlit geometry reaches true black), and the
  // opt-in dim-band recovery that replaces the separation the floor was
  // providing. See applyPerceptualShadowFloor / applyLowLightResponse.
  uniform float u_visibilityFloor;
  uniform float u_shadowLift;
  uniform vec3 u_shadowTint;
  uniform float u_specularStrength;
  uniform float u_emissiveIntensity;
  // The tone stage's exposure, needed here so the perceptual shadow floor can
  // be specified in display space. See applyPerceptualShadowFloor.
  uniform float u_toneExposure;
  uniform vec3 u_fogColor;
  uniform float u_fogDensity;
  uniform float u_fogHeightFalloff;
  uniform bool u_environmentalFxEnabled;
  uniform float u_volumetricStrength;

  struct PointLight {
    vec3 position;
    vec3 color;
    float range;
    float intensity;
    float floorInfluence;
    float volumetricInfluence;
    vec3 direction;
    float innerConeCos;
    float outerConeCos;
    float spotBlend;
    vec4 projectionOrigin; // xyz virtual apex, w distance from physical emitter
  };

  #define MAX_LIGHTS ${MAX_LIGHTS}
  uniform PointLight u_lights[MAX_LIGHTS];
  uniform int u_numLights;

  // Which lights fill the volumetric scattering loop's slots. The loop used
  // to take the FIRST eight array slots, so a dynamic light (appended after
  // every shadow-caster by design) could never contribute airlight. The CPU
  // now selects the volumetric-capable lights by merit
  // (ProjectedLighting.selectVolumetricLightIndices) and hands their indices
  // here in ascending array order — a scene with eight or fewer
  // volumetric-capable lights sums exactly the historical contributions in
  // exactly the historical order, bit-identical.
  #define MAX_VOLUMETRIC_LIGHTS ${MAX_VOLUMETRIC_LIGHT_SLOTS}
  uniform int u_volumetricIndices[MAX_VOLUMETRIC_LIGHTS];
  uniform int u_numVolumetricLights;

  struct FogVolume {
    vec3 position;
    vec3 color;
    float radius;
    float density;
  };
  #define MAX_FOG_VOLUMES 6
  uniform FogVolume u_fogVolumes[MAX_FOG_VOLUMES];
  uniform int u_numFogVolumes;

  uniform vec3 u_cameraPos;
  // Inside this radius of the eye is the operative's own equipment.
  uniform float u_viewmodelRadius;

  // Open sky. When enabled, pixels with no G-buffer coverage are painted with
  // a vertical gradient instead of black. The camera frustum basis vectors are
  // premultiplied by tan(fov/2) (and aspect, for the right vector) on the CPU
  // so a fragment's world-space view ray is one add per axis. World up is -z.
  uniform bool u_skyEnabled;
  uniform vec3 u_skyTopColor;
  uniform vec3 u_skyHorizonColor;
  uniform vec3 u_skyGlowColor;
  uniform vec2 u_skyGlowDir;
  uniform float u_skyGlowStrength;
  uniform float u_skyGlowSharpness;
  uniform vec3 u_skyCameraForward;
  uniform vec3 u_skyCameraRight;
  uniform vec3 u_skyCameraUp;
  // Procedural starfield (0 = off, the default) and a gradient dither that
  // breaks quantization bands in dark sky/fog ramps (0 = off, the default).
  uniform float u_starDensity;
  uniform float u_starBrightness;
  uniform float u_fogDither;
  uniform bool u_fogPlanar;
  // Horizon skyline silhouette band (0 = off, the default and the Liminal
  // guarantee): uncovered sky pixels near the horizon darken into a
  // deterministic tower skyline, a pure function of the world-anchored ray
  // AZIMUTH (like the starfield's dome, it holds still under camera
  // rotation) and the seed.
  uniform float u_skylineStrength;
  uniform float u_skylineSeed;
  uniform vec3 u_flashlightOrigin;
  uniform vec3 u_flashlightDir;
  uniform bool u_flashlightOn;
  uniform float u_batteryFactor;
  uniform float u_flashlightHorizontalOuterTan;
  uniform float u_flashlightVerticalOuterTan;
  uniform float u_flashlightRange;

  uniform highp sampler2DShadow u_flashlightShadowMap;
  uniform mat4 u_flashlightViewProjection;
  uniform bool u_flashlightShadowsEnabled;
  uniform vec2 u_shadowTexelSize;
  uniform float u_shadowNormalBias;
  uniform float u_shadowDepthBias;

  uniform vec2 u_portalPos;
  uniform vec3 u_portalColor;
  uniform float u_portalRange;
  uniform float u_time;
  uniform bool u_hasPortal;

  struct HazardZone {
    vec2 position;
    float radius;
  };
  #define MAX_HAZARDS ${MAX_HAZARD_ZONES}
  uniform HazardZone u_pitchBlackZones[MAX_HAZARDS];
  uniform int u_numPitchBlackZones;
  uniform HazardZone u_jammingFields[MAX_HAZARDS];
  uniform int u_numJammingFields;
  // Cell columns and rows, so a disturbance authored here can be COHERENT
  // ACROSS A CELL. cellFS reduces 16 sub-samples per cell; anything finer than
  // a cell averages back to a smooth dim and reads as nothing at all.
  uniform vec2 u_cellGrid;
  // The accessibility profile's glitch scale - photosensitive 0.15, readable
  // 0.55 - read from the same game.accessibilityGlitchScale the HUD glitch
  // reads, rather than a second knob that could drift away from it.
  uniform float u_interferenceScale;

  /**
   * How far outside a hazard's own radius its cue is still perceptible.
   *
   * The whole point of the number. A cue that starts at the boundary says "you
   * are in it", which arrives too late; a cue that stops at the boundary draws
   * the boundary, which is an instrument mark wearing a costume. Three metres
   * against radii of 3.5-6.0 puts the STEEPEST part of both ramps well outside
   * the circle the game actually tests against, so there is nothing in the
   * picture a player could take a range off.
   */
  const float HAZARD_APPROACH_METRES = 3.0;

  /**
   * The pitch-black zone's darkness, as a weight rather than a boolean.
   *
   * 1.0 everywhere inside the zone - the interior is byte-identical to what it
   * has always been - falling to 0 over the approach band outside it, with zero
   * derivative at d == radius so there is no step to see. What this REPLACES is
   * as important as what it adds: an if (d < radius) snapped every surface off
   * the bottom of the glyph ramp at once, which drew a hard circle on the floor.
   */
  float pitchBlackDarkness(vec3 worldPos) {
    float darkness = 0.0;
    for (int i = 0; i < MAX_HAZARDS; i++) {
      if (i >= u_numPitchBlackZones) break;
      float d = distance(worldPos.xy, u_pitchBlackZones[i].position);
      float radius = u_pitchBlackZones[i].radius;
      darkness = max(darkness, 1.0 - smoothstep(radius, radius + HAZARD_APPROACH_METRES, d));
    }
    return darkness;
  }

  /**
   * The jamming field's weight: worst at the core, gone past the approach band.
   *
   * Peaks at the middle and is roughly half at the geometric edge, so the cue
   * says WHICH WAY IS WORSE without saying where the line is. That is the whole
   * of what a player needs to act - back out the way you came - and none of what
   * the retired panel gave them, which was a bearing and a range.
   */
  float jammingWeight(vec3 worldPos) {
    float jam = 0.0;
    for (int i = 0; i < MAX_HAZARDS; i++) {
      if (i >= u_numJammingFields) break;
      float d = distance(worldPos.xy, u_jammingFields[i].position);
      float radius = u_jammingFields[i].radius;
      jam = max(jam, 1.0 - smoothstep(radius * 0.15, radius + HAZARD_APPROACH_METRES, d));
    }
    return jam;
  }

  float hazardHash(vec2 seed) {
    return fract(sin(dot(seed, vec2(12.9898, 78.233))) * 43758.5453);
  }

  /**
   * Carrier loss: the picture coming apart where the space is jammed.
   *
   * The operative's whole view is a signal, so a field that floods the band
   * takes the picture with it. Authored in the LIGHT buffer rather than as a
   * glyph substitution, which is what makes it stay in the house idiom for
   * free: the ramp downstream turns a disturbed luminance into disturbed
   * GLYPHS, so the cue is made of the same characters the room is and nothing
   * new is ever drawn.
   *
   * Deliberately NOT the global u_glitchFactor. That dial already carries
   * sanity, threat proximity, being spotted, shield hits and - in Endless,
   * which is the only mode hazards exist in at all - stability, which pins it
   * to 0.8 at zero. A fifth claimant on one channel is a cue that disappears
   * exactly when the floor is at its worst.
   *
   * Snow is written at the ramp's own scale, in display luminance divided back
   * out by exposure, for the same reason the perceptual shadow floor is: a term
   * specified in light space is silently exposure-dependent.
   *
   * ## THE FOUR NUMBERS BELOW ARE TASTE, AND THEY ARE GED'S
   *
   * Nothing measured chose them; they are how heavy the effect feels. What was
   * measured is what they currently produce, against the identical frame with
   * no field in it (hazard_control_1080), at 1920x1080:
   *
   *     approaching, 7 m from a 4 m centre     3.91% of pixels changed
   *     standing at the core                  36.51% of pixels changed
   *     the core through 'photosensitive'      6.53% of pixels changed
   *
   * Turning any of them down is one edit and re-shoots five gate cases. The
   * one to reach for first is CARRIER_DEPTH: at 0.9 a lost cell keeps a tenth
   * of the room behind it, and the core case is close to the point where an
   * operative cannot navigate out of the field they walked into.
   */
  // Share of BANDS lost at full weight - the picture losing its horizontal lock.
  const float CARRIER_BAND_DUTY = 0.85;
  // Share of cells lost within a torn band. The product is what reaches a cell.
  const float CARRIER_CELL_DUTY = 0.80;
  // How completely a lost cell is replaced. 1.0 would erase the room entirely.
  const float CARRIER_DEPTH = 0.90;
  // The snow's display-luminance range. The top is deliberately below the
  // flashlight's own level so the bloom bright-pass has nothing new to catch.
  const float CARRIER_SNOW_FLOOR = 0.02;
  const float CARRIER_SNOW_RANGE = 0.40;
  // How fast the pattern churns at full scale, and how much of the cue survives
  // when a player has asked for as little flashing as the game offers. See the
  // note in applyCarrierLoss: the accessibility scale takes the flicker rather
  // than the warning, and the floor is what stops it taking both.
  const float CARRIER_TICK_HZ = 12.0;
  const float CARRIER_SAFE_PRESENCE = 0.45;

  vec3 applyCarrierLoss(vec3 color, vec3 worldPos, float jam) {
    if (jam <= 0.002 || u_interferenceScale <= 0.001) return color;
    // NEVER THE OPERATIVE'S OWN SUIT. Standing in a field puts the arms, the
    // lamp and the scope well inside the weight, and a rig that dissolved into
    // static would be frame-centre noise that says nothing about the room. The
    // fiction is the same rule: the field floods the space, and the suit is the
    // one thing in frame that is not in the space.
    //
    // A RAMP, NOT THE BARE RADIUS. The deferred pass cannot be told which draw a
    // fragment came from, so the only mask available is distance from the eye -
    // and u_viewmodelRadius alone is not enough for this: it is the bloom
    // bright-pass exclusion at 0.8 m, and the forearms reach past it toward the
    // bottom of the frame. Measured against a same-pose control, 0.8 m left
    // 12.15% of the rig coming apart. So the clearance runs from that radius out
    // to three times it and is a smoothstep rather than a step, for the same
    // reason both hazard weights are: an if() across a continuous surface is a
    // drawn edge, and a hard bubble of clean air around the operative would be
    // the most obvious one in the frame.
    float rigClearance = smoothstep(u_viewmodelRadius, u_viewmodelRadius * 3.0,
      distance(worldPos, u_cameraPos));
    if (rigClearance <= 0.001) return color;
    vec2 sceneSize = vec2(textureSize(u_gbufDepthLuma, 0));
    // EXACTLY cellFS's cellIndex. Its taps sit at (cellIndex + offset) *
    // cellSizeUV with offset in [0,1), so every sub-sample of a cell floors to
    // the same pair here and the whole cell draws one number.
    vec2 cellIndex = floor(gl_FragCoord.xy / max(sceneSize, vec2(1.0)) * u_cellGrid);
    // ## THE ACCESSIBILITY SCALE TAKES THE FLICKER, NOT THE WARNING
    //
    // The first version multiplied the duty cycle by u_interferenceScale
    // directly, and MEASURED that way the cue is simply gone on the
    // photosensitive profile: the duty is quadratic in it - a band roll AND a
    // cell roll - so 0.15 left 0.01% of the frame changed against its own
    // control, against 12.56% at full scale. A hazard nothing marks, whose only
    // tell is this, silently stops existing for the players least able to
    // afford a surprise.
    //
    // So the scale is split. What is actually harmful about a dropout is the
    // FLICKER, and that is what the tick rate carries: 12 Hz at full scale,
    // 1.8 Hz on photosensitive, and a STATIC pattern with no flicker at all at
    // zero. What is informative is the PRESENCE, and that keeps a floor. A
    // player who has asked for less flashing is asking for less flashing, not
    // for the unmarked hazard to become unmarked again.
    float safety = clamp(u_interferenceScale, 0.0, 1.0);
    float presence = mix(CARRIER_SAFE_PRESENCE, 1.0, safety);
    float tick = floor(u_time * 0.001 * (CARRIER_TICK_HZ * safety));
    // Torn in horizontal bands two cell-rows deep, because CRT signal loss is
    // horizontal. Per-cell salt reads as film grain; a band reads as a picture
    // losing its lock.
    float band = floor(cellIndex.y * 0.5);
    float bandRoll = hazardHash(vec2(band, tick));
    float cellRoll = hazardHash(cellIndex + vec2(tick * 7.0, tick * 13.0));
    float strength = jam * presence * rigClearance;
    float lost = step(1.0 - strength * CARRIER_BAND_DUTY, bandRoll)
      * step(1.0 - strength * CARRIER_CELL_DUTY, cellRoll);
    if (lost <= 0.0) return color;
    // A random rung of the ramp in the shadow tint. It must be able to go UP as
    // well as down: a dark corridor is already near-black, so a dropout that
    // only subtracts is invisible in exactly the places the operative is most
    // often standing.
    float level = hazardHash(cellIndex.yx + vec2(tick * 3.0, tick * 29.0));
    vec3 tintHue = u_shadowTint / max(dot(u_shadowTint, vec3(0.299, 0.587, 0.114)), 0.001);
    vec3 snow = tintHue * (CARRIER_SNOW_FLOOR + CARRIER_SNOW_RANGE * level)
      / max(u_toneExposure, 0.01);
    return mix(color, snow, clamp(strength * CARRIER_DEPTH, 0.0, 1.0));
  }

  float ambientVisibility(ivec2 texelCoord, vec3 worldPos, vec3 normal) {
    // BIT-IDENTICAL EARLY-OUT, not a new behaviour. At strength 0 the return
    // below evaluates 1.0 - clamp(occlusion * 0.0 / 4.0, ...) - exactly 1.0
    // for every possible occlusion - so this changes cost and nothing else,
    // for every consumer, with no flag to set and no default moved.
    //
    // (No backticks anywhere in this comment on purpose: this GLSL lives in a
    // JS template literal, so one would end the string and take the shader
    // with it. The whole test suite failed to parse the first time.)
    //
    // What it saves is real: eight neighbour taps, up to two texelFetch each,
    // per lit pixel, over a scene that can be several million texels. It is
    // deliberately keyed off the STRENGTH and not off u_contactShadowsEnabled,
    // which would be a very different change - that uniform also gates
    // sampleLightVisibility, so turning it off would make every light in the
    // scene fully unoccluded and shine through walls.
    if (!u_contactShadowsEnabled || u_ambientOcclusionStrength <= 0.0) return 1.0;

    ivec2 bufferSize = textureSize(u_gbufDepthLuma, 0);
    ivec2 offsets[8] = ivec2[](
      ivec2(-1, 0), ivec2(1, 0), ivec2(0, -1), ivec2(0, 1),
      ivec2(-1, -1), ivec2(1, -1), ivec2(-1, 1), ivec2(1, 1)
    );
    float occlusion = 0.0;

    // The tap spacing is expressed in glyph cells, not scene texels, so a
    // supersampled scene keeps the same world-space occlusion footprint it has
    // at 1x instead of collapsing to a fraction of it.
    int step = max(u_aoStep, 1);
    for (int i = 0; i < 8; i++) {
      ivec2 sampleCoord = clamp(texelCoord + offsets[i] * step, ivec2(0), bufferSize - ivec2(1));
      vec3 sampleNormal = texelFetch(u_gbufNormal, sampleCoord, 0).xyz;
      if (length(sampleNormal) < 0.1) continue;

      vec3 samplePos = texelFetch(u_gbufDepthLuma, sampleCoord, 0).xyz;
      vec3 delta = samplePos - worldPos;
      float sampleDistance = length(delta);
      if (sampleDistance < 0.001 || sampleDistance > 2.2) continue;

      float proximity = 1.0 - sampleDistance / 2.2;
      // Positions are stored in RGBA16F. Raster interpolation and half-float
      // rounding can put neighbours on opposite sides of the same flat wall.
      // Normalizing that sub-texel error made it a full-strength occluder,
      // producing moving grain and triangle-shaped shadows as the view turned.
      // Binary16's relative spacing is at most abs(position)/1024; allow that
      // uncertainty along the surface normal before evaluating the horizon.
      float positionTolerance = dot(abs(normal), max(abs(worldPos), abs(samplePos))) / 1024.0 + 0.0001;
      float planeDistance = dot(delta, normal);
      if (abs(planeDistance) <= positionTolerance && dot(normal, sampleNormal) > 0.999) continue;
      float horizon = max((planeDistance - positionTolerance) / sampleDistance - 0.04, 0.0);
      float normalBreak = 1.0 - max(dot(normal, sampleNormal), 0.0);
      occlusion += (horizon * 0.7 + normalBreak * 0.22) * proximity;
    }

    return 1.0 - clamp(occlusion * u_ambientOcclusionStrength / 4.0, 0.0, 0.62);
  }

  vec3 applyAtmosphericFog(vec3 color, vec3 worldPos) {
    // Planar fog (opt-in) measures across the ground only, for cameras above
    // the world. The default keeps the historical eye distance.
    float cameraDistance = u_fogPlanar
      ? distance(worldPos.xy, u_cameraPos.xy)
      : distance(worldPos, u_cameraPos);
    float distanceFog = 1.0 - exp(-cameraDistance * u_fogDensity);
    float heightWeight = exp(-abs(worldPos.z - 0.35) * u_fogHeightFalloff);
    float fogAmount = clamp(distanceFog * mix(0.72, 1.0, heightWeight), 0.0, 0.88);
    if (u_fogDither > 0.0) {
      // Breaks the concentric distance-fog bands that downstream quantization
      // carves out of smooth dark ramps. Off (0) unless the world asks.
      float bandNoise = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453);
      fogAmount = clamp(fogAmount + (bandNoise - 0.5) * u_fogDither, 0.0, 0.88);
    }
    vec3 foggedColor = mix(color, u_fogColor, fogAmount);
    if (!u_environmentalFxEnabled) return foggedColor;

    vec3 viewDelta = worldPos - u_cameraPos;
    float viewDistance = max(length(viewDelta), 0.001);
    vec3 viewDirection = viewDelta / viewDistance;
    for (int i = 0; i < MAX_FOG_VOLUMES; i++) {
      if (i >= u_numFogVolumes) break;
      vec3 toVolume = u_fogVolumes[i].position - u_cameraPos;
      float closestDistance = clamp(dot(toVolume, viewDirection), 0.0, viewDistance);
      vec3 closestPoint = u_cameraPos + viewDirection * closestDistance;
      float radialDistance = distance(closestPoint, u_fogVolumes[i].position);
      float radialWeight = 1.0 - smoothstep(u_fogVolumes[i].radius * 0.35, u_fogVolumes[i].radius, radialDistance);
      float pathWeight = 1.0 - exp(-min(viewDistance, u_fogVolumes[i].radius * 2.0) * u_fogVolumes[i].density);
      foggedColor = mix(foggedColor, u_fogVolumes[i].color, radialWeight * pathWeight * 0.48);
    }
    return foggedColor;
  }

  vec3 applyLowLightResponse(vec3 color, vec3 normal, float adaptationStrength) {
    const vec3 LUMA = vec3(0.299, 0.587, 0.114);
    float luminance = dot(color, LUMA);
    if (luminance <= 0.001 || adaptationStrength <= 0.001) return color;

    // Preserve true black, highlights, and the flashlight's authority while
    // opening the narrow near-black band where silhouettes otherwise vanish
    // into empty ASCII cells. This approximates eye/display dark adaptation,
    // with reduced chroma and a restrained cool-biased shadow response.
    float shadowWeight = 1.0 - smoothstep(0.055, 0.26, luminance);
    float adaptedLuminance = pow(luminance, 0.68);
    float liftedLuminance = mix(
      luminance,
      adaptedLuminance,
      shadowWeight * clamp(adaptationStrength, 0.0, 1.0)
    );
    // OPT-IN dim-band recovery, for a world that dropped u_visibilityFloor.
    //
    // The perceptual floor below is what carried barely-lit geometry onto the
    // glyph ramp; a world authoring real darkness turns it down and takes the
    // separation with it, so everything that DID catch some light collapses
    // into the same empty cell as everything that caught none. This puts a
    // steeper curve back under that band, over a wider window (0.02..0.42 in
    // light space against the base curve's 0.055..0.26), and only ever
    // brightens - max() against the historical result, so no surface the base
    // response already lifted can move down.
    //
    // Faded in by the knob itself, so 0+ is continuous with 0. At exactly 0 -
    // the default - the whole block is skipped and the instruction stream is
    // the historical one.
    //
    // It rides adaptationStrength, which means two things a world should know:
    // it is a modifier of the dark-adaptation response rather than a second
    // independent lift (lowLightAdaptation 0 leaves it inert), and a
    // pitch-black zone fades it out over the same three metres as everything
    // else the zone suppresses, instead of drawing an edge.
    if (u_shadowLift > 0.0) {
      float deepWeight = 1.0 - smoothstep(0.02, 0.42, luminance);
      float deepLuminance = mix(luminance, pow(luminance, 0.42), deepWeight);
      liftedLuminance = mix(
        liftedLuminance,
        max(liftedLuminance, deepLuminance),
        clamp(u_shadowLift, 0.0, 1.0) * clamp(adaptationStrength, 0.0, 1.0)
      );
    }
    vec3 sourceHue = color / max(luminance, 0.001);
    vec3 tintHue = u_shadowTint / max(dot(u_shadowTint, LUMA), 0.001);
    vec3 lowLightHue = mix(tintHue, sourceHue, 0.42);
    vec3 fillDirection = normalize(vec3(-0.35, 0.22, -0.91));
    float formCue = 0.94 + 0.06 * max(dot(normal, fillDirection), 0.0);
    return color + lowLightHue * (liftedLuminance - luminance) * formCue;
  }

  vec3 applyPerceptualShadowFloor(vec3 color, vec3 albedo, vec3 normal, float adaptationStrength) {
    const vec3 LUMA = vec3(0.299, 0.587, 0.114);
    float luminance = dot(color, LUMA);
    float albedoLuminance = dot(albedo, LUMA);
    vec3 fillDirection = normalize(vec3(-0.35, 0.22, -0.91));
    float formCue = 0.35 + 0.65 * abs(dot(normal, fillDirection));
    float adaptation = mix(0.72, 1.0, clamp(adaptationStrength, 0.0, 1.0));
    // Faint navigable silhouettes for geometry no authored light reaches.
    //
    // These two numbers are DISPLAY luminance, not light-buffer values, and the
    // division by exposure is what makes that true. The floor is applied here,
    // before the tone stage multiplies by exposure, so specifying it in light
    // space made it silently exposure-dependent: correcting the stable profile
    // from 1.22 to 0.78 moved the floor from 0.095 display to 0.061 and dropped
    // unlit geometry off the bottom of the glyph ramp. Upgrade 85's own notes
    // warned about exactly that failure and it happened anyway, because the
    // coupling was invisible at the point of change. Expressed this way the
    // floor survives any future exposure retune untouched.
    //
    // The values are deliberately well above the 0.078 the game shipped with.
    // At that level an unlit room read as a void rather than as a dark space,
    // and bright fixtures floated in nothing. Measured lamp-off, this lifts the
    // frame's pure black from 66.5% to 46.6% with the recovered pixels landing
    // in the faintest visible band. Surfaces already brighter than the floor
    // are untouched, so authored lighting and highlights do not move.
    //
    // u_visibilityFloor SCALES that pair rather than replacing it, so the two
    // display numbers keep their ratio (the form cue) at every setting, and so
    // the default of exactly 1.0 is bit-identical by IEEE rather than by
    // approximation. Liminal's facility interiors want 1; an outdoor night
    // city that needs an alley to actually go black wants it near 0, and then
    // wants u_shadowLift above to give the dim band its separation back.
    float visibilityFloor = mix(0.158, 0.213, formCue) * u_visibilityFloor * adaptation
      / max(u_toneExposure, 0.01);
    float deficit = max(visibilityFloor - luminance, 0.0);
    vec3 albedoHue = albedo / max(albedoLuminance, 0.001);
    vec3 tintHue = u_shadowTint / max(dot(u_shadowTint, LUMA), 0.001);
    vec3 shadowHue = mix(tintHue, albedoHue, smoothstep(0.01, 0.12, albedoLuminance) * 0.38);
    return color + shadowHue * deficit;
  }

  ivec2 lightVisibilityCell(vec3 worldPos, uint surfaceCellCode) {
    // Zero means this geometry has no declared grid face. Preserve its exact
    // previous lookup, including noninteger, curved and horizontal surfaces.
    if (surfaceCellCode == 0u || u_lightVisibilityMapSize.x <= 0) {
      return ivec2(floor(worldPos.xy));
    }
    uint index = surfaceCellCode - 1u;
    uint width = uint(u_lightVisibilityMapSize.x);
    return ivec2(int(index % width), int(index / width));
  }

  float sampleLightVisibility(int lightIndex, ivec2 cell) {
    if (!u_castShadowsEnabled || lightIndex >= u_lightVisibilityLayerCount) return 1.0;
    if (any(lessThan(cell, ivec2(0))) || any(greaterThanEqual(cell, u_lightVisibilityMapSize))) return 1.0;
    int layer = clamp(lightIndex, 0, u_lightVisibilityLayerCount - 1);
    int atlasY = cell.y + layer * u_lightVisibilityMapSize.y;
    float visibility = texelFetch(u_lightVisibility, ivec2(cell.x, atlasY), 0).r;
    return mix(u_shadowFloor, 1.0, visibility);
  }

  float projectedLightWeight(PointLight light, vec3 worldPos) {
    vec3 fromLight = worldPos - light.projectionOrigin.xyz;
    float distanceFromLight = length(fromLight);
    float alignment = dot(fromLight / max(distanceFromLight, 0.001), normalize(light.direction));
    float coneWeight = distanceFromLight < 0.001 ? 1.0
      : smoothstep(light.outerConeCos, light.innerConeCos, alignment);
    // A finite aperture fades in ahead of its physical emitter, avoiding
    // backward self-lighting and a hard near-plane stripe. Default cones are
    // unchanged (zero virtual-origin offset).
    float front = dot(worldPos - light.position, light.direction);
    float nearWeight = light.projectionOrigin.w > 0.0
      ? smoothstep(0.0, light.projectionOrigin.w, front) : 1.0;
    coneWeight *= nearWeight;
    return mix(1.0, coneWeight, clamp(light.spotBlend, 0.0, 1.0));
  }

  /**
   * Flashlight occlusion from the depth map.
   *
   * The offset is applied along the surface normal rather than as a pure depth
   * bias. A depth bias large enough to clear acne on the grazing surfaces this
   * game is full of also detaches contact shadows from their caster; offsetting
   * along the normal scales naturally with the geometry instead.
   */
  float sampleFlashlightShadow(vec3 worldPos, vec3 normal) {
    if (!u_flashlightShadowsEnabled) return 1.0;

    vec4 lightClip = u_flashlightViewProjection * vec4(worldPos + normal * u_shadowNormalBias, 1.0);
    if (lightClip.w <= 0.0) return 1.0;

    vec3 projected = lightClip.xyz / lightClip.w * 0.5 + 0.5;
    // Outside the map is unshadowed, not black: the cone mask already handles
    // everything beyond the beam.
    if (any(lessThan(projected.xy, vec2(0.0))) || any(greaterThan(projected.xy, vec2(1.0)))) return 1.0;
    if (projected.z > 1.0) return 1.0;

    float compareDepth = projected.z - u_shadowDepthBias;
    float visibility = 0.0;
    for (int y = -1; y <= 1; y++) {
      for (int x = -1; x <= 1; x++) {
        vec2 offset = vec2(float(x), float(y)) * u_shadowTexelSize;
        visibility += texture(u_flashlightShadowMap, vec3(projected.xy + offset, compareDepth));
      }
    }
    // Nine hardware comparison taps, each already 2x2 filtered.
    return visibility / 9.0;
  }

  vec3 calculateVolumetricScattering(vec3 worldPos) {
    if (!u_environmentalFxEnabled || u_volumetricStrength <= 0.001) return vec3(0.0);
    vec3 rayDelta = worldPos - u_cameraPos;
    float rayLength = max(length(rayDelta), 0.001);
    vec3 rayDirection = rayDelta / rayLength;
    float depthWeight = 1.0 - exp(-rayLength * 0.16);
    vec3 scattering = vec3(0.0);

    if (u_flashlightOn) {
      float coneAlignment = dot(rayDirection, normalize(u_flashlightDir));
      float coneWeight = smoothstep(0.88, 0.985, coneAlignment);
      float batteryOutput = mix(0.58, 1.0, u_batteryFactor);
      scattering += vec3(0.52, 0.64, 0.7) * coneWeight * depthWeight * batteryOutput;
    }

    // The slot list replaces the historical 'i >= 8' positional cap; the two
    // guards below stay IN the shader, exactly as they were, so the CPU
    // selection only ever decides WHICH lights are considered, never how one
    // contributes. Indices arrive in ascending array order (see the uniform's
    // comment), keeping the summation order — and therefore the float sum —
    // identical for scenes the old cap already served.
    for (int slot = 0; slot < MAX_VOLUMETRIC_LIGHTS; slot++) {
      if (slot >= u_numVolumetricLights) break;
      int i = u_volumetricIndices[slot];
      if (distance(u_lights[i].position, u_cameraPos) < 0.75) continue;
      if (u_lights[i].volumetricInfluence <= 0.001) continue;
      vec3 toLight = u_lights[i].position - u_cameraPos;
      float closestDistance = dot(toLight, rayDirection);
      vec3 closestPoint = u_cameraPos + rayDirection * clamp(closestDistance, 0.0, rayLength);
      float radialDistance = distance(u_cameraPos + rayDirection * closestDistance, u_lights[i].position);
      float radialWeight = 1.0 - smoothstep(u_lights[i].range * 0.18, u_lights[i].range, radialDistance);
      float projectionWeight = projectedLightWeight(u_lights[i], closestPoint);
      // Airlight is how far the ray travels through the light's influence
      // sphere, not how distant the surface it happens to land on is. Scaling
      // by depthWeight made a near object a hole in the glow and the far
      // background around it full brightness, so the step traced every
      // silhouette - the "bubble" around each exhibit.
      float halfChord = sqrt(max(u_lights[i].range * u_lights[i].range - radialDistance * radialDistance, 0.0));
      float entry = clamp(closestDistance - halfChord, 0.0, rayLength);
      float exitPoint = clamp(closestDistance + halfChord, 0.0, rayLength);
      float pathWeight = (exitPoint - entry) / max(2.0 * u_lights[i].range, 0.001);
      scattering += u_lights[i].color * radialWeight * radialWeight * projectionWeight * pathWeight
        * u_lights[i].volumetricInfluence * min(u_lights[i].intensity, 1.5) * 0.34;
    }

    return scattering * u_volumetricStrength;
  }

  float skylineHash(float n) {
    return fract(sin(n * 127.1 + u_skylineSeed * 311.7) * 43758.5453);
  }

  /**
   * One band of tower silhouettes: 1.0 where this ray is inside a tower,
   * else 0.0. An INTEGER number of azimuth slots fits the full circle, so the
   * field is seamless across the atan wrap; each slot hashes whether it holds
   * a tower at all (gaps), the tower's width (a centred fraction of the
   * slot), and its height (quantized in coarse elevation steps so the tops
   * sit on flat lines rather than per-pixel noise — every feature is many
   * display cells wide even on the coarsest grid, no single-pixel teeth).
   */
  float skylineBand(float azimuth, float elevation, float slots, float bandSeed, float maxHeight) {
    float turns = (azimuth + 3.14159265) / 6.2831853 * slots;
    float slot = floor(turns);
    if (skylineHash(slot * 3.7 + bandSeed) < 0.22) return 0.0;
    float local = fract(turns);
    float width = 0.38 + skylineHash(slot * 9.1 + bandSeed + 57.0) * 0.5;
    float inset = (1.0 - width) * 0.5;
    if (local < inset || local > 1.0 - inset) return 0.0;
    float height = maxHeight * (0.3 + 0.7 * skylineHash(slot * 5.3 + bandSeed + 113.0));
    height = floor(height / 0.012) * 0.012;
    return elevation < height ? 1.0 : 0.0;
  }

  vec3 skyColor(vec2 uv) {
    vec2 ndc = uv * 2.0 - 1.0;
    vec3 ray = normalize(u_skyCameraForward + u_skyCameraRight * ndc.x + u_skyCameraUp * ndc.y);
    // World up is -z, so elevation is the negated vertical component.
    float elevation = clamp(-ray.z, -1.0, 1.0);
    vec3 sky = mix(u_skyHorizonColor, u_skyTopColor, pow(clamp(elevation, 0.0, 1.0), 0.62));
    // Below the horizon no geometry covered the pixel, which only happens at
    // the open edge of the world; settle those rays into the fog so the void
    // reads as haze rather than a hole.
    sky = mix(sky, u_fogColor, clamp(-elevation * 2.5, 0.0, 1.0));
    // Stars live in a hash-cell grid on a stereographic dome anchored to the
    // world axes, so they hold still under camera rotation. Sized in dome
    // space so a star covers a couple of glyph cells rather than sub-cell
    // shimmer; u_starBrightness is the dawn's dimmer switch.
    // Horizon glow first: the wash-out mask below must see the sky the
    // viewer actually sees, or stars/dither print into the bright dawn band.
    float flatLength = max(length(ray.xy), 0.001);
    float alignment = max(dot(ray.xy / flatLength, u_skyGlowDir), 0.0);
    float horizonBand = pow(1.0 - clamp(abs(elevation), 0.0, 1.0), 3.0);
    vec3 skyOut = sky + u_skyGlowColor * (u_skyGlowStrength * pow(alignment, u_skyGlowSharpness) * horizonBand);

    // Stars wash out against a bright sky (and so does the dither) — without
    // this, a faint addition can tip a bright cell across a glyph-ramp
    // boundary and print as a dark speck.
    float skyLuma = dot(skyOut, vec3(0.299, 0.587, 0.114));
    float darkSky = clamp(1.0 - skyLuma * 2.4, 0.0, 1.0);

    // Horizon skyline: 2-3 overlapping tower bands, the nearer darker and
    // taller, all capped ~0.12 elevation so the band never eats the sky.
    // Applied HERE — after darkSky is measured off the open sky and before
    // the stars are added — so stars evaluate against the sky's own
    // brightness but never render through a silhouette, and a tower blocks
    // the horizon glow behind it (it darkens the glow-summed color).
    // Multiplicative darkening keeps a silhouette darker than whatever sky
    // gradient stands behind it at any strength.
    float skylineOcclusion = 0.0;
    if (u_skylineStrength > 0.001 && elevation >= 0.0 && elevation < 0.125) {
      float azimuth = atan(ray.y, ray.x);
      float nearBand = skylineBand(azimuth, elevation, 56.0, 0.0, 0.12);
      float midBand = skylineBand(azimuth, elevation, 80.0, 41.0, 0.085);
      float farBand = skylineBand(azimuth, elevation, 112.0, 89.0, 0.055);
      skylineOcclusion = max(nearBand, max(midBand * 0.78, farBand * 0.55))
        * clamp(u_skylineStrength, 0.0, 1.0);
      skyOut = mix(skyOut, skyOut * 0.07, skylineOcclusion);
    }

    if (u_starBrightness > 0.001 && u_starDensity > 0.001 && elevation > 0.03 && darkSky > 0.01 && skylineOcclusion <= 0.001) {
      vec2 dome = ray.xy / (1.12 + elevation);
      vec2 grid = dome * 26.0;
      vec2 cell = floor(grid);
      float cellHash = fract(sin(dot(cell, vec2(127.1, 311.7))) * 43758.5453);
      if (cellHash < 0.10 * u_starDensity) {
        vec2 starPos = cell + vec2(0.24, 0.24) + 0.52 * vec2(fract(cellHash * 71.0), fract(cellHash * 733.0));
        float starDist = length(grid - starPos);
        float magnitude = 0.35 + 0.65 * fract(cellHash * 991.0);
        // The gaussian must be negligible at the nearest possible cell
        // border (0.24 grid units) — a fatter core gets a straight chopped
        // edge there, since neighbors never evaluate this cell's star.
        float core = exp(-starDist * starDist * 90.0);
        float horizonFade = smoothstep(0.03, 0.12, elevation);
        skyOut += vec3(0.92, 0.95, 1.0) * (core * magnitude * u_starBrightness * horizonFade * darkSky * 2.0);
      }
    }
    if (u_fogDither > 0.0) {
      float bandNoise = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453);
      // Silhouette fills are flat by design; dither would speckle them.
      skyOut += (bandNoise - 0.5) * u_fogDither * darkSky * (1.0 - skylineOcclusion);
    }
    return skyOut;
  }

  void main() {
    ivec2 texelCoord = ivec2(gl_FragCoord.xy);
    vec4 normalData = texelFetch(u_gbufNormal, texelCoord, 0);
    vec3 normal = normalData.xyz;
    vec4 depthLuma = texelFetch(u_gbufDepthLuma, texelCoord, 0);
    vec3 worldPos = depthLuma.xyz;
    float isSelfLuminous = depthLuma.w;
    vec4 albedoData = texelFetch(u_gbufAlbedo, texelCoord, 0);
    vec3 albedo = albedoData.rgb;
    float lightResponse = albedoData.a;
    float packedRoughness = normalData.w;
    float roughness = packedRoughness <= -3.0 ? -packedRoughness - 3.0
      : packedRoughness < 0.0 ? -packedRoughness - 1.0 : packedRoughness;

    if (length(normal) < 0.1) {
      outLightColor = u_skyEnabled
        ? vec4(skyColor(v_uv), 1.0)
        : vec4(0.0, 0.0, 0.0, 1.0);
      return;
    }

    if (isSelfLuminous > 0.95) {
      // Emissive surfaces drive past 1.0 so they read as sources rather than
      // as merely pale geometry once the tonemap rolls the highlights off.
      //
      // They still need form. This branch used to return pure albedo, so a
      // large emissive wall was perfectly uniform across its whole area and
      // the glyph pass had nothing to resolve but dither noise.
      //
      // A shallow normal response supplies that shape. Ambient occlusion must
      // NOT: it models ambient light being blocked, which has no meaning for a
      // surface emitting its own, and being screen-space it over-occludes
      // exactly where geometry is dense and close. Applying it here dimmed the
      // handheld scanner by up to 62% and put out its contact blips entirely.
      //
      // NOT ON THE OPERATIVE'S OWN INSTRUMENTS. emissiveFill is a fixed
      // world direction and the rig's normals are the camera's, so on a HUD
      // element this shallow response is a brightness dial the player turns -
      // the other half of the 1.5184x heading swing that was blanking the
      // scope's floor plan. The deferred pass cannot be told which draw a
      // fragment came from, so it uses the mask this renderer already has for
      // exactly this object: the near-eye radius the bloom bright-pass
      // excludes on. Same radius, same object, same reason.
      float hud = 1.0 - step(distance(worldPos, u_cameraPos), u_viewmodelRadius);
      vec3 emissiveFill = normalize(vec3(-0.35, 0.22, -0.91));
      float emissiveForm = mix(1.0, 0.82 + 0.18 * max(dot(normal, emissiveFill), 0.0), hud);
      // Authored near-eye lettering belongs to a powered instrument. A
      // room's dimmed emissive palette must not turn down its reading light.
      // World signs and ordinary sprites retain their scene emission level.
      bool instrumentArt = packedRoughness <= -3.0
        && distance(worldPos, u_cameraPos) < u_viewmodelRadius;
      float emissionLevel = instrumentArt ? max(1.0, u_emissiveIntensity) : u_emissiveIntensity;
      vec3 emissive = albedo * emissionLevel * emissiveForm;
      // The fog goes with it, and for the same reason: its volume loop reads
      // the view direction, so it is a second heading term on a surface half a
      // metre from the eye that no weather is between.
      // A node, a terminal or a rift standing inside a jamming field comes
      // apart with the rest of the room. It is world geometry and the field is
      // in the room with it; the near-eye mask inside applyCarrierLoss is what
      // keeps the operative's own instruments out of it.
      vec3 emissiveOut = mix(emissive, applyAtmosphericFog(emissive, worldPos), hud);
      outLightColor = vec4(applyCarrierLoss(emissiveOut, worldPos, jammingWeight(worldPos)), 1.0);
      return;
    }

    if (u_hasPortal && worldPos.z < -0.2 && normal.z > 0.5) {
      float dx = worldPos.x - u_portalPos.x;
      float dy = worldPos.y - u_portalPos.y;
      float dist = length(vec2(dx, dy));
      float maxRadius = 4.5;
      if (dist < maxRadius) {
        float angle = atan(dy, dx);
        float timeFactor = u_time * 0.005;
        float spiral = sin(dist * 3.0 - angle * 4.0 + timeFactor);
        
        float edgeFade = 1.0 - (dist / maxRadius);
        float intensity = max(0.0, (spiral * 0.5 + 0.5) * edgeFade);
        
        float coreFactor = pow(edgeFade, 2.0);
        vec3 portalColor = mix(u_portalColor, vec3(1.0), coreFactor) * intensity;
        
        outLightColor = vec4(portalColor, 1.0);
        return;
      }
    }

    // A pitch-black zone used to be a BOOLEAN here, and a boolean across a
    // continuous surface is a drawn edge. Both endpoints of this weight are
    // exactly what the boolean did: 1.0 anywhere inside the radius, 0.0 outside
    // the approach band. What is new is the three metres between them.
    float pitchBlack = pitchBlackDarkness(worldPos);
    float ambientFactor = u_ambientFactor * (1.0 - pitchBlack);
    float lowLightAdaptation = u_lowLightAdaptation * (1.0 - pitchBlack);
    float visibility = ambientVisibility(texelCoord, worldPos, normal);
    float flashlightStrength = 0.0;

    if (u_flashlightOn) {
      vec3 lightToPos = worldPos - u_flashlightOrigin;
      float dist = length(lightToPos);
      
      if (dist < u_flashlightRange) {
        vec3 F = normalize(u_flashlightDir);
        vec3 W_UP = vec3(0.0, 0.0, -1.0);
        
        vec3 R;
        if (abs(dot(F, W_UP)) > 0.99) {
          R = vec3(1.0, 0.0, 0.0);
        } else {
          R = normalize(cross(F, W_UP));
        }
        vec3 U = cross(R, F);
        
        float forwardDistance = dot(lightToPos, F);
        vec3 dirUnscaled = normalize(lightToPos);

        if (forwardDistance > 0.0) {
          float horizontalSlope = dot(lightToPos, R) / forwardDistance;
          float verticalSlope = dot(lightToPos, U) / forwardDistance;
          float ellipseDist = (horizontalSlope * horizontalSlope) / (u_flashlightHorizontalOuterTan * u_flashlightHorizontalOuterTan)
            + (verticalSlope * verticalSlope) / (u_flashlightVerticalOuterTan * u_flashlightVerticalOuterTan);
          // Falloff from the beam centre, not from 28% out. The old curve was
          // flat across the inner cone and flat across the near half of the
          // range, which under a hard LDR clamp was invisible but now reads as
          // a uniform pool with a hard edge pasted onto the floor.
          float beam = pow(1.0 - smoothstep(0.0, 1.0, ellipseDist), 1.4);
          float rangeFade = 1.0 - smoothstep(u_flashlightRange * 0.08, u_flashlightRange, dist);
          float surfaceFacing = 0.72 + 0.28 * max(dot(normal, -dirUnscaled), 0.0);
          float batteryOutput = mix(0.58, 1.0, u_batteryFactor);
          flashlightStrength = beam * rangeFade * surfaceFacing * batteryOutput
            * sampleFlashlightShadow(worldPos, normal);
        }
      }
    }

    vec3 viewVector = u_cameraPos - worldPos;
    vec3 viewDirection = viewVector / max(length(viewVector), 0.001);
    vec3 flashlightColor = vec3(1.48, 1.52, 1.58) * flashlightStrength;
    float flashlightVisibility = mix(0.82, 1.0, visibility);
    vec3 totalLight = albedo * (vec3(ambientFactor * visibility) + flashlightColor * flashlightVisibility);
    totalLight += albedo * isSelfLuminous * u_emissiveIntensity;

    uint surfaceCellCode = texelFetch(u_gbufVisibilityCell, texelCoord, 0).r;
    ivec2 visibilityCell = lightVisibilityCell(worldPos, surfaceCellCode);

    for (int i = 0; i < u_numLights; i++) {
      vec3 lightDir = u_lights[i].position - worldPos;
      lightDir.z *= 2.0;
      
      float dist = length(lightDir);
      if (dist > 0.001 && dist < u_lights[i].range) {
        vec3 nDir = lightDir / dist;
        float diff = max(dot(normal, nDir), 0.0);
        float attenuation = 1.0 - (dist / u_lights[i].range);
        float shadowVisibility = sampleLightVisibility(i, visibilityCell);
        // Museum exhibit lights are point approximations of overhead spots.
        // Their per-light floor influence suppresses the circular pool a point
        // light would otherwise paint beneath every model, without weakening
        // illumination on the model or the separate reflection pass.
        float horizontalFloor = 1.0 - step(-0.72, normal.z);
        float surfaceInfluence = mix(1.0, u_lights[i].floorInfluence, horizontalFloor);
        float projectionWeight = projectedLightWeight(u_lights[i], worldPos);
        float lightStrength = attenuation * u_lights[i].intensity * visibility * shadowVisibility * surfaceInfluence * projectionWeight;
        vec3 halfVector = nDir + viewDirection;
        vec3 halfDirection = halfVector / max(length(halfVector), 0.001);
        float specularPower = mix(72.0, 8.0, roughness);
        float specular = pow(max(dot(normal, halfDirection), 0.0), specularPower);
        specular *= (1.0 - roughness) * u_specularStrength;
        vec3 diffuseSurface = mix(vec3(1.0), albedo, lightResponse);
        totalLight += diffuseSurface * u_lights[i].color * diff * lightStrength;
        totalLight += u_lights[i].color * specular * lightStrength;
      }
    }

    totalLight += calculateVolumetricScattering(worldPos);
    totalLight = applyAtmosphericFog(totalLight, worldPos);
    totalLight = applyLowLightResponse(totalLight, normal, lowLightAdaptation);
    // The floor is what keeps an unlit room navigable, so a pitch-black zone
    // has to be able to take it away - but taking it away with an if is what
    // drew the circle. mix() reaches both former endpoints exactly and has three
    // metres of ramp between them.
    totalLight = mix(
      applyPerceptualShadowFloor(totalLight, albedo, normal, lowLightAdaptation),
      totalLight,
      pitchBlack
    );
    // LAST, and after the shadow floor on purpose: a floor applied over the snow
    // would lift every lost cell back to the same value and flatten the noise
    // into a wash.
    totalLight = applyCarrierLoss(totalLight, worldPos, jammingWeight(worldPos));
    // Upgrade 85: the light buffer is HDR. Values above 1.0 are kept so the
    // bloom chain can tell a flashlight hotspot from a lit wall, and so the
    // tonemap has a highlight range to roll off. Only the negative side is
    // clamped, since scattering terms can undershoot slightly.
    outLightColor = vec4(max(totalLight, 0.0), 1.0);
  }
`;

export const asciiVS = lightVS;

export const surfaceVS = lightVS;

export const cellVS = lightVS;

export const glyphVS = lightVS;

export const bloomVS = lightVS;

/**
 * Both scene raster paths sample only the selected glyph, even at fractional
 * one-pixel cells. Large cells keep the normal stroke threshold; tiny cells
 * keep sparse marks whose averaged ink would otherwise disappear.
 */
const GLYPH_RASTER_BLOCK = `
  const float GLYPH_COVERAGE_THRESHOLD = 0.1;
${STROKE_GLYPH_BLOCK}
  float sampleGlyphCoverage(vec2 glyph, vec2 local, vec2 cellSize) {
    // Opt-in per-pixel strokes and shades; see StrokeGlyphs.js.
    if (u_strokeGlyphs) {
      float stroke = strokeGlyphCoverage(int(glyph.y * u_atlasSize.x + glyph.x + 0.5), local, cellSize);
      if (stroke >= 0.0) return stroke;
    }
    vec2 glyphPixels = vec2(textureSize(u_fontAtlas, 0)) / u_atlasSize;
    // Beyond this mip level a texel contains more than one atlas character.
    float maxLod = floor(log2(min(glyphPixels.x, glyphPixels.y)));
    float requestedLod = max(log2(max(glyphPixels.x / cellSize.x,
                                     glyphPixels.y / cellSize.y)), 0.0);
    float lod = min(requestedLod, maxLod);
    // Trilinear filtering also reads the next coarser level. Keep its entire
    // bilinear footprint inside this glyph, including at fractional cell edges.
    vec2 margin = 0.5 * exp2(ceil(lod)) / glyphPixels;
    vec2 uv = (glyph + clamp(local, margin, 1.0 - margin)) / u_atlasSize;
    float coverage = textureLod(u_fontAtlas, uv, lod).r;
    // Our 32x64 atlas cell ends at a 1x2 footprint. Synthesize its last 1x1
    // mip from the centre of those two texels rather than reading the atlas
    // mip that mixes neighbouring glyphs. This also removes phase-dependent
    // holes in sparse marks at fractional one-pixel sizes.
    if (requestedLod > maxLod) {
      float average = textureLod(u_fontAtlas, (glyph + 0.5) / u_atlasSize, maxLod).r;
      coverage = mix(coverage, average, min(requestedLod - maxLod, 1.0));
    }
    return coverage;
  }

  float glyphCoverageThreshold(vec2 cellSize) {
    // A dot's average ink is below 0.1. At one-pixel sizes that is still a
    // visible mark, not a blank glyph. Losing it makes adjacent sprite-ramp
    // rungs alternate whole cells between black and colour (moving plaid).
    // Zero coverage stays empty; readable ASCII retains its stroke threshold.
    return mix(0.001, GLYPH_COVERAGE_THRESHOLD,
               smoothstep(2.0, 4.0, max(cellSize.x, cellSize.y)));
  }
`;

/**
 * Engine-rendered HUD: a coarse grid of glyph cells composited over the
 * finished frame by both final passes. Each HUD cell is u_hudCellSize pixels
 * (independent of the scene's glyph cells, so HUD text stays readable at
 * every resolution contract) and is one texel of u_hudCells: rgb = glyph
 * color, a = glyph index / 255, index 0 = empty; bit 7 of that byte is a
 * backing plate that darkens the frame under the cell (HudGlyphLayer.plate).
 * Glyphs come from the same font atlas as the scene (16x8 grid), drawn with a
 * soft offset shadow so they survive bright skies. Over them, the HUD image
 * (u_hudImage at u_hudImageRect, bottom-left pixels; setHudImage). Shared
 * verbatim by glyphFS and asciiFS.
 */
// Screen-space feedback uses the existing final pass; no new DOM/GPU raster
// layer, render target, texture or shader program is created on first use.
const SCREEN_FLASH_BLOCK = `
  uniform float u_screenFlashOpacity;
  uniform float u_screenFlashMiddleStop;
  uniform vec2 u_screenFlashResolution;
  uniform vec4 u_screenFlashInner;
  uniform vec4 u_screenFlashMiddle;
  uniform vec4 u_screenFlashOuter;

  vec3 applyScreenFlash(vec3 color) {
    if (u_screenFlashOpacity <= 0.0) return color;
    // Circle/farthest-corner in output pixels, independent of aspect ratio.
    vec2 halfSize = u_screenFlashResolution * 0.5;
    float radius = clamp(length(gl_FragCoord.xy - halfSize) / length(halfSize), 0.0, 1.0);
    vec4 a = radius <= u_screenFlashMiddleStop ? u_screenFlashInner : u_screenFlashMiddle;
    vec4 b = radius <= u_screenFlashMiddleStop ? u_screenFlashMiddle : u_screenFlashOuter;
    float t = radius <= u_screenFlashMiddleStop ? radius / u_screenFlashMiddleStop
      : (radius - u_screenFlashMiddleStop) / (1.0 - u_screenFlashMiddleStop);
    // Interpolate premultiplied stops like CSS gradients, then composite.
    vec4 stop = mix(vec4(a.rgb * a.a, a.a), vec4(b.rgb * b.a, b.a), t);
    return color * (1.0 - stop.a * u_screenFlashOpacity) + stop.rgb * u_screenFlashOpacity;
  }
`;

const HUD_BLOCK = `
  uniform bool u_hudEnabled;
  uniform sampler2D u_hudCells;
  uniform vec2 u_hudCellSize;
  uniform ivec2 u_hudGrid;
  uniform bool u_hudImageEnabled;
  uniform sampler2D u_hudImage;
  uniform vec4 u_hudImageRect;

  vec3 applyHudCells(vec3 sceneColor) {
    if (!u_hudEnabled) return sceneColor;
    vec2 hudCoord = gl_FragCoord.xy / u_hudCellSize;
    ivec2 hudCell = ivec2(floor(hudCoord));
    if (hudCell.x < 0 || hudCell.y < 0 ||
        hudCell.x >= u_hudGrid.x || hudCell.y >= u_hudGrid.y) {
      return sceneColor;
    }
    vec4 hudData = texelFetch(u_hudCells, hudCell, 0);
    int hudByte = int(hudData.a * 255.0 + 0.5);
    int hudGlyph = hudByte & 127;
    if ((hudByte & 128) != 0) sceneColor *= 0.25;
    if (hudGlyph == 0) return sceneColor;

    vec2 local = fract(hudCoord);
    local.y = 1.0 - local.y;
    float col = mod(float(hudGlyph), 16.0);
    float row = floor(float(hudGlyph) / 16.0);
    vec2 ddxUV = vec2(1.0 / (u_hudCellSize.x * 16.0), 0.0);
    vec2 ddyUV = vec2(0.0, 1.0 / (u_hudCellSize.y * 8.0));
    vec2 glyphUV = (vec2(col, row) + local) / vec2(16.0, 8.0);
    float ink = textureGrad(u_fontAtlas, glyphUV, ddxUV, ddyUV).r;
    // local runs top-down here, so subtracting moves the shadow right and
    // DOWN. A negative y lifted it above the glyph, which read as a dark
    // double of every HUD word over a bright wall.
    vec2 shadowLocal = clamp(local - vec2(0.16, 0.16), 0.0, 1.0);
    vec2 shadowUV = (vec2(col, row) + shadowLocal) / vec2(16.0, 8.0);
    float shadowInk = textureGrad(u_fontAtlas, shadowUV, ddxUV, ddyUV).r;

    vec3 shadowed = mix(sceneColor, vec3(0.0), smoothstep(0.25, 0.7, shadowInk) * 0.6);
    return mix(shadowed, hudData.rgb, smoothstep(0.22, 0.55, ink));
  }

  // The HUD image (setHudImage): a caller's own picture, such as a reticle
  // drawn in lines finer than the HUD's cells, over the frame and the HUD's
  // cells at one texel a pixel, its straight alpha over what is under it.
  // Bloom, tone and fog are done by here, so none of them washes it out.
  vec3 applyHudImage(vec3 color) {
    if (!u_hudImageEnabled) return color;
    vec2 local = (gl_FragCoord.xy - u_hudImageRect.xy) / u_hudImageRect.zw;
    if (any(lessThan(local, vec2(0.0))) || any(greaterThanEqual(local, vec2(1.0)))) return color;
    vec4 image = texture(u_hudImage, local);
    return mix(color, image.rgb, image.a);
  }

  vec3 applyHudGlyphs(vec3 sceneColor) {
    return applyHudImage(applyHudCells(sceneColor));
  }
`;

/**
 * Upgrade 85 tone stage, shared verbatim by the two-pass reduce and the legacy
 * single-pass shader. GLSL has no include, so it is interpolated into both
 * rather than maintained twice and allowed to drift.
 */
const TONE_BLOCK = `
  uniform sampler2D u_bloomTexture;
  uniform float u_bloomIntensity;
  uniform float u_exposure;
  uniform vec3 u_gradeLift;
  uniform vec3 u_gradeGain;
  uniform float u_gradeGamma;
  uniform float u_gradeSaturation;
  uniform float u_highlightDesaturation;
  uniform float u_gradeBlackPoint;
  uniform float u_toneKnee;

  const vec3 TONE_LUMA = vec3(0.299, 0.587, 0.114);

  /**
   * Highlight rolloff that is the identity below the knee.
   *
   * A full filmic shoulder (ACES and friends) assumes a hundred-to-one scene
   * range. This renderer's lighting was authored against a direct LDR display
   * and spans closer to twenty to one, so an aggressive shoulder compresses
   * precisely where all the content sits: lit walls flattened into slabs and
   * the wax museum, whose ambient is 0.72, went uniformly grey. Lowering
   * exposure to compensate instead sank the perceptual shadow floor below the
   * ramp's first visible glyph.
   *
   * Everything under the knee therefore passes through untouched, preserving
   * the authored tonal relationships exactly, and only the range that HDR
   * newly made reachable - emissives, flashlight hotspots, bloom - is rolled
   * off. The curve is C1 continuous at the knee and asymptotic to 1.0.
   */
  float toneCurve(float x) {
    if (x <= u_toneKnee) return x;
    float range = max(1.0 - u_toneKnee, 0.001);
    float over = x - u_toneKnee;
    return u_toneKnee + range * over / (over + range);
  }

  vec3 tonemap(vec3 color) {
    float peak = max(max(color.r, color.g), max(color.b, 1e-5));
    float mapped = toneCurve(peak);
    // Hue-preserving below and at the knee; a per-channel roll takes over in
    // the highlights. Pure ratio preservation never desaturates, so a surface's
    // chromaticity became independent of how hard it was lit and bright panels
    // read as flat colour. Pure per-channel drains the phosphor palette. The
    // blend keeps midtone colour and lets genuine intensity bend toward white.
    vec3 huePreserved = color * (mapped / peak);
    vec3 perChannel = vec3(toneCurve(color.r), toneCurve(color.g), toneCurve(color.b));
    float intensity = smoothstep(u_toneKnee, 1.0, mapped) * u_highlightDesaturation;
    return mix(huePreserved, perChannel, intensity);
  }

  // Per-dimension grading. Lift/gain, gamma and saturation give each atmosphere
  // profile its own response curve rather than only a fog colour and an
  // ambient level.
  vec3 grade(vec3 color) {
    // Soft toe rather than a black-point subtract. Bloom is the only thing
    // lifting the blacks now that the curve is the identity below the knee, and
    // it needs crushing - but a hard subtract also sinks the perceptual shadow
    // floor, which sits at 0.078 precisely so unlit geometry lands on the
    // ramp's first visible glyph. This leaves anything at or above the floor
    // untouched and rolls only genuinely near-black haze away.
    // Driven by luminance so the toe cannot shift hue in the darks.
    float toeLuminance = dot(color, TONE_LUMA);
    vec3 floored = color * smoothstep(0.0, u_gradeBlackPoint * 2.0, toeLuminance);
    vec3 lifted = max(u_gradeLift + floored * (u_gradeGain - u_gradeLift), 0.0);
    vec3 shaped = pow(lifted, vec3(max(u_gradeGamma, 0.01)));
    float luminance = dot(shaped, TONE_LUMA);
    return max(mix(vec3(luminance), shaped, u_gradeSaturation), 0.0);
  }

  vec3 resolveDisplayColor(vec3 hdrColor, vec3 bloomColor) {
    return grade(tonemap((hdrColor + bloomColor * u_bloomIntensity) * u_exposure));
  }
`;

/**
 * Upgrade 85 bloom bright-pass and downsample.
 *
 * Runs on the HDR light buffer, so the threshold is a real radiometric cut
 * rather than a percentage of an already-clipped value. The previous nine-tap
 * bloom lived inside the cell reduce pass and could only ever redistribute
 * brightness that had already survived clamping.
 */
export const bloomPrefilterFS = `#version 300 es
  precision highp float;

  in vec2 v_uv;
  out vec4 outColor;

  uniform sampler2D u_source;
  uniform vec2 u_texelSize;
  uniform float u_threshold;
  uniform float u_softKnee;

  // World position per texel, used only to keep the first-person viewmodel out
  // of the bright pass.
  //
  // The operative's arms and handheld scanner sit ~0.3m from a lamp emitting
  // vec3(1.48, 1.52, 1.58), and the viewmodel materials additionally carry
  // authored emission of 0.7-1.0 as a pre-Upgrade-85 self-lighting hack. Both
  // put it far over any threshold this pass can be given, so it seeded the
  // blur chain and wrapped its own silhouette - and the whole frame - in a
  // halo. A first-person viewmodel is a HUD element wearing geometry's
  // clothes; it should be lit by the world but must not glow into it.
  //
  // Scaling by emission alone does not fix this: the flashlight term on its own
  // clears the threshold. The exclusion has to be positional.
  uniform sampler2D u_gbufDepthLuma;
  uniform vec3 u_cameraPos;
  uniform float u_nearExclude;

  float sceneWeight(vec2 uv) {
    vec3 worldPos = texture(u_gbufDepthLuma, uv).xyz;
    // Feathered so the boundary does not cut a hard edge across an arm that
    // straddles it, and so background texels are unaffected.
    return smoothstep(u_nearExclude * 0.75, u_nearExclude, distance(worldPos, u_cameraPos));
  }

  void main() {
    // Four bilinear taps at the corners of the source quad average sixteen
    // source texels, which keeps the downsample stable under motion.
    vec2 o0 = vec2(-1.0, -1.0) * u_texelSize;
    vec2 o1 = vec2(1.0, -1.0) * u_texelSize;
    vec2 o2 = vec2(-1.0, 1.0) * u_texelSize;
    vec2 o3 = vec2(1.0, 1.0) * u_texelSize;
    vec3 sum = texture(u_source, v_uv + o0).rgb * sceneWeight(v_uv + o0);
    sum += texture(u_source, v_uv + o1).rgb * sceneWeight(v_uv + o1);
    sum += texture(u_source, v_uv + o2).rgb * sceneWeight(v_uv + o2);
    sum += texture(u_source, v_uv + o3).rgb * sceneWeight(v_uv + o3);
    vec3 color = sum * 0.25;

    float brightness = max(color.r, max(color.g, color.b));
    // Soft knee so surfaces drifting through the threshold fade in instead of
    // switching on, which would pump as the flashlight sweeps.
    float knee = max(u_softKnee, 0.0001);
    float soft = clamp(brightness - u_threshold + knee, 0.0, 2.0 * knee);
    soft = soft * soft / (4.0 * knee);
    float contribution = max(soft, brightness - u_threshold) / max(brightness, 0.0001);

    outColor = vec4(color * contribution, 1.0);
  }
`;

/**
 * Separable Gaussian. Run once per axis; the renderer runs two passes per axis
 * at quarter resolution for a wider skirt than a single pass gives.
 */
export const bloomBlurFS = `#version 300 es
  precision highp float;

  in vec2 v_uv;
  out vec4 outColor;

  uniform sampler2D u_source;
  uniform vec2 u_direction;

  void main() {
    // Nine-tap Gaussian folded into five bilinear fetches.
    float weights[3] = float[](0.2270270270, 0.3162162162, 0.0702702703);
    float offsets[3] = float[](0.0, 1.3846153846, 3.2307692308);

    vec3 color = texture(u_source, v_uv).rgb * weights[0];
    for (int i = 1; i < 3; i++) {
      vec2 offset = u_direction * offsets[i];
      color += texture(u_source, v_uv + offset).rgb * weights[i];
      color += texture(u_source, v_uv - offset).rgb * weights[i];
    }
    outColor = vec4(color, 1.0);
  }
`;

// Optional colour fade above a ramp's first visible mark. The black cutoff
// stays fixed; only the jump from black to full ink is softened. Shared by
// legacy and supersampled paths so adaptive quality keeps the same shadows.
const SHADOW_GLYPH_BLOCK = `
  const float lumaScale[13] = float[](0.0, 0.08, 0.15, 0.22, 0.3, 0.38, 0.45, 0.55, 0.65, 0.75, 0.82, 0.9, 1.0);
  uniform float u_shadowFadeWidth;
  uniform bool u_darkWorldGlyphs;

  // Campaign-derived content policy, opt-in for dim industrial interiors.
  // Preserve actual RGB and actor ramps; never promote empty sky or near-black.
  int resolveDarkWorldGlyph(int glyph, float luma, bool isSprite) {
    if (!u_darkWorldGlyphs || isSprite || glyph != 0 || luma < 0.035) return glyph;
    for (int i = 0; i < 13; i++) {
      if (u_charIndices[i] != 0) return u_charIndices[i];
    }
    return glyph;
  }


  float shadowInkWeight(float luma, bool isSprite) {
    if (u_shadowFadeWidth <= 0.0) return 1.0;
    for (int i = 0; i < 13; i++) {
      int glyph = isSprite ? u_spriteCharIndices[i] : u_charIndices[i];
      if (glyph != 0) {
        // Ramps that start with ink have no blank-to-ink cliff.
        if (i == 0) return 1.0;
        return smoothstep(lumaScale[i], lumaScale[i] + u_shadowFadeWidth, luma);
      }
    }
    return 0.0;
  }
`;

/**
 * Upgrade 83 pass 3a - cell reduce.
 *
 * Runs once per glyph cell against a supersampled scene buffer and resolves the
 * cell to a single foreground colour plus a glyph index. Doing the reduction at
 * grid resolution rather than inside the glyph raster keeps the per-cell gather
 * off the 1080p output, where every pixel of a cell would repeat identical work.
 */
export const cellFS = `#version 300 es
  precision highp float;

  in vec2 v_uv;
  layout(location = 0) out vec4 outCell;
  layout(location = 1) out vec4 outCellBackground;

  uniform sampler2D u_accumulatedColor;
  uniform sampler2D u_gbufNormal;
  uniform vec2 u_gridResolution;
  uniform int u_samplesPerAxis;
  uniform int u_charIndices[13];
  uniform int u_spriteCharIndices[13];
  uniform int u_quadrantGlyphs[16];
  uniform sampler2D u_previousCell;
  uniform sampler2D u_previousCellBackground;
  uniform bool u_historyValid;
  uniform float u_glyphHysteresis;
  uniform float u_colorHysteresis;
  uniform float u_signalReleaseThreshold;
  uniform bool u_structuralGlyphs;
  uniform bool u_subCellColor;
  uniform float u_subCellContrast;
  uniform float u_subCellCoherence;
  uniform float u_edgeThreshold;
  uniform float u_highlightPreservation;
  uniform bool u_ditherEnabled;
  uniform float u_glitchFactor;
  // Opt-in glitch style (effects.glitchGlyphs / glitchPalette). Counts of 0
  // keep the historical glyph set and cyan shift.
  uniform int u_glitchGlyphCount;
  uniform int u_glitchGlyphs[8];
  uniform int u_glitchColorCount;
  uniform vec3 u_glitchColors[4];
  uniform float u_time;

${TONE_BLOCK}

${SHADOW_GLYPH_BLOCK}
  const vec3 LUMA = vec3(0.299, 0.587, 0.114);

  // Structural glyph atlas indices, mirrored from STRUCTURAL_GLYPHS in
  // GlyphPipeline.js where they are derived from the glyph string rather than
  // counted by hand. The retired single-pass shader used 93 for the vertical
  // bar, which is '}'.
  const int GLYPH_ARC_LEFT = 8;
  const int GLYPH_ARC_RIGHT = 9;
  const int GLYPH_HORIZONTAL = 13;
  const int GLYPH_DIAGONAL_UP = 15;
  const int GLYPH_DIAGONAL_DOWN = 60;
  const int GLYPH_VERTICAL = 92;

  // The empty cell, mirrored from BLANK_GLYPH_INDEX in GlyphPipeline.js where
  // it is derived from the glyph string. The ordered dither below refuses to
  // promote out of it - see ditherMayPromote for why.
  const int GLYPH_BLANK = 0;

  // Written into the background attachment's otherwise unused alpha so the next
  // frame can tell which branch resolved this cell.
  const float CATEGORY_EMPTY = 0.0;
  const float CATEGORY_RAMP = 1.0;
  const float CATEGORY_STRUCTURAL = 2.0;
  const float CATEGORY_QUADRANT = 3.0;
  const float CATEGORY_PRESERVED_ART = 4.0;

  // With sky enabled, uncovered taps carry the sky the light pass painted
  // instead of black, and every cell resolves as fully covered. Off, the
  // resolve below is exactly the interior behavior it has always had.
  uniform bool u_skyEnabled;

  float rand(vec2 co) {
    return fract(sin(dot(co, vec2(12.9898, 78.233))) * 43758.5453);
  }

  float bayer4(ivec2 cell) {
    int pattern[16] = int[](0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5);
    int index = (cell.y - (cell.y / 4) * 4) * 4 + (cell.x - (cell.x / 4) * 4);
    return (float(pattern[index]) + 0.5) / 16.0;
  }

  void main() {
    vec2 cellIndex = floor(gl_FragCoord.xy);
    vec2 cellSizeUV = 1.0 / u_gridResolution;
    vec2 cellCenterUV = (cellIndex + 0.5) * cellSizeUV;

    int taps = clamp(u_samplesPerAxis, 1, 4);
    float tapCount = float(taps * taps);

    // Coverage accumulates separately from colour. A cell that a silhouette
    // only partly fills then resolves to a sparser glyph in the object's own
    // colour, instead of popping fully on or fully off as the camera moves.
    vec3 colorSum = vec3(0.0);
    vec3 normalSum = vec3(0.0);
    vec3 peakColor = vec3(0.0);
    float peakLuma = -1.0;
    float covered = 0.0;
    float spriteVotes = 0.0;
    float preservedArtVotes = 0.0;

    // Kept for the two-colour resolve below. An unoccupied tap contributes
    // black rather than being skipped, so a silhouette edge clusters into
    // "object" and "empty" and resolves to a hard boundary instead of a
    // uniformly dimmed cell.
    vec3 tapColors[16];
    float tapLumas[16];
    int tapQuadrants[16];
    vec2 tapOffsets[16];
    int sampleCount = 0;

    for (int j = 0; j < 4; j++) {
      if (j >= taps) break;
      for (int i = 0; i < 4; i++) {
        if (i >= taps) break;
        vec2 offset = (vec2(float(i), float(j)) + 0.5) / float(taps);
        vec2 sampleUV = (cellIndex + offset) * cellSizeUV;
        vec4 normalData = texture(u_gbufNormal, sampleUV);
        float occupied = step(0.1, length(normalData.xyz));
        covered += occupied;
        normalSum += normalData.xyz * occupied;
        // Tonemapping each sample before averaging keeps a single blown-out
        // sub-sample from dominating the cell, and puts the luminance the
        // glyph ramp reads into display space where its steps were tuned.
        vec3 tapColor = resolveDisplayColor(
          texture(u_accumulatedColor, sampleUV).rgb,
          texture(u_bloomTexture, sampleUV).rgb
        ) * (u_skyEnabled ? 1.0 : occupied);
        colorSum += tapColor;
        float tapLuma = dot(tapColor, LUMA);
        if (tapLuma > peakLuma) {
          peakLuma = tapLuma;
          peakColor = tapColor;
        }
        spriteVotes += occupied * step(normalData.w, -0.0001);
        preservedArtVotes += occupied * step(normalData.w, -3.0);

        // Quadrant bits follow the render target, where +y is up, so the
        // higher sub-cell rows are the upper quadrants.
        bool right = offset.x >= 0.5;
        bool upper = offset.y >= 0.5;
        tapColors[sampleCount] = tapColor;
        tapLumas[sampleCount] = tapLuma;
        tapOffsets[sampleCount] = offset;
        tapQuadrants[sampleCount] = upper ? (right ? 1 : 0) : (right ? 3 : 2);
        sampleCount++;
      }
    }

    if (covered <= 0.0 && !u_skyEnabled) {
      outCell = vec4(0.0, 0.0, 0.0, 0.0);
      outCellBackground = vec4(0.0, 0.0, 0.0, CATEGORY_EMPTY / 255.0);
      return;
    }

    // Sky taps count as coverage: a cell showing only sky is a full cell of
    // sky, and a silhouette edge is a boundary between building and sky, not
    // between building and nothing.
    float coverage = u_skyEnabled ? 1.0 : covered / tapCount;
    // A strict box average is correct but drops thin bright features - distant
    // conduit, signage and wiring - close to black, because most sub-samples in
    // their cell are dark. Leaning the cell partway toward its brightest sample
    // keeps that detail present while staying spatially averaged and stable,
    // rather than depending on which single texel a cell happened to hit.
    vec3 meanColor = colorSum / (u_skyEnabled ? tapCount : covered);
    // Authored lettering is already pixel art. Edge classification used to
    // hollow out its strokes, and temporal glyph retention could keep those
    // cuts after a page change. Store the sampled screen in both colours so
    // raster coverage cannot rewrite it; a separate category also prevents
    // this page from becoming history for ordinary world cells when closed.
    if (preservedArtVotes > tapCount * 0.5) {
      outCell = vec4(meanColor, 0.0);
      outCellBackground = vec4(meanColor, CATEGORY_PRESERVED_ART / 255.0);
      return;
    }
    vec3 color = mix(meanColor, peakColor, u_highlightPreservation);
    vec3 normal = covered > 0.0 ? normalize(normalSum) : vec3(0.0);
    bool isSprite = spriteVotes > covered * 0.5;

    // Bloom is no longer gathered here. It is a separate HDR chain running
    // before this pass, so it can spread real radiometric energy rather than
    // redistributing values that had already been clipped to 1.0.

    // Neighbouring cell centres, one full cell away. The retired shader stepped
    // 0.35 texels, which under NEAREST filtering resolved back to the centre
    // texel and left every gradient at exactly zero.
    float lumaTaps[9];
    vec3 normalTaps[9];
    for (int j = 0; j < 3; j++) {
      for (int i = 0; i < 3; i++) {
        vec2 sampleUV = cellCenterUV + vec2(float(i - 1), float(j - 1)) * cellSizeUV;
        int index = j * 3 + i;
        // Display space, so the edge thresholds stay meaningful rather than
        // scaling with whatever HDR range the scene happens to occupy.
        lumaTaps[index] = dot(resolveDisplayColor(
          texture(u_accumulatedColor, sampleUV).rgb,
          texture(u_bloomTexture, sampleUV).rgb
        ), LUMA);
        normalTaps[index] = texture(u_gbufNormal, sampleUV).xyz;
      }
    }

    float gradX = ((lumaTaps[2] + 2.0 * lumaTaps[5] + lumaTaps[8])
      - (lumaTaps[0] + 2.0 * lumaTaps[3] + lumaTaps[6])) * 0.25;
    float gradY = ((lumaTaps[6] + 2.0 * lumaTaps[7] + lumaTaps[8])
      - (lumaTaps[0] + 2.0 * lumaTaps[1] + lumaTaps[2])) * 0.25;

    vec3 normalGradX = normalTaps[5] - normalTaps[3];
    vec3 normalGradY = normalTaps[7] - normalTaps[1];
    float normalGradientX = length(normalGradX);
    float normalGradientY = length(normalGradY);
    vec3 curvatureX = normalTaps[5] + normalTaps[3] - 2.0 * normal;
    vec3 curvatureY = normalTaps[7] + normalTaps[1] - 2.0 * normal;

    float luma = dot(color, LUMA);
    if (isSprite) {
      // Saturated emissive sprites (especially the seeker's crimson head) carry
      // strong colour energy despite low perceptual red luminance. Keep their
      // glyph density from collapsing into sparse, black-looking cells.
      float strongestChannel = max(color.r, max(color.g, color.b));
      luma = max(luma, strongestChannel * 0.72);
    }
    luma *= coverage;

    // The two edge measures have different natural ranges, so each is scored
    // against its own threshold and the stronger response wins.
    float shadingEdge = length(vec2(gradX, gradY)) / max(u_edgeThreshold, 0.001);
    float geometryEdge = max(normalGradientX, normalGradientY) / 0.35;
    float edgeStrength = max(shadingEdge, geometryEdge);

    int glyphIndex = 0;
    vec3 backgroundColor = vec3(0.0);
    // How decisively this frame picked its branch, in [0,1]. A cell sitting on
    // a threshold scores near zero and is the kind that flips frame to frame.
    float decisionStrength = 1.0;
    float category = CATEGORY_RAMP;
    float quadrantConfidence = 0.0;
    float inkWeight = shadowInkWeight(luma, isSprite);

    // --- Two-colour resolve -----------------------------------------------
    // Split the cell's samples into a dark and a bright cluster with two
    // Lloyd iterations seeded at the extremes. When the clusters are well
    // separated the cell is describing a boundary, not an average, and a
    // quadrant glyph with distinct foreground and background carries that far
    // better than one density glyph on black.
    float lowSeed = tapLumas[0];
    float highSeed = tapLumas[0];
    for (int i = 0; i < 16; i++) {
      if (i >= sampleCount) break;
      lowSeed = min(lowSeed, tapLumas[i]);
      highSeed = max(highSeed, tapLumas[i]);
    }

    vec3 lowColor = vec3(0.0);
    vec3 highColor = vec3(0.0);
    float lowCount = 0.0;
    float highCount = 0.0;
    int quadrantMask = 0;

    if (u_subCellColor && highSeed - lowSeed > u_subCellContrast) {
      for (int iteration = 0; iteration < 2; iteration++) {
        float lowSum = 0.0;
        float highSum = 0.0;
        lowColor = vec3(0.0);
        highColor = vec3(0.0);
        lowCount = 0.0;
        highCount = 0.0;
        float midpoint = (lowSeed + highSeed) * 0.5;
        for (int i = 0; i < 16; i++) {
          if (i >= sampleCount) break;
          if (tapLumas[i] >= midpoint) {
            highSum += tapLumas[i];
            highColor += tapColors[i];
            highCount += 1.0;
          } else {
            lowSum += tapLumas[i];
            lowColor += tapColors[i];
            lowCount += 1.0;
          }
        }
        if (lowCount > 0.0) lowSeed = lowSum / lowCount;
        if (highCount > 0.0) highSeed = highSum / highCount;
      }

      if (lowCount > 0.0 && highCount > 0.0 && highSeed - lowSeed > u_subCellContrast) {
        lowColor /= lowCount;
        highColor /= highCount;

        // A quadrant belongs to the foreground when most of its samples do.
        float quadrantBright[4];
        float quadrantTotal[4];
        for (int q = 0; q < 4; q++) {
          quadrantBright[q] = 0.0;
          quadrantTotal[q] = 0.0;
        }
        float midpoint = (lowSeed + highSeed) * 0.5;
        vec2 brightCentroid = vec2(0.0);
        vec2 darkCentroid = vec2(0.0);
        for (int i = 0; i < 16; i++) {
          if (i >= sampleCount) break;
          int q = tapQuadrants[i];
          quadrantTotal[q] += 1.0;
          if (tapLumas[i] >= midpoint) {
            quadrantBright[q] += 1.0;
            brightCentroid += tapOffsets[i];
          } else {
            darkCentroid += tapOffsets[i];
          }
        }
        brightCentroid /= highCount;
        darkCentroid /= lowCount;

        // Bimodal luminance alone is not a boundary. Detailed surfaces split
        // into two clusters that are interleaved rather than separated, and
        // treating those as an edge speckles the whole wall. Requiring the two
        // clusters to occupy visibly different parts of the cell keeps the
        // quadrant path on real boundaries and leaves texture to the ramp.
        float separation = distance(brightCentroid, darkCentroid);
        if (separation > u_subCellCoherence) {
          for (int q = 0; q < 4; q++) {
            if (quadrantTotal[q] > 0.0 && quadrantBright[q] * 2.0 > quadrantTotal[q]) {
              quadrantMask += 1 << q;
            }
          }
          // Weakest of the two gates decides how safe this classification is.
          quadrantConfidence = min(
            (separation - u_subCellCoherence) / max(u_subCellCoherence, 0.001),
            (highSeed - lowSeed - u_subCellContrast) / max(u_subCellContrast, 0.001)
          );
        }
      }
    }

    // Masks 0 and 15 carry no sub-cell information, so they fall through to
    // the density ramp rather than flattening the cell to a single tone.
    if (quadrantMask > 0 && quadrantMask < 15) {
      category = CATEGORY_QUADRANT;
      decisionStrength = clamp(quadrantConfidence, 0.0, 1.0);
      glyphIndex = u_quadrantGlyphs[quadrantMask];
      // Carry the highlight lift and bloom this cell already earned onto the
      // foreground cluster. The background keeps the true dark-side colour, so
      // a silhouette edge stays black behind the object rather than haloing.
      color = highColor + (color - meanColor);
      backgroundColor = lowColor;
    } else if (u_structuralGlyphs && edgeStrength > 1.0 && coverage > 0.35 &&
               (geometryEdge > 1.0 || inkWeight >= 1.0)) {
      category = CATEGORY_STRUCTURAL;
      decisionStrength = clamp(edgeStrength - 1.0, 0.0, 1.0);
      float curvatureRatio = (length(curvatureX) + length(curvatureY))
        / max(normalGradientX + normalGradientY, 0.001);
      float dominant = max(normalGradientX, normalGradientY);
      float diagonalBalance = min(normalGradientX, normalGradientY) / max(dominant, 0.001);
      // Parentheses make rounded mesh contours read as arcs instead of a
      // staircase of diagonal strokes. Flat wall silhouettes fail the balance
      // test, so their directional treatment is unchanged.
      bool roundedContour = normalGradientX > normalGradientY * 1.15 &&
        diagonalBalance > 0.30 &&
        curvatureRatio > 0.85;

      if (roundedContour) {
        // The denser side is inside the silhouette: '(' for a left contour,
        // ')' for a right contour.
        glyphIndex = (length(normalTaps[5]) >= length(normalTaps[3])) ? GLYPH_ARC_LEFT : GLYPH_ARC_RIGHT;
      } else {
        // The gradient runs across the edge, so the stroke follows its
        // perpendicular. gl_FragCoord.y increases upward here, which makes a
        // first- or third-quadrant gradient a '\\' stroke and the others '/'.
        float absX = abs(gradX);
        float absY = abs(gradY);
        if (absX > absY * 2.0) {
          glyphIndex = GLYPH_VERTICAL;
        } else if (absY > absX * 2.0) {
          glyphIndex = GLYPH_HORIZONTAL;
        } else {
          glyphIndex = (gradX * gradY > 0.0) ? GLYPH_DIAGONAL_DOWN : GLYPH_DIAGONAL_UP;
        }
      }
    } else {
      int matched = 0;
      for (int i = 0; i < 13; i++) {
        if (luma >= lumaScale[i]) matched = i;
      }
      // Ordered dithering across the adjacent ramp step. The ramp has only
      // thirteen levels, so without it large smooth surfaces band into visible
      // contour rings.
      int upper = min(matched + 1, 12);
      float low = lumaScale[matched];
      float high = lumaScale[upper];
      float fraction = high > low ? clamp((luma - low) / (high - low), 0.0, 1.0) : 0.0;
      float threshold = u_ditherEnabled ? bayer4(ivec2(cellIndex)) : 1.0;

      // The dither redistributes density between two marks. It does not decide
      // whether the cell is marked at all.
      //
      // Every rung in the middle of the ramp swaps one ink glyph for a slightly
      // denser one, which is a low-contrast change and is what dithering is
      // for. The rung where the ramp stops being blank swaps NOTHING for
      // SOMETHING - the only full-contrast step on the ramp - and the Bayer
      // matrix lays those out on a regular four-cell lattice. A shadowed
      // surface sits at roughly 0.15-0.22 display luminance, which for the
      // shipped blocks set is exactly that rung, so every surface the
      // flashlight did not reach came out as a hard chequerboard. Legacy, which
      // has no dither, quantised the same cells to blank - which is why the two
      // pipelines looked like different games in shadow and identical in light.
      //
      // Worse than a stipple, because of the raster: at 3x5 pixel cells the
      // atlas minifies past GLYPH_COVERAGE_THRESHOLD, so the quarter block
      // draws as a SOLID block of the cell colour. There is no faint mark to
      // dither toward. See ditherMayPromote in GlyphPipeline.js, which owns
      // this rule and is tested against it.
      int lowerGlyph = isSprite ? u_spriteCharIndices[matched] : u_charIndices[matched];
      bool mayPromote = lowerGlyph != GLYPH_BLANK;
      int bin = (mayPromote && fraction > threshold) ? upper : matched;
      glyphIndex = isSprite ? u_spriteCharIndices[bin] : u_charIndices[bin];
      // Texture gradients near black are shading, not structural strokes.
      color *= inkWeight;
      category = CATEGORY_RAMP;
      // How decisively the rung was picked. With the dither in play that is the
      // distance from its threshold, since a cell sitting on it alternates on
      // the slightest change. With the dither held off the cell is a plain
      // quantisation, so what it can flip on is its own rung boundary instead -
      // judging it against a threshold no longer in play would hand the
      // hysteresis a reason to hold a glyph that was never marginal.
      //
      // AND A RUNG BOUNDARY THAT DOES NOT CHANGE THE GLYPH IS NOT A DECISION
      // EITHER. Missing that turned the hysteresis below into a one-way ratchet
      // in the dark: ink could be written into a black cell and never erased.
      //
      // The ramp has thirteen rungs and a shipped character set has five, so
      // several rungs run to the SAME glyph - the bottom three all draw blank.
      // A night-sky cell sitting on one of those interior lines is blank on
      // both sides of it: nothing it can flip to differs from what it already
      // is. Scored on raw rung distance it still came out near zero, which
      // armed the hold.
      //
      // NO BACKTICKS ANYWHERE IN THIS COMMENT. It lives inside a JS template
      // literal, so one backtick ends the shader source and the whole engine
      // fails to parse - which is exactly what the first draft of this comment
      // did.
      //
      // In the dark nothing then disarms it. The brightening test releases only
      // on a luminance RISE, so a cell going dark has no escape that way; and
      // the designed valve, previousCategory != CATEGORY_EMPTY, is dead
      // whenever the sky is on, because CATEGORY_EMPTY is written in exactly
      // one place, gated on the cell being uncovered AND the sky being
      // disabled. With both shut, any ink a cell
      // ever received - a star sweeping past as the camera turns - was held
      // forever, and repainted every frame in the current sky colour, because
      // the COLOUR hysteresis does release even though the glyph does not.
      // Reported as "the dark spaces, like the sky, have lots of smudges like
      // residual light", and in curved bands because the affected rungs are
      // iso-elevation rings around the zenith, which project as conic sections.
      //
      // So measure to the nearest boundary that would actually change what is
      // drawn. This can only RAISE decisionStrength, never lower it, so it can
      // only remove holds - and every hold it removes is one that could not
      // have prevented a visible flicker, because both sides of that boundary
      // draw the same glyph.
      int belowRung = max(matched - 1, 0);
      int belowGlyph = isSprite ? u_spriteCharIndices[belowRung] : u_charIndices[belowRung];
      int aboveGlyph = isSprite ? u_spriteCharIndices[upper] : u_charIndices[upper];
      float downMargin = (belowGlyph == glyphIndex) ? 1.0 : fraction;
      float upMargin = (aboveGlyph == glyphIndex) ? 1.0 : (1.0 - fraction);
      decisionStrength = mayPromote
        ? clamp(abs(fraction - threshold) * 2.5, 0.0, 1.0)
        : clamp(min(downMargin, upMargin) * 2.5, 0.0, 1.0);
    }

    if (covered > 0.0) glyphIndex = resolveDarkWorldGlyph(glyphIndex, luma, isSprite);

    // --- Temporal hysteresis ----------------------------------------------
    // Stabilize nearby ink choices, but never reuse ink for a newly blank cell.
    // Foreground RGB is the unmasked surface colour: a blank shadow cell can
    // have almost the same RGB as an inked cell. Comparing RGB alone therefore
    // lets old wall contours survive a camera turn indefinitely in the dark.
    if (u_historyValid && u_glyphHysteresis > 0.0 && glyphIndex != GLYPH_BLANK) {
      ivec2 historyCoord = ivec2(cellIndex);
      vec4 previousCell = texelFetch(u_previousCell, historyCoord, 0);
      vec4 previousBackground = texelFetch(u_previousCellBackground, historyCoord, 0);
      int previousGlyph = int(previousCell.a * 255.0 + 0.5);
      float previousCategory = floor(previousBackground.a * 255.0 + 0.5);

      // A quadrant background is actual scene colour; a ramp/structural
      // background is empty. Do not carry either interpretation into the other.
      // Blank history also cannot suppress a newly arriving mark.
      if (previousCategory == category && previousGlyph != GLYPH_BLANK) {
        float arrivingSignal = dot(color - previousCell.rgb, LUMA);
        bool settling = abs(arrivingSignal) > u_signalReleaseThreshold;
        if (previousGlyph != glyphIndex && !settling && decisionStrength < u_glyphHysteresis) {
          glyphIndex = previousGlyph;
        }

        float foregroundDelta = distance(color, previousCell.rgb);
        float foregroundBlend = settling
          ? 0.0
          : u_colorHysteresis * (1.0 - smoothstep(0.05, 0.25, foregroundDelta));
        color = mix(color, previousCell.rgb, foregroundBlend);

        // Only quadrant cells own a background, and black must clear in this
        // frame. Apply the same signal-release rule to both sides of an edge.
        float backgroundSignal = dot(backgroundColor - previousBackground.rgb, LUMA);
        if (category == CATEGORY_QUADRANT && dot(backgroundColor, LUMA) > 0.0 &&
            abs(backgroundSignal) <= u_signalReleaseThreshold) {
          float backgroundDelta = distance(backgroundColor, previousBackground.rgb);
          float backgroundBlend = u_colorHysteresis * (1.0 - smoothstep(0.05, 0.25, backgroundDelta));
          backgroundColor = mix(backgroundColor, previousBackground.rgb, backgroundBlend);
        }
      }
    }

    if (u_glitchFactor > 0.05 && rand(cellIndex + u_time) < u_glitchFactor * 0.18) {
      int glitchIndices[7] = int[](16, 17, 32, 31, 10, 99, 5);
      float r = rand(cellIndex * 2.0 - u_time);
      if (u_glitchGlyphCount > 0) {
        float count = float(u_glitchGlyphCount);
        glyphIndex = u_glitchGlyphs[int(mod(floor(r * count), count))];
      } else {
        int idx = int(mod(floor(r * 7.0), 7.0));
        glyphIndex = glitchIndices[idx];
      }

      if (u_glitchColorCount > 0) {
        float count = float(u_glitchColorCount);
        color = u_glitchColors[int(mod(floor(rand(cellIndex * 3.0 + u_time) * count), count))];
      } else {
        color.r *= 0.5;
        color.g *= 1.3;
        color.b *= 1.7;
      }
      backgroundColor = vec3(0.0);
    }

    outCell = vec4(clamp(color, 0.0, 1.0), float(glyphIndex) / 255.0);
    outCellBackground = vec4(clamp(backgroundColor, 0.0, 1.0), category / 255.0);
  }
`;

/**
 * Upgrade 83 pass 3b - glyph raster.
 *
 * One cell fetch and one filtered atlas fetch per output pixel. Coverage
 * modulates the foreground instead of being thresholded, so glyph edges are
 * anti-aliased rather than binary.
 */
export const glyphFS = `#version 300 es
  precision highp float;

  in vec2 v_uv;
  out vec4 fragColor;

  uniform sampler2D u_cellData;
  uniform sampler2D u_cellBackground;
  uniform sampler2D u_fontAtlas;
  uniform vec2 u_cellSize;
  uniform vec2 u_atlasSize;

  ${GLYPH_RASTER_BLOCK}
  ${HUD_BLOCK}
${SCREEN_FLASH_BLOCK}

  void main() {
    vec2 cellCoord = floor(gl_FragCoord.xy / u_cellSize);
    vec2 pixelInCell = mod(gl_FragCoord.xy, u_cellSize);

    vec4 cellData = texelFetch(u_cellData, ivec2(cellCoord), 0);
    int glyphIndex = int(cellData.a * 255.0 + 0.5);
    vec3 color = cellData.rgb;
    vec3 background = texelFetch(u_cellBackground, ivec2(cellCoord), 0).rgb;

    float charCol = mod(float(glyphIndex), u_atlasSize.x);
    float charRow = floor(float(glyphIndex) / u_atlasSize.x);

    // The atlas is rasterised on a y-down 2D canvas while gl_FragCoord.y runs
    // upward, so the vertical axis is flipped here. Without this every glyph
    // renders mirrored, which only stayed invisible because the default block
    // character set is vertically symmetric.
    vec2 local = vec2(pixelInCell.x / u_cellSize.x, 1.0 - pixelInCell.y / u_cellSize.y);
    float coverage = sampleGlyphCoverage(vec2(charCol, charRow), local, u_cellSize);

    // Coverage selects between the two colours; it must NOT scale them.
    //
    // The atlas is minified hard - 32x64 glyph cells into roughly 8x16 screen
    // cells - so this fetch returns the glyph's average ink ratio, not an edge
    // alpha. Blending toward the background by it applied glyph density twice:
    // the ramp had already chosen a sparse glyph to represent low luminance,
    // and every one of that glyph's pixels was then scaled by the same
    // sparseness again. Measured against the 86c2dfe reference on
    // seeker_chase, that cost 94% of the frame's bright pixels
    // (brightFraction 0.1350 -> 0.0076) and emptied the top four luminance
    // deciles. It is also what put the scanner's contact blips out: a one-cell
    // dot is almost entirely low-ink glyph.
    //
    // Background is black for ramp and structural cells, so this reduces to
    // the pre-Upgrade-83 behaviour there, and carries the second colour where
    // a quadrant glyph resolved a boundary. Quadrant masks are procedurally
    // drawn rectangles, so a threshold is exact for them rather than a
    // compromise.
    vec3 rendered = coverage < glyphCoverageThreshold(u_cellSize) ? background : color;
    fragColor = vec4(applyScreenFlash(applyHudGlyphs(rendered)), 1.0);
  }
`;

export const surfaceFS = `#version 300 es
  precision highp float;

  in vec2 v_uv;
  out vec4 outSurfaceColor;

  uniform sampler2D u_accumulatedColor;
  uniform sampler2D u_gbufNormal;
  uniform sampler2D u_gbufDepthLuma;
  uniform mat4 u_view;
  uniform mat4 u_projection;
  uniform vec3 u_cameraPos;
  uniform vec2 u_resolution;
  uniform float u_time;
  uniform bool u_reactiveSurfacesEnabled;
  uniform float u_reflectionStrength;
  uniform float u_surfaceDistortion;
  uniform vec3 u_surfaceTint;
  // Average sky color for rays that escape upward off-screen; black =
  // disabled (ceilinged worlds never set it).
  uniform vec3 u_skyReflectColor;
  // 0..1 march extension for tall reflections. 0 — the default everywhere a
  // profile or frame does not ask — is the historical 20-step march, exactly.
  uniform float u_reflectionReach;

  struct ReactiveSurface {
    vec2 position;
    float radius;
    float intensity;
    float phase;
  };
  #define MAX_REACTIVE_SURFACES 12
  uniform ReactiveSurface u_reactiveSurfaces[MAX_REACTIVE_SURFACES];
  uniform int u_numReactiveSurfaces;

  float reactiveSurfaceMask(vec2 worldPosition, out float phase) {
    float combinedMask = 0.0;
    phase = 0.0;
    for (int i = 0; i < MAX_REACTIVE_SURFACES; i++) {
      if (i >= u_numReactiveSurfaces) break;
      ReactiveSurface surface = u_reactiveSurfaces[i];
      vec2 delta = worldPosition - surface.position;
      float cosine = cos(surface.phase);
      float sine = sin(surface.phase);
      vec2 rotated = vec2(delta.x * cosine - delta.y * sine, delta.x * sine + delta.y * cosine);
      float aspect = 0.52 + 0.16 * sin(surface.phase * 1.7);
      float ellipticalDistance = length(vec2(rotated.x, rotated.y / aspect));
      float edgeNoise = sin(rotated.x * 8.0 + surface.phase) * sin(rotated.y * 9.0 - surface.phase) * 0.055;
      float patchMask = 1.0 - smoothstep(surface.radius * 0.72, surface.radius, ellipticalDistance + edgeNoise);
      patchMask *= surface.intensity;
      if (patchMask > combinedMask) {
        combinedMask = patchMask;
        phase = surface.phase;
      }
    }
    return combinedMask;
  }

  vec3 traceReflection(vec3 worldPosition, vec3 normal, vec2 distortion, out float confidence) {
    vec3 incident = normalize(worldPosition - u_cameraPos);
    vec3 rayDirection = normalize(reflect(incident, normal));
    vec3 rayPosition = worldPosition + normal * 0.055 + rayDirection * 0.08;
    confidence = 0.0;

    // The legacy march: 20 steps of growing length, ~9.3 world units of total
    // reach. That reach is tuned for interiors, and in an open night city it
    // is exactly what keeps emissive window facades out of wet streets: the
    // mirror ray to a window several units up a tower is the LONG ray, so lit
    // ground-floor surfaces land inside the march while the bright windows
    // above it never do. u_reflectionReach (opt-in, default 0) appends up to
    // 28 further steps at the final step length — ~22 more units of reach —
    // and, only on those appended steps, widens the acceptance band past the
    // step length so a coarse step cannot straddle a facade and miss it (the
    // legacy band is 0.48 against a 0.795 step, which skips ~40% of face-on
    // crossings). At reach 0 the loop bound, every step length, and both
    // acceptance constants are the historical values, bit for bit.
    int stepCount = 20 + int(u_reflectionReach * 28.0 + 0.5);
    for (int stepIndex = 0; stepIndex < stepCount; stepIndex++) {
      float stepLength = 0.13 + float(min(stepIndex, 19)) * 0.035;
      rayPosition += rayDirection * stepLength;
      vec4 clipPosition = u_projection * u_view * vec4(rayPosition, 1.0);
      if (clipPosition.w <= 0.0) break;
      vec2 sampleUV = clipPosition.xy / clipPosition.w * 0.5 + 0.5;
      if (any(lessThanEqual(sampleUV, vec2(0.01))) || any(greaterThanEqual(sampleUV, vec2(0.99)))) break;

      vec3 sceneNormal = texture(u_gbufNormal, sampleUV).xyz;
      if (length(sceneNormal) < 0.1) continue;
      vec3 scenePosition = texture(u_gbufDepthLuma, sampleUV).xyz;
      float rayDistance = distance(rayPosition, u_cameraPos);
      float sceneDistance = distance(scenePosition, u_cameraPos);
      float depthGap = rayDistance - sceneDistance;
      bool leftOriginSurface = distance(scenePosition, worldPosition) > 0.42;
      float acceptGap = stepIndex < 20 ? 0.48 : 0.9;
      if (stepIndex > 1 && leftOriginSurface && depthGap > 0.0 && depthGap < acceptGap) {
        float edgeFade = smoothstep(0.0, 0.08, sampleUV.x)
          * smoothstep(0.0, 0.08, sampleUV.y)
          * smoothstep(0.0, 0.08, 1.0 - sampleUV.x)
          * smoothstep(0.0, 0.08, 1.0 - sampleUV.y);
        confidence = edgeFade * (1.0 - smoothstep(0.08, acceptGap, depthGap));
        return texture(u_accumulatedColor, clamp(sampleUV + distortion, vec2(0.001), vec2(0.999))).rgb;
      }
    }

    // A ray that rose without hitting anything reflects the open sky, so a
    // puddle on an unlit street still reads wet instead of matte black.
    if (rayDirection.z < -0.25
      && (u_skyReflectColor.r + u_skyReflectColor.g + u_skyReflectColor.b) > 0.001) {
      confidence = 0.3;
      return u_skyReflectColor;
    }
    return vec3(0.0);
  }

  void main() {
    vec3 baseColor = texture(u_accumulatedColor, v_uv).rgb;
    if (!u_reactiveSurfacesEnabled || u_numReactiveSurfaces <= 0 || u_reflectionStrength <= 0.001) {
      outSurfaceColor = vec4(baseColor, 1.0);
      return;
    }

    vec4 normalData = texture(u_gbufNormal, v_uv);
    vec3 normal = normalData.xyz;
    if (normal.z > -0.72 || normalData.w < 0.0) {
      outSurfaceColor = vec4(baseColor, 1.0);
      return;
    }

    vec3 worldPosition = texture(u_gbufDepthLuma, v_uv).xyz;
    float phase = 0.0;
    float surfaceMask = reactiveSurfaceMask(worldPosition.xy, phase);
    if (surfaceMask <= 0.01) {
      outSurfaceColor = vec4(baseColor, 1.0);
      return;
    }

    float time = u_time * 0.001;
    vec2 distortion = vec2(
      sin(worldPosition.y * 9.0 + time * 1.7 + phase),
      cos(worldPosition.x * 8.0 - time * 1.3 + phase)
    ) * u_surfaceDistortion / max(u_resolution, vec2(1.0));
    float reflectionConfidence = 0.0;
    vec3 reflectedColor = traceReflection(worldPosition, normalize(normal), distortion, reflectionConfidence);
    float roughness = clamp(normalData.w, 0.0, 1.0);
    vec3 viewDirection = normalize(u_cameraPos - worldPosition);
    float fresnel = pow(1.0 - max(dot(normalize(normal), viewDirection), 0.0), 2.0);
    float materialResponse = mix(0.68, 1.0, 1.0 - roughness);
    float reflectionMix = surfaceMask * reflectionConfidence * u_reflectionStrength
      * materialResponse * mix(0.58, 1.0, fresnel);
    vec3 wetBase = mix(baseColor, baseColor * u_surfaceTint, surfaceMask * 0.12);
    vec3 composite = mix(wetBase, reflectedColor * u_surfaceTint, clamp(reflectionMix, 0.0, 0.78));
    outSurfaceColor = vec4(composite, 1.0);
  }
`;

export const particleVS = `#version 300 es
  precision highp float;

  layout(location = 0) in vec3 a_position;
  layout(location = 1) in vec3 a_color;
  layout(location = 2) in vec4 a_params;

  uniform mat4 u_view;
  uniform mat4 u_projection;
  uniform vec3 u_cameraPos;
  uniform vec2 u_resolution;
  uniform float u_time;

  out vec3 v_color;
  out float v_cameraDistance;
  out float v_intensity;

  void main() {
    float size = a_params.x;
    float phase = a_params.y;
    float type = a_params.z;
    float intensity = a_params.w;
    float time = u_time * 0.001;
    vec3 worldPos = a_position;

    if (type < 0.5) {
      worldPos.x += sin(time * 0.37 + phase) * 0.12;
      worldPos.y += cos(time * 0.29 + phase * 1.7) * 0.12;
      worldPos.z += sin(time * 0.43 + phase * 2.1) * 0.08;
    } else if (type < 1.5) {
      float fall = fract(time * 1.8 + phase);
      worldPos.x += sin(phase * 8.0) * fall * 0.35;
      worldPos.y += cos(phase * 6.0) * fall * 0.35;
      worldPos.z += fall * 0.72;
      intensity *= 1.0 - fall;
    } else if (type < 2.5) {
      float rise = fract(time * 0.24 + phase);
      worldPos.x += sin(time + phase * 4.0) * rise * 0.28;
      worldPos.y += cos(time * 0.8 + phase * 3.0) * rise * 0.28;
      worldPos.z -= rise * 0.55;
      intensity *= (1.0 - rise) * 0.7;
    } else if (type < 3.5) {
      float orbit = time * 0.8 + phase * 6.2831853;
      float radius = 0.16 + fract(phase) * 0.42;
      worldPos.x += cos(orbit) * radius;
      worldPos.y += sin(orbit) * radius;
      worldPos.z += sin(orbit * 1.7) * 0.2;
      intensity *= 0.65 + 0.35 * sin(time * 3.0 + phase * 9.0);
    } else {
      // Precipitation: fast downward drift (z grows toward the floor in
      // renderer space), wrapping over a tall column, faded at the wrap
      // endpoints so drops never pop in or out.
      float fall = fract(time * (0.9 + fract(phase) * 0.4) + phase);
      worldPos.z = a_position.z + fall * 3.2 - 1.6;
      worldPos.x += sin(phase * 12.0) * 0.05;
      intensity *= 0.85 * (0.5 + 0.5 * sin(fall * 3.14159));
    }

    vec4 clipPosition = u_projection * u_view * vec4(worldPos, 1.0);
    gl_Position = clipPosition;
    float cameraDistance = distance(worldPos, u_cameraPos);
    gl_PointSize = clamp(size * u_resolution.y / max(cameraDistance, 0.5), 1.4, 8.0);
    v_color = a_color;
    v_cameraDistance = cameraDistance;
    v_intensity = max(intensity, 0.0);
  }
`;

export const particleFS = `#version 300 es
  precision highp float;

  in vec3 v_color;
  in float v_cameraDistance;
  in float v_intensity;

  uniform sampler2D u_gbufNormal;
  uniform sampler2D u_gbufDepthLuma;
  uniform vec3 u_cameraPos;

  out vec4 outParticleColor;

  void main() {
    vec2 centered = gl_PointCoord * 2.0 - 1.0;
    float radialMask = 1.0 - smoothstep(0.25, 1.0, dot(centered, centered));
    if (radialMask <= 0.01 || v_intensity <= 0.01) discard;

    ivec2 texelCoord = ivec2(gl_FragCoord.xy);
    vec3 surfaceNormal = texelFetch(u_gbufNormal, texelCoord, 0).xyz;
    if (length(surfaceNormal) > 0.1) {
      vec3 surfacePosition = texelFetch(u_gbufDepthLuma, texelCoord, 0).xyz;
      float surfaceDistance = distance(surfacePosition, u_cameraPos);
      if (v_cameraDistance > surfaceDistance + 0.08) discard;
    }

    float energy = radialMask * v_intensity;
    outParticleColor = vec4(v_color * energy, energy);
  }
`;
export const asciiFS = `#version 300 es
  precision highp float;

  out vec4 fragColor;
  in vec2 v_uv;

  uniform sampler2D u_accumulatedColor;
  uniform sampler2D u_gbufNormal;
  uniform sampler2D u_fontAtlas;

  uniform vec2 u_resolution;
  uniform vec2 u_cellSize;
  uniform vec2 u_atlasSize;
  uniform int u_charIndices[13];
  uniform int u_spriteCharIndices[13];
  uniform float u_glitchFactor;
  // Opt-in glitch style (effects.glitchGlyphs / glitchPalette). Counts of 0
  // keep the historical glyph set and cyan shift.
  uniform int u_glitchGlyphCount;
  uniform int u_glitchGlyphs[8];
  uniform int u_glitchColorCount;
  uniform vec3 u_glitchColors[4];
  uniform float u_time;
  // Sky pixels carry lit color but no normal; with sky on they resolve on the
  // density ramp instead of collapsing to the black empty cell.
  uniform bool u_skyEnabled;
${TONE_BLOCK}
${GLYPH_RASTER_BLOCK}
${HUD_BLOCK}
${SCREEN_FLASH_BLOCK}

${SHADOW_GLYPH_BLOCK}

  float rand(vec2 co) {
    return fract(sin(dot(co, vec2(12.9898, 78.233))) * 43758.5453);
  }

  void main() {
    vec2 cellCoord = floor(gl_FragCoord.xy / u_cellSize);
    vec2 pixelInCell = mod(gl_FragCoord.xy, u_cellSize);
    vec2 cellCenterUV = (cellCoord * u_cellSize + u_cellSize * 0.5) / u_resolution;

    // The light buffer is HDR from Upgrade 85 onward, so even the legacy
    // single-sample path has to tonemap; its former nine-tap gather is
    // replaced by the shared HDR bloom chain.
    vec3 color = resolveDisplayColor(
      texture(u_accumulatedColor, cellCenterUV).rgb,
      texture(u_bloomTexture, cellCenterUV).rgb
    );
    vec4 normalData = texture(u_gbufNormal, cellCenterUV);
    vec3 normal = normalData.xyz;
    bool isSprite = normalData.w < 0.0;
    // Match the supersampled path for screen art on the single-sample tier.
    if (normalData.w <= -3.0) {
      fragColor = vec4(applyHudGlyphs(color), 1.0);
      return;
    }

    if (length(normal) < 0.1 && !u_skyEnabled) {
      fragColor = vec4(applyHudGlyphs(vec3(0.0)), 1.0);
      return;
    }
    
    // Sample normals inside the current cell bounds (0.35x offset) to detect localized edges.
    // Keep all glyph indices within the existing printable-ASCII atlas range:
    // '(' = 8, ')' = 9, '-' = 13, '/' = 15, '\\' = 60.
    float cellSizeX = (u_cellSize.x * 0.35) / u_resolution.x;
    float cellSizeY = (u_cellSize.y * 0.35) / u_resolution.y;
    
    vec3 nLeft  = texture(u_gbufNormal, cellCenterUV - vec2(cellSizeX, 0.0)).xyz;
    vec3 nRight = texture(u_gbufNormal, cellCenterUV + vec2(cellSizeX, 0.0)).xyz;
    vec3 nUp    = texture(u_gbufNormal, cellCenterUV - vec2(0.0, cellSizeY)).xyz;
    vec3 nDown  = texture(u_gbufNormal, cellCenterUV + vec2(0.0, cellSizeY)).xyz;
    
    vec3 gradVecX = nRight - nLeft;
    vec3 gradVecY = nDown - nUp;
    float gradX = length(gradVecX);
    float gradY = length(gradVecY);
    float edgeStrength = max(gradX, gradY);

    // Second-order normal change distinguishes rounded silhouettes from a
    // long, straight edge. It uses the samples we already take, so the pass
    // does not need another G-buffer texture or atlas entry.
    vec3 curvatureX = nRight + nLeft - 2.0 * normal;
    vec3 curvatureY = nDown + nUp - 2.0 * normal;
    float curvatureRatio = (length(curvatureX) + length(curvatureY)) /
      max(gradX + gradY, 0.001);
    float diagonalBalance = min(gradX, gradY) / max(edgeStrength, 0.001);
    
    int glyphIndex = 0;
    
    float luma = dot(color, vec3(0.299, 0.587, 0.114));
    if (isSprite) {
      // Saturated emissive sprites (especially the seeker's crimson head)
      // carry strong color energy despite low perceptual red luminance. Keep
      // their glyph density from collapsing into sparse, black-looking cells.
      float strongestChannel = max(color.r, max(color.g, color.b));
      luma = max(luma, strongestChannel * 0.72);
    }
    
    if (edgeStrength > 0.35) {
      // Parentheses make rounded mesh contours read as arcs instead of a
      // staircase of diagonal strokes. Flat wall silhouettes fail the balance
      // test, so their established directional treatment remains unchanged.
      bool roundedContour = gradX > gradY * 1.15 &&
        diagonalBalance > 0.30 &&
        curvatureRatio > 0.85;

      if (roundedContour) {
        // The denser side is inside the silhouette: '(' for a left contour,
        // ')' for a right contour.
        glyphIndex = (length(nRight) >= length(nLeft)) ? 8 : 9;
      } else if (abs(gradX - gradY) < 0.1) {
        // Compare the complete normal-gradient vectors, not only Z. This
        // keeps slash direction stable on curved meshes whose normals rotate
        // primarily in the X/Y plane.
        float diagonalCorrelation = dot(gradVecX, gradVecY);
        if (abs(diagonalCorrelation) < 0.0001) {
          diagonalCorrelation =
            (nRight.z - nLeft.z) * (nDown.z - nUp.z);
        }
        glyphIndex = (diagonalCorrelation >= 0.0) ? 15 : 60;
      } else if (gradX > gradY) {
        glyphIndex = 93; // Corrected from 92 to render '|' instead of '{'
      } else {
        glyphIndex = 13;
      }
    } else {
      int matchedIdx = 0;
      for (int i = 0; i < 13; i++) {
        if (luma >= lumaScale[i]) {
          matchedIdx = isSprite ? u_spriteCharIndices[i] : u_charIndices[i];
        }
      }
      glyphIndex = resolveDarkWorldGlyph(matchedIdx, luma, isSprite);
      color *= shadowInkWeight(luma, isSprite);
    }
    
    if (u_glitchFactor > 0.05 && rand(cellCoord + u_time) < u_glitchFactor * 0.18) {
      int glitchIndices[7] = int[](16, 17, 32, 31, 10, 99, 5);
      float r = rand(cellCoord * 2.0 - u_time);
      if (u_glitchGlyphCount > 0) {
        float count = float(u_glitchGlyphCount);
        glyphIndex = u_glitchGlyphs[int(mod(floor(r * count), count))];
      } else {
        int idx = int(mod(floor(r * 7.0), 7.0));
        glyphIndex = glitchIndices[idx];
      }
      
      if (u_glitchColorCount > 0) {
        float count = float(u_glitchColorCount);
        color = u_glitchColors[int(mod(floor(rand(cellCoord * 3.0 + u_time) * count), count))];
      } else {
        color.r *= 0.5;
        color.g *= 1.3;
        color.b *= 1.7;
      }
    }
    
    float atlasCols = u_atlasSize.x;
    float charCol = mod(float(glyphIndex), atlasCols);
    float charRow = floor(float(glyphIndex) / atlasCols);

    // The atlas is rasterised on a y-down 2D canvas while gl_FragCoord.y runs
    // upward, so the vertical axis is flipped here.
    vec2 local = vec2(pixelInCell.x / u_cellSize.x, 1.0 - pixelInCell.y / u_cellSize.y);
    float glyphMask = sampleGlyphCoverage(vec2(charCol, charRow), local, u_cellSize);

    // Threshold, never scale - see the two-pass raster for the full reasoning.
    // This path is what Glyph Pipeline "Legacy" runs, so it carried the same
    // regression: Legacy measured darker than High, which is why toggling to it
    // never restored the contact blips and wrongly appeared to clear Phases A,
    // B and D of the fault.
    fragColor = vec4(applyScreenFlash(applyHudGlyphs(glyphMask < glyphCoverageThreshold(u_cellSize) ? vec3(0.0) : color)), 1.0);
  }
`;
