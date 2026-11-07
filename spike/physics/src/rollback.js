// The rollback test. Four bots each run their own copy of the world, the way four
// players' machines would in co-op. Remote inputs arrive late (60 ms plus jitter),
// so each machine guesses, then rewinds and replays when a guess was wrong.
// At the end every machine's world must match a reference run that knew every
// input on time, bit for bit.

import { createSim, PLAYERS, NO_INPUT, sameInput, BTN_JUMP, BTN_SHOVE, hashBytes } from "./sim.js";

const now = () => performance.now();

function mix32(a, b) {
  let h = Math.imul(a ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(b + 0x7f4a7c15, 0xc2b2ae35);
  h ^= h >>> 13;
  h = Math.imul(h, 0x27d4eb2f);
  return (h ^ (h >>> 16)) >>> 0;
}

// A bot's input for a tick. Changes direction every 45 ticks, jumps and shoves now and then,
// and every third stretch walks toward the middle where the toys are.
const toCentre = [
  [1, 1],
  [-1, 1],
  [1, -1],
  [-1, -1],
];
export function botInput(p, tick) {
  const seg = (tick - (tick % 45)) / 45;
  const inSeg = tick % 45;
  const h = mix32(p + 1, seg);
  let mx = (h & 0xff) - 128;
  let my = ((h >>> 8) & 0xff) - 128;
  if (seg % 3 === 0) {
    mx = 110 * toCentre[p][0];
    my = 110 * toCentre[p][1];
  }
  if (mx < -127) mx = -127;
  if (my < -127) my = -127;
  let b = 0;
  if (((h >>> 16) & 3) === 0 && inSeg >= 10 && inSeg < 14) b |= BTN_JUMP;
  if (((h >>> 20) & 3) !== 0 && inSeg >= 20 && inSeg < 26) b |= BTN_SHOVE;
  return { mx, my, b };
}

function stats(arr) {
  if (arr.length === 0) return { n: 0 };
  const s = Float64Array.from(arr).sort();
  const pick = (q) => s[Math.min(s.length - 1, Math.floor(q * s.length))];
  let sum = 0;
  for (const v of s) sum += v;
  const r = (v) => Math.round(v * 1000) / 1000;
  return { n: s.length, mean: r(sum / s.length), p50: r(pick(0.5)), p99: r(pick(0.99)), max: r(s[s.length - 1]) };
}

const CHECK_EVERY = 60;

function referenceRun(RAPIER, ticks, toys) {
  const sim = createSim(RAPIER, { toys });
  const checks = {};
  const stepMs = [];
  const awake = [];
  for (let t = 0; t < ticks; t++) {
    const inputs = [];
    for (let p = 0; p < PLAYERS; p++) inputs.push(botInput(p, t));
    const t0 = now();
    sim.step(inputs);
    stepMs.push(now() - t0);
    if (sim.tick % CHECK_EVERY === 0) {
      checks[sim.tick] = sim.hash();
      awake.push(sim.awakeToys());
    }
  }
  const finalHash = sim.hash();
  const snap = sim.snapshot();
  sim.free();
  return { checks, finalHash, stepMs, awake, snapshotBytes: snap.bytes.length, snapshotSample: snap.bytes };
}

function peerRun(RAPIER, peer, ticks, toys, delayFor) {
  const sim = createSim(RAPIER, { toys });
  const known = Array.from({ length: PLAYERS }, () => new Array(ticks));
  const latest = Array.from({ length: PLAYERS }, () => ({ tick: -1, input: NO_INPUT }));
  const used = new Array(ticks);
  const snaps = new Map();
  const checks = {};

  // Who hears what, when.
  const inbox = new Map();
  for (let q = 0; q < PLAYERS; q++) {
    if (q === peer) continue;
    for (let t = 0; t < ticks; t++) {
      const at = t + delayFor(q, peer, t);
      if (!inbox.has(at)) inbox.set(at, []);
      inbox.get(at).push([q, t]);
    }
  }

  const inputFor = (q, t) => known[q][t] ?? latest[q].input;
  const gather = (t) => {
    const a = [];
    for (let q = 0; q < PLAYERS; q++) a.push(inputFor(q, t));
    return a;
  };

  const m = { frameMs: [], stepMs: [], snapMs: [], restoreMs: [], replayTicks: [], rollbacks: 0, guessesWrong: 0, guesses: 0 };

  const stepOnce = (t) => {
    let s0 = now();
    snaps.set(t, sim.snapshot());
    m.snapMs.push(now() - s0);
    snaps.delete(t - 20);
    const inputs = gather(t);
    used[t] = inputs;
    s0 = now();
    sim.step(inputs);
    m.stepMs.push(now() - s0);
    let hashMs = 0;
    if (sim.tick % CHECK_EVERY === 0) {
      const h0 = now();
      checks[sim.tick] = sim.hash();
      hashMs = now() - h0;
    }
    return hashMs;
  };

  const deliver = (list, cur) => {
    let wrongFrom = Infinity;
    for (const [q, t] of list) {
      const inp = botInput(q, t);
      known[q][t] = inp;
      if (t > latest[q].tick) latest[q] = { tick: t, input: inp };
      if (t < cur) {
        m.guesses++;
        if (!sameInput(used[t][q], inp)) {
          m.guessesWrong++;
          if (t < wrongFrom) wrongFrom = t;
        }
      }
    }
    return wrongFrom;
  };

  const rollbackTo = (from, cur) => {
    m.rollbacks++;
    m.replayTicks.push(cur - from);
    const r0 = now();
    sim.restore(snaps.get(from));
    m.restoreMs.push(now() - r0);
    let hashMs = 0;
    for (let t = from; t < cur; t++) hashMs += stepOnce(t);
    return hashMs;
  };

  for (let cur = 0; cur < ticks; cur++) {
    const f0 = now();
    let hashMs = 0;
    const own = botInput(peer, cur);
    known[peer][cur] = own;
    latest[peer] = { tick: cur, input: own };
    const wrongFrom = deliver(inbox.get(cur) ?? [], cur);
    if (wrongFrom < cur) hashMs += rollbackTo(wrongFrom, cur);
    hashMs += stepOnce(cur);
    m.frameMs.push(now() - f0 - hashMs);
  }
  // Late inputs still in flight at the end: deliver them and settle.
  const rest = [];
  for (const [at, list] of inbox) if (at >= ticks) rest.push(...list);
  const wrongFrom = deliver(rest, ticks);
  if (wrongFrom < ticks) rollbackTo(wrongFrom, ticks);
  const finalHash = sim.hash();
  sim.free();
  return {
    peer,
    checks,
    finalHash,
    rollbacks: m.rollbacks,
    guesses: m.guesses,
    guessesWrong: m.guessesWrong,
    frameMs: stats(m.frameMs),
    stepMs: stats(m.stepMs),
    snapshotMs: stats(m.snapMs),
    restoreMs: stats(m.restoreMs),
    replayTicks: stats(m.replayTicks),
  };
}

// Worst case: every frame rewinds the whole window and replays it.
function stormRun(RAPIER, toys, depth, frames) {
  const sim = createSim(RAPIER, { toys });
  const snaps = new Map();
  for (let t = 0; t < 120; t++) {
    snaps.set(t, sim.snapshot());
    sim.step([0, 1, 2, 3].map((p) => botInput(p, t)));
  }
  const frameMs = [];
  for (let f = 0; f < frames; f++) {
    const cur = sim.tick;
    const f0 = now();
    sim.restore(snaps.get(cur - depth));
    for (let t = cur - depth; t <= cur; t++) {
      snaps.set(t, sim.snapshot());
      sim.step([0, 1, 2, 3].map((p) => botInput(p, t)));
    }
    frameMs.push(now() - f0);
    snaps.delete(cur - 30);
  }
  sim.free();
  return { depth, frames, frameMs: stats(frameMs) };
}

function scaleRun(RAPIER, toys, ticks) {
  const sim = createSim(RAPIER, { toys });
  const stepMs = [];
  const snapMs = [];
  let bytes = 0;
  for (let t = 0; t < ticks; t++) {
    const s0 = now();
    const snap = sim.snapshot();
    snapMs.push(now() - s0);
    bytes = snap.bytes.length;
    const t0 = now();
    sim.step([0, 1, 2, 3].map((p) => botInput(p, t)));
    stepMs.push(now() - t0);
  }
  const awake = sim.awakeToys();
  sim.free();
  return { toys, ticks, stepMs: stats(stepMs), snapshotMs: stats(snapMs), snapshotBytes: bytes, awakeAtEnd: awake };
}

export async function runAll(RAPIER, { ticks = 3600, toys = 150, log = () => {} } = {}) {
  const started = now();
  log(`reference run: ${ticks} ticks, ${toys} toys`);
  const ref = referenceRun(RAPIER, ticks, toys);

  // 60 ms one way is 3.6 ticks at 60 Hz: call it 4, plus 0 to 2 ticks of jitter.
  const delayFor = (from, to, t) => 4 + (mix32(from * 7 + to * 13 + 1, t) % 3);
  const peers = [];
  for (let p = 0; p < PLAYERS; p++) {
    log(`peer ${p} with rollback`);
    peers.push(peerRun(RAPIER, p, ticks, toys, delayFor));
  }

  // Same again with 2 ticks (33 ms) of input delay, which rollback games often add:
  // your own press lands 2 ticks later, so remote guesses go wrong less far back.
  const delayed = (from, to, t) => Math.max(0, delayFor(from, to, t) - 2);
  log("peer 0 again with 2 ticks of input delay");
  const withInputDelay = peerRun(RAPIER, 0, ticks, toys, delayed);

  let mismatches = 0;
  for (const pr of peers.concat([withInputDelay])) {
    for (const [c, h] of Object.entries(ref.checks)) if (pr.checks[c] !== h) mismatches++;
    if (pr.finalHash !== ref.finalHash) mismatches++;
  }

  log("storm: rewind 8 ticks every frame");
  const storm = stormRun(RAPIER, toys, 8, 600);
  log("scale: 150 / 300 / 500 toys");
  const scale = [150, 300, 500].map((n) => scaleRun(RAPIER, n, 600));

  // Second identical reference run in the same process: same world twice, same answer?
  const ref2 = referenceRun(RAPIER, ticks, toys);

  return {
    ticks,
    toys,
    referenceFinalHash: ref.finalHash,
    referenceCheckHashes: ref.checks,
    referenceSnapshotHash: hashBytes(ref.snapshotSample),
    secondRunSame: ref2.finalHash === ref.finalHash,
    referenceStepMs: stats(ref.stepMs),
    awakeToysAtChecks: ref.awake,
    snapshotBytes: ref.snapshotBytes,
    peers,
    withInputDelay,
    peersMatchReference: mismatches === 0,
    hashMismatches: mismatches,
    storm,
    scale,
    totalSeconds: Math.round((now() - started) / 100) / 10,
  };
}
