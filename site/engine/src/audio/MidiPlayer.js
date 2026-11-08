/**
 * MidiPlayer.js - Standard MIDI File (SMF) parser and real-time synthesizer
 * Utilizing Web Audio API look-ahead scheduling for piano and string instruments.
 */

class MidiFileParser {
  constructor(arrayBuffer) {
    this.buffer = arrayBuffer;
    this.view = new DataView(arrayBuffer);
    this.offset = 0;
    this.division = 96;
    this.notes = [];
  }

  parse() {
    const headerType = this.readString(4);
    if (headerType !== 'MThd') {
      throw new Error('Not a valid MIDI file: missing MThd header');
    }
    const headerLength = this.readUint32();
    const format = this.readUint16();
    const numTracks = this.readUint16();
    const division = this.readUint16();
    
    if (division & 0x8000) {
      this.division = 96; // Fallback
    } else {
      this.division = division & 0x7FFF;
    }

    const trackOffsets = [];
    for (let i = 0; i < numTracks; i++) {
      if (this.offset >= this.buffer.byteLength) break;
      const trackType = this.readString(4);
      if (trackType !== 'MTrk') {
        const length = this.readUint32();
        this.offset += length;
        continue;
      }
      const trackLength = this.readUint32();
      trackOffsets.push({ offset: this.offset, length: trackLength });
      this.offset += trackLength;
    }

    const allEvents = [];
    trackOffsets.forEach((trackInfo) => {
      let offset = trackInfo.offset;
      const endOffset = trackInfo.offset + trackInfo.length;
      let tick = 0;
      let runningStatus = 0;

      while (offset < endOffset) {
        const vlq = this.readVarLengthFrom(offset);
        offset += vlq.bytesRead;
        tick += vlq.val;

        let status = this.view.getUint8(offset);
        if (status < 0x80) {
          status = runningStatus;
        } else {
          offset++;
          if (status < 0xF0) {
            runningStatus = status;
          }
        }

        const eventType = status & 0xF0;
        const channel = status & 0x0F;

        if (eventType === 0x80) {
          const note = this.view.getUint8(offset++);
          const velocity = this.view.getUint8(offset++);
          allEvents.push({ tick, type: 'note_off', channel, note, velocity });
        } else if (eventType === 0x90) {
          const note = this.view.getUint8(offset++);
          const velocity = this.view.getUint8(offset++);
          if (velocity === 0) {
            allEvents.push({ tick, type: 'note_off', channel, note, velocity });
          } else {
            allEvents.push({ tick, type: 'note_on', channel, note, velocity });
          }
        } else if (eventType === 0xA0) {
          offset += 2;
        } else if (eventType === 0xB0) {
          const controller = this.view.getUint8(offset++);
          const val = this.view.getUint8(offset++);
          allEvents.push({ tick, type: 'control_change', channel, controller, val });
        } else if (eventType === 0xC0) {
          const program = this.view.getUint8(offset++);
          allEvents.push({ tick, type: 'program_change', channel, program });
        } else if (eventType === 0xD0) {
          offset++;
        } else if (eventType === 0xE0) {
          offset += 2;
        } else if (status === 0xFF) {
          const metaType = this.view.getUint8(offset++);
          const metaLengthVlq = this.readVarLengthFrom(offset);
          offset += metaLengthVlq.bytesRead;
          const metaLength = metaLengthVlq.val;

          if (metaType === 0x51) {
            const tempo = (this.view.getUint8(offset) << 16) |
                          (this.view.getUint8(offset + 1) << 8) |
                          this.view.getUint8(offset + 2);
            allEvents.push({ tick, type: 'tempo', tempo });
          }
          offset += metaLength;
        } else if (status === 0xF0 || status === 0xF7) {
          const sysLengthVlq = this.readVarLengthFrom(offset);
          offset += sysLengthVlq.bytesRead;
          offset += sysLengthVlq.val;
        }
      }
    });

    allEvents.sort((a, b) => a.tick - b.tick);

    let currentTempo = 500000; // Default 120 BPM
    let currentTick = 0;
    let currentTime = 0.0;
    const channelPrograms = new Array(16).fill(0);
    const activeNotes = Array.from({ length: 16 }, () => new Map());

    allEvents.forEach(ev => {
      const deltaTicks = ev.tick - currentTick;
      if (deltaTicks > 0) {
        currentTime += deltaTicks * (currentTempo / 1000000.0 / this.division);
        currentTick = ev.tick;
      }

      if (ev.type === 'tempo') {
        currentTempo = ev.tempo;
      } else if (ev.type === 'program_change') {
        channelPrograms[ev.channel] = ev.program;
      } else if (ev.type === 'note_on') {
        const program = channelPrograms[ev.channel];
        const instrument = (program >= 40 && program <= 55) ? 'strings' : 'piano';
        
        if (activeNotes[ev.channel].has(ev.note)) {
          const noteObj = activeNotes[ev.channel].get(ev.note);
          noteObj.duration = currentTime - noteObj.start;
          this.notes.push(noteObj);
        }

        activeNotes[ev.channel].set(ev.note, {
          start: currentTime,
          duration: -1,
          pitch: ev.note,
          velocity: ev.velocity,
          instrument
        });
      } else if (ev.type === 'note_off') {
        if (activeNotes[ev.channel].has(ev.note)) {
          const noteObj = activeNotes[ev.channel].get(ev.note);
          noteObj.duration = Math.max(0.05, currentTime - noteObj.start);
          this.notes.push(noteObj);
          activeNotes[ev.channel].delete(ev.note);
        }
      }
    });

    activeNotes.forEach((channelMap) => {
      channelMap.forEach(noteObj => {
        noteObj.duration = 1.0;
        this.notes.push(noteObj);
      });
    });

    this.notes.sort((a, b) => a.start - b.start);
    return this.notes;
  }

