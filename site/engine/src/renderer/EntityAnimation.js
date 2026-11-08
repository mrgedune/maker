export { resolveOperativeMotion } from './OperativeMotion.js';

const DEFAULT_TRANSITION_MS = 420;

export const ENTITY_ANIMATION_PROFILES = Object.freeze({
  echo: Object.freeze({
    default: Object.freeze({ pace: 1.55, stride: 0.035, bob: 0.014, sway: 0.04, lean: 0.015, turnLean: 0.025, armSwing: 0.055, secondary: 0.72, breath: 0.012, breathRate: 1.1, cohesion: 0.58, phaseOffset: 0.07, duplicateSpread: 0.06, coreIntensity: 0.4, fracture: 0.12, trailSpread: 0.34 }),
    residual: Object.freeze({ pace: 1.55, stride: 0.035, bob: 0.014, sway: 0.04, lean: 0.015, turnLean: 0.025, armSwing: 0.055, secondary: 0.72, breath: 0.012, breathRate: 1.1, cohesion: 0.58, phaseOffset: 0.07, duplicateSpread: 0.06, coreIntensity: 0.4, fracture: 0.12, trailSpread: 0.34 }),
    manifesting: Object.freeze({ pace: 2.15, stride: 0.048, bob: 0.02, sway: 0.032, lean: 0.04, turnLean: 0.04, armSwing: 0.085, secondary: 1.05, breath: 0.018, breathRate: 1.8, cohesion: 0.82, phaseOffset: 0.13, duplicateSpread: 0.13, coreIntensity: 0.72, fracture: 0.34, trailSpread: 0.52 }),
    interference: Object.freeze({ pace: 3.6, stride: 0.065, bob: 0.03, sway: 0.055, lean: 0.085, turnLean: 0.065, armSwing: 0.12, secondary: 1.5, breath: 0.026, breathRate: 3.6, cohesion: 1, phaseOffset: 0.22, duplicateSpread: 0.24, coreIntensity: 1, fracture: 1, trailSpread: 0.9 }),
    destabilized: Object.freeze({ pace: 5.2, stride: 0.025, bob: 0.045, sway: 0.09, lean: -0.02, turnLean: 0.03, armSwing: 0.05, secondary: 1.8, breath: 0.03, breathRate: 5.4, cohesion: 0.18, phaseOffset: 0.31, duplicateSpread: 0.34, coreIntensity: 1.2, fracture: 1.35, trailSpread: 1 })
  }),
  night_scavenger: Object.freeze({
    default: Object.freeze({ pace: .8, stride: 0, breath: .004, breathRate: 1.3 }),
    idle: Object.freeze({ pace: .8, stride: 0, breath: .004, breathRate: 1.3 }),
    walk: Object.freeze({ pace: 7.8, stride: .19, breath: .006, breathRate: 1.8 }),
    sprint: Object.freeze({ pace: 11, stride: .24, breath: .008, breathRate: 2.4 }),
    concealed: Object.freeze({ pace: 3, stride: .055, crouch: 1, breath: .003, breathRate: 1 })
  }),
  hider: Object.freeze({
    default: Object.freeze({ pace: 0.8, stride: 0, bob: 0.004, sway: 0.006, lean: 0, turnLean: 0.025, armSwing: 0, secondary: 0.35, breath: 0.01, breathRate: 1.1, crouch: 0, guard: 0.08, visor: 1, shieldFlare: 0, signalJitter: 0, collapse: 0 }),
    idle: Object.freeze({ pace: 0.8, stride: 0, bob: 0.004, sway: 0.006, lean: 0, turnLean: 0.025, armSwing: 0, secondary: 0.35, breath: 0.01, breathRate: 1.1, crouch: 0, guard: 0.08, visor: 1, shieldFlare: 0, signalJitter: 0, collapse: 0 }),
    walk: Object.freeze({ pace: 3.2, stride: 0.1, bob: 0.018, sway: 0.018, lean: 0.025, turnLean: 0.04, armSwing: 0.13, secondary: 0.75, breath: 0.012, breathRate: 1.8, crouch: 0, guard: 0.05, visor: 1, shieldFlare: 0, signalJitter: 0, collapse: 0 }),
    sprint: Object.freeze({ pace: 6.2, stride: 0.19, bob: 0.035, sway: 0.012, lean: 0.13, turnLean: 0.065, armSwing: 0.23, secondary: 1.2, breath: 0.018, breathRate: 3.6, crouch: 0.03, guard: 0, visor: 1.12, shieldFlare: 0, signalJitter: 0, collapse: 0 }),
    concealed: Object.freeze({ pace: 1.15, stride: 0.025, bob: 0.006, sway: 0.006, lean: 0.045, turnLean: 0.025, armSwing: 0.035, secondary: 0.28, breath: 0.006, breathRate: 0.8, crouch: 0.2, guard: 0.35, visor: 0.48, shieldFlare: 0, signalJitter: 0, collapse: 0 }),
    compromised: Object.freeze({ pace: 4.5, stride: 0.075, bob: 0.025, sway: 0.026, lean: 0.075, turnLean: 0.06, armSwing: 0.08, secondary: 1.35, breath: 0.022, breathRate: 3.4, crouch: 0.02, guard: 0.78, visor: 1.35, shieldFlare: 1, signalJitter: 1, collapse: 0 }),
    link_lost: Object.freeze({ pace: 0.2, stride: 0, bob: 0, sway: 0, lean: 0, turnLean: 0, armSwing: 0, secondary: 0.08, breath: 0, breathRate: 0.2, crouch: 0, guard: 0, visor: 0, shieldFlare: 0, signalJitter: 0, collapse: 1 })
  }),
  // corp_guard shares hider's body and none of its vocabulary. Its poses are
  // named for what a guard DOES, not for how fast he is moving, and there is
  // deliberately NO speed inference (hider infers idle/walk/sprint from actual
  // travel; see resolveStateKey). A guard walking a beat and a guard walking
  // AT you are the same speed and completely different events, so the state is
  // the game's to say and the archetype never guesses it.
  //
  //   lampRaise   — 0 the lamp is held low-ready across the body, 1 thrust
  //                 forward and up. Kept SMALL on purpose: the lamp's emitter
  //                 offset is exported as one number, so a pose that flung the
  //                 lamp around would make the light lie about where it is.
  //   lampSweep   — how far the beam wanders across the paving as he carries
  //                 it. This is the tell that arrives before the man does.
  //   sidearmRest — 1 the free hand rests on the holster, 0 it swings.
  //   hail        — the free arm up, palm out. The challenge, before a word.
  //   alertGlow   — the shoulder strobes, dim pip to blazing.
  //   stance      — how wide the feet are planted.
  //
  // `default` IS `post`, on the same reasoning arc_bolt's default is `spent`:
  // the state a game gets without asking should be the one that claims the
  // least. A guard who has not noticed you is the safe wrong answer.
  corp_guard: Object.freeze({
    default: Object.freeze({ pace: 0.85, stride: 0, bob: 0.005, sway: 0.007, lean: 0, turnLean: 0.03, armSwing: 0, secondary: 0.3, breath: 0.011, breathRate: 1, lampRaise: 0, lampSweep: 0.35, lampGlow: 1, sidearmRest: 1, hail: 0, alertGlow: 0, stance: 1 }),
    post: Object.freeze({ pace: 0.85, stride: 0, bob: 0.005, sway: 0.007, lean: 0, turnLean: 0.03, armSwing: 0, secondary: 0.3, breath: 0.011, breathRate: 1, lampRaise: 0, lampSweep: 0.35, lampGlow: 1, sidearmRest: 1, hail: 0, alertGlow: 0, stance: 1 }),
    patrol: Object.freeze({ pace: 3, stride: 0.095, bob: 0.017, sway: 0.017, lean: 0.022, turnLean: 0.045, armSwing: 0.1, secondary: 0.72, breath: 0.012, breathRate: 1.7, lampRaise: 0.1, lampSweep: 1, lampGlow: 1, sidearmRest: 0.2, hail: 0, alertGlow: 0.1, stance: 0.5 }),
    challenge: Object.freeze({ pace: 1.9, stride: 0.02, bob: 0.01, sway: 0.006, lean: 0.05, turnLean: 0.05, armSwing: 0.02, secondary: 1.1, breath: 0.02, breathRate: 3, lampRaise: 1, lampSweep: 0.12, lampGlow: 1, sidearmRest: 0, hail: 1, alertGlow: 1, stance: 0.85 })
  }),
  seeker: Object.freeze({
    default: Object.freeze({ pace: 1.8, stride: 0.055, bob: 0.018, sway: 0.025, lean: 0, turnLean: 0.025, armSwing: 0.08, secondary: 0.65, breath: 0.012, breathRate: 1.6, lock: 0.12, aperture: 0.38, tendrilSpread: 0.55 }),
    observed: Object.freeze({ pace: 0.16, stride: 0, bob: 0, sway: 0.002, lean: -0.025, turnLean: 0.006, armSwing: 0, secondary: 0.08, breath: 0.003, breathRate: 0.4, lock: 1, aperture: 0.14, tendrilSpread: 0.18 }),
    wander: Object.freeze({ pace: 2.2, stride: 0.075, bob: 0.022, sway: 0.035, lean: 0, turnLean: 0.035, armSwing: 0.1, secondary: 0.8, breath: 0.014, breathRate: 1.8, lock: 0.1, aperture: 0.35, tendrilSpread: 0.5 }),
    search: Object.freeze({ pace: 3.8, stride: 0.105, bob: 0.03, sway: 0.05, lean: 0.025, turnLean: 0.055, armSwing: 0.14, secondary: 1.05, breath: 0.018, breathRate: 2.3, lock: 0.18, aperture: 0.42, tendrilSpread: 0.62 }),
    agitated: Object.freeze({ pace: 5.1, stride: 0.085, bob: 0.04, sway: 0.075, lean: 0.06, turnLean: 0.075, armSwing: 0.19, secondary: 1.4, breath: 0.025, breathRate: 3.2, lock: 0.05, aperture: 0.72, tendrilSpread: 0.88 }),
    chase: Object.freeze({ pace: 6.4, stride: 0.16, bob: 0.047, sway: 0.035, lean: 0.12, turnLean: 0.09, armSwing: 0.22, secondary: 1.25, breath: 0.02, breathRate: 4.1, lock: 0, aperture: 1, tendrilSpread: 1 })
  }),
  hunter: Object.freeze({
    default: Object.freeze({ pace: 2.2, stride: 0.04, bob: 0.012, sway: 0.012, lean: 0, turnLean: 0.025, secondary: 0.5, breath: 0, breathRate: 1, sensorSweep: 0.72, clampOpen: 0.12, suspension: 0.35 }),
    search: Object.freeze({ pace: 3.1, stride: 0.055, bob: 0.016, sway: 0.018, lean: 0.015, turnLean: 0.04, secondary: 0.9, breath: 0, breathRate: 1, sensorSweep: 1, clampOpen: 0.05, suspension: 0.42 }),
    chase: Object.freeze({ pace: 4.8, stride: 0.085, bob: 0.022, sway: 0.012, lean: 0.1, turnLean: 0.065, secondary: 1.25, breath: 0, breathRate: 1, sensorSweep: 0.18, clampOpen: 1, suspension: 0.82 })
  }),
  banshee: Object.freeze({
    default: Object.freeze({ pace: 0.75, stride: 0.02, bob: 0.008, sway: 0.015, lean: 0, turnLean: 0.02, secondary: 0.35, breath: 0.016, breathRate: 1.1, membraneSpread: 0.12, throatOpen: 0.04, resonance: 0.08, shudder: 0.03 }),
    docile: Object.freeze({ pace: 0.75, stride: 0.02, bob: 0.008, sway: 0.015, lean: 0, turnLean: 0.02, secondary: 0.35, breath: 0.016, breathRate: 1.1, membraneSpread: 0.12, throatOpen: 0.04, resonance: 0.08, shudder: 0.03 }),
    agitated: Object.freeze({ pace: 3.8, stride: 0.05, bob: 0.025, sway: 0.055, lean: 0.04, turnLean: 0.05, secondary: 1.25, breath: 0.03, breathRate: 3.8, membraneSpread: 0.58, throatOpen: 0.48, resonance: 0.7, shudder: 1 }),
    chase: Object.freeze({ pace: 6.2, stride: 0.11, bob: 0.04, sway: 0.04, lean: 0.14, turnLean: 0.08, secondary: 1.6, breath: 0.025, breathRate: 5, membraneSpread: 1, throatOpen: 1, resonance: 1, shudder: 0.45 })
  }),
  specter: Object.freeze({
    default: Object.freeze({ pace: 1.15, stride: 0.015, bob: 0.018, sway: 0.035, lean: 0, turnLean: 0.025, secondary: 0.7, breath: 0.012, breathRate: 1.2, cohesion: 0.58, aperture: 0.34, orbitRate: 0.75, trailSpread: 0.42, phaseBurst: 0.08 }),
    wander: Object.freeze({ pace: 1.15, stride: 0.015, bob: 0.018, sway: 0.035, lean: 0, turnLean: 0.025, secondary: 0.7, breath: 0.012, breathRate: 1.2, cohesion: 0.58, aperture: 0.34, orbitRate: 0.75, trailSpread: 0.42, phaseBurst: 0.08 }),
    stalk: Object.freeze({ pace: 3.8, stride: 0.065, bob: 0.028, sway: 0.018, lean: 0.13, turnLean: 0.07, secondary: 1.35, breath: 0.02, breathRate: 3.4, cohesion: 1, aperture: 1, orbitRate: 2.4, trailSpread: 0.16, phaseBurst: 0.18 }),
    disperse: Object.freeze({ pace: 6.5, stride: 0, bob: 0.055, sway: 0.09, lean: -0.04, turnLean: 0.02, secondary: 1.8, breath: 0.03, breathRate: 6, cohesion: 0.08, aperture: 0.78, orbitRate: 5.8, trailSpread: 1, phaseBurst: 1 })
  }),
  warden: Object.freeze({
    default: Object.freeze({ pace: 0.9, stride: 0.03, bob: 0.007, sway: 0.018, lean: 0.12, turnLean: 0.02, armSwing: 0.035, secondary: 0.65, breath: 0.014, breathRate: 0.85, reach: 0.12, phaseReveal: 1 }),
    dormant: Object.freeze({ pace: 0.2, stride: 0, bob: 0, sway: 0.004, lean: 0.13, turnLean: 0.01, armSwing: 0, secondary: 0.12, breath: 0.006, breathRate: 0.45, reach: 0.05, phaseReveal: 1 }),
    wander: Object.freeze({ pace: 1.15, stride: 0.042, bob: 0.01, sway: 0.028, lean: 0.12, turnLean: 0.028, armSwing: 0.05, secondary: 0.8, breath: 0.018, breathRate: 1.05, reach: 0.16, phaseReveal: 1 }),
    hunt: Object.freeze({ pace: 1.9, stride: 0.072, bob: 0.016, sway: 0.035, lean: 0.17, turnLean: 0.045, armSwing: 0.09, secondary: 1.15, breath: 0.024, breathRate: 1.55, reach: 0.56, phaseReveal: 1 }),
    chase: Object.freeze({ pace: 2.65, stride: 0.095, bob: 0.022, sway: 0.035, lean: 0.2, turnLean: 0.055, armSwing: 0.12, secondary: 1.35, breath: 0.028, breathRate: 1.9, reach: 0.72, phaseReveal: 1 }),
    emerge: Object.freeze({ pace: 0.8, stride: 0, bob: 0, sway: 0.025, lean: 0.14, turnLean: 0.02, armSwing: 0.02, secondary: 1.5, breath: 0.025, breathRate: 1.4, reach: 0.38, phaseReveal: 0.62 }),
    vanish: Object.freeze({ pace: 1.1, stride: 0, bob: 0, sway: 0.04, lean: 0.2, turnLean: 0.025, armSwing: 0.03, secondary: 1.8, breath: 0.02, breathRate: 1.8, reach: 0.55, phaseReveal: 0.34 })
  }),
  mourner: Object.freeze({
    default: Object.freeze({ pace: 0.75, stride: 0.025, bob: 0.008, sway: 0.018, lean: 0.08, turnLean: 0.02, armSwing: 0, secondary: 0.35, breath: 0.018, breathRate: 1.15, faceCover: 1, jawOpen: 0.02, tremor: 0.008, crouch: 0.28 }),
    docile: Object.freeze({ pace: 0.75, stride: 0.025, bob: 0.008, sway: 0.018, lean: 0.08, turnLean: 0.02, armSwing: 0, secondary: 0.35, breath: 0.018, breathRate: 1.15, faceCover: 1, jawOpen: 0.02, tremor: 0.008, crouch: 0.28 }),
    agitated: Object.freeze({ pace: 2.8, stride: 0.045, bob: 0.018, sway: 0.035, lean: 0.11, turnLean: 0.035, armSwing: 0.03, secondary: 1.2, breath: 0.032, breathRate: 3.8, faceCover: 0.82, jawOpen: 0.42, tremor: 0.055, crouch: 0.22 }),
    rage: Object.freeze({ pace: 7.6, stride: 0.235, bob: 0.055, sway: 0.025, lean: 0.2, turnLean: 0.085, armSwing: 0.26, secondary: 1.55, breath: 0.02, breathRate: 5.2, faceCover: 0, jawOpen: 1, tremor: 0.025, crouch: 0.12 })
  }),
  node: Object.freeze({
    offline: Object.freeze({ pace: 0.8, pulseRate: 1.4, pulseDepth: 0.1, lift: 0, ringExpansion: 0, orbitRate: 0.35, secondary: 0.45 }),
    calibrating: Object.freeze({ pace: 2.4, pulseRate: 5.2, pulseDepth: 0.22, lift: -0.035, ringExpansion: 0.035, orbitRate: 1.5, secondary: 1 }),
    active: Object.freeze({ pace: 1.4, pulseRate: 2.8, pulseDepth: 0.14, lift: -0.055, ringExpansion: 0.055, orbitRate: 0.85, secondary: 0.75 }),
    default: Object.freeze({ pace: 0.8, pulseRate: 1.4, pulseDepth: 0.1, lift: 0, ringExpansion: 0, orbitRate: 0.35, secondary: 0.45 })
  }),
  data_core: Object.freeze({
    idle: Object.freeze({ pace: 1, hoverRate: 2.8, hoverDepth: 0.045, spinRate: 1.4, pulseRate: 2.1, pulseDepth: 0.12, orbitRadius: 0.23, secondary: 0.8 }),
    charged: Object.freeze({ pace: 1.5, hoverRate: 3.6, hoverDepth: 0.065, spinRate: 2.2, pulseRate: 4.4, pulseDepth: 0.2, orbitRadius: 0.28, secondary: 1.15 }),
    unstable: Object.freeze({ pace: 2.2, hoverRate: 5.2, hoverDepth: 0.085, spinRate: 3.4, pulseRate: 7.5, pulseDepth: 0.28, orbitRadius: 0.31, secondary: 1.45 }),
    default: Object.freeze({ pace: 1, hoverRate: 2.8, hoverDepth: 0.045, spinRate: 1.4, pulseRate: 2.1, pulseDepth: 0.12, orbitRadius: 0.23, secondary: 0.8 })
  }),
  // Vehicle/prop archetypes (Upgrade: city props). Deliberately quiet: cars
  // and boxes that dance read as bugs. Every motion field is optional and
  // cheap - one or two sines per build at most.
  pod_car: Object.freeze({
    default: Object.freeze({ pace: 1, turnLean: 0.045, hoverRate: 2.4, hoverDepth: 0.012, settle: 0, lampGlow: 1 }),
    drive: Object.freeze({ pace: 1, turnLean: 0.045, hoverRate: 2.4, hoverDepth: 0.012, settle: 0, lampGlow: 1 }),
    parked: Object.freeze({ pace: 0.5, turnLean: 0, hoverRate: 0.9, hoverDepth: 0.004, settle: 0.045, lampGlow: 0.12 })
  }),
  tram_car: Object.freeze({
    default: Object.freeze({ pace: 0.8, turnLean: 0.02, hoverRate: 1.7, hoverDepth: 0.005 })
  }),
  skimmer: Object.freeze({
    default: Object.freeze({ pace: 1.2, turnLean: 0.06, hoverRate: 2.8, hoverDepth: 0.022, wingFlex: 0.05, bank: 0 }),
    cruise: Object.freeze({ pace: 1.2, turnLean: 0.06, hoverRate: 2.8, hoverDepth: 0.022, wingFlex: 0.05, bank: 0 }),
    bank: Object.freeze({ pace: 1.6, turnLean: 0.09, hoverRate: 3.4, hoverDepth: 0.026, wingFlex: 0.09, bank: 0.32 })
  }),
  cache: Object.freeze({
    default: Object.freeze({ pace: 1, seamRate: 2.2, seamDepth: 0.1, lidOpen: 0 }),
    sealed: Object.freeze({ pace: 1, seamRate: 2.2, seamDepth: 0.1, lidOpen: 0 }),
    open: Object.freeze({ pace: 1.3, seamRate: 3.1, seamDepth: 0.16, lidOpen: 1 })
  }),
  crate: Object.freeze({
    default: Object.freeze({ pace: 0.5 })
  }),
  repair_kit: Object.freeze({
    default: Object.freeze({ pace: 1, stripeRate: 1.8, stripeDepth: 0.08 })
  }),
  // A street lamp does not move at all: the ONLY thing its poses carry is
  // lampGlow, and the builder ignores every locomotion field. `dark` is a
  // blackout district's dead fixture, so it keeps the mast and loses the light.
  // The 420 ms profile blend means switching pose fades the face rather than
  // snapping it, which is what a failing municipal lamp should look like.
  street_lamp: Object.freeze({
    default: Object.freeze({ pace: 0.25, lampGlow: 1 }),
    lit: Object.freeze({ pace: 0.25, lampGlow: 1 }),
    dark: Object.freeze({ pace: 0.25, lampGlow: 0 })
  }),
  // Street furniture (Beyond Dawn). Bolted down, and DELIBERATELY DEAD STILL —
  // including the two planted ones. A sway on foliage is tempting and wrong
  // here: the renderer draws at 1x2px glyph cells, so a 0.01-cell edge drift
  // does not read as wind, it reads as the silhouette's boundary glyphs
  // flickering between characters every entity tick. Stillness is the correct
  // ambient behaviour for a mass this coarsely rasterized.
  bench: Object.freeze({
    default: Object.freeze({ pace: 0.25 })
  }),
  planter: Object.freeze({
    default: Object.freeze({ pace: 0.25 })
  }),
  tree_canopy: Object.freeze({
    default: Object.freeze({ pace: 0.25 })
  }),
  // Both lamps carry the street_lamp's `lampGlow` field by the same name and
  // with the same meaning, so a game has one mental model for every fixture
  // that can go out. Note the 420 ms profile blend makes a pose change a FADE;
  // a hard blink wants per-entity `accent` or two registrations (see API.md).
  antenna_mast: Object.freeze({
    default: Object.freeze({ pace: 0.25, lampGlow: 1 }),
    lit: Object.freeze({ pace: 0.25, lampGlow: 1 }),
    dark: Object.freeze({ pace: 0.25, lampGlow: 0 })
  }),
  /**
   * A ROOST OF BATS, hanging. Added for Beyond Dawn's shelter; nothing else
   * references it, so it is additive by construction.
   *
   * `wingSpread` is the whole animation: 0 is folded - wings wrapped round the
   * body, which is what a sleeping bat looks like and is a smooth closed mass
   * at glyph scale - and 1 is startled, wings out and the body dropped. The
   * drop is the honest part: the first thing a disturbed bat does is fall
   * before it flies.
   *
   * `pace` is low because a roost is nearly still. The travel between the two
   * poses is authored in TENTHS of a cell for the reason the steam plume's
   * note below states at length: a hundredth-of-a-cell drift does not read as
   * movement, it reads as the rasteriser changing its mind.
   */
  bat_roost: Object.freeze({
    default: Object.freeze({ pace: 0.2, wingSpread: 0 }),
    folded: Object.freeze({ pace: 0.2, wingSpread: 0 }),
    stirred: Object.freeze({ pace: 0.9, wingSpread: 1 })
  }),
  // Beyond Dawn's shelter fixtures. Each pose drives ONE emissive element and
  // never the silhouette, so an unpowered station is the same object with its
  // light off rather than a different object - which is what lets the room
  // teach what is affordable without redrawing itself.
  workbench: Object.freeze({
    default: Object.freeze({ pace: 0.2, lampGlow: 1 }),
    lit: Object.freeze({ pace: 0.2, lampGlow: 1 }),
    dark: Object.freeze({ pace: 0.2, lampGlow: 0 })
  }),
  cosmetic_post: Object.freeze({
    default: Object.freeze({ pace: 0.2, lampGlow: 1 }),
    lit: Object.freeze({ pace: 0.2, lampGlow: 1 }),
    dark: Object.freeze({ pace: 0.2, lampGlow: 0 })
  }),
  shelter_screen: Object.freeze({
    default: Object.freeze({ pace: 0.2, screenGlow: 1 }),
    unread: Object.freeze({ pace: 0.2, screenGlow: 1 }),
    read: Object.freeze({ pace: 0.2, screenGlow: 0.28 })
  }),
  cot: Object.freeze({ default: Object.freeze({ pace: 0.15 }) }),
  brazier: Object.freeze({
    default: Object.freeze({ pace: 0.4, coalGlow: 1 }),
    lit: Object.freeze({ pace: 0.4, coalGlow: 1 }),
    cold: Object.freeze({ pace: 0.15, coalGlow: 0 })
  }),
  chute: Object.freeze({ default: Object.freeze({ pace: 0.15 }) }),
  cable_run: Object.freeze({ default: Object.freeze({ pace: 0.15 }) }),
  // Winch tether (Beyond Dawn's grapple). NO GAIT: its whole shape comes from
  // `entity.params` on every frame — reach, rise, slack, hook — so there is
  // nothing for a profile to animate and one `default` pose is the honest
  // table. `pace: 0` states that intent; note that the track reads
  // `pose.pace || 1`, so the cycle still advances at 1 — harmless, because
  // the builder never reads the cycle, the stride, the bob or the spawn ramp.
  // With only `default` in the table every state resolves to it, so a game
  // that passes no pose and one that passes 'default' get the same line.
  tether: Object.freeze({ default: Object.freeze({ pace: 0 }) }),
  lantern: Object.freeze({
    default: Object.freeze({ pace: 0.25, lampGlow: 1 }),
    lit: Object.freeze({ pace: 0.25, lampGlow: 1 }),
    dark: Object.freeze({ pace: 0.25, lampGlow: 0 })
  }),
  // Steam plume (Beyond Dawn's vent hazard). THE ONE ARCHETYPE THAT IS
  // SUPPOSED TO MOVE A LOT, and the exception proves the street-furniture rule
  // above rather than contradicting it. Foliage was held dead still because a
  // 0.01-cell drift at 1x2px cells does not read as wind, it reads as boundary
  // glyphs flickering. The answer is not "never move a mass", it is "move it
  // far enough that the motion is the shape changing rather than the
  // rasterizer changing its mind" — so every travel here is authored in TENTHS
  // of a cell, an order of magnitude over the flicker band.
  //
  //   plumeRise  — how far up the column reaches, as a fraction of the
  //                authored 2.6-cell envelope. The whole column compresses
  //                toward the plate at low rise.
  //   plumeSwell — lobe radii AND their offsets from the axis, so a gathering
  //                breath is a small plume and not a thin one.
  //   billow     — lateral travel of one billow, in cells.
  //   surge      — vertical travel of one billow, in cells. One-sided (see the
  //                builder): a lobe only ever sags FROM its authored height,
  //                which is what keeps the authored numbers a true envelope.
  //   churnRate / churnDepth — the boil's rate in Hz-ish and how far a lobe
  //                shrinks at the bottom of its cycle.
  //
  // The 420 ms profile blend is load-bearing here rather than cosmetic: the
  // game's telegraph window is 800 ms and its blast 1000 ms, so a
  // telegraph -> active pose change GROWS the column over the first 420 ms of
  // the blast instead of popping a full-height plume into existence. The
  // gather and the blast are one continuous motion for free.
  steam_plume: Object.freeze({
    default: Object.freeze({ pace: 1, plumeRise: 1, plumeSwell: 1, billow: 0.1, surge: 0.11, churnRate: 1.35, churnDepth: 0.22 }),
    active: Object.freeze({ pace: 1, plumeRise: 1, plumeSwell: 1, billow: 0.1, surge: 0.11, churnRate: 1.35, churnDepth: 0.22 }),
    // The first breath: low, small, and slower — pressure gathering rather
    // than pressure released. Deliberately NOT a short version of the blast;
    // what a player must read in 800 ms is "something is about to come out of
    // that plate", so it hugs the plate.
    telegraph: Object.freeze({ pace: 0.7, plumeRise: 0.34, plumeSwell: 0.52, billow: 0.045, surge: 0.05, churnRate: 0.95, churnDepth: 0.3 })
  }),
  // Arc bolt (Beyond Dawn's discharge). THE ONE ARCHETYPE THAT DOES NOT MOVE
  // AT ALL — it is REPLACED. Every other profile in this file describes a
  // continuous quantity a builder can evaluate at any instant; the plume above
  // boils, the street furniture holds still, a creature walks. Lightning does
  // neither. A bolt's path exists for a few dozen milliseconds and then a
  // completely different path exists, and the eye reads the SUBSTITUTION as
  // electricity. Interpolating between two paths would read as a hose being
  // waved, which is the one thing electricity never looks like.
  //
  // So the fields below are constant WITHIN one strike, and `restrikeRate` is
  // how often the builder throws the whole path away and hashes a new one.
  // Between two strikes the mesh is byte-identical; across one, half its
  // vertices move a third of a cell. That is the entire animation.
  //
  //   jag         — the bolt's deviation from the straight line between its
  //                 emitter and its terminus, in cells, at mid-span. The
  //                 builder spends this as a DIRECTION per node and never as a
  //                 magnitude (see the builder): a jag whose size varies
  //                 spends half its nodes nearly straight, and a nearly
  //                 straight bolt is a rope.
  //   ground      — 0..1, how much the far end is CONNECTED to something. This
  //                 one field carries the whole difference between the two
  //                 things a discharge can do, and nothing else in the profile
  //                 needs to know which happened.
  //   fork        — how far the mid-span forks reach off the spine, as a
  //                 fraction of their authored radial distance.
  //   restrikeRate— path replacements a second. Meshes rebuild on the 30 Hz
  //                 entity tick, so a rate near 15 holds each path for about
  //                 two ticks; much higher and the strike boundary lands
  //                 inside the tick and the re-jag turns into noise.
  //
  // A 60 ms pose blend, not the file's 420 (the builder passes `transitionMs`
  // itself). 420 ms is longer than the entity's whole life, and a bolt that
  // spent its existence morphing from frayed to grounded would be showing the
  // player a contact it did not have yet. A bolt is born knowing what it hit.
  arc_bolt: Object.freeze({
    // `default` IS `spent`, and that choice is the archetype's safety
    // interlock rather than a convenience. Guessing `grounded` wrongly hangs a
    // bright termination in open air — which is exactly the lie the game's new
    // line-of-sight test exists to stop telling. Guessing `spent` wrongly only
    // costs a fray where a contact belonged.
    default: Object.freeze({ pace: 1, jag: 0.26, ground: 0, fork: 1, restrikeRate: 18 }),
    spent: Object.freeze({ pace: 1, jag: 0.26, ground: 0, fork: 1, restrikeRate: 18 }),
    // Grounded into something: the terminus stops wandering (it is a promise
    // about where the bolt stopped), the strands converge on it, and the path
    // re-strikes a little slower — a bolt with somewhere to be flails less
    // than one with nowhere.
    grounded: Object.freeze({ pace: 1, jag: 0.24, ground: 1, fork: 1, restrikeRate: 14 })
  })
});

