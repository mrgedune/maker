const clamp = (value, minimum, maximum) => Math.max(minimum, Math.min(maximum, value));

const PROFILE_DATA = {
  standard: {
    hudScale: 1.0,
    worldLabelScale: 1.0,
    motionScale: 1.0,
    bloomScale: 1.0,
    glitchScale: 1.0,
    flickerAllowed: true,
    contrastMode: 'standard'
  },
  readable: {
    hudScale: 1.15,
    worldLabelScale: 1.2,
    motionScale: 0.8,
    bloomScale: 0.65,
    glitchScale: 0.55,
    flickerAllowed: false,
    contrastMode: 'high-contrast'
  },
  photosensitive: {
    hudScale: 1.1,
    worldLabelScale: 1.15,
    motionScale: 0.35,
    bloomScale: 0.25,
    glitchScale: 0.15,
    flickerAllowed: false,
    contrastMode: 'high-contrast'
  }
};

export const ACCESSIBILITY_PROFILES = Object.freeze(
  Object.fromEntries(
    Object.entries(PROFILE_DATA).map(([name, profile]) => [name, Object.freeze({ ...profile })])
  )
);

export function normalizeAccessibilityPreset(preset = 'standard') {
  return Object.prototype.hasOwnProperty.call(ACCESSIBILITY_PROFILES, preset) ? preset : 'standard';
}

export function resolveAccessibilityProfile(preset = 'standard', overrides = {}) {
  const name = normalizeAccessibilityPreset(preset);
  const source = ACCESSIBILITY_PROFILES[name];
  return {
    name,
    hudScale: clamp(Number.isFinite(overrides.hudScale) ? overrides.hudScale : source.hudScale, 0.8, 1.35),
    worldLabelScale: clamp(
      Number.isFinite(overrides.worldLabelScale) ? overrides.worldLabelScale : source.worldLabelScale,
      0.8,
      1.4
    ),
    motionScale: clamp(Number.isFinite(overrides.motionScale) ? overrides.motionScale : source.motionScale, 0.0, 1.0),
    bloomScale: clamp(Number.isFinite(overrides.bloomScale) ? overrides.bloomScale : source.bloomScale, 0.0, 1.0),
    glitchScale: clamp(Number.isFinite(overrides.glitchScale) ? overrides.glitchScale : source.glitchScale, 0.0, 1.0),
    flickerAllowed: typeof overrides.flickerAllowed === 'boolean' ? overrides.flickerAllowed : source.flickerAllowed,
    contrastMode: overrides.contrastMode === 'high-contrast' ? 'high-contrast' : source.contrastMode
  };
}
