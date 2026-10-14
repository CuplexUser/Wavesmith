import { describe, expect, it } from 'vitest';
import { PerfMonitor } from '../src/sim/perf';
import { Stepper } from '../src/sim/stepper';

describe('PerfMonitor', () => {
  it('fits the step budget to the measured step cost', () => {
    const p = new PerfMonitor(120, 2, 9);
    for (let i = 0; i < 60; i++) p.record(1000 / 60, 2, 2 * 1.5, 1);
    expect(p.stepBudget()).toBe(6);
    // 6 steps a frame at 60 fps is 360 steps a second: three times real time.
    expect(p.affordableSpeed()).toBeCloseTo(3, 1);
  });

  it('flags slow motion when the run falls behind', () => {
    const p = new PerfMonitor(120, 2);
    for (let i = 0; i < 60; i++) p.record(1000 / 30, 1, 8, 1);
    expect(p.reading().slow).toBe(true);
    const q = new PerfMonitor(120, 2);
    for (let i = 0; i < 60; i++) q.record(1000 / 60, 2, 1, 1);
    expect(q.reading().slow).toBe(false);
  });

  it('lowers the pixel ratio when drawing, not solving, is slow', () => {
    const p = new PerfMonitor(120, 2);
    for (let i = 0; i < 120; i++) p.record(40, 5, 2, 1);
    expect(p.suggestDpr()).toBe(1.5);
  });
});

describe('Stepper budget', () => {
  it('never takes more steps than the budget and reports the shortfall', () => {
    const s = new Stepper(120);
    s.budget = 1;
    expect(s.advance(1000 / 30)).toBe(1);
    expect(s.limited).toBe(true);
    s.budget = Infinity;
    expect(s.advance(1000 / 60)).toBe(2);
    expect(s.limited).toBe(false);
  });
});