let animationTracks = new WeakMap();

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function smoothstep(value) {
  const t = clamp(value, 0, 1);
  return t * t * (3 - 2 * t);
}

function lerp(a, b, amount) {
  return a + (b - a) * amount;
}

function shortestAngleDelta(from, to) {
  let delta = to - from;
  while (delta < -Math.PI) delta += Math.PI * 2;
  while (delta > Math.PI) delta -= Math.PI * 2;
  return delta;
}

function phaseFor(entity) {
  const source = String(entity.id || `${entity.x}:${entity.y}:${entity.type}`);
  let hash = 2166136261;
  for (let index = 0; index < source.length; index++) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return ((hash >>> 0) / 4294967295) * Math.PI * 2;
}

function resolveStateKey(entity, archetype, inferredSpeed = 0) {
  if (archetype === 'night_scavenger') {
    if (['idle', 'walk', 'sprint', 'concealed'].includes(entity.state)) return entity.state;
    if (inferredSpeed > 1.4) return 'sprint';
    return inferredSpeed > .035 ? 'walk' : 'idle';
  }
  if (archetype === 'hider') {
    if (entity.isDead) return 'link_lost';
    if (entity.isSpotted) return 'compromised';
    if (['idle', 'walk', 'sprint', 'concealed', 'compromised', 'link_lost'].includes(entity.state)) return entity.state;
    if (inferredSpeed > 1.4) return 'sprint';
    if (inferredSpeed > 0.035) return 'walk';
    return 'idle';
  }
  if (archetype === 'seeker' && entity.isObserved) return 'observed';
  if (archetype === 'specter' && (entity.phaseShiftPulse || 0) > 0) return 'disperse';
  if (archetype === 'node') {
    if (entity.active) return 'active';
    if ((entity.calibration || 0) > 0) return 'calibrating';
    return 'offline';
  }
  if (archetype === 'data_core') {
    if (entity.state === 'unstable') return 'unstable';
    if (entity.active || entity.state === 'charged') return 'charged';
    return 'idle';
  }
  return entity.state || 'default';
}

