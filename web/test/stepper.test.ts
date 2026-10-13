import { describe, expect, it } from 'vitest';
import { Stepper } from '../src/sim/stepper';

describe('Stepper', () => {
  it('takes the same number of steps regardless of frame timing', () => {
    const run = (frames: number[]) => {
      const s = new Stepper(120);
      return frames.reduce((n, dt) => n + s.advance(dt), 0);
    };
    const smooth = Array<number>(60).fill(1000 / 60);
    // Same total time as `smooth`, split unevenly.
    const jittery = [5, 30, 11, 20.67, 22, 11.33, ...Array<number>(54).fill(1000 / 60)];
    expect(run(smooth)).toBe(120);
    expect(run(jittery)).toBe(120);
  });

  it('carries fractional steps between frames', () => {
    const s = new Stepper(120);
    // 3 ms is 0.36 steps; the third frame crosses 1.
    expect([s.advance(3), s.advance(3), s.advance(3)]).toEqual([0, 0, 1]);
  });

  it('caps catch-up after a stall', () => {
    const s = new Stepper(120);
    expect(s.advance(5000)).toBe(s.maxStepsPerFrame);
    // The backlog is dropped rather than replayed.
    expect(s.advance(1000 / 60)).toBe(2);
  });

  it('does nothing while paused and scales with speed', () => {
    const s = new Stepper(120);
    s.paused = true;
    expect(s.advance(100)).toBe(0);
    s.paused = false;
    s.speed = 3;
    expect(s.advance(50)).toBe(18);
  });
});
