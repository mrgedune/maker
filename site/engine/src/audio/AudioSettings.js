/**
 * Versioned, dependency-neutral audio settings contracts.
 *
 * The historical field names are retained at the persistence boundary so old
 * custom presets remain readable. In schema v2 they mean Master, Music, SFX,
 * Tempo, and Reverb percentages respectively.
 */

export const AUDIO_PRESET_SCHEMA_VERSION = 2;

const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const clamp = (value, minimum, maximum) => Math.max(minimum, Math.min(maximum, value));

const CURRENT_RANGES = Object.freeze({
  baseFreq: Object.freeze([0, 100]),
  beatFreq: Object.freeze([0, 100]),
  waveSpeed: Object.freeze([0, 100]),
  noiseVol: Object.freeze([50, 200]),
  saturation: Object.freeze([0, 100])
});

const LEGACY_RANGES = Object.freeze({
  baseFreq: Object.freeze([40, 300]),
  beatFreq: Object.freeze([0, 25]),
  waveSpeed: Object.freeze([0, 2]),
  noiseVol: Object.freeze([0, 1]),
  saturation: Object.freeze([0, 100])
});

const PRESET_FIELDS = Object.freeze(Object.keys(CURRENT_RANGES));

function requirePresetObject(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new TypeError('Audio preset must be an object');
  }
  return raw;
}

function requireFiniteNumber(value, label) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TypeError(`${label} must be a finite number`);
  }
  return value;
}

function readFiniteFields(raw) {
  return Object.fromEntries(PRESET_FIELDS.map(field => [
    field,
    requireFiniteNumber(raw[field], field)
  ]));
}

function valuesFit(values, ranges) {
  return PRESET_FIELDS.every(field => {
    const [minimum, maximum] = ranges[field];
    return values[field] >= minimum && values[field] <= maximum;
  });
}

function normalizeName(rawName, fallback) {
  if (rawName === undefined) return fallback;
  if (typeof rawName !== 'string') throw new TypeError('name must be a string');
  const name = rawName.trim();
  return (name || fallback).slice(0, 64);
}

function makeV2Preset(raw, values, fallbackName) {
  return Object.freeze({
    schemaVersion: AUDIO_PRESET_SCHEMA_VERSION,
    name: normalizeName(raw.name, fallbackName),
    baseFreq: clamp(values.baseFreq, ...CURRENT_RANGES.baseFreq),
    beatFreq: clamp(values.beatFreq, ...CURRENT_RANGES.beatFreq),
    waveSpeed: clamp(values.waveSpeed, ...CURRENT_RANGES.waveSpeed),
    noiseVol: clamp(values.noiseVol, ...CURRENT_RANGES.noiseVol),
    saturation: clamp(values.saturation, ...CURRENT_RANGES.saturation)
  });
}

/**
 * Normalize a v2 preset or migrate one of the two shipped unversioned formats.
 *
 * A present schemaVersion is authoritative and must be exactly numeric 2.
 * Truly unversioned values are classified by their complete legal range: the
 * current Tempo range (50..200) and legacy noise range (0..1) are disjoint.
 * Partial/out-of-range shapes are rejected instead of guessed.
 */
export function normalizeAudioPreset(raw) {
  const preset = requirePresetObject(raw);
  const values = readFiniteFields(preset);

  if (hasOwn(preset, 'schemaVersion')) {
    if (preset.schemaVersion !== AUDIO_PRESET_SCHEMA_VERSION) {
      throw new RangeError(`Unsupported audio preset schema: ${String(preset.schemaVersion)}`);
    }
    return makeV2Preset(preset, values, 'Custom');
  }

  const currentFormat = valuesFit(values, CURRENT_RANGES);
  const legacyFormat = valuesFit(values, LEGACY_RANGES);
  if (currentFormat && legacyFormat) {
    throw new RangeError('Ambiguous unversioned audio preset');
  }
  if (currentFormat) return makeV2Preset(preset, values, 'Migrated Current');
  if (!legacyFormat) throw new RangeError('Unknown unversioned audio preset format');

  return makeV2Preset(preset, {
    baseFreq: (values.baseFreq - 40) / 260 * 100,
    beatFreq: values.beatFreq / 25 * 100,
    waveSpeed: values.waveSpeed / 2 * 100,
    noiseVol: (0.5 + values.noiseVol * 1.5) * 100,
    saturation: values.saturation
  }, 'Migrated Legacy');
}

export const DEFAULT_AUDIO_PRESET = Object.freeze({
  schemaVersion: AUDIO_PRESET_SCHEMA_VERSION,
  name: 'Current',
  baseFreq: 64,
  beatFreq: 80,
  waveSpeed: 80,
  noiseVol: 100,
  saturation: 40
});

export const DEFAULT_AUDIO_SETTINGS = Object.freeze({
  schemaVersion: AUDIO_PRESET_SCHEMA_VERSION,
  preset: DEFAULT_AUDIO_PRESET,
  trackId: 'horror_atmosphere',
  soundscapeEnabled: true,
  fullSoundEnabled: true,
  focusPolicy: 'mute',
  dynamicRange: 'standard',
  mono: false
});
