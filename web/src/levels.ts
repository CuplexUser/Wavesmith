// Level catalog: the JSON files in /levels plus chapter order and unlock rules.

import type { Level } from './types';

export interface ChapterDef {
  id: number;
  name: string;
  /** Included in the free tier (the full-game unlock arrives with the Android build). */
  free: boolean;
  levels: string[];
  /** Folder under /levels holding the chapter's files (default `ch<id>`). */
  dir?: string;
}

export interface Catalog {
  chapters: ChapterDef[];
  /** Levels by folder and file stem, e.g. "ch1/01-first-bounce". */
  levels: Map<string, Level>;
}

export type LevelState = 'locked' | 'open' | 'done';

/** Builds a catalog from level modules keyed by path, ignoring reference solutions. */
export function buildCatalog(chapters: ChapterDef[], modules: Record<string, unknown>): Catalog {
  const levels = new Map<string, Level>();
  for (const [path, mod] of Object.entries(modules)) {
    const parts = path.split('/');
    const file = parts.pop() ?? '';
    const dir = parts.pop() ?? '';
    if (!file.endsWith('.json') || file.endsWith('.solution.json')) continue;
    levels.set(`${dir}/${file.replace(/\.json$/, '')}`, mod as Level);
  }
  return { chapters, levels };
}

/** Levels of a chapter, in order, skipping any whose file is missing. */
export function chapterLevels(catalog: Catalog, chapter: ChapterDef): Level[] {
  const dir = chapter.dir ?? `ch${chapter.id}`;
  return chapter.levels.flatMap((stem) => {
    const l = catalog.levels.get(`${dir}/${stem}`);
    return l ? [l] : [];
  });
}

/**
 * A level opens once the one before it in its chapter is solved; the first level of each
 * playable chapter opens once the previous chapter's last level is solved.
 */
export function levelStates(
  catalog: Catalog,
  stars: (id: string) => number,
  /** Open everything (development builds, for playtesting paid chapters). */
  unlockAll = false,
): Map<string, LevelState> {
  const out = new Map<string, LevelState>();
  let previousSolved = true;
  for (const ch of catalog.chapters) {
    for (const level of chapterLevels(catalog, ch)) {
      const s = stars(level.id);
      out.set(level.id, s > 0 ? 'done' : unlockAll || (previousSolved && ch.free) ? 'open' : 'locked');
      previousSolved = s > 0;
    }
  }
  return out;
}

/** The level after `id` in catalog order, if any. */
export function nextLevel(catalog: Catalog, id: string): Level | null {
  const all = catalog.chapters.flatMap((c) => chapterLevels(catalog, c));
  const i = all.findIndex((l) => l.id === id);
  return i >= 0 ? (all[i + 1] ?? null) : null;
}

let cached: Catalog | null = null;

/** The bundled catalog. */
export async function loadCatalog(): Promise<Catalog> {
  if (cached) return cached;
  const chapters = (await import('../../levels/chapters.json')).default.chapters as ChapterDef[];
  // Reference solutions stay out of the bundle.
  const modules = import.meta.glob(['../../levels/*/*.json', '!../../levels/*/*.solution.json'], {
    eager: true,
    import: 'default',
  });
  cached = buildCatalog(chapters, modules);
  return cached;
}
