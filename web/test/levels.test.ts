import { describe, expect, it } from 'vitest';
import chapters from '../../levels/chapters.json';
import { buildCatalog, levelStates, nextLevel, type ChapterDef } from '../src/levels';
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
  { id: 1, name: 'One', free: true, levels: ['a', 'b', 'c'] },
  { id: 2, name: 'Two', free: true, levels: ['d'] },
  { id: 3, name: 'Three', free: false, levels: ['e'] },
];

const catalog = buildCatalog(defs, {
  '../../levels/ch1/a.json': lvl('1-1'),
  '../../levels/ch1/a.solution.json': { pieces: [] },
  '../../levels/ch1/b.json': lvl('1-2'),
  '../../levels/ch1/c.json': lvl('1-3'),
  '../../levels/ch2/d.json': lvl('2-1'),
  '../../levels/ch3/e.json': lvl('3-1'),
});

describe('level catalog', () => {
  it('skips reference solutions', () => {
    expect(catalog.levels.size).toBe(5);
  });

  it('opens levels in order as earlier ones are solved', () => {
    const stars: Record<string, number> = {};
    const states = () => levelStates(catalog, (id) => stars[id] ?? 0);
    expect([...states().values()]).toEqual(['open', 'locked', 'locked', 'locked', 'locked']);
    stars['1-1'] = 2;
    stars['1-2'] = 1;
    expect(states().get('1-3')).toBe('open');
    stars['1-3'] = 3;
    expect(states().get('2-1')).toBe('open');
    stars['2-1'] = 3;
    // Paid chapters stay locked in the free build.
    expect(states().get('3-1')).toBe('locked');
  });

  it('finds the next level across chapters', () => {
    expect(nextLevel(catalog, '1-3')?.id).toBe('2-1');
    expect(nextLevel(catalog, '3-1')).toBeNull();
  });

  it('ships chapter 1 (sound) and chapter 5 (light) as playable chapters', () => {
    const defs = chapters.chapters as ChapterDef[];
    expect(defs[0]!.levels.length).toBe(6);
    expect(defs[0]!.free).toBe(true);
    const light = defs.find((c) => c.name === 'Light')!;
    expect(light.levels.length).toBeGreaterThanOrEqual(4);
  });

  it('keys levels by folder so chapters can reuse file names', () => {
    const two = buildCatalog(
      [
        { id: 1, name: 'A', free: true, levels: ['01-x'] },
        { id: 2, name: 'B', free: true, levels: ['01-x'] },
      ],
      { '../../levels/ch1/01-x.json': lvl('1-1'), '../../levels/ch2/01-x.json': lvl('2-1') },
    );
    expect(nextLevel(two, '1-1')?.id).toBe('2-1');
  });
});
