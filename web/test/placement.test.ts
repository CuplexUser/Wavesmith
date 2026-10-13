import { describe, expect, it } from 'vitest';
import { arcDist, arcFrom, len, sub } from '../src/geometry';
import { BEND_OFFSET, dragHandle, handlesFor } from '../src/input/handles';
import { checkPlacements, createItem, pinchDelta, remaining, totalCost, transformItem } from '../src/placement';
import type { Item, Level, V2 } from '../src/types';

const level: Level = {
  id: 't',
  name: 'Test',
  chapter: 1,
  grid: { width: 256, height: 160 },
  medium: { c: 60 },
  sources: [{ kind: 'point', pos: [40, 80], freq: 3 }],
  goals: [{ kind: 'focus', pos: [200, 80], radius: 5, threshold: 0.3, hold: 2 }],
  inventory: { wall: { count: 2, cost: 1, maxSize: 50 }, absorber: { count: 1, cost: 2 } },
  budget: 3,
  par: { cost: 2, energy: 10 },
  timeLimit: 30,
};

const wall = (a: V2, b: V2): Item => ({ kind: 'wall', a, b, thickness: 3 });

describe('placement checks', () => {
  it('accepts a valid layout and counts cost', () => {
    const items = [wall([100, 20], [100, 60])];
    expect(checkPlacements(level, items)).toBeNull();
    expect(totalCost(level, items)).toBe(1);
  });

  it('enforces inventory, size cap, and budget', () => {
    expect(checkPlacements(level, [{ kind: 'lens', pos: [100, 100], radii: [8, 8], ratio: 0.5 }])).toMatch(/No lens/);
    expect(checkPlacements(level, [wall([100, 10], [100, 70])])).toMatch(/at most 50/);
    const three = [wall([100, 10], [100, 40]), wall([110, 10], [110, 40]), wall([120, 10], [120, 40])];
    expect(checkPlacements(level, three)).toMatch(/Only 2/);
    const pricey: Item[] = [
      wall([100, 10], [100, 40]),
      wall([110, 10], [110, 40]),
      { kind: 'absorber', pos: [150, 30], size: [10, 10] },
    ];
    expect(checkPlacements(level, pricey)).toMatch(/Over budget/);
  });

  it('keeps pieces off sources, goals, and the board edge', () => {
    expect(checkPlacements(level, [wall([40, 70], [40, 100])])).toMatch(/source/);
    expect(checkPlacements(level, [wall([200, 60], [200, 100])])).toMatch(/goal/);
    expect(checkPlacements(level, [wall([250, 10], [270, 10])])).toMatch(/board/);
  });

  it('reports how many more pieces fit', () => {
    expect(remaining(level, [], 'wall')).toBe(2);
    expect(remaining(level, [wall([100, 10], [100, 40]), wall([110, 10], [110, 40])], 'absorber')).toBe(0);
    expect(remaining(level, [], 'lens')).toBe(0);
  });

  it('creates new pieces within the size cap', () => {
    const capped = { ...level, inventory: { reflector: { count: 1, cost: 1, maxSize: 20 } } };
    const r = createItem(capped, 'reflector', [100, 100]);
    expect(r.kind === 'reflector' && len(sub(r.b, r.a))).toBeCloseTo(20);
  });
});

describe('gestures and handles', () => {
  it('computes pinch rotation and scale', () => {
    const d = pinchDelta({ a: [0, 0], b: [10, 0] }, { a: [5, 5], b: [5, 25] });
    expect(d.angle).toBeCloseTo(Math.PI / 2);
    expect(d.factor).toBeCloseTo(2);
  });

  it('rotates and scales segments about their midpoint', () => {
    const t = transformItem(wall([90, 50], [110, 50]), Math.PI / 2, 1.5);
    if (t.kind !== 'wall') throw new Error('expected a wall');
    expect(t.a[0]).toBeCloseTo(100);
    expect(t.a[1]).toBeCloseTo(35);
    expect(t.b[1]).toBeCloseTo(65);
  });

  it('bends a reflector from a handle floating off its face, at most a half circle', () => {
    const r: Item = { kind: 'reflector', a: [0, 0], b: [40, 0], bulge: 0 };
    const lvl = { ...level, inventory: { reflector: { count: 1, cost: 1 } } };
    // The handle starts BEND_OFFSET off the middle, so the middle itself stays free for moving.
    const handle = handlesFor(r).find((h) => h.id === 'bulge')!;
    expect(handle.pos[1]).toBeCloseTo(BEND_OFFSET);
    const bent = dragHandle(lvl, r, 'bulge', [20, BEND_OFFSET + 8]);
    expect(bent.kind === 'reflector' && bent.bulge).toBeCloseTo(8);
    const flat = dragHandle(lvl, r, 'bulge', [20, BEND_OFFSET - 3]);
    expect(flat.kind === 'reflector' && flat.bulge).toBe(0);
    const other = dragHandle(lvl, r, 'bulge', [20, -BEND_OFFSET - 5]);
    expect(other.kind === 'reflector' && other.bulge).toBeCloseTo(-5);
    const max = dragHandle(lvl, r, 'bulge', [20, 90]);
    expect(max.kind === 'reflector' && max.bulge).toBeCloseTo(20);
  });

  it('keeps the far end fixed when an endpoint is dragged past the size cap', () => {
    const w = dragHandle(level, wall([100, 50], [120, 50]), 'b', [200, 50]);
    if (w.kind !== 'wall') throw new Error('expected a wall');
    expect(w.a).toEqual([100, 50]);
    expect(w.b[0]).toBeCloseTo(150);
  });

  it('stops endpoint drags at the size cap', () => {
    const w = dragHandle(level, wall([100, 50], [120, 50]), 'b', [200, 50]);
    expect(w.kind === 'wall' && len(sub(w.b, w.a))).toBeCloseTo(50);
  });
});

describe('arcs', () => {
  it('matches the core: endpoints and apex lie on the arc', () => {
    const arc = arcFrom([0, 0], [20, 0], 5)!;
    expect(arc.apex[0]).toBeCloseTo(10);
    expect(arc.apex[1]).toBeCloseTo(5);
    expect(arcDist([10, 0], [0, 0], [20, 0], 5)).toBeCloseTo(5);
    expect(len(sub([0, 0], arc.center))).toBeCloseTo(arc.radius);
  });
});
