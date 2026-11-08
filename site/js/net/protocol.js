// Copied from Critical Response (game/net/protocol.js), not shared; WORLD added.
// The messages co-op machines send each other while a run is on (ADR-0015),
// as bytes. Little endian throughout. Each starts with its kind and the slot
// of the operative whose machine sent it.
//
//   INPUT  its own inputs, the latest few ticks again in every packet (a
//          dropped packet costs nothing), and how far it has the receiver's
//   CHECK  a hash of its world after a tick every machine has every input for
//   STATE  part of the host's world after such a tick: a drift's repair
//   PING / PONG  round trips, for the clocks
//   LEAVE  from the host: an operative's link is lost from this tick on, with
//          the last of its inputs the host had
//
// Dropping into a run under way (rollback.js):
//   JOIN     from the host: one more operative joins the world before this
//            tick, as the room's member who asked
//   WELCOME  from the host to the one dropping in, in parts as STATE: the
//            world after a tick every machine has every input for, and how
//            the session stands
//   READY    from the one dropping in: its world has caught up, at this tick
//   LIVE     from the host: from this tick on its inputs count

export const KIND = {
  INPUT: 1,
  CHECK: 2,
  STATE: 3,
  PING: 4,
  PONG: 5,
  LEAVE: 6,
  JOIN: 7,
  WELCOME: 8,
  READY: 9,
  LIVE: 10,
  WORLD: 11, // the lobby: the world file, in pieces, to a member who has not got it
};

// The most bytes of a world one STATE carries (data channels take 16 KB
// everywhere).
export const CHUNK = 15000;

export function encodeInput(from, ack, start, a, b, count) {
  const view = new DataView(new ArrayBuffer(11 + count * 8));
  view.setUint8(0, KIND.INPUT);
  view.setUint8(1, from);
  view.setInt32(2, ack, true);
  view.setUint32(6, start, true);
  view.setUint8(10, count);
  for (let i = 0; i < count; i += 1) {
    view.setUint32(11 + i * 8, a[i], true);
    view.setUint32(15 + i * 8, b[i], true);
  }
  return new Uint8Array(view.buffer);
}

export function encodeCheck(from, tick, hash) {
  const view = new DataView(new ArrayBuffer(10));
  view.setUint8(0, KIND.CHECK);
  view.setUint8(1, from);
  view.setUint32(2, tick, true);
  view.setUint32(6, hash, true);
  return new Uint8Array(view.buffer);
}

// A world in pieces: one message for each CHUNK of its bytes.
export function encodeState(from, tick, bytes, kind = KIND.STATE) {
  const count = Math.max(1, Math.ceil(bytes.length / CHUNK));
  const parts = [];
  for (let index = 0; index < count; index += 1) {
    const piece = bytes.subarray(index * CHUNK, (index + 1) * CHUNK);
    const out = new Uint8Array(10 + piece.length);
    const view = new DataView(out.buffer);
    view.setUint8(0, kind);
    view.setUint8(1, from);
    view.setUint32(2, tick, true);
    view.setUint16(6, index, true);
    view.setUint16(8, count, true);
    out.set(piece, 10);
    parts.push(out);
  }
  return parts;
}

export function encodePing(kind, from, stamp) {
  const view = new DataView(new ArrayBuffer(10));
  view.setUint8(0, kind);
  view.setUint8(1, from);
  view.setFloat64(2, stamp, true);
  return new Uint8Array(view.buffer);
}

export function encodeLeave(from, slot, tick, a, b, count) {
  const view = new DataView(new ArrayBuffer(9 + count * 8));
  view.setUint8(0, KIND.LEAVE);
  view.setUint8(1, from);
  view.setUint8(2, slot);
  view.setUint32(3, tick, true);
  view.setUint16(7, count, true);
  for (let i = 0; i < count; i += 1) {
    view.setUint32(9 + i * 8, a[i], true);
    view.setUint32(13 + i * 8, b[i], true);
  }
  return new Uint8Array(view.buffer);
}

// JOIN: { index, tick, slot, who } as JSON after the kind and the sender.
export function encodeJoin(from, join) {
  const text = new TextEncoder().encode(JSON.stringify(join));
  const out = new Uint8Array(2 + text.length);
  out[0] = KIND.JOIN;
  out[1] = from;
  out.set(text, 2);
  return out;
}

