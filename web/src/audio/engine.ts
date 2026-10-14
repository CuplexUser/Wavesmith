// Game audio, all synthesized with WebAudio (no samples to download).
//
// - A quiet ambient pad in the level's key.
// - A "probe" voice that follows the first goal: its brightness and loudness grow with the
//   reading, it pulses in time with the actual wave arriving at the target, and its pitch
//   climbs a pentatonic scale as the goal gets closer.
// - Light levels use a glassy, shimmering voice instead; silence goals use filtered noise that
//   calms as the zone goes quiet.
// - Short sounds for picking up, placing, moving, removing, and invalid moves, voiced per piece
//   material (metal ping, stone thunk, foam thud, glass chime).
// - Milestone notes as goals fill, and a fanfare that grows with the star count.

import type { Item } from '../types';

export type VoiceKind = 'sound' | 'light' | 'silence';

/** Semitone offsets of a major pentatonic scale over two octaves. */
const PENTATONIC = [0, 2, 4, 7, 9, 12, 14, 16, 19, 21, 24];

const midiToHz = (m: number) => 440 * Math.pow(2, (m - 69) / 12);

/** A short exponentially decaying impulse response, generated once, for the reverb. */
function makeImpulse(ctx: AudioContext, seconds: number, decay: number): AudioBuffer {
  const rate = ctx.sampleRate;
  const len = Math.floor(rate * seconds);
  const buf = ctx.createBuffer(2, len, rate);
  for (let ch = 0; ch < 2; ch++) {
    const data = buf.getChannelData(ch);
    let seed = 1234 + ch * 777;
    for (let i = 0; i < len; i++) {
      // Small LCG so the impulse is the same every time.
      seed = (seed * 1664525 + 1013904223) >>> 0;
      const noise = seed / 2 ** 31 - 1;
      data[i] = noise * Math.pow(1 - i / len, decay);
    }
  }
  return buf;
}

export class AudioEngine {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private dry: GainNode | null = null;
  private wet: GainNode | null = null;
  private noiseBuf: AudioBuffer | null = null;

  // Probe voice.
  private voiceGain: GainNode | null = null;
  private voiceFilter: BiquadFilterNode | null = null;
  private voiceOscs: OscillatorNode[] = [];
  private voiceTypes: OscillatorType[] = [];
  private shimmer: GainNode | null = null;
  private noiseGain: GainNode | null = null;
  private noiseFilter: BiquadFilterNode | null = null;

  // Ambient pad.
  private padGain: GainNode | null = null;
  private padOscs: OscillatorNode[] = [];

  private kind: VoiceKind = 'sound';
  private root = 57; // A3
  private lastStep = -1;
  private lastMilestone = 0;
  muted = false;
  /** Master volume, 0..1. */
  volume = 0.9;

  get running(): boolean {
    return this.ctx?.state === 'running';
  }

  /** Must be called from a user gesture (browsers block audio until then). */
  start(): void {
    if (this.ctx) {
      if (this.ctx.state !== 'running') void this.ctx.resume();
      return;
    }
    const Ctor =
      window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return;
    const ctx = new Ctor();
    this.ctx = ctx;

    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -18;
    comp.ratio.value = 3;
    this.master = ctx.createGain();
    this.master.gain.value = this.muted ? 0 : this.volume;
    comp.connect(this.master).connect(ctx.destination);

    this.dry = ctx.createGain();
    this.dry.connect(comp);
    const reverb = ctx.createConvolver();
    reverb.buffer = makeImpulse(ctx, 2.4, 2.8);
    this.wet = ctx.createGain();
    this.wet.gain.value = 0.32;
    this.wet.connect(reverb).connect(comp);

    // Noise source shared by silence goals and some effects.
    const n = ctx.sampleRate * 2;
    this.noiseBuf = ctx.createBuffer(1, n, ctx.sampleRate);
    const nd = this.noiseBuf.getChannelData(0);
    let last = 0;
    for (let i = 0; i < n; i++) {
      // Gently low-passed white noise (closer to pink).
      last = 0.97 * last + 0.03 * (Math.random() * 2 - 1);
      nd[i] = last * 6;
    }

    this.buildVoice();
    this.buildPad();
  }

