// Level music, made on the spot with WebAudio like the sounds: a few short
// loops of bass, drums and a lead, scheduled a little ahead of the clock.
// No files, so it costs nothing to ship and plays the same anywhere.
//
//   const music = createMusic(ctx, destination)
//   music.play('pulse'), music.stop(fadeSeconds), music.setVolume(0..1)

const NOTE = (n) => 440 * 2 ** ((n - 69) / 12);

// Each track: tempo, steps (16ths) in the loop, and per step: bass note,
// lead note, and drums (k kick, s snare, h hat). null is a rest.
const TRACKS = {
  pulse: {
    bpm: 112,
    bass: [40, null, 40, null, 40, null, 43, null, 40, null, 40, null, 38, null, 38, 38],
    lead: [null, null, 64, null, null, 67, null, null, 64, null, null, 71, null, 69, null, null],
    drums: ['k', 'h', 'h', 'h', 's', 'h', 'k', 'h', 'k', 'h', 'h', 'h', 's', 'h', 'h', 'h'],
    leadWave: 'square',
    bassWave: 'sawtooth',
  },
  dread: {
    bpm: 70,
    bass: [33, null, null, null, null, null, null, null, 33, null, null, null, 34, null, null, null],
    lead: [null, null, null, null, 69, null, null, null, null, null, null, null, 68, null, null, null],
    drums: ['k', null, null, null, null, null, null, null, null, null, 'k', null, null, null, null, 'h'],
    leadWave: 'triangle',
    bassWave: 'sawtooth',
  },
  chase: {
    bpm: 150,
    bass: [38, 38, 50, 38, 38, 50, 38, 50, 41, 41, 53, 41, 36, 36, 48, 36],
    lead: [62, 65, 69, 65, 62, 65, 69, 72, 65, 69, 72, 69, 60, 64, 67, 64],
    drums: ['k', 'h', 's', 'h', 'k', 'k', 's', 'h', 'k', 'h', 's', 'h', 'k', 'h', 's', 's'],
    leadWave: 'square',
    bassWave: 'square',
  },
  calm: {
    bpm: 84,
    bass: [45, null, null, null, null, null, null, null, 41, null, null, null, null, null, null, null],
    lead: [69, null, 72, null, 76, null, null, null, 72, null, 69, null, 65, null, null, null],
    drums: [null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, 'h'],
    leadWave: 'sine',
    bassWave: 'triangle',
  },
};

export const TRACK_IDS = Object.keys(TRACKS);

export function createMusic(ctx, destination) {
  const bus = ctx.createGain();
  bus.gain.value = 0.5;
  bus.connect(destination);
  let volume = 0.5;
  let track = null;
  let name = 'none';
  let step = 0;
  let next = 0;
  let timer = 0;
  let noise = null;

  function noiseBuffer() {
    if (noise) return noise;
    noise = ctx.createBuffer(1, ctx.sampleRate / 2, ctx.sampleRate);
    const d = noise.getChannelData(0);
    let seed = 7;
    for (let i = 0; i < d.length; i++) {
      seed = (seed * 16807) % 2147483647;
      d[i] = (seed / 2147483647) * 2 - 1;
    }
    return noise;
  }

  function tone(freq, at, length, wave, gain, cutoff) {
    const o = ctx.createOscillator();
    o.type = wave;
    o.frequency.value = freq;
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = cutoff;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, at);
    g.gain.linearRampToValueAtTime(gain, at + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, at + length);
    o.connect(f).connect(g).connect(bus);
    o.start(at);
    o.stop(at + length + 0.05);
  }

  function drum(kind, at) {
    if (kind === 'k') {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.frequency.setValueAtTime(140, at);
      o.frequency.exponentialRampToValueAtTime(40, at + 0.12);
      g.gain.setValueAtTime(0.9, at);
      g.gain.exponentialRampToValueAtTime(0.0001, at + 0.2);
      o.connect(g).connect(bus);
      o.start(at);
      o.stop(at + 0.25);
      return;
    }
    const src = ctx.createBufferSource();
    src.buffer = noiseBuffer();
    const f = ctx.createBiquadFilter();
    f.type = kind === 'h' ? 'highpass' : 'bandpass';
    f.frequency.value = kind === 'h' ? 7000 : 1800;
    const g = ctx.createGain();
    const length = kind === 'h' ? 0.04 : 0.14;
    g.gain.setValueAtTime(kind === 'h' ? 0.18 : 0.45, at);
    g.gain.exponentialRampToValueAtTime(0.0001, at + length);
    src.connect(f).connect(g).connect(bus);
    src.start(at);
    src.stop(at + length + 0.02);
  }

  function schedule() {
    if (!track) return;
    const sixteenth = 60 / track.bpm / 4;
    while (next < ctx.currentTime + 0.2) {
      const i = step % track.bass.length;
      if (track.bass[i] !== null) tone(NOTE(track.bass[i]), next, sixteenth * 1.8, track.bassWave, 0.32, 700);
      if (track.lead[i] !== null) tone(NOTE(track.lead[i]), next, sixteenth * 1.5, track.leadWave, 0.12, 2600);
      if (track.drums[i]) drum(track.drums[i], next);
      step += 1;
      next += sixteenth;
    }
  }

  return {
    get playing() {
      return name;
    },
    play(id) {
      if (id === name) return;
      name = TRACKS[id] ? id : 'none';
      track = TRACKS[id] ?? null;
      clearInterval(timer);
      bus.gain.cancelScheduledValues(ctx.currentTime);
      bus.gain.setValueAtTime(volume, ctx.currentTime);
      if (!track) return;
      step = 0;
      next = ctx.currentTime + 0.08;
      schedule();
      timer = setInterval(schedule, 60);
    },
    stop(fade = 0.6) {
      clearInterval(timer);
      track = null;
      name = 'none';
      const now = ctx.currentTime;
      bus.gain.cancelScheduledValues(now);
      bus.gain.setValueAtTime(bus.gain.value, now);
      bus.gain.linearRampToValueAtTime(0, now + Math.max(0.01, fade));
    },
    setVolume(v) {
      volume = Math.max(0, Math.min(1, v));
      if (track) bus.gain.setValueAtTime(volume, ctx.currentTime);
    },
  };
}
