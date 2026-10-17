// Play Games Services: achievements, leaderboards, and a cloud save of the progress JSON. A
// no-op on the web and in builds without a Games project ID (android/.../PlayGamesPlugin.java).

import { registerPlugin } from '@capacitor/core';
import type { Catalog } from '../levels';
import { chapterLevels } from '../levels';
import { isNative } from './native';

interface PlayGamesPlugin {
  isAvailable(): Promise<{ available: boolean }>;
  status(): Promise<{ signedIn: boolean }>;
  signIn(): Promise<{ signedIn: boolean }>;
  unlock(o: { name: string }): Promise<void>;
  showAchievements(): Promise<void>;
  submitScore(o: { name: string; score: number }): Promise<void>;
  showLeaderboard(o: { name?: string }): Promise<void>;
  save(o: { data: string }): Promise<void>;
  load(): Promise<{ data: string }>;
}

// Play IDs live in android/app/src/main/res/values/game-ids.xml, the Play Console's "Get
// resources" export. It names each entry after the title given in the console, so the names
// below must match those titles (lowercase, spaces as "_"). See docs/android.md for the list.

/** Play names of the achievements, keyed by the names earnedAchievements returns. */
export const ACHIEVEMENTS: Record<string, string> = {
  'first-solve': 'first_ripple',
  'chapter-1': 'reflection',
  'chapter-2': 'interference',
  'chapter-3': 'resonance',
  'chapter-4': 'refraction',
  'chapter-5': 'light',
  'chapter-6': 'doppler',
  'chapter-1-stars': 'reflection_mastered',
  'chapter-2-stars': 'interference_mastered',
  'chapter-3-stars': 'resonance_mastered',
  'chapter-4-stars': 'refraction_mastered',
  'chapter-5-stars': 'light_mastered',
  'chapter-6-stars': 'doppler_mastered',
  'all-stars': 'wavesmith',
};

/** Play names of the leaderboards. */
export const LEADERBOARDS = {
  totalStars: 'total_stars',
} as const;

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

/** Stars earned across the whole catalog, the score on the total-stars leaderboard. */
export function totalStars(catalog: Catalog, stars: (id: string) => number): number {
  let total = 0;
  for (const level of catalog.levels.values()) total += stars(level.id);
  return total;
}

export interface Games {
  readonly available: boolean;
  signedIn(): Promise<boolean>;
  signIn(): Promise<boolean>;
  /**
   * Unlocks every earned achievement and submits the star total to its leaderboard (repeats
   * and lower scores are ignored by Play).
   */
  sync(earned: string[], totalStars: number): Promise<void>;
  showAchievements(): Promise<void>;
  showLeaderboards(): Promise<void>;
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
  async showLeaderboards(): Promise<void> {}
  async save(): Promise<void> {}
  async load(): Promise<string | null> {
    return null;
  }
}

class PlayGames implements Games {
  readonly available = true;
  private unlocked = new Set<string>();
  private submittedStars = 0;
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

  async sync(earned: string[], totalStars: number): Promise<void> {
    for (const key of earned) {
      const name = ACHIEVEMENTS[key];
      if (!name || this.unlocked.has(name)) continue;
      try {
        await this.plugin.unlock({ name });
        this.unlocked.add(name);
      } catch {
        // Not signed in or offline: retried on the next sync.
      }
    }
    if (totalStars > this.submittedStars) {
      try {
        await this.plugin.submitScore({ name: LEADERBOARDS.totalStars, score: totalStars });
        this.submittedStars = totalStars;
      } catch {
        // Retried on the next sync.
      }
    }
  }

  async showAchievements(): Promise<void> {
    await this.plugin.showAchievements().catch(() => {});
  }

  async showLeaderboards(): Promise<void> {
    await this.plugin.showLeaderboard({}).catch(() => {});
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