  private send(node: AudioNode, wet = 1): void {
    node.connect(this.dry!);
    if (wet > 0) {
      const g = this.ctx!.createGain();
      g.gain.value = wet;
      node.connect(g).connect(this.wet!);
    }
  }

  private buildVoice(): void {
    const ctx = this.ctx!;
    this.voiceGain = ctx.createGain();
    this.voiceGain.gain.value = 0;
    this.voiceFilter = ctx.createBiquadFilter();
    this.voiceFilter.type = 'lowpass';
    this.voiceFilter.frequency.value = 600;
    this.voiceFilter.Q.value = 2;
    this.shimmer = ctx.createGain();
    this.shimmer.gain.value = 1;
    this.voiceFilter.connect(this.shimmer).connect(this.voiceGain);
    this.send(this.voiceGain, 0.8);
    // Two slightly detuned saws and a sine an octave down.
    const specs: [OscillatorType, number, number][] = [
      ['sawtooth', -6, 0.25],
      ['sawtooth', 6, 0.25],
      ['sine', -1200, 0.6],
      ['triangle', 1200, 0.12],
    ];
    for (const [type, detune, level] of specs) {
      const o = ctx.createOscillator();
      o.type = type;
      o.detune.value = detune;
      const g = ctx.createGain();
      g.gain.value = level;
      o.connect(g).connect(this.voiceFilter);
      o.start();
      this.voiceOscs.push(o);
      this.voiceTypes.push(type);
    }
    // Noise voice for silence goals.
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    src.loop = true;
    this.noiseFilter = ctx.createBiquadFilter();
    this.noiseFilter.type = 'bandpass';
    this.noiseFilter.frequency.value = 900;
    this.noiseFilter.Q.value = 0.7;
    this.noiseGain = ctx.createGain();
    this.noiseGain.gain.value = 0;
    src.connect(this.noiseFilter).connect(this.noiseGain);
    this.send(this.noiseGain, 0.4);
    src.start();
  }

  private buildPad(): void {
    const ctx = this.ctx!;
    this.padGain = ctx.createGain();
    this.padGain.gain.value = 0;
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 700;
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 0.07;
    const lfoGain = ctx.createGain();
    lfoGain.gain.value = 300;
    lfo.connect(lfoGain).connect(filter.frequency);
    lfo.start();
    filter.connect(this.padGain);
    this.send(this.padGain, 1);
    for (const [interval, detune] of [
      [0, -4],
      [7, 3],
      [12, 5],
      [16, -3],
    ] as const) {
      const o = ctx.createOscillator();
      o.type = 'triangle';
      o.frequency.value = midiToHz(this.root - 12 + interval);
      o.detune.value = detune;
      o.connect(filter);
      o.start();
      this.padOscs.push(o);
    }
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    this.applyGain();
  }

  setVolume(volume: number): void {
    this.volume = Math.max(0, Math.min(1, volume));
    this.applyGain();
  }

  private applyGain(): void {
    const g = this.muted ? 0 : this.volume;
    if (this.ctx && this.master) this.master.gain.setTargetAtTime(g, this.ctx.currentTime, 0.05);
  }

  /** Sets the key and voice for a level and fades the pad in. `seed` varies the key per level. */
  enterLevel(kind: VoiceKind, seed: number): void {
    this.kind = kind;
    // Walk the circle of fifths so neighboring levels sound related but not identical.
    this.root = 50 + ((seed * 7) % 12);
    this.lastStep = -1;
    this.lastMilestone = 0;
    const ctx = this.ctx;
    if (!ctx) return;
    const t = ctx.currentTime;
    const pad = [0, 7, 12, 16];
    this.padOscs.forEach((o, i) => o.frequency.setTargetAtTime(midiToHz(this.root - 12 + pad[i]!), t, 0.4));
    this.padGain?.gain.setTargetAtTime(0.045, t, 1.5);
    // Light gets a pure, glassy tone; sound keeps its warmer saws.
    this.voiceOscs.forEach((o, i) => {
      const type = this.voiceTypes[i]!;
      o.type = kind === 'light' && type === 'sawtooth' ? 'sine' : type;
    });
  }

