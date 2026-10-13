// Haptic feedback tied to wave amplitude. The web build uses the Vibration API; the Android
// build will provide a Capacitor-backed implementation of the same interface.

export interface Haptics {
  /** A short tick, stronger for higher `strength` (0..1). */
  pulse(strength: number): void;
  /** Celebration pattern for a solved level. */
  success(): void;
}

export class WebHaptics implements Haptics {
  enabled = true;

  private vibrate(pattern: number | number[]): void {
    if (!this.enabled) return;
    try {
      navigator.vibrate?.(pattern);
    } catch {
      // Some browsers throw when vibration is blocked; feedback is optional.
    }
  }

  pulse(strength: number): void {
    this.vibrate(Math.round(8 + 30 * Math.max(0, Math.min(1, strength))));
  }

  success(): void {
    this.vibrate([30, 60, 30, 60, 80]);
  }
}

/**
 * Emits a pulse each time a reading rises through one of the thresholds, so players can feel
 * amplitude building toward a goal without a constant buzz.
 */
export class AmplitudeBuckets {
  private last = 0;

  constructor(
    private haptics: Haptics,
    private steps: number[] = [0.5, 0.8, 1],
  ) {}

  update(level: number): void {
    const bucket = this.steps.filter((s) => level >= s).length;
    if (bucket > this.last) this.haptics.pulse(bucket / this.steps.length);
    this.last = bucket;
  }

  reset(): void {
    this.last = 0;
  }
}
