// The example worlds in the File menu: each one is listed, loads, passes the
// Ship checks, and a scripted player wins it in the game's own simulation.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { normalize, canonical } from '../site/js/kit/format.js';
import { checkWorld } from '../site/js/ship/checks.js';
import { EXAMPLES } from '../site/js/ui/examples.js';
import { MADE } from '../tools/examples.mjs';
import { drive } from './drive.mjs';

const RAPIER = (await import('../site/vendor/rapier/rapier.mjs')).default;
await RAPIER.init();

const DIR = new URL('../site/examples/', import.meta.url);
const read = (id) => JSON.parse(readFileSync(new URL(`${id}.world.json`, DIR), 'utf8'));

test('every example file is in the File menu, and every entry has a file', () => {
  const files = readdirSync(DIR).map((f) => f.replace(/\.world\.json$/, '')).sort();
  assert.deepEqual(EXAMPLES.map((e) => e.id).sort(), files);
});

test('the examples load as they are, pass the checks, and match tools/examples.mjs', () => {
  for (const { id } of EXAMPLES) {
    const raw = read(id);
    const doc = normalize(raw);
    assert.equal(canonical(doc), canonical(raw), `${id} changes when loaded`);
    const blocking = checkWorld(doc, { playedToEnd: true }).filter((c) => c.status !== 'ok');
    assert.deepEqual(blocking, [], id);
    for (const l of doc.levels)
      for (const p of l.parts) if (p.type === 'message') assert.ok(p.props.text.length <= 80, `${id}: ${p.props.text}`);
    if (MADE[id]) assert.equal(canonical(MADE[id]()), canonical(raw), `${id} is out of date: run node tools/examples.mjs`);
  }
});

test('Toy box: the spring, a thrown barrel and a ball over the fence hit the three targets', () => {
  const d = drive(RAPIER, read('toy-box'));
  const S = d.game.state;
  const hit = (id) => S.parts[id].hitT > 0;
  const targets = d.game.level.parts.filter((p) => p.type === 'target').map((p) => p.id);
  // Up the spring onto the ledge, and swing at the first.
  d.path([[3.5, 14], [6.5, 20.5]]);
  d.goTo(2.9, 20.5);
  d.face(2.5, 20.5, 0.3);
  d.press('attack');
  d.wait(30);
  assert.ok(hit(targets[0]), 'the target on the ledge');
  // A barrel thrown at the cracked wall opens the room with the second.
  d.path([[6.5, 18], [10, 12], [19.5, 11.2]]);
  d.face(19.5, 10.5);
  d.press('use');
  assert.ok(d.p.held, 'holding a barrel');
  d.goTo(19.5, 11, { tol: 0.2 });
  d.face(19.5, 16.5, -0.05);
  d.wait(10);
  d.press('attack');
  d.wait(60);
  assert.ok(d.seen('break'), 'the wall breaks');
  assert.equal(d.p.health, 100, 'from far enough away');
  d.path([[19.5, 15], [19.5, 17.5], [19.5, 19.4]]);
  d.face(19.5, 20.5, 0.3);
  d.press('attack');
  d.wait(30);
  assert.ok(hit(targets[1]), 'the target in the room');
  // A ball over the glass fence for the third.
  d.path([[19.5, 15], [17.5, 12], [17.5, 9.3]]);
  d.face(17.5, 8.5, 0.5);
  d.press('use');
  assert.ok(d.p.held, 'holding a ball');
  d.goTo(18.5, 11, { tol: 0.2 });
  d.face(18.5, 1.2, -0.35);
  d.wait(10);
  d.press('attack');
  d.wait(200);
  assert.ok(hit(targets[2]), 'the target behind the fence');
  assert.equal(S.phase, 'won');
});