function blendProfiles(from, to, amount) {
  const blended = {};
  const keys = new Set([...Object.keys(from), ...Object.keys(to)]);
  for (const key of keys) {
    const fromValue = Number.isFinite(from[key]) ? from[key] : 0;
    const toValue = Number.isFinite(to[key]) ? to[key] : fromValue;
    blended[key] = lerp(fromValue, toValue, amount);
  }
  return blended;
}

export function resetEntityAnimationState() {
  animationTracks = new WeakMap();
}

// Steady-state evaluation for deterministic renders (see setDeterministic on
// the renderer). While on, every call evaluates a fresh track as if the entity
// had always existed in its current state: no spawn ramp, no pose blend, gait
// phase from the clock alone, and no speed inferred from movement, so a frame
// depends only on its own inputs and time. Nothing is stored. Off (the
// default) is the historical tracked animation.
let steadyState = false;

export function setEntityAnimationSteadyState(enabled) {
  steadyState = enabled === true;
}

export function resolveEntityAnimation(entity, archetype, currentTime = 0, options = {}) {
  const profiles = ENTITY_ANIMATION_PROFILES[archetype] || { default: {} };
  let track = steadyState ? null : animationTracks.get(entity);
  if (!track) {
    const initialState = options.stateOverride || resolveStateKey(entity, archetype, 0);
    const initialProfile = profiles[initialState] || profiles.default || {};
    const phase = phaseFor(entity);
    track = {
      state: initialState,
      previousState: initialState,
      transitionStart: steadyState ? -Infinity : currentTime,
      lastTime: currentTime,
      createdAt: steadyState ? -Infinity : currentTime,
      cycle: currentTime * 0.001 * (initialProfile.pace || 1) + phase,
      phase,
      lastAngle: Number.isFinite(entity.angle) ? entity.angle : 0,
      lastX: Number.isFinite(entity.x) ? entity.x : 0,
      lastY: Number.isFinite(entity.y) ? entity.y : 0,
      speed: 0,
      turn: 0
    };
    if (!steadyState) animationTracks.set(entity, track);
  }

  const deltaSeconds = clamp((currentTime - track.lastTime) * 0.001, 0, 0.1);
  if (deltaSeconds > 0 && Number.isFinite(entity.x) && Number.isFinite(entity.y)) {
    const distance = Math.hypot(entity.x - track.lastX, entity.y - track.lastY);
    const instantaneousSpeed = clamp(distance / deltaSeconds, 0, 4);
    track.speed = lerp(track.speed, instantaneousSpeed, clamp(deltaSeconds * 10, 0, 1));
  }
  if (Number.isFinite(entity.x)) track.lastX = entity.x;
  if (Number.isFinite(entity.y)) track.lastY = entity.y;

  const state = options.stateOverride || resolveStateKey(entity, archetype, track.speed);
  const targetProfile = profiles[state] || profiles.default || {};

  if (track.state !== state) {
    track.previousState = track.state;
    track.state = state;
    track.transitionStart = currentTime;
  }

  const transitionMs = Number.isFinite(options.transitionMs) ? options.transitionMs : DEFAULT_TRANSITION_MS;
  const transition = smoothstep(transitionMs <= 0 ? 1 : (currentTime - track.transitionStart) / transitionMs);
  const previousProfile = profiles[track.previousState] || profiles.default || targetProfile;
  // A Red Edition finisher authors the body directly. Gameplay profiles describe
  // creatures in locomotion; a fatality is staged, so an authored pose replaces
  // state resolution outright instead of blending with a walk or sprint cycle.
  // Layering over the archetype default keeps authored data to what differs.
  const authoredPose = entity && entity.finisherPose && typeof entity.finisherPose === 'object'
    ? entity.finisherPose
    : null;
  const pose = authoredPose
    ? { ...(profiles.default || {}), ...authoredPose }
    : blendProfiles(previousProfile, targetProfile, transition);
  track.cycle += deltaSeconds * (pose.pace || 1);

  const angle = Number.isFinite(entity.angle) ? entity.angle : track.lastAngle;
  if (deltaSeconds > 0) {
    const angularVelocity = shortestAngleDelta(track.lastAngle, angle) / deltaSeconds;
    const targetTurn = clamp(angularVelocity * 0.08, -1, 1);
    track.turn = lerp(track.turn, targetTurn, clamp(deltaSeconds * 8, 0, 1));
  }
  track.lastAngle = angle;
  track.lastTime = Math.max(track.lastTime, currentTime);

  const timeSeconds = currentTime * 0.001;
  const secondaryScale = options.lod === 'simplified' ? 0.35 : 1;
  const rawStride = Math.sin(track.cycle);
  const stride = rawStride * (pose.stride || 0);
  const bob = Math.abs(rawStride) * (pose.bob || 0);
  const sway = Math.sin(track.cycle * 0.5) * (pose.sway || 0);
  const breath = Math.sin(timeSeconds * (pose.breathRate || 1) + track.phase) * (pose.breath || 0);
  const secondary = Math.sin(track.cycle * 0.7 + track.phase * 0.5) * (pose.secondary || 0) * secondaryScale;
  const pulse = 1 + Math.sin(timeSeconds * (pose.pulseRate || 1) + track.phase) * (pose.pulseDepth || 0);

  return Object.freeze({
    archetype,
    state,
    previousState: track.previousState,
    transition,
    pose: Object.freeze(pose),
    timeSeconds,
    phase: track.phase,
    gait: track.cycle,
    stride,
    counterStride: -stride,
    bob,
    sway,
    breath,
    secondary,
    turn: track.turn,
    lean: (pose.lean || 0) + track.turn * (pose.turnLean || 0),
    pulse,
    motionSpeed: track.speed,
    // An authored pose means the body is staged, not arriving. Letting the spawn
    // ramp run draws a converging materialise outline over the first 650ms of
    // every finisher, which reads as a ghost of the entity.
    spawnProgress: authoredPose ? 1 : smoothstep((currentTime - track.createdAt) / 650),
    // 1 while a finisher is staging this body, 0 during gameplay.
    //
    // Pose parameters were tuned as ambient gameplay detail - a drone's clamps
    // gesturing as it patrols past at distance. Their geometric travel is
    // 0.01-0.18 units, which is invisible at cutscene range where the entity
    // fills the frame and the parameter is supposed to carry the whole kill.
    // Mesh builders read this to give the capture and unfold mechanisms their
    // full travel during a finisher without touching how they look in play.
    finisherStage: authoredPose ? 1 : 0
  });
}
