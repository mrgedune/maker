// Copied from Critical Response (game/sim/rng.js), not shared.
// Seeded random (mulberry32). The simulation draws randomness only from here, so
// a run is fully decided by its seed and its input log.

export function createRng(seed) {
  let state = seed >>> 0 || 1;
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    range: (lo, hi) => lo + (hi - lo) * next(),
    getState: () => state,
    // A saved world puts its stream back where it was (snapshot.js).
    setState: (s) => {
      state = s >>> 0;
    },
  };
}
