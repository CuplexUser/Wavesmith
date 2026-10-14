// Fixed-timestep accumulator. The solver always advances in whole steps of 1/stepsPerSecond
// simulated seconds, so a run's outcome never depends on the display's frame rate.

export class Stepper {
  private acc = 0;
  paused = false;
  /** Simulated seconds per real second. */
  speed = 1;
  /**
   * Most steps the device can afford in one frame, set by the performance monitor. When the
   * requested speed needs more, the run falls behind real time (slow motion) instead of
   * dropping frames.
   */
  budget = Infinity;
  /** Whether the last frame wanted more steps than the cap allowed. */
  limited = false;

  constructor(
    readonly stepsPerSecond: number,
    /** Most steps taken in one frame; extra time is dropped so a stall can't snowball. */
    readonly maxStepsPerFrame = Math.ceil(stepsPerSecond / 10),
  ) {}

  /** Returns how many solver steps to take for `dtMs` of real time. */
  advance(dtMs: number): number {
    if (this.paused || !(dtMs > 0)) return 0;
    this.acc += (dtMs / 1000) * this.stepsPerSecond * this.speed;
    const cap = Math.max(1, Math.min(this.maxStepsPerFrame * Math.max(1, Math.ceil(this.speed)), this.budget));
    // The epsilon keeps rounding error from losing a step when frame times sum exactly.
    let n = Math.floor(this.acc + 1e-9);
    this.acc = Math.max(0, this.acc - n);
    this.limited = n > cap;
    if (n > cap) {
      n = cap;
      this.acc = 0;
    }
    return n;
  }

  reset(): void {
    this.acc = 0;
  }
}
