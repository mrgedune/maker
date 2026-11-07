// Copied from Critical Response (tools/rooms-dev.mjs), not shared.
// The co-op room service on this machine: the same room code the
// Cloudflare Worker runs (server/rooms/room.js), behind a small WebSocket
// server of its own, so development and the headless tests need nothing from
// outside and no packages.
//
//   npm run rooms                        ws://127.0.0.1:8787
//   npm run rooms -- --port 8790
//
// Then the maker with ?rooms=ws://127.0.0.1:8787 uses it (site/js/net/rooms.js).
// startRooms({ port }) runs it from a script and returns { url, close }.

import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { isCode, join, leave, message, randomCode } from '../server/rooms/room.js';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const ROUTE = /^\/rooms\/([A-Z]{4}|new)$/;

// One socket over a raw connection: RFC 6455 framing, enough for a browser.
function socketOver(raw, { onMessage, onClose }) {
  let buffer = Buffer.alloc(0);
  let parts = [];
  let partType = 0;
  let closed = false;
  const frame = (op, payload) => {
    const length = payload.length;
    const head =
      length < 126
        ? Buffer.from([0x80 | op, length])
        : length < 65536
          ? Buffer.from([0x80 | op, 126, length >> 8, length & 255])
          : Buffer.concat([Buffer.from([0x80 | op, 127]), bigLength(length)]);
    if (!raw.destroyed) raw.write(Buffer.concat([head, payload]));
  };
  const ws = {
    attachment: null,
    send(data) {
      if (closed) return;
      if (typeof data === 'string') frame(1, Buffer.from(data, 'utf8'));
      else frame(2, Buffer.from(data.buffer, data.byteOffset, data.byteLength));
    },
    close(code = 1000, why = '') {
      if (closed) return;
      const reason = Buffer.from(String(why).slice(0, 100), 'utf8');
      const body = Buffer.alloc(2 + reason.length);
      body.writeUInt16BE(code, 0);
      reason.copy(body, 2);
      frame(8, body);
      finish();
      setTimeout(() => raw.destroy(), 50);
    },
  };
  const finish = () => {
    if (closed) return;
    closed = true;
    setImmediate(() => onClose(ws));
  };
  raw.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    for (;;) {
      if (buffer.length < 2) return;
      const fin = (buffer[0] & 0x80) !== 0;
      const op = buffer[0] & 0x0f;
      let length = buffer[1] & 0x7f;
      let at = 2;
      if (length === 126) {
        if (buffer.length < 4) return;
        length = buffer.readUInt16BE(2);
        at = 4;
      } else if (length === 127) {
        if (buffer.length < 10) return;
        length = Number(buffer.readBigUInt64BE(2));
        at = 10;
      }
      const masked = (buffer[1] & 0x80) !== 0;
      const mask = masked ? buffer.subarray(at, at + 4) : null;
      if (masked) at += 4;
      if (buffer.length < at + length) return;
      const payload = Buffer.from(buffer.subarray(at, at + length));
      buffer = buffer.subarray(at + length);
      if (mask) for (let i = 0; i < payload.length; i += 1) payload[i] ^= mask[i & 3];
      if (op === 8) {
        ws.close(1000, 'closed');
        return;
      }
      if (op === 9) {
        frame(10, payload);
        continue;
      }
      if (op === 10) continue;
      if (op !== 0) partType = op;
      parts.push(payload);
      if (!fin) continue;
      const whole = Buffer.concat(parts);
      parts = [];
      const data =
        partType === 1
          ? whole.toString('utf8')
          : new Uint8Array(whole.buffer, whole.byteOffset, whole.length).slice().buffer;
      onMessage(ws, data);
    }
  });
  raw.on('close', finish);
  raw.on('error', finish);
  return ws;
}

function bigLength(n) {
  const b = Buffer.alloc(8);
  b.writeBigUInt64BE(BigInt(n));
  return b;
}

// `count(names)`: given the studio's counts as the room service adds them
// (server/rooms/room.js), for the tests.
export function startRooms({ port = 8787, quiet = false, count = null } = {}) {
  const rooms = new Map(); // code -> { meta, sockets }
  const roomOf = (code) => {
    let room = rooms.get(code);
    if (!room) rooms.set(code, (room = { meta: null, sockets: new Set() }));
    return room;
  };
  const hostFor = (code) => {
    const room = roomOf(code);
    return {
      sockets: () => [...room.sockets],
      member: (ws) => ws.attachment,
      attach: (ws, member) => {
        ws.attachment = member ? { ...member } : null;
      },
      meta: () => room.meta,
      keep: (meta) => {
        room.meta = meta;
        if (!meta) rooms.delete(code);
      },
      send: (ws, data) => ws.send(data),
      close: (ws, code2, why) => ws.close(code2, why),
      ...(count ? { count } : {}),
    };
  };
  const server = createServer((req, res) => {
    res.writeHead(req.url === '/' ? 200 : 404, { 'content-type': 'text/plain' });
    res.end(req.url === '/' ? 'Critical Response rooms (on this machine)\n' : 'Not found\n');
  });
  server.on('upgrade', (req, raw) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const route = ROUTE.exec(url.pathname);
    const key = req.headers['sec-websocket-key'];
    if (!route || !key || (route[1] !== 'new' && !isCode(route[1]))) {
      raw.end('HTTP/1.1 404 Not Found\r\n\r\n');
      return;
    }
    let code = route[1];
    const create = code === 'new';
    if (create)
      do code = randomCode();
      while (rooms.get(code)?.meta?.open);
    const accept = createHash('sha1')
      .update(key + GUID)
      .digest('base64');
    raw.write(
      'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    raw.setNoDelay(true);
    const room = roomOf(code);
    const host = hostFor(code);
    const ws = socketOver(raw, {
      onMessage: (s, data) => message(host, s, data),
      onClose: (s) => {
        leave(host, s);
        room.sockets.delete(s);
      },
    });
    room.sockets.add(ws);
    const member = join(host, ws, {
      code,
      name: url.searchParams.get('name'),
      version: url.searchParams.get('v'),
      create,
    });
    if (!quiet && member) console.log(`room ${code}: ${member.name} in slot ${member.slot}`);
  });
  const open = new Set();
  server.on('connection', (raw) => {
    open.add(raw);
    raw.on('close', () => open.delete(raw));
  });
  const close = () =>
    new Promise((done) => {
      for (const raw of open) raw.destroy();
      server.close(done);
    });
  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      const url = `ws://127.0.0.1:${server.address().port}`;
      if (!quiet) console.log(`rooms on ${url}`);
      resolve({ url, close, server });
    });
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const at = process.argv.indexOf('--port');
  startRooms({ port: at > 0 ? Number(process.argv[at + 1]) : 8787 });
}
