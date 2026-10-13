import { describe, expect, it } from 'vitest';
import { ProgressStore, type StorageLike } from '../src/progress/store';

class MemoryStorage implements StorageLike {
  map = new Map<string, string>();
  getItem(k: string) {
    return this.map.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    this.map.set(k, v);
  }
}

describe('ProgressStore', () => {
  it('keeps the best result and persists it', () => {
    const mem = new MemoryStorage();
    const a = new ProgressStore(mem);
    expect(a.record('1-1', 2)).toBe(true);
    expect(a.record('1-1', 1)).toBe(false);
    expect(a.record('1-1', 3)).toBe(true);
    expect(new ProgressStore(mem).stars('1-1')).toBe(3);
  });

  it('works when storage throws', () => {
    const broken: StorageLike = {
      getItem() {
        throw new Error('blocked');
      },
      setItem() {
        throw new Error('quota');
      },
    };
    const s = new ProgressStore(broken);
    expect(s.stars('1-1')).toBe(0);
    expect(s.record('1-1', 2)).toBe(true);
    expect(s.stars('1-1')).toBe(2);
    s.setSetting('muted', true);
    expect(s.settings.muted).toBe(true);
  });

  it('works with no storage and ignores corrupt data', () => {
    expect(new ProgressStore(null).stars('x')).toBe(0);
    const mem = new MemoryStorage();
    mem.setItem('wavesmith.progress.v1', '{not json');
    expect(new ProgressStore(mem).stars('1-1')).toBe(0);
  });
});
