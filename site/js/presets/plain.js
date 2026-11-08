// The plain fight presets: what any copy of the maker ships with. Numbers are
// ticks at 60 a second, metres and health points. The sliders on the
// Characters screen scale them (fight.js).

export const PLAIN = {
  name: 'Plain',
  presets: {
    brawler: {
      label: 'Crowd brawler',
      about: 'Walks straight at the nearest player and swings. Weak alone, a problem in numbers.',
      health: 60, speed: 3.4, reach: 1.7, sight: 16, tell: 30, strike: 6, recover: 28, damage: 12,
      stagger: 40, cooldown: 24, weights: { swing: 4, slam: 1, throw: 1, charge: 1 }, circle: 0, stages: null,
    },
    duel: {
      label: 'Duel',
      about: 'Circles you, waits for an opening, then commits. Parry it and it reels.',
      health: 140, speed: 3.8, reach: 1.9, sight: 18, tell: 26, strike: 6, recover: 34, damage: 16,
      stagger: 60, cooldown: 40, weights: { swing: 4, slam: 1, throw: 1, charge: 2 }, circle: 3.2, stages: null,
    },
    ambusher: {
      label: 'Ambusher',
      about: 'Waits out of sight until you are close, then charges.',
      health: 70, speed: 5.2, reach: 1.7, sight: 7, tell: 20, strike: 6, recover: 40, damage: 18,
      stagger: 50, cooldown: 30, weights: { swing: 2, slam: 0, throw: 0, charge: 4 }, circle: 0, stages: null,
    },
    boss: {
      label: 'Boss, three stages',
      about: 'Big, slow swings with a clear tell. Changes at two thirds and one third health.',
      health: 600, speed: 3.0, reach: 2.6, sight: 30, tell: 40, strike: 8, recover: 40, damage: 24,
      stagger: 70, cooldown: 30, weights: { swing: 3, slam: 2, throw: 2, charge: 2 }, circle: 0,
      stages: [
        { at: 1, tell: 1, speed: 1, cooldown: 1 },
        { at: 0.66, tell: 0.85, speed: 1.15, cooldown: 0.8 },
        { at: 0.33, tell: 0.7, speed: 1.3, cooldown: 0.6 },
      ],
    },
  },
  // How fights look and feel, beyond the numbers above.
  feel: {
    hitstopSolo: { hit: 0, heavy: 0, parry: 0, kill: 0 }, // ticks the world holds still (never in co-op)
    flash: { hit: 0.25, parry: 0.45, boom: 0.5 }, // screen wash strength
    flashTicks: 6,
    bossBar: true,
    stageShift: false, // each boss stage recolours the room
    quietEnd: false, // the boss's end holds still and the music stops
    tips: true,
  },
};
