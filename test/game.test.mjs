// The game kit: a world steps the same way every time from the same inputs,
// and rolling back to a saved tick and stepping again lands on the same
// state. That is what co-op stands on.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createGame } from '../site/js/kit/game.js';
import { pack, unpack } from '../site/js/kit/input.js';
import { sampleWorld, botInput } from './sample-world.mjs';
import { newWorld, normalize } from '../site/js/kit/format.js';

const RAPIER = (await import('../site/vendor/rapier/rapier.mjs')).default;
await RAPIER.init();

// Inputs go through the wire format, as they do in co-op.
const inputsAt = (tick, crew) => Array.from({ length: crew }, (_, s) => unpack(...pack(botInput(tick, s))));

function run(ticks, crew = 2, seed = 7) {
  const game = createGame({ RAPIER, world: sampleWorld(), crew, seed });
  const hashes = [];
  const seen = new Set();
  for (let t = 0; t < ticks; t++) {
    for (const e of game.step(inputsAt(t, crew))) seen.add(e.t);
    if (t % 60 === 0) hashes.push(game.hash());
  }
  return { game, hashes, seen };
}

test('two runs of the same world and inputs match', () => {
  const a = run(900);
  const b = run(900);
  assert.deepEqual(a.hashes, b.hashes);
  assert.equal(a.game.hash(), b.game.hash());
});

test('a different seed or different inputs give a different run', () => {
  const a = run(600, 2, 7);
  const b = run(600, 2, 8);
  assert.notEqual(a.game.hash(), b.game.hash());
});

test('rolling back and stepping again lands on the same state', () => {
  const crew = 3;
  const game = createGame({ RAPIER, world: sampleWorld(), crew, seed: 3 });
  for (let t = 0; t < 300; t++) game.step(inputsAt(t, crew));
  const snap = game.save();
  for (let t = 300; t < 420; t++) game.step(inputsAt(t, crew));
  const first = game.hash();
  // Roll back with some wrong guesses in between, then replay the truth.
  game.load(snap);
  for (let t = 300; t < 340; t++) game.step(inputsAt(t + 1000, crew));
  game.load(snap);
  for (let t = 300; t < 420; t++) game.step(inputsAt(t, crew));
  assert.equal(game.hash(), first);
  // And the replay keeps matching from there on.
  const ref = createGame({ RAPIER, world: sampleWorld(), crew, seed: 3 });
  for (let t = 0; t < 420; t++) ref.step(inputsAt(t, crew));
  assert.equal(ref.hash(), first);
});

test('the world does things: players move, creatures fight, machines run', () => {
  // Three wandering bots, so that between them one reaches a toy and a pickup.
  const { game, seen } = run(1800, 3, 11);
  const s = game.state;
  assert.ok(s.tick === 1800);
  for (const kind of ['swing', 'spawn', 'grab', 'press', 'door', 'pickup']) assert.ok(seen.has(kind), `no ${kind} event; saw ${[...seen].join(' ')}`);
  const moved = s.players.some((p) => Math.hypot(p.x - 4, p.y - 9) > 1);
  assert.ok(moved, 'players did not move');
});

test('the simulation draws on no clock, no Math.random and no platform trig', async () => {
  const raw = await readFile(new URL('../site/js/kit/game.js', import.meta.url), 'utf8');
  const src = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  for (const banned of ['Math.random', 'Date.now', 'performance.now', 'Math.sin', 'Math.cos', 'Math.atan2', 'Math.tan', 'Math.exp', 'Math.pow', 'Math.hypot'])
    assert.ok(!src.includes(banned), `game.js uses ${banned}`);
});

test('a fight: a player who walks up and swings beats a grunt, and the grunt fights back', () => {
  const w = newWorld('Arena');
  const l = w.levels[0];
  l.parts.push({ id: 's', type: 'start', x: 4, y: 12, z: 0, turn: 0, props: {} });
  l.parts.push({ id: 'g', type: 'creature', x: 14, y: 12, z: 0, turn: 180, props: { character: 'grunt' } });
  l.parts.push({ id: 'd', type: 'down', x: 1, y: 1, z: 0, props: { which: 'all' } });
  l.parts.push({ id: 'win', type: 'win', x: 1, y: 2, z: 0, props: {} });
  l.wires.push({ from: 'd', to: 'win' });
  const game = createGame({ RAPIER, world: normalize(w), crew: 1, seed: 5 });
  const seen = new Set();
  for (let t = 0; t < 3600 && game.state.phase === 'play'; t++) {
    const p = game.state.players[0];
    const c = game.state.creatures[0];
    const yaw = Math.atan2(c.y - p.y, c.x - p.x);
    const d = Math.hypot(c.x - p.x, c.y - p.y);
    for (const e of game.step([{ move: [0, d > 1.6 ? 1 : 0], yaw, pitch: 0, attack: t % 20 < 2, parry: c.state === 'tell' && c.t < 8 && t % 40 < 20 }])) seen.add(e.t);
  }
  for (const kind of ['alert', 'tell', 'strike', 'hit', 'kill', 'won']) assert.ok(seen.has(kind), `no ${kind}; saw ${[...seen].join(' ')}`);
  assert.equal(game.state.phase, 'won');
});

test('jumping: up a low step and onto a crate, but not over a 2 m wall', () => {
  const w = newWorld('Walls');
  const l = w.levels[0];
  l.size = [16, 8];
  l.parts.push({ id: 's', type: 'start', x: 1.5, y: 4, z: 0, turn: 0, props: {} });
  l.blocks.push([3, 3, 'stone', 0, 0.5], [3, 4, 'stone', 0, 0.5]); // a step
  l.parts.push({ id: 'c', type: 'crate', x: 6.5, y: 4, z: 0, turn: 0, props: { pinned: true } });
  for (let y = 0; y < 8; y++) l.blocks.push([10, y, 'stone', 0, 2]); // a wall right across
  const game = createGame({ RAPIER, world: normalize(w), crew: 1, seed: 1 });
  const p = () => game.state.players[0];
  let onStep = 0, onCrate = 0, top = 0;
  for (let t = 0; t < 600; t++) {
    const x = p().x;
    // Jump at the crate, then keep jumping at the wall.
    const jump = (x > 5.2 && x < 5.5) || (x > 9 && t % 20 === 0);
    game.step([{ move: [0, 1], yaw: 0, pitch: 0, jump }]);
    if (x > 3.2 && x < 3.8) onStep = Math.max(onStep, p().z);
    if (Math.abs(x - 6.5) < 0.3) onCrate = Math.max(onCrate, p().z);
    top = Math.max(top, p().z);
  }
  assert.ok(onStep > 0.45, `did not walk up the step (z ${onStep})`);
  assert.ok(onCrate > 0.85, `did not get onto the crate (z ${onCrate})`);
  assert.ok(p().x < 10, `went over the wall (x ${p().x}, highest z ${top})`);
});