  readString(len) {
    let str = '';
    for (let i = 0; i < len; i++) {
      str += String.fromCharCode(this.view.getUint8(this.offset++));
    }
    return str;
  }

  readUint32() {
    const val = this.view.getUint32(this.offset);
    this.offset += 4;
    return val;
  }

  readUint16() {
    const val = this.view.getUint16(this.offset);
    this.offset += 2;
    return val;
  }

  readVarLengthFrom(offset) {
    let val = 0;
    let bytesRead = 0;
    while (true) {
      const b = this.view.getUint8(offset + bytesRead);
      bytesRead++;
      val = (val << 7) | (b & 0x7f);
      if ((b & 0x80) === 0) break;
    }
    return { val, bytesRead };
  }
}

export class MidiPlayer {
  constructor(audioCtx) {
    this.ctx = audioCtx;
    this.destination = null; // Connect to AudioEngine's reverb/gain matrix
    
    // Playback state
    this.isPlaying = false;
    this.notes = [];
    this.nextNoteIndex = 0;
    this.audioStartTime = 0;
    this.playbackTime = 0;
    
    // User configuration
    this.tempoMultiplier = 1.0;
    // Music loudness belongs to AudioEngine.musicBusGain. This remains a
    // compatibility control for direct MidiPlayer users, but AudioEngine keeps
    // it at unity so the Music slider is never applied inside each note.
    this.volume = 1.0;

    // Scheduler properties
    this.schedulerTimerId = null;
    this.lookahead = 0.15; // Schedule 150ms in advance
    this.tickInterval = 50; // Run tick every 50ms
    
    // Tracks active synth voice node references for clean cleanup
    this.activeVoices = [];
  }

  loadMidi(arrayBuffer) {
    try {
      const parser = new MidiFileParser(arrayBuffer);
      this.notes = parser.parse();
      console.log(`[MidiPlayer] Loaded MIDI file successfully: ${this.notes.length} notes parsed.`);
      this.nextNoteIndex = 0;
      this.playbackTime = 0;
    } catch (e) {
      console.error('[MidiPlayer] Failed to parse MIDI file:', e);
      this.notes = [];
    }
  }

