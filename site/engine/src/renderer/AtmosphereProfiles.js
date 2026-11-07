/**
 * Upgrade 85 tone defaults, and the resolver that turns a named atmosphere into
 * the grade the frame is rendered with.
 *
 * Exposure scales the HDR light buffer before the filmic tonemap. The grade is
 * a lift/gain pair with a gamma and a saturation, which is what turns profiles
 * into distinct looks rather than a set of fog colours.
 *
 * The profiles themselves are not here. Which dimensions exist, and what each
 * one looks like, is the loaded world's to say - see
 * `world/FacilityAtmosphere.js` for Liminal's three. The engine is handed that
 * table through `AsciiRendererWebGL#setAtmosphereProfiles`. What stays here is
 * everything a caller must not be able to get wrong: the fallback grade, and
 * the accessibility rules the resolver applies on top of whichever profile it
 * was given.
 */
export const DEFAULT_TONE = Object.freeze({
  // Retuned after the Upgrade 83 glyph-raster regression was fixed. Every
  // exposure originally graded against this file was set while the raster was
  // multiplying each cell's colour by its glyph's ink ratio, so they had been
  // raised to fight a darkening that was never tonal. With that removed they
  // all blew out. The values a profile overrides are measured back onto the
  // 86c2dfe reference rather than scaled by a common factor. Fallback only: any
  // installed profile is expected to state its own exposure.
  exposure: 0.735,
  bloomThreshold: 1.05,
  bloomSoftKnee: 0.55,
  bloomIntensity: 0.85,
  emissiveIntensity: 1.8,
  // Where the rolloff begins. Below it the tone stage is the identity, so the
  // lighting the game already had reaches the glyph ramp untouched and the
  // perceptual shadow floor still lands on the ramp's first visible glyph.
  //
  // Counter-intuitively this wants to be low. A high knee is "linear, then a
  // short hard squash": at 0.78 everything from flashlight-lit (1.2) to
  // emissive (6.0) landed inside 0.066 of output range, so every bright
  // surface resolved to the same near-maximum value and highlights read as
  // blown. At 0.45 that same input range spreads across 0.183 - roughly three
  // times the tonal separation - because the shoulder is longer and gentler.
  toneKnee: 0.45,
  highlightDesaturation: 0.6,
  // Soft-toe knee. Anything at or above the perceptual shadow floor (0.078)
  // passes through; only near-black bloom haze is rolled away.
  gradeBlackPoint: 0.03,
  gradeLift: [0, 0, 0],
  gradeGain: [1, 1, 1],
  gradeGamma: 1,
  gradeSaturation: 1
});

export const NEUTRAL_PROFILE_NAME = 'neutral';

/**
 * What the engine renders with when no profile table has been installed, or
 * when it is asked for a dimension the installed table does not have.
 *
 * It is the tone defaults plus the spatial fields the resolver needs, chosen so
 * that everything which is a *look* - fog, tints, volumetrics, reflections,
 * distortion - is the identity. An engine that has not been told what world it
 * is drawing should not invent an atmosphere for it. What remains are the
 * shading constants that decide legibility rather than style, so a scene with
 * no profile installed still reads on the glyph ramp instead of rendering as a
 * flat black frame.
 */
export const NEUTRAL_ATMOSPHERE = Object.freeze({
  ...DEFAULT_TONE,
  fogColor: Object.freeze([0, 0, 0]),
  fogDensity: 0,
  fogHeightFalloff: 0,
  ambientFactor: 0.15,
  lowLightAdaptation: 0.72,
  shadowTint: Object.freeze([1, 1, 1]),
  ambientOcclusionStrength: 0.42,
  shadowFloor: 0.42,
  // 1 = the historical perceptual shadow floor, 0 = none (real darkness).
  // 0 = the historical dim-band response, no extra recovery.
  visibilityFloor: 1,
  shadowLift: 0,
  specularStrength: 0.38,
  volumetricStrength: 0,
  particleDensity: 0,
  // null = the effect profile's own ceilings (EnvironmentalEffects.js:
  // `baseParticles` per profile, and PRECIPITATION_BASE_BUDGET for streaks).
  // 'none' = the historical whole-map seeding.
  particleBudget: null,
  precipitationBudget: null,
  particleFocus: 'none',
  particleFocusRadius: 0,
  reflectionStrength: 0,
  reflectionReach: 0,
  reactiveSurfaceDensity: 0,
  surfaceDistortion: 0,
  surfaceTint: Object.freeze([1, 1, 1]),
  starDensity: 0,
  starBrightness: 0,
  fogDither: 0,
  skylineStrength: 0,
  skylineSeed: 0
});

