// Reused uniform storage; absent effects are neutral, malformed channels are
// bounded, and no frame allocates a new color buffer.
const clamp = (value, fallback = 0) => Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : fallback;
export function createScreenFlashState() {
  return { opacity: 0, middleStop: .55, inner: new Float32Array(4),
    middle: new Float32Array(4), outer: new Float32Array(4) };
}
export function updateScreenFlash(state, flash) {
  state.opacity = clamp(flash?.opacity);
  if (!state.opacity) return state;
  state.middleStop = Math.max(.001, Math.min(.999, clamp(flash.middleStop, .55)));
  for (const name of ['inner', 'middle', 'outer']) {
    for (let i = 0; i < 4; i++) state[name][i] = clamp(flash[name]?.[i]);
  }
  return state;
}
