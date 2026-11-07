// A character's fight settings (the Characters screen) turned into the
// numbers its creature runs on. The preset gives the shape; the sliders, 0 to
// 10 with 5 the preset as made, scale it.

import { PLAIN } from '../presets/plain.js';
import { RABBIT_HOUSE } from '../presets/rabbit-house.js';

export const PACKS = { plain: PLAIN, 'rabbit-house': RABBIT_HOUSE };

// The pack the official maker uses for new characters. A public copy of the
// maker sets this to 'plain' and leaves rabbit-house.js out.
export const DEFAULT_PACK = 'rabbit-house';

export const packOf = (fight) => PACKS[fight?.pack] ?? PACKS.plain;

const scale = (v, lo, hi) => lo + ((hi - lo) * v) / 10; // slider 0..10 to a factor
const ticks = (v) => Math.max(1, Math.round(v));

// More players, tougher creatures (Critical Response's numbers).
export const CREW_HEALTH = [1, 1.2, 1.4, 1.6];

export function tuning(character, crew = 1, tougherRoom = true) {
  const fight = character?.fight ?? { preset: 'brawler', health: 5, tell: 5, parry: 5, speed: 5, damage: 5, moves: { swing: true } };
  const pack = packOf(fight);
  const base = pack.presets[fight.preset] ?? pack.presets.brawler;
  const tough = tougherRoom && fight.tougher !== false ? CREW_HEALTH[Math.max(0, Math.min(3, crew - 1))] : 1;
  const tellF = scale(fight.tell, 0.5, 1.5);
  const weights = {};
  for (const m of ['swing', 'slam', 'throw', 'charge']) weights[m] = fight.moves?.[m] ? base.weights[m] || 1 : 0;
  if (!Object.values(weights).some((w) => w > 0)) weights.swing = 1;
  return {
    preset: fight.preset,
    health: Math.max(1, Math.round(base.health * scale(fight.health, 0.3, 1.7) * tough)),
    speed: base.speed * scale(fight.speed, 0.6, 1.4),
    reach: base.reach,
    sight: base.sight,
    tell: ticks(base.tell * tellF),
    strike: base.strike,
    recover: ticks(base.recover),
    damage: Math.max(1, Math.round(base.damage * scale(fight.damage, 0.5, 1.5))),
    stagger: ticks(base.stagger * scale(fight.parry, 0.4, 1.6)),
    cooldown: ticks(base.cooldown),
    weights,
    circle: base.circle,
    stages: base.stages,
    boss: fight.preset === 'boss',
  };
}

export function feelOf(character) {
  return packOf(character?.fight).feel;
}

// The feel a whole world plays with: the boss's pack if there is one, else
// the first creature's, else plain.
export function worldFeel(world) {
  const creatures = (world?.characters ?? []).filter((c) => c.role !== 'player');
  const boss = creatures.find((c) => c.fight?.preset === 'boss');
  return feelOf(boss ?? creatures[0]);
}