test('Wiring lab: crates on both plates, a button and a run, three presses, out', () => {
  const d = drive(RAPIER, read('wiring-lab'));
  const S = d.game.state;
  for (const [cx, cy, px, py] of [[4.5, 2.5, 7.5, 2.5], [4.5, 8.5, 7.5, 8.5]]) {
    d.goTo(cx - 1, cy > 5 ? cy - 0.6 : cy + 0.6);
    d.face(cx, cy, 0.4);
    d.press('use');
    assert.ok(d.p.held, 'holding a crate');
    d.goTo(px - 1.3, py, { tol: 0.2 });
    d.face(px, py, 0.4);
    d.press('use');
    d.wait(40);
  }
  const doors = d.game.level.parts.filter((p) => p.type === 'door').map((p) => S.parts[p.id]);
  assert.ok(doors[0].open > 0, 'both plates open the first door');
  assert.ok(d.path([[9, 5.5], [12, 5.5], [15.5, 9.6]]), 'into the second room');
  d.face(15.5, 10.8);
  d.press('use');
  assert.ok(d.path([[18.5, 5.5], [22, 5.5]], { run: true }), 'through the second door before it shuts');
  for (const [x, y] of [[22.5, 1.2], [22.5, 10.8], [24.5, 10.8]]) {
    d.goTo(x, y < 5 ? 2.3 : 9.7);
    d.face(x, y);
    d.press('use');
    d.wait(40);
  }
  d.path([[24, 5.5], [27.5, 5.5]]);
  d.wait(60);
  assert.equal(S.phase, 'won');
});

test('Arena: the three, then the champion through the gate', () => {
  const d = drive(RAPIER, read('arena'));
  const S = d.game.state;
  assert.equal(d.fight({ who: (c) => c.char !== 'champion' }), true, 'the three');
  assert.equal(d.fight(), true, 'the champion');
  d.wait(200);
  assert.equal(S.phase, 'won');
  assert.ok(d.seen('parry') && d.seen('door'), 'parried, and the gate opened');
});

test('Vault Run: the key, the crate, the guards, the wall, then the Keeper', () => {
  const d = drive(RAPIER, read('vault-run'));
  const S = d.game.state;
  // Up the spring to the key.
  d.path([[4.5, 17], [4.5, 20.5]], { tol: 0.25 });
  for (let i = 0; i < 90 && !(d.p.z > 2.9); i++) d.step({ yaw: Math.PI });
  for (let i = 0; i < 90 && d.p.x > 3.1; i++) d.step({ move: [0, 1], yaw: Math.PI });
  d.wait(60);
  d.goTo(2.5, 21.5, { tol: 0.4 });
  d.goTo(2.5, 18.2, { tol: 0.4 });
  d.wait(40);
  // The crate onto the plate opens the door; the guards.
  d.path([[4.5, 12], [5, 5.5]]);
  d.face(6.5, 5.5, 0.3);
  d.press('use');
  d.goTo(7.25, 5.5, { tol: 0.2 });
  d.face(8.5, 5.5, 0.04);
  d.press('use');
  d.wait(60);
  assert.ok(S.parts.plate1.pressed, 'the crate is on the plate');
  d.path([[9, 9], [11.2, 11.5], [14.2, 11.5]]);
  assert.equal(d.fight({ range: 14 }), true, 'the guards');
  // The barrel at the strongroom wall, and the gems.
  d.goTo(17, 9.5, { tol: 0.4 });
  const b = d.game.pose(S.parts.barrel1.body);
  d.goTo(b.x, b.y + 1.3, { tol: 0.25 });
  d.face(b.x, b.y, 0.3);
  d.press('use');
  d.goTo(20.5, 10.8, { tol: 0.3 });
  d.face(20.5, 5.5, 0.04);
  d.press('attack');
  d.wait(90);
  assert.ok(S.parts.breakable1.gone, 'the wall is down');
  d.path([[20.5, 6.5], [20.5, 3.5], [19.5, 2.5], [21.5, 2.5], [20.5, 4.2], [20.5, 7]], { tol: 0.35 });
  // The key opens the locked door to the exit.
  d.path([[19.5, 12], [20.5, 16.8], [20.5, 21.5]], { tol: 0.25 });
  d.wait(60);
  assert.equal(S.score, 30, 'three gems');
  for (let i = 0; i < 600 && S.phase !== 'play'; i++) d.step();
  assert.equal(S.level, 1, 'on to the vault');
  // The Keeper, with the health packs when it gets close.
  d.goTo(8, 12, { tol: 0.4 });
  for (let round = 0; round < 8 && S.phase === 'play'; round++) {
    if (d.fight({ lowHp: 40 }) !== 'low') continue;
    const pack = d.game.level.parts
      .filter((q) => q.type === 'health' && !S.parts[q.id].gone)
      .sort((a, c) => Math.hypot(a.x - d.p.x, a.y - d.p.y) - Math.hypot(c.x - d.p.x, c.y - d.p.y))[0];
    if (!pack) d.fight();
    else d.path([...(d.p.x > 10 ? [[d.p.x, 10]] : []), [7, 10], [pack.x, pack.y]], { run: true, tol: 0.4 });
  }
  d.wait(200);
  assert.equal(S.phase, 'won');
});
