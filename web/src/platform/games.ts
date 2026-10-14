// Play Games Services: achievements and a cloud save of the progress JSON. A no-op on the web
// and in builds without a Games project ID (android/.../PlayGamesPlugin.java).

import { registerPlugin } from '@capacitor/core';
import type { Catalog } from '../levels';
import { chapterLevels } from '../levels';
import { isNative } from './native';

interface PlayGamesPlugin {
  isAvailable(): Promise<{ available: boolean }>;
  status(): Promise<{ signedIn: boolean }>;
  signIn(): Promise<{ signedIn: boolean }>;
  unlock(o: { id: string }): Promise<void>;
  showAchievements(): Promise<void>;
  save(o: { data: string }): Promise<void>;
  load(): Promise<{ data: string }>;
}

/**
 * Achievement IDs from the Play Console (Play Games Services → Achievements), keyed by the
 * game's own names. Achievements without an ID are skipped. See docs/android.md for the list
 * to create.
 */
export const ACHIEVEMENT_IDS: Record<string, string> = {
  'first-solve': '',
  'chapter-1': '',
  'chapter-2': '',
  'chapter-3': '',
  'chapter-4': '',
  'chapter-5': '',
  'chapter-6': '',
  'chapter-1-stars': '',
  'chapter-2-stars': '',
  'chapter-3-stars': '',
  'chapter-4-stars': '',
  'chapter-5-stars': '',
  'chapter-6-stars': '',
  'all-stars': '',
};

/** Achievements earned by a set of results (stars per level id). */
export function earnedAchievements(catalog: Catalog, stars: (id: string) => number): string[] {
  const out: string[] = [];
  let any = false;
  let all = true;
  for (const ch of catalog.chapters) {
    const levels = chapterLevels(catalog, ch);
    if (levels.length === 0) continue;
    const s = levels.map((l) => stars(l.id));
    if (s.some((x) => x > 0)) any = true;
    if (s.every((x) => x > 0)) out.push(`chapter-${ch.id}`);
    if (s.every((x) => x === 3)) out.push(`chapter-${ch.id}-stars`);
    else all = false;
  }
  if (any) out.unshift('first-solve');
  if (all && any) out.push('all-stars');
  return out;
}

export interface Games {
  readonly available: boolean;
  signedIn(): Promise<boolean>;
  signIn(): Promise<boolean>;
  /** Unlocks every earned achievement that has a Play ID (repeats are ignored by Play). */
  sync(earned: string[]): Promise<void>;
  showAchievements(): Promise<void>;
  save(json: string): Promise<void>;
  load(): Promise<string | null>;
}

class NoGames implements Games {
  readonly available = false;
  async signedIn(): Promise<boolean> {
    return false;
  }
  async signIn(): Promise<boolean> {
    return false;
  }
  async sync(): Promise<void> {}
  async showAchievements(): Promise<void> {}
  async save(): Promise<void> {}
  async load(): Promise<string | null> {
    return null;
  }
}

class PlayGames implements Games {
  readonly available = true;
  private unlocked = new Set<string>();
  constructor(private plugin: PlayGamesPlugin) {}

  async signedIn(): Promise<boolean> {
    try {
      return (await this.plugin.status()).signedIn;
    } catch {
      return false;
    }
  }

  async signIn(): Promise<boolean> {
    try {
      return (await this.plugin.signIn()).signedIn;
    } catch {
      return false;
    }
  }

  async sync(earned: string[]): Promise<void> {
    for (const key of earned) {
      const id = ACHIEVEMENT_IDS[key];
      if (!id || this.unlocked.has(id)) continue;
      try {
        await this.plugin.unlock({ id });
        this.unlocked.add(id);
      } catch {
        // Not signed in or offline: retried on the next sync.
      }
    }
  }

  async showAchievements(): Promise<void> {
    await this.plugin.showAchievements().catch(() => {});
  }

  async save(json: string): Promise<void> {
    await this.plugin.save({ data: json }).catch(() => {});
  }

  async load(): Promise<string | null> {
    try {
      return (await this.plugin.load()).data || null;
    } catch {
      return null;
    }
  }
}

export async function createGames(): Promise<Games> {
  if (!isNative()) return new NoGames();
  const plugin = registerPlugin<PlayGamesPlugin>('PlayGames');
  try {
    return (await plugin.isAvailable()).available ? new PlayGames(plugin) : new NoGames();
  } catch {
    return new NoGames();
  }
}
