// Playing together, from the room to the run. Apart from the page, so the
// tests can drive it.
//
// The host opens a room with its world; a friend joins with the room's code.
// The host's world goes to every member that has not got it (WORLD, in
// pieces, over the links); a member checks it against the host's hash, keeps
// it, and says it is ready. The host starts the run once everyone has it:
// every machine then makes the same game (world, seed, crew) and a rollback
// session steps it (session.js). One who comes in after the start gets the
// world the same way and drops in (admit, WELCOME). The host's stop() brings
// everyone back to the lobby; the host leaving closes the room.
//
// A player in the game is an index, in crew order; a member of the room is a
// slot. `slots[index]` is the room slot of each player, kept here.
//
//   const lobby = await openLobby({ RAPIER, service, code, name, doc })
//   lobby.on('change' | 'start' | 'stop' | 'closed', fn)
//   lobby.setWorld(doc), lobby.start(level), lobby.stop()   the host
//   lobby.setName(name), lobby.leave()

import { createGame } from '../kit/game.js';
import { canonical, hashText, normalize, worldHash } from '../kit/format.js';
import { openRoom } from './rooms.js';
import { createLinks } from './transport.js';
import { createSession } from './session.js';
import { decode, encodeState, KIND, welcomeReader } from './protocol.js';

const hashTick = (hash) => parseInt(hash.slice(0, 8), 16) >>> 0;

