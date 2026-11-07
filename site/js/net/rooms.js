// Copied from Critical Response (game/net/rooms.js), not shared; the maker's fields.
// The co-op room, from the maker's side: openRoom() asks the room service for
// a room, or into one by its code, and returns it once the room has said
// which slot this machine is. The room's own rules are server/rooms/room.js;
// transport.js opens the socket.
//
// room.on(type, fn) hears the room: 'members' (the roster), 'start' (seed,
// level, crew), 'stop' (the run is over), 'signal' (WebRTC's, for transport.js), 'left' (a member gone),
// 'closed' (the room is gone: `why`). room.onBytes(fn) hears what the relay
// carries. room.set({ name, has, ready }), room.start({ seed, level }) and room.stop() (the
// host), room.signal(to, data), room.relay(to, bytes), room.close().
// room.late: it came in after the run started, to drop into it.

import { BUILD } from './build.js';
import { openSocket } from './transport.js';

export { BUILD };

// The room service, on Cloudflare (server/rooms/). The site's CSP names this
// address too.
export const ROOM_SERVICE = 'wss://maker-rooms.mrgedune.workers.dev';

// Where the rooms are: the service, or with ?rooms= one running on this
// machine (npm run rooms), for development and the headless tests.
export function roomService(params) {
  const asked = params?.get?.('rooms');
  if (asked && /^ws:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?$/.test(asked)) return asked;
  return ROOM_SERVICE;
}

// What a closed room says, by its close code (server/rooms/room.js CLOSE).
const WHY = {
  4001: 'The host left.',
  4003: 'That run has already started.',
  4004: 'There is no room with that code.',
  4005: 'That room is full.',
  4006: 'That room is on another version of the maker. Reload to update.',
  4008: 'The room refused a message.',
  4009: 'That room code is taken.',
};
const why = (code) => WHY[code] ?? 'The room could not be reached.';

const KEEPALIVE = 20000; // ms between pings, so a quiet link is not dropped

export function openRoom({ service = ROOM_SERVICE, code = 'new', name = '', version = BUILD }) {
  const url = `${service}/rooms/${code}?v=${encodeURIComponent(version)}&name=${encodeURIComponent(name)}`;
  const ws = openSocket(url);
  const handlers = new Map();
  let onBytes = () => {};
  const emit = (type, msg) => {
    for (const fn of handlers.get(type) ?? []) fn(msg);
  };
  const say = (msg) => {
    if (ws.readyState === 1) ws.send(JSON.stringify(msg));
  };
  const room = {
    code: null,
    slot: -1,
    members: [],
    started: null,
    late: false,
    open: false,
    on(type, fn) {
      if (!handlers.has(type)) handlers.set(type, new Set());
      handlers.get(type).add(fn);
      return () => handlers.get(type).delete(fn);
    },
    onBytes(fn) {
      onBytes = fn;
    },
    set(fields) {
      say({ type: 'set', ...fields });
    },
    start({ seed, level }) {
      say({ type: 'start', seed, level });
    },
    stop() {
      say({ type: 'stop' });
    },
    signal(to, data) {
      say({ type: 'signal', to, data });
    },
    relay(to, bytes) {
      if (ws.readyState !== 1) return;
      const out = new Uint8Array(bytes.length + 1);
      out[0] = to;
      out.set(bytes, 1);
      ws.send(out);
    },
    close() {
      clearInterval(alive);
      if (ws.readyState <= 1) ws.close(1000, 'left');
    },
  };
  const alive = setInterval(() => ws.readyState === 1 && ws.send('ping'), KEEPALIVE);
  return new Promise((resolve, reject) => {
    ws.onmessage = (e) => {
      if (typeof e.data !== 'string') {
        const bytes = new Uint8Array(e.data);
        if (bytes.length > 1) onBytes(bytes[0], bytes.subarray(1));
        return;
      }
      let msg;
      try {
        msg = JSON.parse(e.data);
      } catch {
        return; // 'pong'
      }
      if (msg.type === 'welcome') {
        room.code = msg.code;
        room.slot = msg.slot;
        room.late = Boolean(msg.started);
        if (msg.started) room.started = { seed: msg.seed, level: msg.level };
        room.open = true;
        resolve(room);
      } else if (msg.type === 'members') room.members = msg.members;
      else if (msg.type === 'start') room.started = msg;
      else if (msg.type === 'stop') room.started = null;
      emit(msg.type, msg);
    };
    ws.onclose = (e) => {
      clearInterval(alive);
      const wasOpen = room.open;
      room.open = false;
      if (!wasOpen) reject(new Error(why(e.code)));
      else emit('closed', { why: e.code === 1000 ? 'You left the room.' : why(e.code) });
    };
  });
}
