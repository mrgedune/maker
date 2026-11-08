export const DEFAULT_MATERIAL_PROPERTIES = Object.freeze({
  roughness: 0.65,
  emission: 0,
  lightResponse: 0.5
});

function clamp01(value, fallback) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(0, Math.min(1, numeric));
}

export function normalizeMaterialProperties(properties = {}) {
  return {
    roughness: clamp01(properties.roughness, DEFAULT_MATERIAL_PROPERTIES.roughness),
    emission: clamp01(properties.emission, DEFAULT_MATERIAL_PROPERTIES.emission),
    lightResponse: clamp01(properties.lightResponse, DEFAULT_MATERIAL_PROPERTIES.lightResponse)
  };
}

export function encodeMaterialProperties(properties = {}) {
  const normalized = normalizeMaterialProperties(properties);
  return [
    Math.round(normalized.roughness * 255),
    Math.round(normalized.emission * 255),
    Math.round(normalized.lightResponse * 255),
    255
  ];
}
