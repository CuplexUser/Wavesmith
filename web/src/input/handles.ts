// Drag handles for editing a selected piece.

import { add, chordNormal, dot, len, mid, rotate, scale, sub } from '../geometry';
import { clampSize } from '../placement';
import type { Item, Level, V2 } from '../types';

export type HandleId = 'a' | 'b' | 'bulge' | 'size' | 'rx' | 'ry' | 'rotate';

export interface Handle {
  id: HandleId;
  pos: V2;
}

/** Distance (cells) from a box or lens edge to its rotate handle. */
const ROTATE_OFFSET = 9;
/**
 * Distance (cells) the bend handle floats off a reflector's face, so grabbing the middle of
 * the reflector moves it instead of bending it. Dragging within this distance of the chord
 * leaves the reflector flat.
 */
export const BEND_OFFSET = 8;

/** Where a reflector's bend handle sits. */
export function bendHandlePos(a: V2, b: V2, bulge: number): V2 {
  const n = chordNormal(a, b);
  const side = bulge < 0 ? -1 : 1;
  return add(mid(a, b), scale(n, bulge + side * BEND_OFFSET));
}

/** The bulge for a bend handle dragged to `p`, within a half circle. */
export function bulgeFromHandle(a: V2, b: V2, p: V2): number {
  const v = dot(sub(p, mid(a, b)), chordNormal(a, b));
  const bulge = v > BEND_OFFSET ? v - BEND_OFFSET : v < -BEND_OFFSET ? v + BEND_OFFSET : 0;
  const limit = len(sub(b, a)) / 2;
  return Math.max(-limit, Math.min(limit, bulge));
}

export function handlesFor(item: Item): Handle[] {
  switch (item.kind) {
    case 'wall':
      return [
        { id: 'a', pos: item.a },
        { id: 'b', pos: item.b },
      ];
    case 'reflector':
      return [
        { id: 'a', pos: item.a },
        { id: 'b', pos: item.b },
        { id: 'bulge', pos: bendHandlePos(item.a, item.b, item.bulge ?? 0) },
      ];
    case 'prism': {
      const ang = item.angle ?? 0;
      const [w, h] = item.size;
      return [
        // The base corner sets width and height together.
        { id: 'size', pos: add(item.pos, rotate([w / 2, h / 3], ang)) },
        { id: 'rotate', pos: add(item.pos, rotate([0, (-2 * h) / 3 - ROTATE_OFFSET], ang)) },
      ];
    }
    case 'absorber':
    case 'slab': {
      const ang = item.angle ?? 0;
      return [
        { id: 'size', pos: add(item.pos, rotate([item.size[0] / 2, item.size[1] / 2], ang)) },
        { id: 'rotate', pos: add(item.pos, rotate([0, -(item.size[1] / 2 + ROTATE_OFFSET)], ang)) },
      ];
    }
    case 'lens': {
      const ang = item.angle ?? 0;
      return [
        { id: 'rx', pos: add(item.pos, rotate([item.radii[0], 0], ang)) },
        { id: 'ry', pos: add(item.pos, rotate([0, item.radii[1]], ang)) },
        { id: 'rotate', pos: add(item.pos, rotate([0, -(item.radii[1] + ROTATE_OFFSET)], ang)) },
      ];
    }
    default:
      return [];
  }
}

/** Shortest segment a player can make, in cells. */
const MIN_SEGMENT = 4;

/**
 * Where an endpoint lands when dragged to `p` while the other end stays at `fixed`: on the
 * board, at least `MIN_SEGMENT` away, and no longer than the level's size cap.
 */
export function constrainEndpoint(level: Level, item: Item, fixed: V2, p: V2): V2 {
  const { width, height } = level.grid;
  const q: V2 = [Math.max(0, Math.min(width, p[0])), Math.max(0, Math.min(height, p[1]))];
  const v = sub(q, fixed);
  const l = len(v);
  const cap = level.inventory[item.kind]?.maxSize ?? Infinity;
  if (l < 1e-6) return add(fixed, [MIN_SEGMENT, 0]);
  const target = Math.max(MIN_SEGMENT, Math.min(cap, l));
  return target === l ? q : add(fixed, [(v[0] / l) * target, (v[1] / l) * target]);
}

/** The piece after dragging handle `id` to `p`, kept within the level's size cap. */
export function dragHandle(level: Level, item: Item, id: HandleId, p: V2): Item {
  let next: Item = item;
  switch (item.kind) {
    case 'wall':
      if (id === 'a' || id === 'b') {
        const fixed = id === 'a' ? item.b : item.a;
        // Already constrained: return directly so the cap isn't applied a second way.
        return { ...item, [id]: constrainEndpoint(level, item, fixed, p) };
      }
      break;
    case 'reflector':
      if (id === 'a' || id === 'b') {
        const fixed = id === 'a' ? item.b : item.a;
        const moved = { ...item, [id]: constrainEndpoint(level, item, fixed, p) };
        // Keep the bend within a half circle of the new chord.
        const limit = len(sub(moved.b, moved.a)) / 2;
        const bulge = Math.max(-limit, Math.min(limit, item.bulge ?? 0));
        next = { ...moved, bulge };
      } else if (id === 'bulge') {
        next = { ...item, bulge: bulgeFromHandle(item.a, item.b, p) };
      }
      break;
    case 'prism': {
      const ang = item.angle ?? 0;
      const q = rotate(sub(p, item.pos), -ang);
      if (id === 'size') {
        // The handle sits at (w/2, h/3); keep the base below the centroid.
        next = { ...item, size: [Math.max(8, 2 * Math.abs(q[0])), Math.max(8, 3 * Math.max(q[1], 2.7))] };
      } else if (id === 'rotate') {
        next = { ...item, angle: handleAngle(item.pos, p) };
      }
      break;
    }
    case 'absorber':
    case 'slab': {
      const ang = item.angle ?? 0;
      if (id === 'size') {
        const q = rotate(sub(p, item.pos), -ang);
        next = { ...item, size: [Math.max(4, 2 * Math.abs(q[0])), Math.max(4, 2 * Math.abs(q[1]))] };
      } else if (id === 'rotate') {
        next = { ...item, angle: handleAngle(item.pos, p) };
      }
      break;
    }
    case 'lens': {
      const ang = item.angle ?? 0;
      const q = rotate(sub(p, item.pos), -ang);
      if (id === 'rx') next = { ...item, radii: [Math.max(3, Math.abs(q[0])), item.radii[1]] };
      else if (id === 'ry') next = { ...item, radii: [item.radii[0], Math.max(3, Math.abs(q[1]))] };
      else if (id === 'rotate') next = { ...item, angle: handleAngle(item.pos, p) };
      break;
    }
    default:
      break;
  }
  return clampSize(level, next);
}

/** Rotate handles sit "above" the piece (local −y), so pointing up means angle 0. */
function handleAngle(center: V2, p: V2): number {
  const d = sub(p, center);
  return Math.atan2(d[1], d[0]) + Math.PI / 2;
}
