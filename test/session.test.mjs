// Co-op sessions over a pretend network: late, out of order, lossy. Each
// machine steps its own copy of the world on its own clock, guesses its
// teammates' inputs, and rolls back when the real ones come. However the
// packets go, every machine has to end on the same world.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGame } from '../site/js/kit/game.js';
import { createSession } from '../site/js/net/session.js';
import { welcomeReader } from '../site/js/net/protocol.js';
import { sampleWorld, botInput } from './sample-world.mjs';

const RAPIER = (await import('../site/vendor/rapier/rapier.mjs')).default;
await RAPIER.init();

const FRAME = 1000 / 60;

// The network: each packet takes latency plus up to jitter ms; unreliable
// ones may be lost, reliable ones arrive in order.
function network({ latency = 40, jitter = 40, loss = 0.1, seed = 3 } = {}) {
  let r = seed >>> 0;
  const rand = () => {
    r = (Math.imul(r, 1664525) + 1013904223) >>> 0;
    return r / 4294967296;
  };
  let now = 0;
  const queue = [];
  const ordered = new Map();
  return {
    get now() {
      return now;
    },
    tick() {
      now += FRAME;
    },
    send(from, to, bytes, { reliable = false } = {}) {
      if (!reliable && rand() < loss) return;
      let at = now + latency + rand() * jitter;
      if (reliable) {
        const key = `${from}>${to}`;
        at = Math.max(at, ordered.get(key) ?? 0);
        ordered.set(key, at);
      }
      queue.push({ at, from, to, bytes: bytes.slice() });
    },
    due() {
      const ready = queue.filter((m) => m.at <= now).sort((a, b) => a.at - b.at);
      for (const m of ready) queue.splice(queue.indexOf(m), 1);
      return ready;
    },
  };
}

function machine(net, index, { crew, seed, world }) {
  const game = createGame({ RAPIER, world, crew, seed });
  const m = { index, game, session: null, gone: false, end: Infinity, reader: null, world, seed };
  m.session = createSession({ game, local: index, send: (to, bytes, o) => net.send(index, to, bytes, o), now: net.now });
  return m;
}

// One that drops in: no session until the host's WELCOME is in.
function joiner(net, index, { crew, seed, world }) {
  const game = createGame({ RAPIER, world, crew, seed });
  return { index, game, session: null, gone: false, end: Infinity, reader: welcomeReader(), world, seed };
}

function frame(net, machines, input = botInput) {
  for (const msg of net.due()) {
    const m = machines[msg.to];
    if (!m || m.gone) continue;
    if (!m.session) {
      const welcome = m.reader(msg.bytes);
      if (welcome) {
        m.session = createSession({
          game: m.game,
          local: m.index,
          send: (to, bytes, o) => net.send(m.index, to, bytes, o),
          now: net.now,
          welcome,
        });
      }
      continue;
    }
    m.session.receive(msg.from, msg.bytes, net.now);
  }
  for (const m of machines) {
    if (m.gone || !m.session) continue;
    const s = m.session;
    s.settle();
    // Step once a frame, more while behind (one dropping in catches up).
    const steps = 1 + Math.min(10, Math.max(0, s.behind() - 2));
    for (let i = 0; i < steps && m.game.tick < m.end; i += 1) {
      if (s.blocked()) break;
      s.advance(input(m.game.tick, m.index));
    }
    s.flush(net.now);
  }
  net.tick();
}

// Runs until every machine still here has stepped to `end` and every packet
// has had time to arrive, then settles them.
function finish(net, machines, end) {
  for (const m of machines) m.end = end;
  for (let i = 0; i < 2000; i += 1) {
    frame(net, machines);
    if (machines.every((m) => m.gone || (m.session && m.game.tick >= end))) break;
  }
  for (let i = 0; i < 120; i += 1) frame(net, machines);
  for (const m of machines) if (!m.gone) m.session.settle();
}

const here = (machines) => machines.filter((m) => !m.gone);

test('two machines on a late, lossy network end on the same world', () => {
  const world = sampleWorld();
  const net = network();
  const machines = [0, 1].map((i) => machine(net, i, { crew: 2, seed: 9, world }));
  for (let i = 0; i < 600; i += 1) frame(net, machines);
  finish(net, machines, 720);
  const [a, b] = machines;
  assert.equal(a.game.tick, 720);
  assert.equal(b.game.tick, 720);
  assert.equal(a.game.hash(), b.game.hash());
  assert.ok(a.session.stats.rollbacks + b.session.stats.rollbacks > 0, 'guesses were made and put right');
  assert.equal(a.session.stats.repairs + b.session.stats.repairs, 0, 'no drift to repair');
  assert.ok(a.session.stats.checks > 0 && b.session.stats.checks > 0);
});

test('a drifted machine is put right from the host', () => {
  const world = sampleWorld();
  const net = network({ loss: 0.05 });
  const machines = [0, 1].map((i) => machine(net, i, { crew: 2, seed: 4, world }));
  // A bug on one machine only: at tick 300 its score goes up by itself.
  const { game } = machines[1];
  const step = game.step;
  game.step = (inputs) => {
    const events = step(inputs);
    if (game.tick === 301) game.state.score += 5;
    return events;
  };
  for (let i = 0; i < 600; i += 1) frame(net, machines);
  finish(net, machines, 660);
  assert.ok(machines[1].session.stats.repairs > 0, 'the host sent its world');
  assert.equal(machines[0].game.hash(), machines[1].game.hash());
});

test('a third player drops into a run under way', () => {
  const world = sampleWorld();
  const net = network({ loss: 0.05 });
  const machines = [0, 1].map((i) => machine(net, i, { crew: 2, seed: 11, world }));
  for (let i = 0; i < 240; i += 1) frame(net, machines);
  machines.push(joiner(net, 2, { crew: 2, seed: 11, world }));
  const index = machines[0].session.admit({ slot: 2, who: 'Cleo' });
  assert.equal(index, 2);
  for (let i = 0; i < 600; i += 1) frame(net, machines);
  finish(net, machines, 1000);
  const [a, b, c] = machines;
  assert.ok(c.session, 'the WELCOME came');
  assert.equal(c.session.joining, false, 'it went live');
  assert.equal(a.game.state.players.length, 3);
  assert.equal(c.game.state.players[2].waiting, false);
  assert.equal(a.game.hash(), b.game.hash());
  assert.equal(a.game.hash(), c.game.hash());
});

test('a machine that goes quiet is dropped and the rest play on', () => {
  const world = sampleWorld();
  const net = network({ loss: 0.05 });
  const machines = [0, 1, 2].map((i) => machine(net, i, { crew: 3, seed: 5, world }));
  for (let i = 0; i < 200; i += 1) frame(net, machines);
  machines[2].gone = true; // its tab closed
  for (let i = 0; i < 400; i += 1) frame(net, machines);
  finish(net, machines, 760);
  const [a, b] = here(machines);
  assert.equal(a.game.state.players[2].out, true);
  assert.equal(a.game.hash(), b.game.hash());
  assert.equal(a.game.tick, 760);
});