  leaveLevel(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const t = ctx.currentTime;
    this.padGain?.gain.setTargetAtTime(0, t, 0.3);
    this.voiceGain?.gain.setTargetAtTime(0, t, 0.08);
    this.noiseGain?.gain.setTargetAtTime(0, t, 0.08);
  }

  /**
   * Called every frame with the first goal's reading. `level` is the smoothed reading over its
   * threshold (1 = at threshold); `wave` is the instantaneous field at the target over the
   * threshold, which makes the tone pulse with the wave.
   */
  update(goalKind: 'focus' | 'silence' | 'other', level: number, wave: number): void {
    const ctx = this.ctx;
    if (!ctx || !this.voiceGain || !this.voiceFilter || !this.noiseGain || !this.noiseFilter) return;
    const t = ctx.currentTime;
    const x = Math.max(0, Math.min(1.5, level));
    if (goalKind === 'silence') {
      // Hiss when loud, calm when quiet.
      this.voiceGain.gain.setTargetAtTime(0, t, 0.1);
      this.noiseGain.gain.setTargetAtTime(0.05 * Math.min(1.5, x), t, 0.1);
      this.noiseFilter.frequency.setTargetAtTime(400 + 1600 * Math.min(1, x), t, 0.1);
      return;
    }
    this.noiseGain.gain.setTargetAtTime(0, t, 0.1);
    // Pitch climbs the scale as the reading approaches the goal.
    const stepIdx = Math.min(PENTATONIC.length - 1, Math.floor(x * 6));
    if (stepIdx !== this.lastStep) {
      this.lastStep = stepIdx;
      const f = midiToHz(this.root + 12 + PENTATONIC[stepIdx]!);
      for (const o of this.voiceOscs) o.frequency.setTargetAtTime(f, t, 0.06);
    }
    this.voiceFilter.frequency.setTargetAtTime(350 + 2600 * Math.min(1, x), t, 0.08);
    // Loudness follows the reading; the live wave adds a pulse at the wave's own frequency.
    const pulse = 0.55 + 0.45 * Math.min(1, Math.abs(wave));
    const base = 0.11 * x * x;
    this.voiceGain.gain.setTargetAtTime(base * pulse, t, 0.03);
    if (this.shimmer) {
      // Light shimmers with a fast tremolo.
      const s = this.kind === 'light' ? 0.75 + 0.25 * Math.sin(t * 2 * Math.PI * 7) : 1;
      this.shimmer.gain.setTargetAtTime(s, t, 0.01);
    }
    // Milestone notes at 50%, 80%, and 100%.
    const milestone = x >= 1 ? 3 : x >= 0.8 ? 2 : x >= 0.5 ? 1 : 0;
    if (milestone > this.lastMilestone) this.pluck(this.root + 24 + PENTATONIC[milestone + 1]!, 0.09, 0.9);
    this.lastMilestone = Math.max(this.lastMilestone, milestone);
    if (x < 0.3) this.lastMilestone = 0;
  }

  silence(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    this.voiceGain?.gain.setTargetAtTime(0, ctx.currentTime, 0.08);
    this.noiseGain?.gain.setTargetAtTime(0, ctx.currentTime, 0.08);
  }

  // ---------- One-shot sounds ----------

  /** A plucked note with a soft attack and exponential decay. */
  private pluck(midi: number, gain: number, decay: number, type: OscillatorType = 'triangle', at = 0): void {
    const ctx = this.ctx;
    if (!ctx || this.muted) return;
    const t = ctx.currentTime + at;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = type;
    o.frequency.value = midiToHz(midi);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(gain, t + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t + decay);
    o.connect(g);
    this.send(g, 0.7);
    o.start(t);
    o.stop(t + decay + 0.05);
  }

  /** A metallic ping: a sine with inharmonic partials (FM-free bell). */
  private bell(freq: number, gain: number, decay: number, at = 0): void {
    const ctx = this.ctx;
    if (!ctx || this.muted) return;
    const t = ctx.currentTime + at;
    for (const [ratio, level] of [
      [1, 1],
      [2.76, 0.45],
      [5.4, 0.22],
      [8.9, 0.1],
    ] as const) {
      // Skip partials above what the output can reproduce.
      if (freq * ratio > ctx.sampleRate * 0.45) continue;
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.frequency.value = freq * ratio;
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(gain * level, t + 0.004);
      g.gain.exponentialRampToValueAtTime(0.0001, t + decay / ratio ** 0.5);
      o.connect(g);
      this.send(g, 0.8);
      o.start(t);
      o.stop(t + decay + 0.05);
    }
  }

