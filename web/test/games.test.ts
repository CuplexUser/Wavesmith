import { describe, expect, it } from 'vitest';
import { buildCatalog, type ChapterDef } from '../src/levels';
import { earnedAchievements } from '../src/platform/games';
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