  play() {
    if (this.isPlaying) return;
    if (this.notes.length === 0) {
      console.warn('[MidiPlayer] No MIDI data loaded to play.');
      return;
    }

    this.isPlaying = true;
    this.audioStartTime = this.ctx.currentTime - (this.playbackTime / this.tempoMultiplier);
    this.schedulerTimerId = setInterval(() => this.schedulerTick(), this.tickInterval);
    console.log('[MidiPlayer] Playback started.');
  }

  stop() {
    if (!this.isPlaying) return;
    this.isPlaying = false;
    clearInterval(this.schedulerTimerId);
    this.schedulerTimerId = null;
    
    // Calculate current playback time
    this.playbackTime = (this.ctx.currentTime - this.audioStartTime) * this.tempoMultiplier;
    
    // Stop all active sound nodes immediately
    this.activeVoices.forEach(voice => {
      try {
        voice.oscs.forEach(osc => osc.stop());
      } catch (e) {}
    });
    this.activeVoices = [];
    console.log('[MidiPlayer] Playback stopped.');
  }

  reset() {
    this.stop();
    this.playbackTime = 0;
    this.nextNoteIndex = 0;
  }

  setTempo(multiplier) {
    this.tempoMultiplier = Math.max(0.5, Math.min(2.0, multiplier));
    if (this.isPlaying) {
      // Adjust audioStartTime to match new tempo scaling seamlessly
      const elapsedTicks = (this.ctx.currentTime - this.audioStartTime) * this.tempoMultiplier;
      this.audioStartTime = this.ctx.currentTime - (this.playbackTime / this.tempoMultiplier);
    }
  }

  setVolume(vol) {
    this.volume = Math.max(0.0, Math.min(1.0, vol));
  }

  schedulerTick() {
    if (!this.isPlaying) return;
    if (this.ctx.state === 'suspended') {
      this.audioStartTime = this.ctx.currentTime - (this.playbackTime / this.tempoMultiplier);
      return;
    }
    
    const now = this.ctx.currentTime;
    const currentPlayTime = (now - this.audioStartTime) * this.tempoMultiplier;
    this.playbackTime = currentPlayTime;
    
    const scheduleAheadTime = currentPlayTime + this.lookahead;
    
    while (this.nextNoteIndex < this.notes.length) {
      const note = this.notes[this.nextNoteIndex];
      if (note.start <= scheduleAheadTime) {
        // Schedule this note!
        const noteStartAudioTime = this.audioStartTime + (note.start / this.tempoMultiplier);
        const noteDurationAudioTime = note.duration / this.tempoMultiplier;
        
        this.synthesizeNote(note, noteStartAudioTime, noteDurationAudioTime);
        this.nextNoteIndex++;
      } else {
        break;
      }
    }
    
    // Loop the playlist composition
    if (this.nextNoteIndex >= this.notes.length) {
      const songDuration = this.notes[this.notes.length - 1].start + this.notes[this.notes.length - 1].duration;
      if (currentPlayTime >= songDuration + 1.0) { // 1 second buffer at end
        console.log('[MidiPlayer] Composition finished, looping...');
        this.reset();
        this.play();
      }
    }

    // Clean up expired voices
    this.activeVoices = this.activeVoices.filter(voice => voice.endTime > now);
  }

  midiToFreq(note) {
    return 440 * Math.pow(2, (note - 69) / 12);
  }

