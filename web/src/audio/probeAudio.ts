// Turns the primary goal's probe reading into sound: a tone pitched from the source frequency
// whose loudness follows the measured amplitude, so resonance and focus are audible as a swell.

/** Maps a simulation frequency (Hz) to an audible pitch. 3 Hz lands on A4. */
export function audiblePitch(simFreq: number): number {
  return 440 * Math.pow(2, Math.log2(Math.max(0.25, simFreq) / 3) * 0.5);
}

export class ProbeAudio {
  private ctx: AudioContext | null = null;
  private osc: OscillatorNode | null = null;
  private overtone: OscillatorNode | null = null;
  private gain: GainNode | null = null;
  private master: GainNode | null = null;
  muted = false;

  /** Must be called from a user gesture (browsers block audio until then). */
  start(): void {
    if (this.ctx) {
      void this.ctx.resume();
      return;
    }
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return;
    const ctx = new Ctor();
    this.ctx = ctx;
    this.master = ctx.createGain();
    this.master.gain.value = this.muted ? 0 : 1;
    this.master.connect(ctx.destination);
    this.gain = ctx.createGain();
    this.gain.gain.value = 0;
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 1800;
    this.gain.connect(filter).connect(this.master);
    this.osc = ctx.createOscillator();
    this.osc.type = 'sine';
    this.osc.connect(this.gain);
    this.overtone = ctx.createOscillator();
    this.overtone.type = 'triangle';
    const soft = ctx.createGain();
    soft.gain.value = 0.18;
    this.overtone.connect(soft).connect(this.gain);
    this.osc.start();
    this.overtone.start();
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    if (this.ctx && this.master) {
      this.master.gain.setTargetAtTime(muted ? 0 : 1, this.ctx.currentTime, 0.05);
    }
  }

  /** `level` is the reading relative to its goal threshold (1 = at threshold). */
  update(simFreq: number, level: number): void {
    if (!this.ctx || !this.osc || !this.overtone || !this.gain) return;
    const t = this.ctx.currentTime;
    const f = audiblePitch(simFreq);
    this.osc.frequency.setTargetAtTime(f, t, 0.05);
    this.overtone.frequency.setTargetAtTime(f * 2, t, 0.05);
    const x = Math.max(0, Math.min(1.5, level));
    this.gain.gain.setTargetAtTime(0.12 * x * x, t, 0.12);
  }

  silence(): void {
    if (this.ctx && this.gain) this.gain.gain.setTargetAtTime(0, this.ctx.currentTime, 0.08);
  }

  /** A short rising arpeggio for a solved level. */
  chime(): void {
    const ctx = this.ctx;
    if (!ctx || !this.master) return;
    [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => {
      const t = ctx.currentTime + i * 0.09;
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = 'sine';
      o.frequency.value = f;
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(0.14, t + 0.015);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.7);
      o.connect(g).connect(this.master!);
      o.start(t);
      o.stop(t + 0.75);
    });
  }

  suspend(): void {
    void this.ctx?.suspend();
  }
}
