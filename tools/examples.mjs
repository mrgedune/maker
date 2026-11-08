// The example worlds in the File menu, written out as world files:
//   node tools/examples.mjs       writes site/examples/*.world.json
// Vault Run is the world built through the maker's own screens for the
// acceptance test; it is kept as a file (site/examples/vault-run.world.json)
// and only checked here. The others are laid out below, cell by cell.
// test/examples.test.mjs plays every one of them to the end.

import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { newWorld, newCharacter, normalize, canonical } from '../site/js/kit/format.js';
import { PART } from '../site/js/kit/catalog.js';

const out = fileURLToPath(new URL('../site/examples/', import.meta.url));

// A level being laid out: blocks by the cell, parts, wires.
function layout(level) {
  const cells = new Map();
  let n = 0;
  const L = {
    level,
    // Fill cells x0..x1, y0..y1 (inclusive) from bottom to top.
    box(x0, y0, x1, y1, mat, bottom, top) {
      for (let x = Math.min(x0, x1); x <= Math.max(x0, x1); x++)
        for (let y = Math.min(y0, y1); y <= Math.max(y0, y1); y++) cells.set(`${x},${y}`, [x, y, mat, bottom, top]);
    },
    clear(x, y) {
      cells.delete(`${x},${y}`);
    },
    ring(mat, top) {
      const [w, h] = level.size;
      L.box(0, 0, w - 1, 0, mat, 0, top);
      L.box(0, h - 1, w - 1, h - 1, mat, 0, top);
      L.box(0, 0, 0, h - 1, mat, 0, top);
      L.box(w - 1, 0, w - 1, h - 1, mat, 0, top);
    },
    part(type, x, y, props = {}, extra = {}) {
      const id = extra.id ?? `${type}${++n}`;
      level.parts.push({ id, type, x, y, z: extra.z ?? 0, turn: extra.turn ?? 0, size: extra.size ?? [...PART[type].size], color: PART[type].color, props });
      return id;
    },
    // Machine parts have no body: they sit beside what they work, out of
    // the way, where Build and Wiring show them.
    machine(type, props, [x, y]) {
      return L.part(type, x, y, props);
    },
    wire(from, to) {
      level.wires.push({ from, to });
    },
    done() {
      level.blocks = [...cells.values()];
      return level;
    },
  };
  return L;
}

const plain = (c, fight = {}) => {
  c.fight = { ...c.fight, pack: 'plain', ...fight };
  return c;
};

// ---------------------------------------------------------------- Toy box

export function toyBox() {
  const w = newWorld('Toy box');
  w.screens = { title: 'Toy box', subtitle: 'Hit the three targets. The toys help.', win: 'All three down.', lose: 'Game over' };
  w.characters = [plain(newCharacter('player', 'Player look', 'player'))];
  const lv = w.levels[0];
  Object.assign(lv, { name: 'The toy box', size: [24, 24], floor: 'grass', light: 7, music: 'calm' });
  const L = layout(lv);
  L.ring('brick', 2);
  L.part('start', 3.5, 3.5, {}, { turn: 45 });

  // A pile of crates, some balls, a seesaw.
  for (const [x, z] of [[6.5, 0], [7.5, 0], [8.5, 0], [7, 0.9], [8, 0.9], [7.5, 1.8]]) L.part('crate', x, 9.5, {}, { z });
  for (const [x, y] of [[4.5, 7.5], [5.5, 8.5], [10.5, 3.5]]) L.part('ball', x, y);
  L.part('seesaw', 12.5, 9.5);

  // Balls in a launch pit, and a button that throws them.
  const pit = L.part('launcher', 11, 15, { strength: 6, lift: 7 }, { turn: 90 });
  for (const [x, y] of [[10.5, 14.5], [11.5, 14.5], [10.5, 15.5], [11.5, 15.5]]) L.part('ball', x, y);
  const throwIt = L.part('button', 8.5, 15.5, { hold: 0.5 }, { z: 0.8 });
  L.box(8, 15, 8, 15, 'metal', 0, 0.8);
  L.wire(throwIt, pit);

  // Target 1: up on a ledge, reached by the spring pad.
  L.box(1, 18, 3, 22, 'stone', 0, 2.5);
  L.part('spring', 4.5, 20.5, { strength: 6 });
  const t1 = L.part('target', 2.5, 20.5, {}, { z: 2.7, turn: 90 });

  // Target 2: in a room behind a wall only a blast knocks down.
  L.box(16, 16, 22, 16, 'stone', 0, 2);
  L.box(16, 16, 16, 22, 'stone', 0, 2);
  L.clear(19, 16);
  L.part('breakable', 19.5, 16.5, { hits: 0 });
  const t2 = L.part('target', 19.5, 20.5, {}, { z: 0.4 });
  L.part('barrel', 19.5, 10.5);
  L.part('barrel', 21.5, 10.5);

  // Target 3: behind a glass fence too tall to jump. Throw something over.
  L.box(15, 6, 22, 6, 'glass', 0, 2.2);
  L.box(15, 1, 15, 6, 'glass', 0, 2.2);
  const t3 = L.part('target', 18.5, 1.2, {}, { z: 1 });
  for (const [x, y] of [[17.5, 8.5], [19.5, 8.5]]) L.part('ball', x, y);

  // Each target, once hit, stays counted and lights its lamp. All three: done.
  const all = L.machine('and', {}, [6.5, 1.5]);
  [t1, t2, t3].forEach((t, i) => {
    const counted = L.machine('counter', { target: 1 }, [[2.5, 17.5], [18.5, 22.5], [17.5, 2.5]][i]);
    L.wire(t, counted);
    L.wire(counted, all);
    const lamp = L.part('lamp', [2.5, 19.5, 18.5][i], [20.5, 20.5, 1.6][i], { brightness: 7, reach: 4 }, { z: [4, 1.8, 2.6][i] });
    L.wire(counted, lamp);
  });
  const said = L.machine('message', { text: 'All three targets hit.', seconds: 3 }, [7.5, 1.5]);
  const cheer = L.machine('sound', { sound: 'fanfare' }, [8.5, 1.5]);
  const later = L.machine('delay', { seconds: 2 }, [9.5, 1.5]);
  const win = L.machine('win', {}, [10.5, 1.5]);
  for (const to of [said, cheer, later]) L.wire(all, to);
  L.wire(later, win);

  // What to do, when the run starts.
  const hello = L.part('zone', 3.5, 3.5, { who: 'players' }, { size: [3, 3, 2] });
  const tell = L.machine('message', { text: 'Hit the three targets. Throw, blast or bounce your way there.', seconds: 6 }, [3.5, 1.5]);
  L.wire(hello, tell);
  L.done();
  return normalize(w);
}