  synthesizeNote(note, startTime, duration) {
    // Add a lookahead safety margin (25ms) for parameter scheduling.
    // Under Proton/Wine, audio context latency can cause events scheduled at ctx.currentTime to be in the past,
    // causing V8/Chromium to drop the parameter ramps and mute the notes.
    const minStartTime = this.ctx.currentTime + 0.025;
    if (startTime < minStartTime) {
      startTime = minStartTime;
    }
    
    const freq = this.midiToFreq(note.pitch);
    const velocityFactor = note.velocity / 127.0;
    const dest = this.destination || this.ctx.destination;

    const oscs = [];
    const mainGain = this.ctx.createGain();
    mainGain.gain.setValueAtTime(0.0, startTime);

    if (note.instrument === 'strings') {
      // Chamber Strings Voice: detuned triangle waves with lowpass filter
      const osc1 = this.ctx.createOscillator();
      const osc2 = this.ctx.createOscillator();
      
      osc1.type = 'triangle';
      osc1.frequency.setValueAtTime(freq, startTime);
      osc1.detune.setValueAtTime(-10, startTime); // detune 10 cents down

      osc2.type = 'triangle';
      osc2.frequency.setValueAtTime(freq, startTime);
      osc2.detune.setValueAtTime(10, startTime); // detune 10 cents up
      
      const filter = this.ctx.createBiquadFilter();
      filter.type = 'lowpass';
      // Lowpass cutoff changes slightly based on pitch to keep string texture warm
      filter.frequency.setValueAtTime(freq * 2.5, startTime);
      
      osc1.connect(filter);
      osc2.connect(filter);
      filter.connect(mainGain);
      
      oscs.push(osc1, osc2);

      // ADSR Strings Envelope
      const attack = 0.18;
      const decay = 0.2;
      const release = 1.0;
      const sustainVol = 0.6 * velocityFactor * this.volume * 0.18;

      mainGain.gain.linearRampToValueAtTime(sustainVol, startTime + attack);
      mainGain.gain.setValueAtTime(sustainVol, startTime + duration);
      mainGain.gain.exponentialRampToValueAtTime(0.001, startTime + duration + release);

      osc1.start(startTime);
      osc2.start(startTime);
      
      const stopTime = startTime + duration + release;
      osc1.stop(stopTime);
      osc2.stop(stopTime);

    } else {
      // Classical Piano Voice: Additive synthesis mixing sine (fundamental) and triangle (attack brightness)
      const osc1 = this.ctx.createOscillator();
      const osc2 = this.ctx.createOscillator();
      
      osc1.type = 'sine';
      osc1.frequency.setValueAtTime(freq, startTime);
      
      osc2.type = 'triangle';
      osc2.frequency.setValueAtTime(freq * 2, startTime); // second harmonic
      
      const osc2Gain = this.ctx.createGain();
      // Brightness decays quickly for piano attack
      osc2Gain.gain.setValueAtTime(0.12 * velocityFactor, startTime);
      osc2Gain.gain.exponentialRampToValueAtTime(0.001, startTime + 0.15);
      
      osc1.connect(mainGain);
      osc2.connect(osc2Gain);
      osc2Gain.connect(mainGain);
      
      oscs.push(osc1, osc2);

      // Decay changes based on pitch (piano high notes decay faster)
      const pitchFactor = Math.max(0.1, 1.0 - (note.pitch / 120.0));
      const attack = 0.006;
      const decay = 1.2 * pitchFactor;
      const release = 0.8 * pitchFactor;
      const peakVol = 0.5 * velocityFactor * this.volume * 0.28;
      const sustainVol = peakVol * 0.15;

      mainGain.gain.linearRampToValueAtTime(peakVol, startTime + attack);
      mainGain.gain.exponentialRampToValueAtTime(sustainVol, startTime + attack + decay);
      mainGain.gain.setValueAtTime(sustainVol, startTime + duration);
      mainGain.gain.exponentialRampToValueAtTime(0.001, startTime + duration + release);

      osc1.start(startTime);
      osc2.start(startTime);
      
      const stopTime = startTime + duration + release;
      osc1.stop(stopTime);
      osc2.stop(stopTime);
    }

    mainGain.connect(dest);
    
    this.activeVoices.push({
      oscs,
      endTime: startTime + duration + 1.5
    });
  }
}
