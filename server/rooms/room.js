// A co-op room, apart from where it runs. Adapted from Critical Response's
// (server/rooms/room.js), not shared: the maker's members carry a name,
// whether they hold the host's world file, and ready.
//
// A room is a four-letter code with up to four members. The first is the host
// (slot 0), whose world everyone plays. The room carries WebRTC's signalling
// between members (`signal`) and, while two of them have no direct link, their
// bytes (binary frames: the first byte is the slot it goes to, 255 for
// everyone; it arrives with the sender's slot there instead). That is how the
// host's world file reaches the others (net/lobby.js). A member of another
// build is refused, so games never mix. If the host leaves, the room closes.
// Once the run has started, a member who comes in is `late`: it gets the
// world, says it is ready, and the host's game brings it in (net/session.js).
//
// Where it runs supplies `host`:
//   sockets()            the members' open sockets
//   member(ws)           what is attached to a socket: { slot, name, has, ready, late }
//   attach(ws, member)   attaches it
//   meta()               the room's own: { code, version, open, started, seed, level, at, peak }
//   keep(meta)           keeps it (null: the room is gone)
//   send(ws, data)       a string or bytes
//   close(ws, code, why)
//   now()                optional: ms since 1970

export const ROOM = {
  most: 4, // members
  name: 16, // characters of a name
  bytes: 64 * 1024, // the most a message may hold
  everyone: 255, // the relay's slot for all the others
};

// Room codes: four letters, no I or O (read as 1 and 0).
export const LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
export const isCode = (code) => typeof code === 'string' && /^[A-HJ-NP-Z]{4}$/.test(code);

export function randomCode(random = Math.random) {
  let code = '';
  for (let i = 0; i < 4; i += 1) code += LETTERS[Math.floor(random() * LETTERS.length)];
  return code;
}

// Why a socket is closed, as WebSocket close codes.
export const CLOSE = {
  hostLeft: 4001,
  started: 4003,
  missing: 4004,
  full: 4005,
  version: 4006,
  bad: 4008,
  taken: 4009,
};

const cleanName = (name, slot) =>
  String(name ?? '')
    .replace(/[^\p{L}\p{N} _.-]/gu, '')
    .trim()
    .slice(0, ROOM.name) || `Player ${slot + 1}`;
const cleanHas = (v) => (typeof v === 'string' && /^[0-9a-f]{1,32}$/.test(v) ? v : null);

function members(host, except = null) {
  return host
    .sockets()
    .filter((ws) => ws !== except && host.member(ws))
    .map((ws) => ({ ws, ...host.member(ws) }))
    .sort((a, b) => a.slot - b.slot);
}

const roster = (list) => list.map(({ slot, name, has = null, ready, late = false }) => ({ slot, name, has, ready, late }));

function tell(host, data, except = null) {
  const text = JSON.stringify(data);
  for (const { ws } of members(host, except)) host.send(ws, text);
}

function announce(host, except = null) {
  tell(host, { type: 'members', members: roster(members(host, except)) }, except);
}

const nowOf = (host) => host.now?.() ?? Date.now();

// A socket asks in: `create` makes the room (the Worker gives a fresh code).
// Returns its member, or null once it has been closed with the reason.
export function join(host, ws, { code, name, version, create = false }) {
  let meta = host.meta();
  const refuse = (closeCode, why) => {
    host.close(ws, closeCode, why);
    return null;
  };
  if (!isCode(code)) return refuse(CLOSE.missing, 'no such room');
  if (typeof version !== 'string' || !version || version.length > 64) return refuse(CLOSE.version, 'no version');
  if (create) {
    if (meta?.open) return refuse(CLOSE.taken, 'taken');
    meta = { code, version, open: true, started: false, seed: null, level: 0, at: nowOf(host), peak: 0 };
    host.keep(meta);
  } else if (!meta?.open) return refuse(CLOSE.missing, 'no such room');
  if (meta.version !== version) return refuse(CLOSE.version, 'another version of the maker');
  const taken = new Set(members(host, ws).map((m) => m.slot));
  if (taken.size >= ROOM.most) return refuse(CLOSE.full, 'the room is full');
  if (taken.size + 1 > (meta.peak ?? 0)) host.keep({ ...meta, peak: taken.size + 1 });
  let slot = 0;
  while (taken.has(slot)) slot += 1;
  const member = { slot, name: cleanName(name, slot), has: null, ready: false, late: Boolean(meta.started) };
  host.attach(ws, member);
  host.send(ws, JSON.stringify({ type: 'welcome', code, slot, version, host: 0, started: member.late, seed: meta.seed, level: meta.level }));
  announce(host);
  return member;
}

export function message(host, ws, data) {
  const me = host.member(ws);
  if (!me) return;
  const size = typeof data === 'string' ? data.length : data.byteLength;
  if (size > ROOM.bytes) {
    host.close(ws, CLOSE.bad, 'too big');
    return;
  }
  if (typeof data !== 'string') {
    relay(host, me, new Uint8Array(data));
    return;
  }
  // A keepalive (on Cloudflare the Worker answers it without waking the room).
  if (data === 'ping') {
    host.send(ws, 'pong');
    return;
  }
  let msg;
  try {
    msg = JSON.parse(data);
  } catch {
    return;
  }
  const meta = host.meta();
  if (msg.type === 'set') {
    if ('name' in msg && (!meta.started || me.late)) me.name = cleanName(msg.name, me.slot);
    if ('has' in msg) me.has = cleanHas(msg.has);
    if ('ready' in msg) me.ready = Boolean(msg.ready);
    host.attach(ws, me);
    announce(host);
  } else if (msg.type === 'start' && me.slot === 0 && !meta.started) {
    const seed = Number.isInteger(msg.seed) ? msg.seed >>> 0 : 1;
    const level = Number.isInteger(msg.level) && msg.level >= 0 && msg.level < 8 ? msg.level : 0;
    host.keep({ ...meta, started: true, seed, level });
    tell(host, { type: 'start', seed, level, crew: roster(members(host)) });
  } else if (msg.type === 'signal') {
    const to = members(host).find((m) => m.slot === msg.to);
    if (to && to.ws !== ws) host.send(to.ws, JSON.stringify({ type: 'signal', from: me.slot, data: msg.data }));
  } else if (msg.type === 'ping') {
    host.send(ws, JSON.stringify({ type: 'pong', stamp: msg.stamp }));
  }
}

function relay(host, me, bytes) {
  if (bytes.length < 2) return;
  const to = bytes[0];
  const out = bytes.slice();
  out[0] = me.slot;
  for (const m of members(host)) if (m.slot !== me.slot && (to === ROOM.everyone || m.slot === to)) host.send(m.ws, out);
}

// A socket has gone. The host's going closes the room.
export function leave(host, ws) {
  const me = host.member(ws);
  if (!me) return;
  host.attach(ws, null);
  const rest = members(host, ws);
  if (me.slot === 0 || rest.length === 0) {
    for (const m of rest) {
      host.attach(m.ws, null);
      host.close(m.ws, CLOSE.hostLeft, 'the host left');
    }
    host.keep(null);
    return;
  }
  tell(host, { type: 'left', slot: me.slot }, ws);
  announce(host, ws);
}