// ---------------------------------------------------------------- Wiring lab

export function wiringLab() {
  const w = newWorld('Wiring lab');
  w.screens = { title: 'Wiring lab', subtitle: 'Three rooms, three machines, one way out.', win: 'Out of the lab.', lose: 'Game over' };
  w.characters = [plain(newCharacter('player', 'Player look', 'player'))];
  const lv = w.levels[0];
  Object.assign(lv, { name: 'The lab', size: [30, 12], floor: 'stone', light: 6, sky: false, music: 'pulse' });
  const L = layout(lv);
  L.ring('metal', 3);
  L.box(10, 1, 10, 10, 'metal', 0, 3);
  L.box(20, 1, 20, 10, 'metal', 0, 3);
  L.clear(10, 5);
  L.clear(20, 5);
  const doorSize = [1, 0.3, 3];
  L.part('start', 2.5, 5.5);

  // Room 1: two plates, both pressed, open door 1 (And).
  const p1 = L.part('plate', 7.5, 2.5);
  const p2 = L.part('plate', 7.5, 8.5);
  L.part('crate', 4.5, 2.5);
  L.part('crate', 4.5, 8.5);
  const both = L.machine('and', {}, [10.5, 3.5]);
  const door1 = L.part('door', 10.5, 5.5, {}, { turn: 90, size: doorSize });
  L.wire(p1, both);
  L.wire(p2, both);
  L.wire(both, door1);
  for (const [p, y] of [[p1, 2.5], [p2, 8.5]]) L.wire(p, L.part('lamp', 8.8, y, { brightness: 6, reach: 3 }, { z: 2.4 }));
  const in1 = L.part('zone', 3, 5.5, { who: 'players' }, { size: [3, 3, 2] });
  L.wire(in1, L.machine('message', { text: 'Both plates must be pressed to open the door. Crates press them too.', seconds: 6 }, [1.5, 3.5]));

  // Room 2: a button opens door 2 a moment later, for a few seconds (Delay).
  const press = L.part('button', 15.5, 10.8, { hold: 4 }, { z: 1 });
  const soon = L.machine('delay', { seconds: 0.5 }, [20.5, 3.5]);
  const door2 = L.part('door', 20.5, 5.5, {}, { turn: 90, size: doorSize });
  L.wire(press, soon);
  L.wire(soon, door2);
  L.wire(press, L.machine('sound', { sound: 'clank' }, [16.5, 10.5]));
  const in2 = L.part('zone', 12, 5.5, { who: 'players' }, { size: [2, 3, 2] });
  L.wire(in2, L.machine('message', { text: 'The button opens the far door for a few seconds. Run.', seconds: 5 }, [12, 3.5]));

  // Room 3: three presses of any button open the last door (Counter).
  L.box(26, 3, 28, 3, 'metal', 0, 3);
  L.box(26, 7, 28, 7, 'metal', 0, 3);
  L.box(26, 4, 26, 6, 'metal', 0, 3);
  L.clear(26, 5);
  const three = L.machine('counter', { target: 3 }, [26.5, 3.5]);
  const chime = L.machine('sound', { sound: 'chime' }, [23.5, 10.5]);
  for (const [x, y] of [[22.5, 1.2], [22.5, 10.8], [24.5, 10.8]]) {
    const b = L.part('button', x, y, { hold: 0.5 }, { z: 1 });
    L.wire(b, three);
    L.wire(b, chime);
  }
  const door3 = L.part('door', 26.5, 5.5, {}, { turn: 90, size: doorSize });
  L.wire(three, door3);
  L.part('exit', 27.5, 5.5);
  // A lamp over the exit that blinks (Timer into a Switch).
  const tick = L.machine('timer', { every: 0.5 }, [27.5, 3.5]);
  const flip = L.machine('toggle', {}, [28.5, 3.5]);
  L.wire(tick, flip);
  L.wire(flip, L.part('lamp', 27.5, 5.5, { brightness: 8, reach: 4 }, { z: 2.6 }));
  const in3 = L.part('zone', 22, 5.5, { who: 'players' }, { size: [2, 3, 2] });
  L.wire(in3, L.machine('message', { text: 'Three button presses open the last door.', seconds: 5 }, [22, 3.5]));
  L.done();
  return normalize(w);
}

