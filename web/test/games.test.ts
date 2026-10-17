import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildCatalog, type ChapterDef } from '../src/levels';
import { ACHIEVEMENTS, earnedAchievements, totalStars } from '../src/platform/games';
import type { Level } from '../src/types';

const lvl = (id: string): Level => ({
  id,
  name: id,
  chapter: 1,
  grid: { width: 64, height: 64 },
  medium: { c: 60 },
  sources: [],
  goals: [],
  inventory: {},
  budget: 0,
  par: { cost: 0, energy: 0 },
  timeLimit: 10,
});

const defs: ChapterDef[] = [
  { id: 1, name: 'One', free: true, levels: ['a', 'b'] },
  { id: 2, name: 'Two', free: false, levels: ['c'] },
];
const catalog = buildCatalog(defs, {
  '../../levels/ch1/a.json': lvl('1-1'),
  '../../levels/ch1/b.json': lvl('1-2'),
  '../../levels/ch2/c.json': lvl('2-1'),
});

describe('achievements', () => {
  it('earns nothing before the first solve', () => {
    expect(earnedAchievements(catalog, () => 0)).toEqual([]);
  });

  it('marks chapters complete and fully starred', () => {
    const stars: Record<string, number> = { '1-1': 3, '1-2': 2 };
    expect(earnedAchievements(catalog, (id) => stars[id] ?? 0)).toEqual(['first-solve', 'chapter-1']);
    stars['1-2'] = 3;
    stars['2-1'] = 3;
    expect(earnedAchievements(catalog, (id) => stars[id] ?? 0)).toEqual([
      'first-solve',
      'chapter-1',
      'chapter-1-stars',
      'chapter-2',
      'chapter-2-stars',
      'all-stars',
    ]);
  });
});

describe('game-ids.xml', () => {
  const xml = readFileSync(new URL('../android/app/src/main/res/values/game-ids.xml', import.meta.url), 'utf8');

  it('has an ID for every achievement the game unlocks', () => {
    for (const name of Object.values(ACHIEVEMENTS)) expect(xml).toContain(`name="achievement_${name}"`);
  });
});

describe('leaderboards', () => {
  it('totals stars across every chapter', () => {
    expect(totalStars(catalog, () => 0)).toBe(0);
    const stars: Record<string, number> = { '1-1': 3, '1-2': 1, '2-1': 2 };
    expect(totalStars(catalog, (id) => stars[id] ?? 0)).toBe(6);
  });
});
