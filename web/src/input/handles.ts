// Drag handles for editing a selected piece.

import { add, arcFrom, len, mid, rotate, sub } from '../geometry';
import { bulgeToward, clampSize } from '../placement';
import type { Item, Level, V2 } from '../types';

export type HandleId = 'a' | 'b' | 'bulge' | 'size' | 'rx' | 'ry' | 'rotate';

export interface Handle {
  id: HandleId;
  pos: V2;
}

/** Distance (cells) from a box or lens edge to its rotate handle. */
const ROTATE_OFFSET = 9;

export function handlesFor(item: Item): Handle[] {
  switch (item.kind) {
    case 'wall':
      return [
        { id: 'a', pos: item.a },
        { id: 'b', pos: item.b },
      ];
    case 'reflector': {
      const arc = arcFrom(item.a, item.b, item.bulge ?? 0);
      return [
        { id: 'a', pos: item.a },
        { id: 'b', pos: item.b },
        { id: 'bulge', pos: arc ? arc.apex : mid(item.a, item.b) },
      ];
    }
    case 'absorber': {
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

/** The piece after dragging handle `id` to `p`, kept within the level's size cap. */
export function dragHandle(level: Level, item: Item, id: HandleId, p: V2): Item {
  let next: Item = item;
  switch (item.kind) {
    case 'wall':
      if (id === 'a' || id === 'b') next = { ...item, [id]: p };
      break;
    case 'reflector':
      if (id === 'a' || id === 'b') {
        const moved = { ...item, [id]: p };
        // Keep the bend within a half circle of the new chord.
        const limit = len(sub(moved.b, moved.a)) / 2;
        const bulge = Math.max(-limit, Math.min(limit, item.bulge ?? 0));
        next = { ...moved, bulge };
      } else if (id === 'bulge') {
        next = { ...item, bulge: bulgeToward(item.a, item.b, p) };
      }
      break;
    case 'absorber': {
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
