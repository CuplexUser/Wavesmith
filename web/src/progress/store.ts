// Best star counts per level, kept in localStorage. Storage can be missing or throw (private
// windows, blocked site data), so every access is guarded and the game works without it.

const KEY = 'wavesmith.progress.v1';

/** Light-level color mapping: the physical red/green/blue, or one that stays distinct for
 * the common forms of color blindness. */
export type Palette = 'standard' | 'colorblind';

export interface Settings {
  muted: boolean;
  /** Master volume, 0..1. */
  volume: number;
  haptics: boolean;
  /** Calmer visuals; `null` follows the system's reduced-motion setting. */
  reducedMotion: boolean | null;
  palette: Palette;
  /** Frame rate and solver timing over the board (P in a level). */
  perfStats: boolean;
  /** The Chapter 1 walkthrough has been shown. */
  tutorialSeen: boolean;
  /** Run display-only simulations (the title screen) on the GPU when WebGPU is available. */
  gpu: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  muted: false,
  volume: 0.9,
  haptics: true,
  reducedMotion: null,
  palette: 'standard',
  perfStats: false,
  tutorialSeen: false,
  gpu: true,
};

export interface Progress {
  stars: Record<string, number>;
  /** Player settings that should survive reloads. */
  settings?: Partial<Settings>;
  /** Older saves kept these two at the top level. */
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

  get settings(): Settings {
    const legacy: Partial<Settings> = {};
    if (this.data.muted !== undefined) legacy.muted = this.data.muted;
    if (this.data.haptics !== undefined) legacy.haptics = this.data.haptics;
    return { ...DEFAULT_SETTINGS, ...legacy, ...this.data.settings };
  }

  setSetting<K extends keyof Settings>(name: K, value: Settings[K]): void {
    this.data.settings = { ...this.data.settings, [name]: value };
    this.write();
  }

  /** Forgets every star (settings stay). */
  resetProgress(): void {
    this.data.stars = {};
    this.write();
  }

  /** The whole save, for moving it to native storage or a cloud save. */
  snapshot(): Progress {
    return JSON.parse(JSON.stringify(this.data)) as Progress;
  }

  /**
   * Merges another save (native storage, cloud save) into this one, keeping the best stars
   * per level. Settings from `other` fill in only what this save hasn't set.
   */
  merge(other: Progress): void {
    for (const [id, n] of Object.entries(other.stars ?? {})) {
      if (typeof n === 'number' && n > this.stars(id)) this.data.stars[id] = Math.min(3, Math.floor(n));
    }
    this.data.settings = { ...other.settings, ...this.data.settings };
    this.write();
  }

  all(): Readonly<Record<string, number>> {
    return this.data.stars;
  }
}