/**
 * Grades one named dimension out of `profiles`, applying the accessibility
 * options on top.
 *
 * `profiles` is the table the world installed, keyed by dimension name; an
 * unknown name, or no table at all, resolves to `NEUTRAL_ATMOSPHERE`. The
 * engine deliberately has no default dimension name of its own - naming one
 * would be naming a world - so the caller that installs a table names its
 * starting dimension too.
 *
 * The accessibility flags are applied here, once, rather than by each world:
 * `environmentalFx: false` zeroes volumetrics and particles, `reactiveSurfaces:
 * false` collapses reflections and distortion, and `bloom: false` zeroes bloom
 * intensity which is otherwise attenuated by the clamped `bloomScale`. All
 * three are echoed back out on the resolved profile so the renderer can branch
 * on them without re-reading settings.
 */
export function resolveAtmosphereProfile(dimension, options = {}, profiles = null) {
  const installed = profiles && typeof profiles === 'object' ? profiles[dimension] : null;
  const profileName = installed ? dimension : NEUTRAL_PROFILE_NAME;
  const source = installed || NEUTRAL_ATMOSPHERE;
  const bloomScale = Number.isFinite(options.bloomScale)
    ? Math.max(0, Math.min(1, options.bloomScale))
    : 1;

  return {
    name: profileName,
    fogColor: colorTriple(options.fogColor, source.fogColor),
    fogDensity: Number.isFinite(options.fogDensity) ? options.fogDensity : source.fogDensity,
    fogHeightFalloff: Number.isFinite(options.fogHeightFalloff)
      ? options.fogHeightFalloff
      : source.fogHeightFalloff,
    ambientFactor: Number.isFinite(options.ambientFactor) ? options.ambientFactor : source.ambientFactor,
    lowLightAdaptation: Number.isFinite(options.lowLightAdaptation)
      ? options.lowLightAdaptation
      : source.lowLightAdaptation,
    shadowTint: Array.isArray(options.shadowTint) && options.shadowTint.length >= 3
      ? options.shadowTint.slice(0, 3)
      : [...source.shadowTint],
    ambientOcclusionStrength: Number.isFinite(options.ambientOcclusionStrength)
      ? options.ambientOcclusionStrength
      : source.ambientOcclusionStrength,
    shadowFloor: Number.isFinite(options.shadowFloor) ? options.shadowFloor : source.shadowFloor,
    // The two knobs that decide whether a world can author darkness at all.
    // `visibilityFloor` scales the shader's unconditional display-luminance
    // floor (1 = historical, 0 = unlit geometry reaches true black);
    // `shadowLift` is its companion, recovering the dim band the floor used to
    // be doing the work of. Both clamp to 0..1 and both default to the
    // historical behaviour when a profile predates them.
    visibilityFloor: Number.isFinite(options.visibilityFloor)
      ? Math.max(0, Math.min(1, options.visibilityFloor))
      : (Number.isFinite(source.visibilityFloor) ? Math.max(0, Math.min(1, source.visibilityFloor)) : 1),
    shadowLift: Number.isFinite(options.shadowLift)
      ? Math.max(0, Math.min(1, options.shadowLift))
      : (Number.isFinite(source.shadowLift) ? Math.max(0, Math.min(1, source.shadowLift)) : 0),
    specularStrength: Number.isFinite(options.specularStrength) ? options.specularStrength : source.specularStrength,
    volumetricStrength: options.environmentalFx === false
      ? 0
      : (Number.isFinite(options.volumetricStrength) ? options.volumetricStrength : source.volumetricStrength),
    particleDensity: options.environmentalFx === false
      ? 0
      : (Number.isFinite(options.particleDensity) ? options.particleDensity : source.particleDensity),
    // Particle CEILINGS, distinct from particleDensity (which scales toward
    // the ceiling). null — the default — means "whatever the effect profile's
    // own constant is", so the historical 72 dust motes / 160 rain streaks
    // stay the defaults without this file restating them. A finite value
    // replaces the constant; it is rounded and floored at 0 here so the
    // builder never sees a fractional or negative budget. Zeroed by the
    // environmentalFx gate along with everything else particle-shaped.
    particleBudget: options.environmentalFx === false
      ? 0
      : resolveBudget(options.particleBudget, source.particleBudget),
    precipitationBudget: options.environmentalFx === false
      ? 0
      : resolveBudget(options.precipitationBudget, source.precipitationBudget),
    // 'camera' concentrates the particle budget in the cells near the viewer
    // instead of spreading it across the whole district — the analogue of
    // reactiveSurfaceFocus, and the same 16-cell sector fingerprint keeps the
    // rebuild from thrashing. Radius is in world cells; <= 0 with focus on
    // means "no radius limit, just nearest-first". Forced to 'none' under the
    // accessibility gate so a disabled tier keeps ONE stable fingerprint.
    particleFocus: options.environmentalFx === false
      ? 'none'
      : (options.particleFocus === 'camera'
        ? 'camera'
        : (source.particleFocus === 'camera' ? 'camera' : 'none')),
    particleFocusRadius: Number.isFinite(options.particleFocusRadius)
      ? Math.max(0, options.particleFocusRadius)
      : (Number.isFinite(source.particleFocusRadius) ? Math.max(0, source.particleFocusRadius) : 0),
    // Optional 0..1 dust recolor (null = the tone profile's palette) and
    // precipitation amount, both zeroed with the environmentalFx gate.
    dustColor: Array.isArray(options.dustColor) && options.dustColor.length >= 3
      ? options.dustColor.slice(0, 3)
      : (Array.isArray(source.dustColor) ? [...source.dustColor] : null),
    precipitation: options.environmentalFx === false
      ? 0
      : (Number.isFinite(options.precipitation)
        ? Math.max(0, Math.min(1, options.precipitation))
        : (Number.isFinite(source.precipitation) ? Math.max(0, Math.min(1, source.precipitation)) : 0)),
    reflectionStrength: options.reactiveSurfaces === false
      ? 0
      : (Number.isFinite(options.reflectionStrength) ? options.reflectionStrength : source.reflectionStrength),
    // 0..1 extension of the reflection march's reach (tall emissive facades in
    // wet streets). 0 — the default everywhere a profile or frame does not
    // ask — is the historical 20-step march, guaranteed.
    reflectionReach: options.reactiveSurfaces === false
      ? 0
      : (Number.isFinite(options.reflectionReach)
        ? Math.max(0, Math.min(1, options.reflectionReach))
        : (Number.isFinite(source.reflectionReach) ? Math.max(0, Math.min(1, source.reflectionReach)) : 0)),
    reactiveSurfaceDensity: options.reactiveSurfaces === false
      ? 0
      : (Number.isFinite(options.reactiveSurfaceDensity) ? options.reactiveSurfaceDensity : source.reactiveSurfaceDensity),
    surfaceDistortion: options.reactiveSurfaces === false
      ? 0
      : (Number.isFinite(options.surfaceDistortion) ? options.surfaceDistortion : source.surfaceDistortion),
    surfaceTint: Array.isArray(options.surfaceTint) && options.surfaceTint.length >= 3
      ? options.surfaceTint.slice(0, 3)
      : [...source.surfaceTint],
    exposure: Number.isFinite(options.exposure) ? options.exposure : source.exposure,
    bloomThreshold: Number.isFinite(options.bloomThreshold) ? options.bloomThreshold : source.bloomThreshold,
    bloomSoftKnee: source.bloomSoftKnee,
    // The accessibility bloom scale already attenuates this profile's bloom
    // strength; the HDR chain honours the same reduction.
    bloomIntensity: options.bloom === false ? 0 : source.bloomIntensity * bloomScale,
    emissiveIntensity: Number.isFinite(options.emissiveIntensity)
      ? options.emissiveIntensity
      : source.emissiveIntensity,
    gradeLift: colorTriple(options.gradeLift, source.gradeLift),
    gradeGain: colorTriple(options.gradeGain, source.gradeGain),
    gradeGamma: Number.isFinite(options.gradeGamma) ? options.gradeGamma : source.gradeGamma,
    gradeSaturation: Number.isFinite(options.gradeSaturation)
      ? options.gradeSaturation
      : source.gradeSaturation,
    toneKnee: Number.isFinite(options.toneKnee) ? options.toneKnee : source.toneKnee,
    highlightDesaturation: source.highlightDesaturation,
    gradeBlackPoint: Number.isFinite(options.gradeBlackPoint)
      ? options.gradeBlackPoint
      : source.gradeBlackPoint,
    fullFloorReflection: options.fullFloorReflection === true,
    // 'camera' re-seeds the few reactive patches near the viewer as they
    // cross sectors — for large open maps. Absent/none keeps the historical
    // whole-map seeding. Zeroed with the other reactive fields when the
    // accessibility gate disables the effect, so a disabled tier keeps one
    // stable fingerprint instead of churning on sector crossings.
    reactiveSurfaceFocus: options.reactiveSurfaces === false
      ? 'none'
      : (options.reactiveSurfaceFocus === 'camera' ? 'camera' : 'none'),
    contactShadows: options.contactShadows !== false,
    bloom: options.bloom !== false,
    environmentalFx: options.environmentalFx !== false,
    reactiveSurfaces: options.reactiveSurfaces !== false,
    // Open-sky rendering. When enabled, the light pass paints a vertical
    // gradient into pixels no geometry covered, with an optional azimuthal
    // horizon glow (a dawn line, a city glow, a sunset). Profiles may install
    // these too; per-frame options win so a day/night cycle can lerp them.
    skyEnabled: options.skyEnabled === true || (options.skyEnabled !== false && source.skyEnabled === true),
    skyTopColor: colorTriple(options.skyTopColor, source.skyTopColor || [0, 0, 0]),
    skyHorizonColor: colorTriple(options.skyHorizonColor, source.skyHorizonColor || [0, 0, 0]),
    skyGlowColor: colorTriple(options.skyGlowColor, source.skyGlowColor || [0, 0, 0]),
    skyGlowAzimuth: Number.isFinite(options.skyGlowAzimuth)
      ? options.skyGlowAzimuth
      : (Number.isFinite(source.skyGlowAzimuth) ? source.skyGlowAzimuth : 0),
    skyGlowStrength: Number.isFinite(options.skyGlowStrength)
      ? options.skyGlowStrength
      : (Number.isFinite(source.skyGlowStrength) ? source.skyGlowStrength : 0),
    skyGlowSharpness: Number.isFinite(options.skyGlowSharpness)
      ? Math.max(0.5, options.skyGlowSharpness)
      : (Number.isFinite(source.skyGlowSharpness) ? Math.max(0.5, source.skyGlowSharpness) : 3),
    // Procedural starfield in the uncovered sky, and a quantization-band
    // dither for dark sky/fog ramps. All default 0 = historical output.
    starDensity: Number.isFinite(options.starDensity)
      ? Math.max(0, options.starDensity)
      : (Number.isFinite(source.starDensity) ? Math.max(0, source.starDensity) : 0),
    starBrightness: Number.isFinite(options.starBrightness)
      ? Math.max(0, options.starBrightness)
      : (Number.isFinite(source.starBrightness) ? Math.max(0, source.starBrightness) : 0),
    fogDither: Number.isFinite(options.fogDither)
      ? Math.max(0, Math.min(0.05, options.fogDither))
      : (Number.isFinite(source.fogDither) ? Math.max(0, Math.min(0.05, source.fogDither)) : 0),
    // Horizon skyline silhouette band in the uncovered sky. Strength 0 — the
    // default everywhere a profile or frame does not ask — is the historical
    // sky, guaranteed; the seed may be any finite number and simply reseats
    // the hashed tower field.
    skylineStrength: Number.isFinite(options.skylineStrength)
      ? Math.max(0, Math.min(1, options.skylineStrength))
      : (Number.isFinite(source.skylineStrength) ? Math.max(0, Math.min(1, source.skylineStrength)) : 0),
    skylineSeed: Number.isFinite(options.skylineSeed)
      ? options.skylineSeed
      : (Number.isFinite(source.skylineSeed) ? source.skylineSeed : 0),
    // Opt-in planar fog: distance fog measured across the ground plane only,
    // so a camera above the world does not fog out everything below it. The
    // key is absent unless asked for, keeping resolved profiles unchanged.
    ...(options.fogPlanar === true || source.fogPlanar === true ? { fogPlanar: true } : {})
  };
}

function resolveBudget(option, sourceValue) {
  if (Number.isFinite(option)) return Math.max(0, Math.round(option));
  if (Number.isFinite(sourceValue)) return Math.max(0, Math.round(sourceValue));
  return null;
}

function colorTriple(value, fallback) {
  return Array.isArray(value) && value.length >= 3 && value.every(part => Number.isFinite(part))
    ? value.slice(0, 3)
    : [...fallback];
}

/** Sub-linear fixture range scaling. Identity at one; 1.75 at double scale. */
export function resolveLightRangeScale(scale = 1) {
  return 1 + 0.75 * (scale - 1);
}