// ---------------------------------------------------------------- Arena

export function arena() {
  const w = newWorld('Arena');
  w.screens = { title: 'Arena', subtitle: 'Beat the three, then the champion. Right click parries.', win: 'Arena cleared.', lose: 'Beaten.' };
  const player = plain(newCharacter('player', 'Player look', 'player'));
  const grunt = plain(newCharacter('grunt', 'Grunt', 'creature', 'brawler'));
  const lurker = plain(newCharacter('lurker', 'Lurker', 'creature', 'ambusher'));
  lurker.look.colors.outfit = '#2a3d5b';
  const champion = plain(newCharacter('champion', 'Champion', 'creature', 'duel'));
  champion.look.colors.outfit = '#6b2a2a';
  w.characters = [player, grunt, lurker, champion];
  const lv = w.levels[0];
  Object.assign(lv, { name: 'The pit', size: [24, 24], floor: 'sand', light: 6, music: 'chase' });
  const L = layout(lv);
  L.ring('stone', 3);
  for (const [x, y] of [[6, 6], [16, 6], [6, 13], [16, 13]]) L.box(x, y, x + 1, y + 1, 'stone', 0, 3);
  // The champion's cage at the far end, shut until the three are down.
  L.box(8, 18, 15, 18, 'stone', 0, 3);
  L.box(8, 19, 8, 22, 'stone', 0, 3);
  L.box(15, 19, 15, 22, 'stone', 0, 3);
  L.clear(11, 18);
  const gate = L.part('door', 11.5, 18.5, {}, { size: [1, 0.3, 3] });
  L.part('creature', 11.5, 21, { character: 'champion' }, { turn: 270 });
  L.part('start', 11.5, 2.5, {}, { turn: 90 });
  const three = L.machine('counter', { target: 3 }, [9.5, 18.5]);
  for (const [ch, x, y, turn, waits] of [['grunt', 9.5, 12, 270, false], ['grunt', 14.5, 12, 270, false], ['lurker', 20.5, 3.5, 180, true]]) {
    const c = L.part('creature', x, y, { character: ch, waits }, { turn });
    L.wire(c, three);
  }
  L.wire(three, gate);
  L.wire(three, L.machine('message', { text: 'The gate is open.', seconds: 3 }, [12.5, 18.5]));
  L.wire(three, L.machine('sound', { sound: 'clank' }, [13.5, 18.5]));
  L.part('health', 2.5, 21.5, { amount: 50 });
  L.part('health', 21.5, 21.5, { amount: 50 });
  const down = L.machine('down', { which: 'all' }, [16.5, 1.5]);
  L.wire(down, L.machine('message', { text: 'Arena cleared.', seconds: 3 }, [17.5, 1.5]));
  const later = L.machine('delay', { seconds: 2 }, [18.5, 1.5]);
  L.wire(down, later);
  L.wire(later, L.machine('win', {}, [19.5, 1.5]));
  const hello = L.part('zone', 11.5, 2.5, { who: 'players' }, { size: [3, 3, 2] });
  L.wire(hello, L.machine('message', { text: 'Beat the three in the pit and the gate opens.', seconds: 6 }, [14.5, 1.5]));
  L.done();
  return normalize(w);
}

export const MADE = { 'toy-box': toyBox, 'wiring-lab': wiringLab, arena };

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  for (const [name, make] of Object.entries(MADE)) {
    await writeFile(`${out}${name}.world.json`, `${JSON.stringify(JSON.parse(canonical(make())), null, 1)}\n`);
    console.log(`wrote site/examples/${name}.world.json`);
  }
}
