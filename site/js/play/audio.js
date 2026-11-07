// Sounds made on the spot with WebAudio: no sound files, so a world plays the
// same anywhere and the export stays small. Each game event has a sound; a
// sound that happens somewhere is quieter further away and panned to its side.

export function createAudio() {
  let ctx = null;
  let master = null;
  let volume = 0.7;
  let noise = null;
  let quietUntil = 0;

  function ensure() {
    if (ctx) return ctx;
    const AC = globalThis.AudioContext || globalThis.webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
    master = ctx.createGain();
    master.gain.value = volume;
    const comp = ctx.createDynamicsCompressor();
    master.connect(comp).connect(ctx.destination);
    const len = ctx.sampleRate;
    noise = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = noise.getChannelData(0);
    let seed = 1;
    for (let i = 0; i < len; i++) {
      seed = (seed * 16807) % 2147483647;
      data[i] = (seed / 2147483647) * 2 - 1;
    }
    return ctx;
  }

  function out(gain, pan) {
    const g = ctx.createGain();
    g.gain.value = gain;
    if (ctx.createStereoPanner) {
      const p = ctx.createStereoPanner();
      p.pan.value = Math.max(-1, Math.min(1, pan));
      g.connect(p).connect(master);
    } else g.connect(master);
    return g;
  }

  function tone(dest, { type = 'sine', from = 440, to = from, at = 0, dur = 0.15, gain = 0.4, attack = 0.005 }) {
    const t = ctx.currentTime + at;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(from, t);
    if (to !== from) o.frequency.exponentialRampToValueAtTime(Math.max(20, to), t + dur);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(dest);
    o.start(t);
    o.stop(t + dur + 0.02);
  }

  function hiss(dest, { at = 0, dur = 0.2, gain = 0.4, freq = 1200, to = freq, q = 1, type = 'bandpass' }) {
    const t = ctx.currentTime + at;
    const src = ctx.createBufferSource();
    src.buffer = noise;
    src.playbackRate.value = 1;
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.Q.value = q;
    f.frequency.setValueAtTime(freq, t);
    if (to !== freq) f.frequency.exponentialRampToValueAtTime(Math.max(30, to), t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(f).connect(g).connect(dest);
    src.start(t, Math.random() * 0.5);
    src.stop(t + dur + 0.05);
  }

  const SOUNDS = {
    swing: (d) => hiss(d, { dur: 0.16, gain: 0.25, freq: 600, to: 2400, q: 2 }),
    shot: (d) => { hiss(d, { dur: 0.12, gain: 0.6, freq: 2500, to: 400, q: 0.8 }); tone(d, { type: 'square', from: 180, to: 60, dur: 0.08, gain: 0.25 }); },
    landed: (d) => { tone(d, { from: 140, to: 60, dur: 0.12, gain: 0.5 }); hiss(d, { dur: 0.08, gain: 0.3, freq: 900, q: 1 }); },
    hit: (d) => { tone(d, { from: 160, to: 70, dur: 0.12, gain: 0.45 }); hiss(d, { dur: 0.07, gain: 0.25, freq: 1400, q: 1 }); },
    hurt: (d) => { tone(d, { type: 'triangle', from: 110, to: 50, dur: 0.22, gain: 0.6 }); hiss(d, { dur: 0.15, gain: 0.3, freq: 500, q: 0.7 }); },
    parry: (d) => { tone(d, { from: 1500, dur: 0.5, gain: 0.35 }); tone(d, { from: 2260, dur: 0.35, gain: 0.2 }); hiss(d, { dur: 0.06, gain: 0.4, freq: 4000, q: 1 }); },
    kill: (d) => { tone(d, { type: 'sawtooth', from: 220, to: 40, dur: 0.4, gain: 0.25 }); hiss(d, { dur: 0.25, gain: 0.3, freq: 700, to: 200 }); },
    boom: (d) => { hiss(d, { dur: 0.9, gain: 0.9, freq: 400, to: 60, q: 0.5, type: 'lowpass' }); tone(d, { from: 80, to: 30, dur: 0.7, gain: 0.7 }); },
    break: (d) => { hiss(d, { dur: 0.45, gain: 0.5, freq: 900, to: 200, q: 0.6 }); tone(d, { from: 90, to: 50, dur: 0.3, gain: 0.4 }); },
    jump: (d) => tone(d, { from: 220, to: 330, dur: 0.1, gain: 0.08 }),
    pickup: (d) => { tone(d, { from: 880, dur: 0.12, gain: 0.25 }); tone(d, { from: 1320, at: 0.07, dur: 0.18, gain: 0.25 }); },
    door: (d) => { tone(d, { type: 'sawtooth', from: 70, to: 90, dur: 0.6, gain: 0.12 }); hiss(d, { dur: 0.6, gain: 0.08, freq: 300, q: 2 }); },
    clank: (d) => { tone(d, { type: 'square', from: 620, to: 500, dur: 0.12, gain: 0.15 }); tone(d, { from: 1830, dur: 0.18, gain: 0.08 }); },
    ding: (d) => { tone(d, { from: 1046, dur: 0.6, gain: 0.3 }); tone(d, { from: 2093, dur: 0.3, gain: 0.1 }); },
    spring: (d) => { tone(d, { from: 180, to: 720, dur: 0.18, gain: 0.3 }); tone(d, { from: 720, to: 360, at: 0.16, dur: 0.2, gain: 0.15 }); },
    tell: (d) => tone(d, { type: 'triangle', from: 300, to: 520, dur: 0.18, gain: 0.12 }),
    alert: (d) => { tone(d, { type: 'square', from: 330, dur: 0.08, gain: 0.08 }); tone(d, { type: 'square', from: 440, at: 0.09, dur: 0.1, gain: 0.08 }); },
    stage: (d) => { tone(d, { type: 'sawtooth', from: 55, to: 110, dur: 1.2, gain: 0.3, attack: 0.2 }); hiss(d, { dur: 1, gain: 0.2, freq: 200, to: 900 }); },
    slam: (d) => { tone(d, { from: 70, to: 30, dur: 0.5, gain: 0.8 }); hiss(d, { dur: 0.4, gain: 0.5, freq: 300, to: 80, type: 'lowpass' }); },
    throw: (d) => hiss(d, { dur: 0.2, gain: 0.2, freq: 400, to: 1600, q: 1.5 }),
    grab: (d) => tone(d, { from: 300, to: 260, dur: 0.06, gain: 0.12 }),
    use: (d) => tone(d, { type: 'square', from: 520, dur: 0.05, gain: 0.08 }),
    press: (d) => tone(d, { type: 'square', from: 300, dur: 0.05, gain: 0.08 }),
    spawn: (d) => { hiss(d, { dur: 0.5, gain: 0.25, freq: 200, to: 2000, q: 3 }); },
    launch: (d) => { hiss(d, { dur: 0.35, gain: 0.4, freq: 300, to: 2400, q: 1 }); tone(d, { from: 200, to: 600, dur: 0.3, gain: 0.2 }); },
    score: (d) => tone(d, { type: 'square', from: 990, dur: 0.07, gain: 0.08 }),
    unlock: (d) => { tone(d, { type: 'square', from: 400, dur: 0.06, gain: 0.12 }); tone(d, { from: 800, at: 0.07, dur: 0.2, gain: 0.2 }); },
    splat: (d) => hiss(d, { dur: 0.15, gain: 0.25, freq: 500, q: 0.8 }),
    revived: (d) => { tone(d, { from: 440, dur: 0.15, gain: 0.2 }); tone(d, { from: 660, at: 0.12, dur: 0.25, gain: 0.2 }); },
    down: (d) => tone(d, { type: 'triangle', from: 330, to: 110, dur: 0.6, gain: 0.3 }),
    clear: (d) => [523, 659, 784].forEach((f, i) => tone(d, { from: f, at: i * 0.12, dur: 0.3, gain: 0.2 })),
    won: (d) => [523, 659, 784, 1046].forEach((f, i) => tone(d, { type: 'triangle', from: f, at: i * 0.15, dur: 0.5, gain: 0.25 })),
    over: (d) => [392, 330, 262].forEach((f, i) => tone(d, { type: 'triangle', from: f, at: i * 0.2, dur: 0.5, gain: 0.2 })),
    // The Sound part's choices.
    chime: (d) => [784, 1046, 1318].forEach((f, i) => tone(d, { from: f, at: i * 0.08, dur: 0.4, gain: 0.18 })),
    alarm: (d) => [0, 0.25, 0.5].forEach((at) => tone(d, { type: 'square', from: 880, to: 660, at, dur: 0.22, gain: 0.12 })),
    blast: (d) => { hiss(d, { dur: 0.6, gain: 0.6, freq: 600, to: 100, q: 0.5 }); tone(d, { from: 100, to: 40, dur: 0.5, gain: 0.5 }); },
    fanfare: (d) => [523, 659, 784, 1046, 784, 1046].forEach((f, i) => tone(d, { type: 'square', from: f, at: i * 0.11, dur: 0.18, gain: 0.08 })),
  };
  SOUNDS.effect = SOUNDS.spawn;

  return {
    unlock() {
      const c = ensure();
      if (c && c.state === 'suspended') c.resume();
    },
    setVolume(v) {
      volume = v;
      if (master) master.gain.value = v;
    },
    // A quiet stretch: nothing plays (a boss's end).
    quiet(seconds) {
      if (!ensure()) return;
      quietUntil = ctx.currentTime + seconds;
    },
    // Plays the sound for an event, heard from the listener's place.
    play(name, at = null, listener = null) {
      if (!ensure() || ctx.state !== 'running' || volume <= 0) return;
      if (ctx.currentTime < quietUntil && name !== 'kill') return;
      const fn = SOUNDS[name];
      if (!fn) return;
      let gain = 1;
      let pan = 0;
      if (at && listener) {
        const dx = at.x - listener.x;
        const dy = at.y - listener.y;
        const d = Math.hypot(dx, dy);
        gain = 1 / (1 + d * 0.12);
        if (d > 0.5) {
          // Right of the listener is +y when facing +x (the engine's way).
          const right = -Math.sin(listener.yaw) * dx + Math.cos(listener.yaw) * dy;
          pan = (right / d) * 0.8;
        }
      }
      if (gain < 0.04) return;
      fn(out(gain, pan));
    },
  };
}
