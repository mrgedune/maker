// A small world with one of nearly everything, for the tests: blocks, toys,
// a seesaw, a door wired to a plate, a locked door and a key, a creature and
// a boss, a spawner on a timer, an exit.

import { newWorld, newCharacter, normalize } from '../site/js/kit/format.js';

export function sampleWorld() {
  const w = newWorld('Test lab');
  w.characters.push(newCharacter('duke', 'Duke', 'creature', 'boss'));
  w.characters.push(newCharacter('slinger', 'Slinger', 'creature', 'ambusher'));
  w.characters[3].fight.moves = { swing: false, slam: false, throw: true, charge: false };
  const l = w.levels[0];
  l.size = [24, 24];
  // A wall across the middle with a gap where the door goes, and a platform.
  for (let x = 0; x < 24; x++) if (x !== 12) l.blocks.push([x, 12, 'stone', 0, 3]);
  for (let x = 3; x < 7; x++) for (let y = 3; y < 6; y++) l.blocks.push([x, y, 'wood', 0, 1]);
  let n = 0;
  const part = (type, x, y, z = 0, props = {}, extra = {}) => {
    const p = { id: `p${++n}`, type, x, y, z, turn: 0, props, ...extra };
    l.parts.push(p);
    return p.id;
  };
  part('start', 4, 9);
  part('start', 6, 9);
  for (let i = 0; i < 6; i++) part('crate', 9 + (i % 3) * 0.95, 5, Math.floor(i / 3) * 0.9);
  part('ball', 15, 6, 0);
  const barrel = part('barrel', 17, 8);
  part('plank', 4, 4, 1);
  part('seesaw', 19, 3);
  part('spring', 2, 2);
  part('breakable', 18, 11.5, 0, {}, { size: [1, 1, 2] });
  const plate = part('plate', 10, 9);
  const door = part('door', 12.5, 12.5, 0, {}, { turn: 90, size: [1, 0.3, 3] });
  wire(plate, door);
  part('key', 20, 9, 0);
  part('door', 21.5, 15, 0, { locked: true });
  part('gem', 8, 8, 0, { value: 25 });
  part('health', 8, 10, 0);
  const grunt = part('creature', 14, 17, 0, { character: 'grunt' });
  part('creature', 7, 19, 0, { character: 'slinger' });
  part('creature', 18, 20, 0, { character: 'duke', waits: true });
  const down = part('down', 1, 1, 0, { which: grunt });
  const msg = part('message', 1, 2, 0, { text: 'Grunt down.' });
  wire(down, msg);
  const timer = part('timer', 1, 3, 0, { every: 4 });
  const counter = part('counter', 1, 4, 0, { target: 2 });
  const spawner = part('spawner', 3, 20, 0, { character: 'grunt', most: 2 });
  wire(timer, spawner);
  wire(timer, counter);
  const lamp = part('lamp', 12, 14, 2.5);
  wire(counter, lamp);
  const zone = part('zone', 20, 20, 0, { who: 'players' }, { size: [4, 4, 2] });
  const score = part('score', 1, 5, 0, { amount: 5 });
  wire(zone, score);
  part('target', 22, 6, 0.5);
  part('launcher', 15, 2, 0);
  part('exit', 22, 22);
  void barrel;
  function wire(from, to) {
    l.wires.push({ from, to });
  }
  return normalize(w);
}

// Bots: deterministic made-up players that wander, look round, jump, swing,
// grab and parry, driven only by the tick and their slot.
export function botInput(tick, slot) {
  let h = Math.imul((tick >> 4) + 1, 0x9e3779b1) ^ Math.imul(slot + 7, 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  h ^= h >>> 16;
  const r = (k) => ((h >>> k) & 0xff) / 255;
  return {
    move: [r(0) * 2 - 1, r(8) * 1.6 - 0.4],
    yaw: ((tick * 0.013 + slot * 1.7 + r(16) * 2) % (Math.PI * 2)),
    pitch: (r(24) - 0.5) * 0.6,
    jump: (tick + slot * 5) % 97 < 2,
    attack: (tick + slot * 3) % 23 < 2,
    parry: (tick + slot * 11) % 61 < 6,
    use: (tick + slot * 13) % 71 < 2,
    run: r(4) > 0.6,
  };
}