  /** A filtered noise burst: thuds, clicks, and whooshes. */
  private burst(from: number, to: number, gain: number, dur: number, q = 1): void {
    const ctx = this.ctx;
    if (!ctx || !this.noiseBuf || this.muted) return;
    const t = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.Q.value = q;
    f.frequency.setValueAtTime(from, t);
    f.frequency.exponentialRampToValueAtTime(to, t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(f).connect(g);
    this.send(g, 0.3);
    src.start(t, Math.random());
    src.stop(t + dur + 0.05);
  }

  /** A pitched thunk that drops quickly, like setting down something heavy. */
  private thunk(from: number, to: number, gain: number, dur: number): void {
    const ctx = this.ctx;
    if (!ctx || this.muted) return;
    const t = ctx.currentTime;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = 'sine';
    o.frequency.setValueAtTime(from, t);
    o.frequency.exponentialRampToValueAtTime(to, t + dur);
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g);
    this.send(g, 0.2);
    o.start(t);
    o.stop(t + dur + 0.05);
  }

  /** The material voice of a piece. */
  private materialHit(item: Item | undefined, strength: number): void {
    const root = midiToHz(this.root + 24);
    switch (item?.kind) {
      case 'reflector':
        this.bell(root * 2, 0.07 * strength, 0.9);
        break;
      case 'wall':
        this.thunk(170, 70, 0.22 * strength, 0.16);
        this.burst(2500, 900, 0.05 * strength, 0.04, 2);
        break;
      case 'absorber':
        this.burst(500, 160, 0.25 * strength, 0.14, 0.8);
        break;
      case 'lens':
      case 'prism':
      case 'slab':
        this.bell(root * 3, 0.05 * strength, 1.3);
        this.bell(root * 4.5, 0.025 * strength, 1.0, 0.03);
        break;
      case 'emitter':
        this.pluck(this.root + 24, 0.08 * strength, 0.3, 'square');
        break;
      case 'resonator':
        this.bell(root, 0.08 * strength, 1.6);
        break;
      default:
        this.burst(3000, 2000, 0.05 * strength, 0.03, 3);
    }
  }

  /** Feedback for editing actions. */
  edit(kind: 'select' | 'place' | 'move' | 'remove' | 'invalid' | 'pickup', item?: Item): void {
    switch (kind) {
      case 'select':
        this.burst(4200, 3200, 0.04, 0.03, 4);
        break;
      case 'pickup':
        this.burst(1800, 2600, 0.04, 0.05, 2);
        break;
      case 'place':
        this.materialHit(item, 1);
        break;
      case 'move':
        this.materialHit(item, 0.6);
        break;
      case 'remove':
        this.burst(2400, 200, 0.12, 0.28, 1.2);
        break;
      case 'invalid':
        this.pluck(this.root - 1, 0.07, 0.12, 'square');
        this.pluck(this.root - 1, 0.07, 0.12, 'square', 0.13);
        break;
    }
  }

  /** A short tick for UI buttons. */
  click(): void {
    this.burst(5200, 4000, 0.025, 0.02, 5);
  }

  /** Solve fanfare: more stars, longer and brighter. */
  fanfare(stars: number): void {
    const notes = [0, 4, 7, 12, 16, 19, 24].slice(0, 3 + stars + (stars === 3 ? 1 : 0));
    notes.forEach((n, i) => this.pluck(this.root + 12 + n, 0.12, 1.4, 'triangle', i * 0.09));
    if (stars === 3) {
      [0, 0.12, 0.24].forEach((d, i) => this.bell(midiToHz(this.root + 48 + PENTATONIC[i * 2]!), 0.03, 1.2, 0.5 + d));
    }
  }

  /** Two falling notes when time runs out. */
  timeout(): void {
    this.pluck(this.root + 7, 0.09, 0.6, 'triangle');
    this.pluck(this.root + 3, 0.09, 0.9, 'triangle', 0.22);
  }

  suspend(): void {
    void this.ctx?.suspend();
  }
}
