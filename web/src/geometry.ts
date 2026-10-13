// 2D helpers mirroring `wavesmith-core/src/tools.rs`, used for drawing, hit testing, and
// instant placement feedback. Rust stays the authority on what is valid.

import type { Item, V2 } from './types';

export const add = (a: V2, b: V2): V2 => [a[0] + b[0], a[1] + b[1]];
export const sub = (a: V2, b: V2): V2 => [a[0] - b[0], a[1] - b[1]];
export const scale = (a: V2, s: number): V2 => [a[0] * s, a[1] * s];
export const dot = (a: V2, b: V2): number => a[0] * b[0] + a[1] * b[1];
export const len = (a: V2): number => Math.hypot(a[0], a[1]);
export const mid = (a: V2, b: V2): V2 => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];

export function rotate(p: V2, angle: number): V2 {
  const s = Math.sin(angle);
  const c = Math.cos(angle);
  return [c * p[0] - s * p[1], s * p[0] + c * p[1]];
}

export function segDist(p: V2, a: V2, b: V2): number {
  const ab = sub(b, a);
  const ap = sub(p, a);
  const l2 = dot(ab, ab);
  const t = l2 > 0 ? Math.min(1, Math.max(0, dot(ap, ab) / l2)) : 0;
  return len(sub(ap, scale(ab, t)));
}

export interface Arc {
  center: V2;
  radius: number;
  apexDir: V2;
  cosHalf: number;
  apex: V2;
  /** Angles of the endpoints around the center, for drawing. */
  start: number;
  end: number;
  /** Whether drawing from `start` to `end` should go counterclockwise. */
  ccw: boolean;
}

const MIN_BULGE = 0.25;

/** Unit left normal of the chord a→b, `(-dy, dx)`. */
export function chordNormal(a: V2, b: V2): V2 {
  const d = sub(b, a);
  const l = len(d) || 1;
  return [-d[1] / l, d[0] / l];
}

export function arcFrom(a: V2, b: V2, bulge: number): Arc | null {
  const ab = sub(b, a);
  const chord = len(ab);
  if (Math.abs(bulge) < MIN_BULGE || chord < 1e-3) return null;
  const half = chord / 2;
  const n = chordNormal(a, b);
  const m = mid(a, b);
  const r = (half * half + bulge * bulge) / (2 * Math.abs(bulge));
  const apex = add(m, scale(n, bulge));
  const dir = scale(n, Math.sign(bulge));
  const center = sub(apex, scale(dir, r));
  const ca = sub(a, center);
  const cb = sub(b, center);
  const start = Math.atan2(ca[1], ca[0]);
  const end = Math.atan2(cb[1], cb[0]);
  // Go the way that passes through the apex.
  const apexAngle = Math.atan2(dir[1], dir[0]);
  const ccw = !angleBetween(apexAngle, start, end);
  return { center, radius: r, apexDir: dir, cosHalf: dot(ca, dir) / len(ca), apex, start, end, ccw };
}

/** Whether `x` lies on the clockwise-increasing sweep from `s` to `e` (canvas angles). */
function angleBetween(x: number, s: number, e: number): boolean {
  const tau = Math.PI * 2;
  const norm = (v: number) => ((v % tau) + tau) % tau;
  return norm(x - s) <= norm(e - s);
}

export function arcDist(p: V2, a: V2, b: V2, bulge: number): number {
  const arc = arcFrom(a, b, bulge);
  if (!arc) return segDist(p, a, b);
  const d = sub(p, arc.center);
  const dl = len(d);
  if (dl > 1e-6 && dot(d, arc.apexDir) / dl >= arc.cosHalf) return Math.abs(dl - arc.radius);
  return Math.min(len(sub(p, a)), len(sub(p, b)));
}

export function boxSdf(p: V2, pos: V2, size: V2, angle: number): number {
  const q = rotate(sub(p, pos), -angle);
  const dx = Math.abs(q[0]) - size[0] / 2;
  const dy = Math.abs(q[1]) - size[1] / 2;
  return len([Math.max(dx, 0), Math.max(dy, 0)]) + Math.min(Math.max(dx, dy), 0);
}

export function ellipseRho(p: V2, pos: V2, radii: V2, angle: number): number {
  const q = rotate(sub(p, pos), -angle);
  return Math.hypot(q[0] / radii[0], q[1] / radii[1]);
}

/** Distance from `p` to the piece's surface; zero or negative inside. */
export function itemDistance(item: Item, p: V2): number {
  switch (item.kind) {
    case 'wall':
      return segDist(p, item.a, item.b) - (item.thickness ?? 3) / 2;
    case 'reflector':
      return arcDist(p, item.a, item.b, item.bulge ?? 0) - (item.thickness ?? 3) / 2;
    case 'absorber':
      return boxSdf(p, item.pos, item.size, item.angle ?? 0);
    case 'lens':
      return (ellipseRho(p, item.pos, item.radii, item.angle ?? 0) - 1) * Math.min(...item.radii);
    case 'resonator':
    case 'emitter':
      return len(sub(p, item.pos));
  }
}

export function isObstacle(item: Item): boolean {
  return item.kind === 'wall' || item.kind === 'reflector' || item.kind === 'absorber';
}

/** Largest span in cells, compared with inventory size caps. */
export function itemSize(item: Item): number {
  switch (item.kind) {
    case 'wall':
    case 'reflector':
      return len(sub(item.b, item.a));
    case 'absorber':
      return Math.max(...item.size);
    case 'lens':
      return 2 * Math.max(...item.radii);
    default:
      return 0;
  }
}

/** The piece's pivot: the midpoint for segments, the position otherwise. */
export function itemCenter(item: Item): V2 {
  return item.kind === 'wall' || item.kind === 'reflector' ? mid(item.a, item.b) : item.pos;
}

/** Points that must stay on the board. */
export function controlPoints(item: Item): V2[] {
  if (item.kind === 'wall') return [item.a, item.b];
  if (item.kind === 'reflector') {
    const arc = arcFrom(item.a, item.b, item.bulge ?? 0);
    return arc ? [item.a, item.b, arc.apex] : [item.a, item.b];
  }
  return [item.pos];
}

export function translate(item: Item, d: V2): Item {
  if (item.kind === 'wall' || item.kind === 'reflector') {
    return { ...item, a: add(item.a, d), b: add(item.b, d) };
  }
  return { ...item, pos: add(item.pos, d) };
}

export function clone(item: Item): Item {
  return JSON.parse(JSON.stringify(item)) as Item;
}