export async function openLobby({ RAPIER, service, code = 'new', name = '', doc = null, links: linkOptions = {}, now = () => performance.now() }) {
  const room = await openRoom({ service, code, name });
  const isHost = room.slot === 0;
  const handlers = new Map();
  const emit = (type, data) => {
    for (const fn of handlers.get(type) ?? []) fn(data);
  };

  let world = null; // the world everyone plays: { doc, text, hash }
  const receiving = { hash: null, got: 0, count: 0 };
  const sentTo = new Map(); // slot -> the hash sent it
  let run = null; // { game, session, slots, names, level, late }
  let reader = null;
  let closed = null;
  let retry = 0;

  function keepWorld(d) {
    const text = canonical(normalize(d));
    const hash = hashText(text);
    world = { doc: normalize(JSON.parse(text)), text, hash };
    return world;
  }

  // ------------------------------------------------------------ links

  const links = createLinks(room, { ...linkOptions, onBytes: heard });
  const pieces = new Map();

  function heard(slot, bytes) {
    const msg = decode(bytes);
    if (!msg) return;
    if (msg.kind === KIND.WORLD) {
      if (slot === 0 && !isHost) gotPiece(msg);
      return;
    }
    if (!run) return;
    if (!run.session) {
      if (slot === 0 && reader) {
        const welcome = reader(bytes);
        if (welcome) welcomed(welcome);
      }
      return;
    }
    const index = run.slots.lastIndexOf(slot);
    if (index < 0) return;
    run.session.receive(index, bytes, now());
    run.onBytes?.();
  }

  function gotPiece(msg) {
    const host = room.members.find((m) => m.slot === 0);
    if (!host?.has || hashTick(host.has) !== msg.tick) return;
    const parts = pieces.get(msg.tick) ?? new Array(msg.count);
    if (!parts[msg.index]) parts[msg.index] = msg.piece.slice();
    pieces.set(msg.tick, parts);
    receiving.hash = host.has;
    receiving.got = parts.filter(Boolean).length;
    receiving.count = msg.count;
    emit('change');
    if (receiving.got < msg.count) return;
    pieces.delete(msg.tick);
    const all = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let at = 0;
    for (const p of parts) {
      all.set(p, at);
      at += p.length;
    }
    try {
      const got = keepWorld(JSON.parse(new TextDecoder().decode(all)));
      if (got.hash !== host.has) throw new Error('hash');
      room.set({ has: got.hash, ready: true });
    } catch {
      world = null;
      room.set({ has: null, ready: false });
    }
    receiving.hash = null;
    emit('change');
  }

  // The host sends its world to each member without it.
  function share() {
    if (!isHost || !world) return;
    const bytes = new TextEncoder().encode(world.text);
    for (const m of room.members) {
      if (m.slot === 0 || m.has === world.hash || sentTo.get(m.slot) === world.hash) continue;
      sentTo.set(m.slot, world.hash);
      for (const part of encodeState(0, hashTick(world.hash), bytes, KIND.WORLD)) links.send(m.slot, part, { reliable: true });
    }
  }

  // ------------------------------------------------------------ the run

  function begin({ seed, level, crew }) {
    const slots = crew.map((m) => m.slot);
    const names = crew.map((m) => m.name);
    const local = slots.indexOf(room.slot);
    if (local < 0) {
      // Not in the crew (no world yet when it started): drop in.
      lateJoin();
      return;
    }
    const game = createGame({ RAPIER, world: world.doc, crew: crew.length, seed, startLevel: level });
    run = { game, session: null, slots, names, level, late: false, driven: false, keep: 0 };
    run.session = makeSession(game, local, null);
    keepAlive(run);
    emit('start', run);
  }

  function makeSession(game, local, welcome) {
    return createSession({
      game,
      local,
      welcome,
      now: now(),
      send: (index, bytes, opts) => {
        const slot = run?.slots[index];
        if (slot !== undefined) links.send(slot, bytes, opts);
      },
      details: () => ({ roomSlots: run.slots.slice(), names: run.names.slice() }),
      onJoin: ({ index, slot, who }) => {
        run.slots[index] = slot;
        run.names[index] = who;
        emit('change');
      },
    });
  }

  // Until the page's runner steps the session (it takes a moment to make its
  // view), the session still says it is here, so no one gives up on it.
  function keepAlive(r) {
    r.keep = setInterval(() => {
      if (r.driven || run !== r) clearInterval(r.keep);
      else r.session.flush(now());
    }, 100);
  }

  function lateJoin() {
    run = { game: null, session: null, slots: [], names: [], level: 0, late: true, driven: false, keep: 0 };
    reader = welcomeReader();
    emit('change');
  }

  function welcomed(welcome) {
    if (!world) return;
    const { about } = welcome;
    run.slots = about.roomSlots.slice();
    run.names = about.names.slice();
    const local = run.slots.lastIndexOf(room.slot);
    if (local < 0) return;
    const game = createGame({ RAPIER, world: world.doc, crew: 1, seed: 1 });
    run.game = game;
    run.session = makeSession(game, local, welcome);
    reader = null;
    keepAlive(run);
    emit('start', run);
  }

  // The host lets in members who came late, once they have the world.
  function admitLate() {
    if (!isHost || !run?.session || !world) return;
    for (const m of room.members) {
      if (m.slot === 0 || !m.late || !m.ready || m.has !== world.hash) continue;
      if (run.slots.some((s, i) => s === m.slot && !run.game.state.players[i]?.out)) continue;
      run.session.admit({ slot: m.slot, who: m.name });
    }
  }

  function endRun() {
    if (!run) return;
    const old = run;
    run = null;
    reader = null;
    clearInterval(old.keep);
    try {
      old.session?.end('stopped');
      old.game?.world.free();
    } catch {
      // freed already
    }
  }

  // ------------------------------------------------------------ the room

  room.on('members', () => {
    share();
    admitLate();
    emit('change');
  });
  room.on('start', (msg) => {
    if (!world) {
      lateJoin();
      return;
    }
    begin(msg);
  });
  room.on('stop', () => {
    emit('stop');
    endRun();
    emit('change');
  });
  room.on('left', ({ slot }) => {
    sentTo.delete(slot);
    if (isHost && run?.session) {
      const index = run.slots.lastIndexOf(slot);
      if (index > 0) run.session.drop(index);
    }
  });
  room.on('closed', ({ why }) => {
    closed = why;
    run?.session?.end(why);
    clearInterval(retry);
    links.close();
    emit('closed', why);
    endRun();
  });
  retry = setInterval(admitLate, 500);

  if (isHost) {
    keepWorld(doc);
    room.set({ has: world.hash, ready: true });
  } else if (room.late) lateJoin();

  const lobby = {
    room,
    links,
    isHost,
    get code() {
      return room.code;
    },
    get slot() {
      return room.slot;
    },
    get world() {
      return world;
    },
    get receiving() {
      return receiving;
    },
    get run() {
      return run;
    },
    get closed() {
      return closed;
    },
    // Everyone in the room, with what the page shows of each.
    get members() {
      const hash = isHost ? world?.hash : room.members.find((m) => m.slot === 0)?.has;
      return room.members.map((m) => ({
        ...m,
        you: m.slot === room.slot,
        hasWorld: Boolean(hash) && m.has === hash,
        link: m.slot === room.slot ? null : links.status(m.slot),
      }));
    },
    // Everyone has the world: the host may start.
    get canStart() {
      return isHost && !run && Boolean(world) && room.members.every((m) => m.has === world.hash && m.ready);
    },
    on(type, fn) {
      if (!handlers.has(type)) handlers.set(type, new Set());
      handlers.get(type).add(fn);
      return () => handlers.get(type).delete(fn);
    },
    setName(next) {
      room.set({ name: next });
    },
    setWorld(next) {
      if (!isHost || run) return;
      const before = world?.hash;
      keepWorld(next);
      if (world.hash !== before) {
        room.set({ has: world.hash, ready: true });
        share();
        emit('change');
      }
    },
    start(level = 0) {
      if (!lobby.canStart) return false;
      const seed = (Math.floor(now() * 1000) ^ Date.now()) >>> 0 || 1;
      room.start({ seed, level });
      return true;
    },
    stop() {
      if (isHost && run) room.stop();
    },
    leave() {
      endRun();
      clearInterval(retry);
      links.close();
      room.close();
    },
    hash: () => world?.hash ?? null,
  };
  return lobby;
}

export { worldHash };
