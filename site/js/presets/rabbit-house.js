// RABBIT HOUSE FIGHT PRESETS: PRIVATE.
//
// Tuned from the studio's fight brain (studio-hq docs/action-brain). This
// file must never go into a public copy of the maker: the open-source build
// ships plain.js alone. The brain's rules stay in studio-hq; what is here is
// only the numbers they came to.
//
// What the tuning does, by rule:
//   13/32 the player's best move gets the biggest moment: a parry stops the
//         world for about a quarter of a second (solo) on a full flash.
//   32    stops sized to the hit: 0.1 s a hit, 0.17 s heavy, 0.25 s parry.
//   34    a fight starts at full pitch: no slow walk-up, creatures see you
//         further and close faster.
//   5     the calmer fighter reads as stronger: the boss's first stage is
//         slow and heavy; it speeds up as it cracks.
//   11/8  each stage changes the terms and the colour of the room.
//   12    the last move takes the longest and the fight ends in quiet.
//   36/38 the boss is named on arrival; one line teaches the parry.

export const RABBIT_HOUSE = {
  name: 'Rabbit House',
  presets: {
    brawler: {
      label: 'Crowd brawler',
      about: 'Comes at you at once and swings with a short, readable tell. Dangerous in numbers.',
      health: 55, speed: 4.2, reach: 1.7, sight: 22, tell: 24, strike: 5, recover: 22, damage: 11,
      stagger: 48, cooldown: 18, weights: { swing: 5, slam: 1, throw: 1, charge: 2 }, circle: 0, stages: null,
    },
    duel: {
      label: 'Duel',
      about: 'Calm, circling, patient. Commits hard. A parry breaks it open for a long beat.',
      health: 150, speed: 4.0, reach: 2.0, sight: 24, tell: 28, strike: 6, recover: 30, damage: 18,
      stagger: 80, cooldown: 34, weights: { swing: 5, slam: 1, throw: 1, charge: 2 }, circle: 3.4, stages: null,
    },
    ambusher: {
      label: 'Ambusher',
      about: 'Holds dead still until you are close, then crosses the room in one move.',
      health: 70, speed: 6.0, reach: 1.8, sight: 8, tell: 16, strike: 6, recover: 44, damage: 20,
      stagger: 60, cooldown: 26, weights: { swing: 2, slam: 0, throw: 0, charge: 5 }, circle: 0, stages: null,
    },
    boss: {
      label: 'Boss, three stages',
      about: 'Three stages, each changing the room. Big swings with a clear tell. Your best move gets the biggest moment. Starts at full pitch. Ends in quiet.',
      health: 640, speed: 2.6, reach: 2.7, sight: 40, tell: 44, strike: 8, recover: 46, damage: 26,
      stagger: 90, cooldown: 30, weights: { swing: 3, slam: 2, throw: 2, charge: 2 }, circle: 0,
      stages: [
        { at: 1, tell: 1, speed: 1, cooldown: 1 },
        { at: 0.66, tell: 0.8, speed: 1.25, cooldown: 0.75 },
        { at: 0.33, tell: 0.62, speed: 1.5, cooldown: 0.5 },
      ],
    },
  },
  feel: {
    hitstopSolo: { hit: 6, heavy: 10, parry: 15, kill: 8 },
    flash: { hit: 0.3, parry: 0.85, boom: 0.6 },
    flashTicks: 3,
    bossBar: true,
    stageShift: true,
    quietEnd: true,
    tips: true,
  },
};
