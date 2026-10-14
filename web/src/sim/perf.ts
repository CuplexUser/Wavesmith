// Frame and solver timing. Decides how many solver steps fit in a frame, whether light levels
// can run faster than real time, and when to drop the canvas resolution, so slow phones keep a
// smooth frame rate instead of stuttering.

/** Exponential moving average that starts from its first sample. */
class Ema {
  value = NaN;
  constructor(private readonly k: number) {}
  push(v: number): number {
    this.value = Number.isNaN(this.value) ? v : this.value + (v - this.value) * this.k;
    return this.value;
  }
}

export interface PerfReading {
  fps: number;
  /** Milliseconds per solver step (all channels). */
  msPerStep: number;
  /** Simulated seconds per real second over the last second or so. */
  simRate: number;
  /** Device pixel ratio the board renders at. */
  dpr: number;
  /** The run is falling behind the requested speed. */
  slow: boolean;
}

export class PerfMonitor {
  /** Milliseconds per frame the solver may use. */
  readonly simBudgetMs: number;
  private frame = new Ema(0.05);
  private step = new Ema(0.1);
  private rate = new Ema(0.05);
  private slowFrames = 0;
  /** Frames seen, so early (warm-up) frames don't trigger changes. */
  private frames = 0;
  dpr: number;

  constructor(
    readonly stepsPerSecond: number,
    maxDpr: number,
    simBudgetMs = 9,
  ) {
    this.dpr = maxDpr;
    this.simBudgetMs = simBudgetMs;
  }

  /** Records a frame: real time since the last one, steps taken, and their cost. */
  record(frameMs: number, steps: number, stepMs: number, requestedSpeed: number): void {
    if (!(frameMs > 0) || frameMs > 500) return; // Tab switches and stalls.
    this.frames++;
    this.frame.push(frameMs);
    if (steps > 0) this.step.push(stepMs / steps);
    const achieved = steps / this.stepsPerSecond / (frameMs / 1000);
    this.rate.push(achieved);
    this.slowFrames = requestedSpeed > 0 && achieved < requestedSpeed * 0.85 ? this.slowFrames + 1 : 0;
  }

  /** Steps that fit in the solver's share of a frame. */
  stepBudget(): number {
    const ms = this.step.value;
    if (Number.isNaN(ms) || ms <= 0) return Infinity;
    return Math.max(1, Math.floor(this.simBudgetMs / ms));
  }

  /**
   * The fastest sim speed (simulated seconds per real second) this device sustains within
   * the budget at its current frame rate, or NaN before there is enough data.
   */
  affordableSpeed(): number {
    const ms = this.step.value;
    const frame = this.frame.value;
    if (this.frames < 30 || Number.isNaN(ms) || Number.isNaN(frame)) return NaN;
    const stepsPerFrame = this.simBudgetMs / ms;
    return (stepsPerFrame * (1000 / Math.max(frame, 1000 / 60))) / this.stepsPerSecond;
  }

  /**
   * Suggests a lower pixel ratio when frames are slow even though the solver fits its
   * budget, which means drawing is the bottleneck. Returns the new ratio, or null.
   */
  suggestDpr(): number | null {
    if (this.frames < 90) return null;
    const frame = this.frame.value;
    const sim = this.step.value * Math.min(this.stepBudget(), 1e6);
    if (frame > 24 && this.dpr > 1 && !(sim > frame * 0.6)) {
      this.dpr = Math.max(1, this.dpr - 0.5);
      this.frames = 0;
      return this.dpr;
    }
    return null;
  }

  reading(): PerfReading {
    return {
      fps: 1000 / this.frame.value,
      msPerStep: this.step.value,
      simRate: this.rate.value,
      dpr: this.dpr,
      slow: this.slowFrames > 30,
    };
  }
}
