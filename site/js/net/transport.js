// Copied from Critical Response (game/net/transport.js), not shared.
// How co-op machines reach each other : the only file in the maker
// that opens a socket or a peer connection.
//
// openSocket(url) opens the room's WebSocket, for rooms.js. createLinks(room) joins
// every member of a room to every other, peer to peer: an RTCPeerConnection
// each, with two data channels made the same way on both ends (`negotiated`):
// 'inputs', unordered and never resent, and 'control', reliable and in order.
// The member in the lower slot makes the offer; the room carries the offers,
// answers and candidates (`signal`). Until a pair's channels open, or where a
// router never lets them, their bytes go through the room's relay instead, so
// a link always works; links.status(slot) says which way it goes.
//
// STUN is Cloudflare's public server, which needs no account; there is no
// TURN (the room's relay is the fallback). `ice: false` leaves STUN out, for
// machines on one network (the headless tests); `direct: false` sends
// everything through the room, to try the relay.

const STUN = 'stun:stun.cloudflare.com:3478';

// A channel already holding this much waits: inputs are resent every frame
// anyway, and a queue would only make them late.
const BACKLOG = 256 * 1024;

export function openSocket(url) {
  const ws = new WebSocket(url);
  ws.binaryType = 'arraybuffer';
  return ws;
}

// `room`: an open room (rooms.js). `onBytes(slot, bytes)`: a message from the
// member in that slot, whichever way it came.
export function createLinks(
  room,
  { ice = true, direct: peer2peer = true, onBytes: heard = () => {} } = {},
) {
  let onBytes = heard;
  const peers = new Map(); // slot -> { pc, inputs, control, open }
  const config = { iceServers: ice ? [{ urls: STUN }] : [] };
  let closed = false;

  function open(slot) {
    if (
      closed ||
      !peer2peer ||
      slot === room.slot ||
      peers.has(slot) ||
      typeof RTCPeerConnection === 'undefined'
    )
      return;
    const pc = new RTCPeerConnection(config);
    const inputs = pc.createDataChannel('inputs', {
      negotiated: true,
      id: 0,
      ordered: false,
      maxRetransmits: 0,
    });
    const control = pc.createDataChannel('control', { negotiated: true, id: 1, ordered: true });
    const peer = { pc, inputs, control, pending: [] };
    peers.set(slot, peer);
    for (const channel of [inputs, control]) {
      channel.binaryType = 'arraybuffer';
      channel.onmessage = (e) => onBytes(slot, new Uint8Array(e.data));
    }
    pc.onicecandidate = (e) => {
      if (e.candidate) room.signal(slot, { candidate: e.candidate.toJSON() });
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed') pc.restartIce?.();
    };
    if (room.slot < slot)
      pc.createOffer()
        .then((offer) => pc.setLocalDescription(offer))
        .then(() => room.signal(slot, { sdp: pc.localDescription.toJSON() }))
        .catch(() => {});
  }

  async function signal(from, data) {
    if (closed || !data) return;
    open(from);
    const peer = peers.get(from);
    if (!peer) return;
    const { pc } = peer;
    try {
      if (data.sdp) {
        await pc.setRemoteDescription(data.sdp);
        for (const candidate of peer.pending.splice(0)) await pc.addIceCandidate(candidate);
        if (data.sdp.type === 'offer') {
          await pc.setLocalDescription(await pc.createAnswer());
          room.signal(from, { sdp: pc.localDescription.toJSON() });
        }
      } else if (data.candidate) {
        if (pc.remoteDescription) await pc.addIceCandidate(data.candidate);
        else peer.pending.push(data.candidate);
      }
    } catch {
      // A bad or stale signal: the relay still carries the link.
    }
  }

  function drop(slot) {
    const peer = peers.get(slot);
    if (!peer) return;
    peers.delete(slot);
    peer.pc.close();
  }

  const offs = [
    room.on('members', ({ members }) => {
      for (const m of members) open(m.slot);
      for (const slot of peers.keys()) if (!members.some((m) => m.slot === slot)) drop(slot);
    }),
    room.on('signal', ({ from, data }) => signal(from, data)),
    room.on('left', ({ slot }) => drop(slot)),
  ];
  room.onBytes((slot, bytes) => onBytes(slot, bytes));
  for (const m of room.members) open(m.slot);

  const direct = (slot, reliable) => {
    const peer = peers.get(slot);
    const channel = peer && (reliable ? peer.control : peer.inputs);
    return channel?.readyState === 'open' ? channel : null;
  };

  return {
    // Bytes to the member in `slot`: directly when the pair's channel is open,
    // else through the room.
    send(slot, bytes, { reliable = false } = {}) {
      if (closed) return;
      const channel = direct(slot, reliable);
      if (!channel) {
        room.relay(slot, bytes);
        return;
      }
      if (!reliable && channel.bufferedAmount > BACKLOG) return;
      try {
        channel.send(bytes);
      } catch {
        room.relay(slot, bytes);
      }
    },
    // Who hears what arrives, from here on (the run takes it from the lobby).
    onBytes(fn) {
      onBytes = fn;
    },
    // 'direct' or 'relay', for the lobby and the HUD.
    status(slot) {
      return direct(slot, true) && direct(slot, false) ? 'direct' : 'relay';
    },
    close() {
      closed = true;
      for (const off of offs) off();
      for (const slot of [...peers.keys()]) drop(slot);
    },
  };
}
