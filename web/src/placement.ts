// Creating, editing, and pre-validating the player's pieces. Mirrors
// `Level::check_placements` in the Rust core so the UI can react instantly.

import {
  add,
  chordNormal,
  controlPoints,
  dot,
  isObstacle,
  itemCenter,
  itemDistance,
  itemSize,
  len,
  mid,
  rotate,
  scale,
  sub,
} from './geometry';
import type { Item, Level, ToolKind, V2 } from './types';

const SOURCE_CLEARANCE = 3;
const GOAL_CLEARANCE = 1;

export function sourcePoints(level: Level): V2[] {
  return level.sources.flatMap((s) => (s.kind === 'point' ? [s.pos] : [s.a, s.b]));
}

export function goalZones(level: Level): { pos: V2; radius: number }[] {
  return level.goals.flatMap((g) => {
    switch (g.kind) {
      case 'focus':
      case 'silence':
        return [{ pos: g.pos, radius: g.radius }];
      case 'resonate':
        return [{ pos: g.pos, radius: 3 }];
      case 'sustain':
        return [...g.antinodes, ...g.nodes].map((pos) => ({ pos, radius: g.radius }));
    }
  });
}

export function countOf(items: Item[], kind: ToolKind): number {
  return items.filter((i) => i.kind === kind).length;
}

export function totalCost(level: Level, items: Item[]): number {
  return items.reduce((sum, i) => sum + (level.inventory[i.kind]?.cost ?? 0), 0);
}

/** Pieces of `kind` the player can still add, considering both count and budget. */
export function remaining(level: Level, items: Item[], kind: ToolKind): number {
  const entry = level.inventory[kind];
  if (!entry) return 0;
  const byCount = entry.count - countOf(items, kind);
  const left = level.budget - totalCost(level, items);
  const byBudget = entry.cost > 0 ? Math.floor(left / entry.cost) : byCount;
  return Math.max(0, Math.min(byCount, byBudget));
}

/** Returns null when the layout is acceptable, or a short reason when it is not. */
export function checkPlacements(level: Level, items: Item[]): string | null {
  const counts = new Map<ToolKind, number>();
  for (const item of items) {
    const entry = level.inventory[item.kind];
    if (!entry) return `No ${item.kind}s in this level`;
    const n = (counts.get(item.kind) ?? 0) + 1;
    counts.set(item.kind, n);
    if (n > entry.count) return `Only ${entry.count} ${item.kind}${entry.count === 1 ? '' : 's'} available`;
    if (entry.maxSize !== undefined && itemSize(item) > entry.maxSize + 1e-3) {
      return `Too long: ${item.kind}s are at most ${entry.maxSize} cells here`;
    }
    const { width, height } = level.grid;
    for (const p of controlPoints(item)) {
      if (p[0] < 0 || p[1] < 0 || p[0] > width || p[1] > height) return 'Keep pieces on the board';
    }
    if (isObstacle(item)) {
      for (const p of sourcePoints(level)) {
        if (itemDistance(item, p) < SOURCE_CLEARANCE) return "Pieces can't cover a source";
      }
      for (const z of goalZones(level)) {
        if (itemDistance(item, z.pos) < z.radius + GOAL_CLEARANCE) return "Pieces can't cover a goal";
      }
    } else if (item.kind === 'emitter' || item.kind === 'resonator') {
      for (const z of goalZones(level)) {
        if (len(sub(item.pos, z.pos)) < z.radius + GOAL_CLEARANCE) return "Pieces can't cover a goal";
      }
    }
  }
  const cost = totalCost(level, items);
  if (cost > level.budget) return `Over budget (${cost}/${level.budget})`;
  return null;
}

/** A new piece of `kind` centered on `p`, sized to fit the level's cap. */
export function createItem(level: Level, kind: ToolKind, p: V2): Item {
  const cap = level.inventory[kind]?.maxSize ?? Infinity;
  const span = (want: number) => Math.min(want, cap);
  const freq = level.sources[0]?.freq ?? 3;
  switch (kind) {
    case 'wall': {
      const h = span(30) / 2;
      return { kind, a: [p[0] - h, p[1]], b: [p[0] + h, p[1]], thickness: 3 };
    }
    case 'reflector': {
      const h = span(40) / 2;
      return { kind, a: [p[0] - h, p[1]], b: [p[0] + h, p[1]], bulge: 0, thickness: 3 };
    }
    case 'absorber':
      return { kind, pos: p, size: [span(24), Math.min(12, span(24))], angle: 0, strength: 40 };
    case 'lens': {
      const r = span(32) / 2;
      return { kind, pos: p, radii: [r, r], angle: 0, ratio: 0.6 };
    }
    case 'resonator':
      return { kind, pos: p, freq, q: 25 };
    case 'emitter':
      return { kind, pos: p, freq, amp: 1, phase: 0 };
  }
}

/** Rotates the piece about its center. */
export function rotateItem(item: Item, angle: number): Item {
  return transformItem(item, angle, 1);
}

/** Rotates by `angle` and scales by `factor` about the piece's center. */
export function transformItem(item: Item, angle: number, factor: number): Item {
  const c = itemCenter(item);
  const tp = (p: V2): V2 => add(c, scale(rotate(sub(p, c), angle), factor));
  switch (item.kind) {
    case 'wall':
      return { ...item, a: tp(item.a), b: tp(item.b) };
    case 'reflector':
      return { ...item, a: tp(item.a), b: tp(item.b), bulge: (item.bulge ?? 0) * factor };
    case 'absorber':
      return { ...item, angle: (item.angle ?? 0) + angle, size: scale(item.size, factor) };
    case 'lens':
      return { ...item, angle: (item.angle ?? 0) + angle, radii: scale(item.radii, factor) };
    default:
      return item;
  }
}

/** Limits a piece to its size cap, shrinking about its center. */
export function clampSize(level: Level, item: Item): Item {
  const cap = level.inventory[item.kind]?.maxSize;
  const size = itemSize(item);
  if (cap === undefined || size <= cap) return item;
  return transformItem(item, 0, cap / size);
}

/** Bulge that puts a reflector's apex at (the projection of) `p`, within a half circle. */
export function bulgeToward(a: V2, b: V2, p: V2): number {
  const n = chordNormal(a, b);
  const limit = len(sub(b, a)) / 2;
  const v = dot(sub(p, mid(a, b)), n);
  const snapped = Math.abs(v) < 1 ? 0 : v;
  return Math.max(-limit, Math.min(limit, snapped));
}

export interface TwoPointer {
  a: V2;
  b: V2;
}

/** Rotation (radians) and scale factor taking one pointer pair to another, for pinch gestures. */
export function pinchDelta(from: TwoPointer, to: TwoPointer): { angle: number; factor: number } {
  const d0 = sub(from.b, from.a);
  const d1 = sub(to.b, to.a);
  const l0 = len(d0);
  const l1 = len(d1);
  if (l0 < 1e-6 || l1 < 1e-6) return { angle: 0, factor: 1 };
  const angle = Math.atan2(d1[1], d1[0]) - Math.atan2(d0[1], d0[0]);
  return { angle: Math.atan2(Math.sin(angle), Math.cos(angle)), factor: l1 / l0 };
}
