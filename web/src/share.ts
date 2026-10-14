// Shareable solutions: a layout of pieces encoded into the URL hash, e.g.
// `#/play/5-4?s=<code>`. The code is base64url-encoded JSON with coordinates rounded to
// hundredths of a cell, which keeps links short without changing how a layout plays.

import type { Item, ToolKind } from './types';
import { TOOL_ORDER } from './types';

function round(value: unknown): unknown {
  if (typeof value === 'number') return Math.round(value * 100) / 100;
  if (Array.isArray(value)) return value.map(round);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, round(v)]));
  }
  return value;
}

function toBase64Url(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(code: string): string {
  const b64 = code.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}

export function encodeLayout(items: Item[]): string {
  return toBase64Url(JSON.stringify(round(items)));
}

const isV2 = (v: unknown): boolean =>
  Array.isArray(v) && v.length === 2 && v.every((n) => typeof n === 'number' && Number.isFinite(n));

/**
 * Decodes a layout, or returns null if the code is malformed. Only the shape is checked here;
 * the core still validates every piece against the level before it is applied.
 */
export function decodeLayout(code: string): Item[] | null {
  try {
    const parsed: unknown = JSON.parse(fromBase64Url(code));
    if (!Array.isArray(parsed) || parsed.length > 64) return null;
    for (const item of parsed) {
      if (!item || typeof item !== 'object') return null;
      const it = item as Record<string, unknown>;
      if (!TOOL_ORDER.includes(it.kind as ToolKind)) return null;
      const points = 'pos' in it ? [it.pos] : [it.a, it.b];
      if (!points.every(isV2)) return null;
    }
    return parsed as Item[];
  } catch {
    return null;
  }
}

/** A link that opens `levelId` with `items` already placed. */
export function shareUrl(levelId: string, items: Item[], base: string = location.href): string {
  const url = new URL(base);
  url.hash = `#/play/${levelId}?s=${encodeLayout(items)}`;
  return url.toString();
}
