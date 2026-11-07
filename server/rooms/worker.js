// The maker's co-op room service on Cloudflare: a Worker that sends each room
// code to its own Durable Object, which runs room.js. Adapted from Critical
// Response's (server/rooms/worker.js), not shared. Deployed from this folder
// with `npx wrangler deploy`, only on David's word.
//
//   wss://<worker>/rooms/new?v=<build>&name=<name>    a new room, a fresh code
//   wss://<worker>/rooms/ABCD?v=<build>&name=<name>   that room
//
// The room keeps its sockets with the hibernation API: while its players talk
// peer to peer it sleeps, and costs next to nothing. A socket only comes from
// the maker's own pages (ORIGINS) or a page on this machine.

import { DurableObject } from 'cloudflare:workers';
import { isCode, join, leave, message, randomCode } from './room.js';

const ROUTE = /^\/rooms\/([A-Z]{4}|new)$/;

function fromMaker(origin, env) {
  if (!origin) return false;
  if ((env.ORIGINS ?? '').split(/\s+/).includes(origin)) return true;
  if (/^https:\/\/[a-z0-9-]+\.rabbithouse-maker\.pages\.dev$/.test(origin)) return true;
  return /^http:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?$/.test(origin);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/') return new Response('Rabbit House maker rooms\n');
    const route = ROUTE.exec(url.pathname);
    if (!route || (route[1] !== 'new' && !isCode(route[1]))) return new Response('Not found', { status: 404 });
    if (request.headers.get('Upgrade') !== 'websocket') return new Response('Rooms take a WebSocket', { status: 426 });
    if (!fromMaker(request.headers.get('Origin'), env)) return new Response('Not from the maker', { status: 403 });
    const ask = (code, create) => {
      const headers = new Headers(request.headers);
      headers.delete('x-room-create');
      if (create) headers.set('x-room-create', '1');
      const forward = new Request(`${url.origin}/rooms/${code}${url.search}`, { headers, method: 'GET' });
      return env.ROOMS.get(env.ROOMS.idFromName(code)).fetch(forward);
    };
    if (route[1] !== 'new') return ask(route[1], false);
    // A fresh code: one whose room is not open already.
    for (let tries = 0; tries < 8; tries += 1) {
      const answer = await ask(randomCode(), true);
      if (answer.status !== 409) return answer;
    }
    return new Response('No free room', { status: 503 });
  },
};

export class Room extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.state = null;
    ctx.blockConcurrencyWhile(async () => {
      this.state = (await ctx.storage.get('meta')) ?? null;
    });
    // Keepalives, answered while the room sleeps.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
    const ctxRef = ctx;
    this.host = {
      sockets: () => ctxRef.getWebSockets(),
      member: (ws) => ws.deserializeAttachment() ?? null,
      attach: (ws, member) => ws.serializeAttachment(member),
      meta: () => this.state,
      keep: (meta) => {
        this.state = meta;
        if (meta) ctxRef.storage.put('meta', meta);
        else ctxRef.storage.deleteAll();
      },
      send: (ws, data) => {
        try {
          ws.send(data);
        } catch {
          // Closing already.
        }
      },
      close: (ws, code, why) => {
        try {
          ws.close(code, why);
        } catch {
          // Closed already.
        }
      },
      now: () => Date.now(),
    };
  }

  async fetch(request) {
    const url = new URL(request.url);
    const code = url.pathname.split('/').pop();
    const create = request.headers.get('x-room-create') === '1';
    if (create && this.state?.open) return new Response('Taken', { status: 409 });
    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server);
    join(this.host, server, { code, name: url.searchParams.get('name'), version: url.searchParams.get('v'), create });
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, data) {
    message(this.host, ws, data);
  }

  async webSocketClose(ws) {
    leave(this.host, ws);
    this.host.close(ws, 1000, 'closed');
  }

  async webSocketError(ws) {
    leave(this.host, ws);
  }
}
