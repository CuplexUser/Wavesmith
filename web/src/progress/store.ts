// Best star counts per level, kept in localStorage. Storage can be missing or throw (private
// windows, blocked site data), so every access is guarded and the game works without it.

const KEY = 'wavesmith.progress.v1';

export interface Progress {
  stars: Record<string, number>;
  /** Player settings that should survive reloads. */
  muted?: boolean;
  haptics?: boolean;
}

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function defaultStorage(): StorageLike | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

export class ProgressStore {
  private data: Progress;

  constructor(private storage: StorageLike | null = defaultStorage()) {
    this.data = this.read();
  }

  private read(): Progress {
    try {
      const raw = this.storage?.getItem(KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as Partial<Progress>;
        if (parsed && typeof parsed.stars === 'object' && parsed.stars !== null) {
          return { ...parsed, stars: { ...parsed.stars } };
        }
      }
    } catch {
      // Corrupt or unavailable storage: start fresh.
    }
    return { stars: {} };
  }

  private write(): void {
    try {
      this.storage?.setItem(KEY, JSON.stringify(this.data));
    } catch {
      // Quota or permission errors only cost persistence.
    }
  }

  stars(levelId: string): number {
    return this.data.stars[levelId] ?? 0;
  }

  /** Records a result, keeping the best. Returns true if it improved. */
  record(levelId: string, stars: number): boolean {
    if (stars <= this.stars(levelId)) return false;
    this.data.stars[levelId] = stars;
    this.write();
    return true;
  }

  get settings(): { muted: boolean; haptics: boolean } {
    return { muted: this.data.muted ?? false, haptics: this.data.haptics ?? true };
  }

  setSetting(name: 'muted' | 'haptics', value: boolean): void {
    this.data[name] = value;
    this.write();
  }

  all(): Readonly<Record<string, number>> {
    return this.data.stars;
  }
}
