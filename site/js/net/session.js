// Rollback co-op, ported from Critical Response (game/net/rollback.js) onto
// the maker's game (kit/game.js). Every machine steps the same world on the
// same inputs and only inputs travel. A machine's own input lands on the tick
// it is pressed; a teammate's that has not arrived yet is guessed (what they
// did last, held), and when the real one comes the world is rolled back to
// that tick and stepped forward again on it, inside one frame.
//
// A world can still drift (a bug that reads something it should not). Every
// CHECK ticks that every machine has every input for, they hash their worlds
// and send the hash to the host, slot 0; a machine whose hash is not the
// host's is sent the host's world and steps on from it.
//
// createSession({ game, local, send }) wraps a game every machine made the
// same way (world, seed, crew). Each frame the runner calls settle(), then
// for each tick due, while blocked() says nothing, advance() with this
// machine's input; receive(from, bytes, now) for every message, and
// flush(now) to send. `send(to, bytes, { reliable })` goes to a player index.
//
// Dropping in: the host's admit() gives a room member who asked the next
// player and a tick a little ahead, and tells the others (JOIN); every
// machine adds the player to the world before stepping that tick, its inputs
// WAITING until it is live. Once that tick is final the host sends it the
// world and how the session stands (WELCOME); createSession({ welcome })
// steps on from there quickly (behind()), says READY once caught up, and the
// host names a tick from which its inputs count (LIVE).
//
// The maker's version: game.save/load/hash in place of Critical Response's
// snapshot calls, and pledge() for a hidden tab.

import { ARRIVED, WAITING, idleFrom, pack, predict, unpack } from '../kit/input.js';
import {
  decode,
  encodeCheck,
  encodeInput,
  encodeJoin,
  encodeLeave,
  encodeLive,
  encodePing,
  encodeReady,
  encodeState,
  encodeWelcome,
  KIND,
} from './protocol.js';

export const ROLLBACK = {
  most: 15, // ticks a guess may run past a teammate's last input (250 ms)
  ring: 64, // snapshots and shown events kept, by tick
  history: 4096, // ticks of every player's input kept (68 s), to step again from
  check: 120, // ticks between drift checks
  redundancy: 32, // ticks of input in one packet at most
  catchUp: 120, // ... to a teammate missing more than that (one dropping in)
  join: 36, // ticks ahead the host sets a JOIN or a LIVE (600 ms), so all hear first
  lead: 3, // ticks ahead of a teammate's clock before this machine waits one
  even: 0.5, // ticks ahead past which its clock runs a little slow (pace)
  slower: 0.95, // how slow: it gives back 3 ticks a second
  ping: 500, // ms between round trips
  silence: 3000, // ms without a word before the host calls a link lost
  players: 4,
};

const H = ROLLBACK.history;
const R = ROLLBACK.ring;
const NONE = new Uint32Array(0);
const toJson = (v) => (v === Infinity ? null : v);
const fromJson = (v) => v ?? Infinity;

// What tells two shown events apart, for a rolled-back tick's.
const keyOf = (ev) => `${ev.t}|${ev.id ?? ''}|${ev.slot ?? ''}|${ev.kind ?? ev.name ?? ev.move ?? ''}`;

// ---------------------------------------------------------------- snapshots

// A game's save as bytes: its JSON (state, rng, level, tick) and the physics.
export function snapshotBytes(save) {
  const text = new TextEncoder().encode(JSON.stringify({ tick: save.tick, state: save.state, rng: save.rng, level: save.level }));
  const phys = save.phys;
  const out = new Uint8Array(4 + text.length + phys.length);
  new DataView(out.buffer).setUint32(0, text.length, true);
  out.set(text, 4);
  out.set(phys, 4 + text.length);
  return out;
}
export function snapshotFrom(bytes) {
  const n = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0, true);
  const head = JSON.parse(new TextDecoder().decode(bytes.subarray(4, 4 + n)));
  return { ...head, phys: bytes.slice(4 + n) };
}
const crewOf = (save) => save.state.players.length;