// WELCOME: its JSON (how the session stands) and the world's bytes, as one
// run of bytes for encodeState: the JSON's length, the JSON, the world.
export function encodeWelcome(from, tick, about, world) {
  const text = new TextEncoder().encode(JSON.stringify(about));
  const bytes = new Uint8Array(4 + text.length + world.length);
  new DataView(bytes.buffer).setUint32(0, text.length, true);
  bytes.set(text, 4);
  bytes.set(world, 4 + text.length);
  return encodeState(from, tick, bytes, KIND.WELCOME);
}

export function readWelcome(bytes) {
  const length = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0, true);
  const about = JSON.parse(new TextDecoder().decode(bytes.subarray(4, 4 + length)));
  return { about, world: bytes.slice(4 + length) };
}

// A WELCOME's pieces put back together: each message in turn, and once the
// last is in, { from, about, world }; null until then, and for any other kind.
export function welcomeReader() {
  const pending = new Map();
  return (bytes) => {
    const msg = decode(bytes);
    if (!msg || msg.kind !== KIND.WELCOME) return null;
    const parts = pending.get(msg.tick) ?? new Array(msg.count);
    parts[msg.index] = msg.piece.slice();
    pending.set(msg.tick, parts);
    if (parts.filter(Boolean).length < msg.count) return null;
    pending.delete(msg.tick);
    const whole = new Uint8Array(parts.reduce((sum, p) => sum + p.length, 0));
    let at = 0;
    for (const p of parts) {
      whole.set(p, at);
      at += p.length;
    }
    return { from: msg.from, ...readWelcome(whole) };
  };
}

// READY (the one dropping in) and LIVE (the host, for operative `index`).
export function encodeReady(from, tick) {
  const view = new DataView(new ArrayBuffer(6));
  view.setUint8(0, KIND.READY);
  view.setUint8(1, from);
  view.setUint32(2, tick, true);
  return new Uint8Array(view.buffer);
}

export function encodeLive(from, index, tick) {
  const view = new DataView(new ArrayBuffer(7));
  view.setUint8(0, KIND.LIVE);
  view.setUint8(1, from);
  view.setUint8(2, index);
  view.setUint32(3, tick, true);
  return new Uint8Array(view.buffer);
}

// Any message, read back: { kind, from, ... }. Null for one this build does
// not know, or one cut short.
export function decode(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length < 2) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const kind = view.getUint8(0);
  const from = view.getUint8(1);
  try {
    if (kind === KIND.INPUT) {
      const count = view.getUint8(10);
      const a = new Uint32Array(count);
      const b = new Uint32Array(count);
      for (let i = 0; i < count; i += 1) {
        a[i] = view.getUint32(11 + i * 8, true);
        b[i] = view.getUint32(15 + i * 8, true);
      }
      return { kind, from, ack: view.getInt32(2, true), start: view.getUint32(6, true), a, b };
    }
    if (kind === KIND.CHECK)
      return { kind, from, tick: view.getUint32(2, true), hash: view.getUint32(6, true) };
    if (kind === KIND.STATE || kind === KIND.WELCOME || kind === KIND.WORLD)
      return {
        kind,
        from,
        tick: view.getUint32(2, true),
        index: view.getUint16(6, true),
        count: view.getUint16(8, true),
        piece: bytes.subarray(10),
      };
    if (kind === KIND.PING || kind === KIND.PONG)
      return { kind, from, stamp: view.getFloat64(2, true) };
    if (kind === KIND.LEAVE) {
      const count = view.getUint16(7, true);
      const a = new Uint32Array(count);
      const b = new Uint32Array(count);
      for (let i = 0; i < count; i += 1) {
        a[i] = view.getUint32(9 + i * 8, true);
        b[i] = view.getUint32(13 + i * 8, true);
      }
      return { kind, from, slot: view.getUint8(2), tick: view.getUint32(3, true), a, b };
    }
    if (kind === KIND.JOIN)
      return { kind, from, ...JSON.parse(new TextDecoder().decode(bytes.subarray(2))) };
    if (kind === KIND.READY) return { kind, from, tick: view.getUint32(2, true) };
    if (kind === KIND.LIVE)
      return { kind, from, index: view.getUint8(2), tick: view.getUint32(3, true) };
  } catch {
    return null;
  }
  return null;
}