export function createSession({ game, local, send, now = 0, welcome = null, details = () => ({}), onJoin = () => {} }) {
  const host = local === 0;
  const slotFor = () => ({
    a: new Uint32Array(H),
    b: new Uint32Array(H),
    at: new Int32Array(H).fill(-1),
    usedA: new Uint32Array(H),
    usedB: new Uint32Array(H),
    usedAt: new Int32Array(H).fill(-1),
    known: -1,
    latest: -1,
    left: Infinity,
    lastA: 0,
    lastB: 0,
    theirAck: -1,
    heard: now,
    rtt: 0,
    from: 0,
    live: 0,
  });
  const inputs = Array.from({ length: game.state.players.length }, slotFor);
  const joins = []; // { index, at, slot, who, welcomed }
  let ready = false;
  let clock = now;
  // The ring: what the game was at the start of a tick, and (every CHECK
  // ticks) its hash.
  const snaps = Array.from({ length: R }, () => ({ tick: -1, save: null, hash: null }));
  const shown = Array.from({ length: R }, () => ({ tick: -1, keys: new Map() }));
  let rollbackTo = Infinity;
  let checked = -1;
  const hashes = new Map();
  const kept = new Map();
  const theirs = [];
  const pieces = new Map();
  let lastPing = -Infinity;
  let lastFlush = now;
  let over = null;
  const stats = { rollbacks: 0, resimulated: 0, deepest: 0, stalls: 0, waits: 0, repairs: 0, repairsSent: 0, late: 0, checks: 0 };

  const has = (k, t) => inputs[k].at[t % H] === t;
  const final = () => {
    let f = Infinity;
    for (const slot of inputs) {
      if (slot.live === Infinity) continue;
      f = Math.min(f, slot.left < Infinity && slot.known >= slot.left - 1 ? Infinity : slot.known);
    }
    return f;
  };

  function wordsFor(k, t) {
    const slot = inputs[k];
    if (t >= slot.left) return idleFrom(slot.lastA);
    if (t < slot.live) return WAITING;
    if (has(k, t)) return [slot.a[t % H], slot.b[t % H]];
    const i = t % H;
    slot.usedA[i] = slot.lastA;
    slot.usedB[i] = predict(slot.lastB);
    slot.usedAt[i] = t;
    return [slot.usedA[i], slot.usedB[i]];
  }

  function save(t) {
    const s = snaps[t % R];
    s.tick = t;
    s.save = game.save();
    s.hash = t % ROLLBACK.check === 0 ? game.hash() : null;
  }

  function stepOne(out, first) {
    for (const j of joins) if (j.at === game.tick && game.state.players.length === j.index) game.addPlayer();
    const t = game.tick;
    save(t);
    const tickInputs = [];
    for (let k = 0; k < game.state.players.length; k += 1) tickInputs.push(unpack(...wordsFor(k, t)));
    const events = game.step(tickInputs);
    const record = shown[t % R];
    if (first) {
      record.tick = t;
      record.keys.clear();
    } else if (record.tick !== t) return;
    const counts = new Map();
    for (const ev of events) {
      const key = keyOf(ev);
      const seen = (counts.get(key) ?? 0) + 1;
      counts.set(key, seen);
      if (seen <= (record.keys.get(key) ?? 0)) continue;
      record.keys.set(key, seen);
      if (!first) stats.late += 1;
      out.push(ev);
    }
  }

  function resimulate(from, out) {
    const to = game.tick;
    const snap = snaps[from % R];
    if (snap.tick !== from || crewOf(snap.save) <= local) {
      send(0, encodeCheck(local, checked, 0), { reliable: true });
      return;
    }
    game.load(snap.save);
    stats.rollbacks += 1;
    stats.resimulated += to - from;
    stats.deepest = Math.max(stats.deepest, to - from);
    while (game.tick < to) stepOne(out, false);
  }

  function hashChecks() {
    const f = final();
    for (let t = checked + ROLLBACK.check; t <= f && t + 1 < game.tick; t += ROLLBACK.check) {
      const snap = snaps[(t + 1) % R];
      checked = t;
      if (snap.tick !== t + 1 || snap.hash === null) continue;
      stats.checks += 1;
      hashes.set(t, snap.hash);
      if (hashes.size > 8) hashes.delete(hashes.keys().next().value);
      if (host) {
        kept.set(t, snap.save);
        if (kept.size > 3) kept.delete(kept.keys().next().value);
        for (let i = theirs.length - 1; i >= 0; i -= 1) if (theirs[i].tick <= t) compare(theirs.splice(i, 1)[0]);
      } else send(0, encodeCheck(local, t, snap.hash), { reliable: true });
    }
  }

  function compare({ from, tick, hash }) {
    const own = hashes.get(tick);
    if (own === undefined || own === hash) return;
    const world = kept.get(tick);
    if (!world) return;
    stats.repairsSent += 1;
    for (const part of encodeState(local, tick + 1, snapshotBytes(world))) send(from, part, { reliable: true });
  }

  function repair(tick, bytes, out) {
    const to = game.tick;
    if (tick > to || to - tick >= H) return;
    const snap = snapshotFrom(bytes);
    if (crewOf(snap) <= local || crewOf(snap) > inputs.length) return;
    game.load(snap);
    stats.repairs += 1;
    while (game.tick < to) stepOne(out, false);
  }

  function take(k, t, a, b) {
    const slot = inputs[k];
    if (t >= slot.left || t < slot.live || has(k, t) || t <= slot.known - H) return;
    const i = t % H;
    slot.a[i] = a;
    slot.b[i] = b;
    slot.at[i] = t;
    if (t > slot.latest) {
      slot.latest = t;
      slot.lastA = a;
      slot.lastB = b;
    }
    while (has(k, slot.known + 1)) slot.known += 1;
    if (t < game.tick && slot.usedAt[i] === t && (slot.usedA[i] !== a || slot.usedB[i] !== b)) rollbackTo = Math.min(rollbackTo, t);
  }

  function leave(k, from, a, b) {
    const slot = inputs[k];
    if (!slot || slot.left <= from) return;
    for (let i = 0; i < a.length; i += 1) take(k, from - a.length + i, a[i], b[i]);
    slot.left = from;
    if (from < game.tick) rollbackTo = Math.min(rollbackTo, from);
  }

  function join({ index, at, slot, who }) {
    if (index !== inputs.length || index >= ROLLBACK.players) return false;
    const s = slotFor();
    s.from = at;
    s.live = Infinity;
    s.heard = clock;
    inputs.push(s);
    joins.push({ index, at, slot, who, welcomed: !host });
    if (at < game.tick) rollbackTo = Math.min(rollbackTo, at);
    onJoin({ index, at, slot, who });
    return true;
  }

  function live(index, at) {
    const slot = inputs[index];
    if (!slot || slot.live !== Infinity || slot.left < Infinity) return;
    slot.live = at;
    slot.known = Math.max(slot.known, at - 1);
    slot.latest = Math.max(slot.latest, at - 1);
    [slot.lastA, slot.lastB] = ARRIVED;
    if (index === local) for (let t = at; t < game.tick; t += 1) take(local, t, ...ARRIVED);
    if (at < game.tick) rollbackTo = Math.min(rollbackTo, at);
  }

  function welcomeJoiners() {
    if (!host) return;
    const f = final();
    for (const j of joins) {
      if (j.welcomed || inputs[j.index].left < Infinity || f === Infinity || f + 1 < j.at) continue;
      const tick = f + 1;
      const snap = snaps[tick % R];
      if (snap.tick !== tick) continue;
      j.welcomed = true;
      const about = {
        tick,
        joins: joins.map(({ index, at, slot, who }) => ({ index, at, slot, who })),
        slots: inputs.map((s, k) => {
          const list = [];
          for (let t = Math.max(tick, s.known - H + 1); t <= s.known; t += 1) if (has(k, t)) list.push([t, s.a[t % H], s.b[t % H]]);
          return { from: s.from, live: toJson(s.live), left: toJson(s.left), known: s.known, latest: s.latest, lastA: s.lastA, lastB: s.lastB, inputs: list };
        }),
        ...details(),
      };
      for (const part of encodeWelcome(local, tick, about, snapshotBytes(snap.save))) send(j.index, part, { reliable: true });
    }
  }

  if (welcome) {
    const { about } = welcome;
    joins.push(...about.joins.map((j) => ({ ...j, welcomed: true })));
    inputs.length = 0;
    for (const s of about.slots) {
      const slot = slotFor();
      Object.assign(slot, { from: s.from, live: fromJson(s.live), left: fromJson(s.left), known: s.known, latest: s.latest, lastA: s.lastA, lastB: s.lastB });
      for (const [t, a, b] of s.inputs) {
        slot.a[t % H] = a;
        slot.b[t % H] = b;
        slot.at[t % H] = t;
      }
      inputs.push(slot);
    }
    game.load(snapshotFrom(welcome.world));
    checked = Math.floor(game.tick / ROLLBACK.check) * ROLLBACK.check - 1;
  }

  const session = {
    game,
    local,
    host,
    stats,
    get over() {
      return over;
    },
    get final() {
      return final();
    },
    get players() {
      return inputs.length;
    },
    settle() {
      const out = [];
      if (rollbackTo < game.tick) resimulate(rollbackTo, out);
      rollbackTo = Infinity;
      return out;
    },
    blocked() {
      if (over) return 'over';
      const t = game.tick;
      for (let k = 0; k < inputs.length; k += 1) {
        const slot = inputs[k];
        if (k === local || slot.left <= t || slot.live > t) continue;
        if (t - slot.known > ROLLBACK.most) {
          stats.stalls += 1;
          return 'stalled';
        }
      }
      if (session.lead() > ROLLBACK.lead) {
        stats.waits += 1;
        return 'waiting';
      }
      return null;
    },
    advance(input) {
      const out = session.settle();
      take(local, game.tick, ...pack(input));
      stepOne(out, true);
      hashChecks();
      welcomeJoiners();
      return out;
    },
    pace() {
      return session.lead() > ROLLBACK.even ? ROLLBACK.slower : 1;
    },
    lead() {
      let most = -Infinity;
      for (let k = 0; k < inputs.length; k += 1) {
        const slot = inputs[k];
        if (k === local || slot.left < Infinity || slot.live === Infinity || slot.latest < 0) continue;
        const next = slot.latest + 1 + (slot.rtt / 2) * 0.06;
        most = Math.max(most, game.tick - next);
      }
      return most;
    },
    behind() {
      let most = 0;
      for (let k = 0; k < inputs.length; k += 1) {
        const slot = inputs[k];
        if (k === local || slot.left < Infinity || slot.live === Infinity) continue;
        most = Math.max(most, slot.known - game.tick + 1);
      }
      return most;
    },
    get joining() {
      return inputs[local]?.live === Infinity;
    },
    // A tab the browser has hidden steps rarely. Its player stands still for
    // the next `ticks`, said now, so the others need not wait for it.
    pledge(input, ticks) {
      const own = inputs[local];
      if (over || own.live === Infinity || own.left < Infinity) return;
      const [a, b] = pack({ yaw: input.yaw, pitch: input.pitch });
      for (let t = game.tick; t < game.tick + ticks; t += 1) take(local, t, a, b);
    },
    admit({ slot, who }) {
      if (!host || over || game.state.phase !== 'play' || inputs.length >= ROLLBACK.players) return -1;
      if (inputs.some((s) => s.live === Infinity && s.left === Infinity)) return -1;
      const index = inputs.length;
      const at = game.tick + ROLLBACK.join;
      for (let k = 0; k < index; k += 1) if (k !== local && inputs[k].left === Infinity) send(k, encodeJoin(local, { index, at, slot, who }), { reliable: true });
      join({ index, at, slot, who });
      return index;
    },
    receive(from, bytes, time = 0) {
      const msg = decode(bytes);
      if (!msg || msg.from !== from || from >= inputs.length || from === local) return [];
      const slot = inputs[from];
      slot.heard = time;
      clock = time;
      const out = [];
      if (msg.kind === KIND.INPUT) {
        slot.theirAck = Math.max(slot.theirAck, msg.ack);
        for (let i = 0; i < msg.a.length; i += 1) take(from, msg.start + i, msg.a[i], msg.b[i]);
      } else if (msg.kind === KIND.CHECK && host) {
        if (hashes.has(msg.tick)) compare(msg);
        else theirs.push(msg);
      } else if (msg.kind === KIND.STATE && from === 0) {
        const parts = pieces.get(msg.tick) ?? new Array(msg.count);
        parts[msg.index] = msg.piece.slice();
        pieces.set(msg.tick, parts);
        if (parts.filter(Boolean).length === msg.count) {
          pieces.delete(msg.tick);
          const bytes = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
          let at = 0;
          for (const p of parts) {
            bytes.set(p, at);
            at += p.length;
          }
          repair(msg.tick, bytes, out);
          rollbackTo = Infinity;
        }
      } else if (msg.kind === KIND.PING) {
        send(from, encodePing(KIND.PONG, local, msg.stamp), { reliable: false });
      } else if (msg.kind === KIND.PONG) {
        const rtt = Math.max(0, time - msg.stamp);
        slot.rtt = slot.rtt ? slot.rtt * 0.8 + rtt * 0.2 : rtt;
      } else if (msg.kind === KIND.LEAVE && from === 0) {
        leave(msg.slot, msg.tick, msg.a, msg.b);
      } else if (msg.kind === KIND.JOIN && from === 0 && !host) {
        join(msg);
      } else if (msg.kind === KIND.LIVE && from === 0) {
        live(msg.index, msg.tick);
      } else if (msg.kind === KIND.READY && host && slot.live === Infinity) {
        const at = Math.max(game.tick, msg.tick) + ROLLBACK.join;
        for (let k = 0; k < inputs.length; k += 1) if (k !== local && inputs[k].left === Infinity) send(k, encodeLive(local, from, at), { reliable: true });
        live(from, at);
      }
      return out;
    },
    flush(time = 0) {
      if (over) return;
      // This machine was held up (making its view, a slow frame): what came
      // in meanwhile has not been read yet, so no one is silent for it.
      if (time - lastFlush > ROLLBACK.silence / 3) for (const slot of inputs) slot.heard = Math.max(slot.heard, time);
      lastFlush = time;
      clock = time;
      const own = inputs[local];
      for (let k = 0; k < inputs.length; k += 1) {
        if (k === local || inputs[k].left < Infinity) continue;
        const end = own.known;
        const missing = end - inputs[k].theirAck > ROLLBACK.redundancy;
        const start = missing
          ? Math.max(inputs[k].theirAck + 1, own.live, end - H + 1, 0)
          : Math.max(inputs[k].theirAck + 1, end - ROLLBACK.redundancy + 1, 0);
        const count = Math.min(end - start + 1, missing ? ROLLBACK.catchUp : ROLLBACK.redundancy);
        if (count <= 0) {
          // Nothing new of its own (joining, or held up): still say how far
          // it has theirs, or they would send the same old ticks for ever.
          send(k, encodeInput(local, inputs[k].known, 0, NONE, NONE, 0), { reliable: false });
          continue;
        }
        const a = new Uint32Array(count);
        const b = new Uint32Array(count);
        for (let i = 0; i < count; i += 1) {
          a[i] = own.a[(start + i) % H];
          b[i] = own.b[(start + i) % H];
        }
        send(k, encodeInput(local, inputs[k].known, start, a, b, count), { reliable: false });
      }
      if (time - lastPing >= ROLLBACK.ping) {
        lastPing = time;
        for (let k = 0; k < inputs.length; k += 1) if (k !== local && inputs[k].left === Infinity) send(k, encodePing(KIND.PING, local, time), { reliable: false });
      }
      if (own.live === Infinity && !ready && !host) {
        const others = inputs.filter((s, k) => k !== local && s.left === Infinity && s.live !== Infinity);
        if (others.length && others.every((s) => game.tick >= s.latest - 2)) {
          ready = true;
          send(0, encodeReady(local, game.tick), { reliable: true });
        }
      }
      for (let k = 0; k < inputs.length; k += 1) {
        const slot = inputs[k];
        // One dropping in is making its game and catching up: it gets longer.
        const silence = slot.live === Infinity ? ROLLBACK.silence * 5 : ROLLBACK.silence;
        if (k === local || slot.left < Infinity || time - slot.heard < silence) continue;
        if (host) session.drop(k);
        else if (k === 0) over = 'The host is gone.';
      }
    },
    drop(k) {
      if (!host || k === local || !inputs[k] || inputs[k].left < Infinity) return;
      const slot = inputs[k];
      const from = slot.live === Infinity ? Math.max(game.tick, slot.from) : slot.known + 1;
      const count = Math.min(ROLLBACK.redundancy * 2, from);
      const a = new Uint32Array(count);
      const b = new Uint32Array(count);
      for (let i = 0; i < count; i += 1) {
        const t = from - count + i;
        a[i] = slot.a[t % H];
        b[i] = slot.b[t % H];
      }
      for (let j = 0; j < inputs.length; j += 1) if (j !== local && j !== k && inputs[j].left === Infinity) send(j, encodeLeave(local, k, from, a, b, count), { reliable: true });
      leave(k, from, a, b);
    },
    end(why = 'ended') {
      over ??= why;
    },
    links() {
      const list = [];
      for (let k = 0; k < inputs.length; k += 1) {
        if (k === local) continue;
        const slot = inputs[k];
        list.push({ index: k, rtt: slot.rtt, behind: game.tick - 1 - slot.known, left: slot.left < Infinity });
      }
      return list;
    },
  };
  return session;
}
