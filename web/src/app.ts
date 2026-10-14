// Shared services and screen routing.

import { AudioEngine } from './audio/engine';
import type { Catalog } from './levels';
import { earnedAchievements, type Games } from './platform/games';
import { AmplitudeBuckets, type Haptics } from './platform/haptics';
import type { Lifecycle } from './platform/native';
import type { Store } from './platform/store';
import { ProgressStore, type Progress, type Settings, type StorageLike } from './progress/store';
import { setPalette } from './render/palette';
import { decodeLayout } from './share';
import type { Item } from './types';
import type { EditorSession } from './ui/levelEditor';

export type Route =
  | { screen: 'title' }
  | { screen: 'select' }
  /** `layout` comes from a shared link and is placed when the level opens; `custom` is a
   * level being play-tested from the editor. */
  | { screen: 'play'; levelId: string; layout?: Item[]; custom?: EditorSession }
  | { screen: 'editor' };

export interface Screen {
  destroy(): void;
}

/** Device services: web implementations in the browser, Capacitor plugins in the app. */
export interface Platform {
  haptics: Haptics & { enabled: boolean };
  storage: StorageLike | null;
  lifecycle: Lifecycle;
  store: Store;
  games: Games;
}

export class App {
  readonly audio = new AudioEngine();
  readonly haptics: Haptics & { enabled: boolean };
  readonly buckets: AmplitudeBuckets;
  readonly progress: ProgressStore;
  readonly store: Store;
  readonly games: Games;
  private route: Route = { screen: 'title' };
  private activeListeners = new Set<(active: boolean) => void>();
  private cloudTimer: number | undefined;
  private current: Screen | null = null;
  private settingsListeners = new Set<() => void>();
  private systemReducedMotion =
    typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null;
  private factories = new Map<Route['screen'], (app: App, route: Route) => Screen>();

  constructor(
    readonly root: HTMLElement,
    readonly catalog: Catalog,
    readonly platform: Platform,
  ) {
    this.haptics = platform.haptics;
    this.buckets = new AmplitudeBuckets(this.haptics);
    this.progress = new ProgressStore(platform.storage);
    this.store = platform.store;
    this.games = platform.games;
    platform.lifecycle.onActive((active) => {
      if (!active) this.audio.suspend();
      for (const fn of this.activeListeners) fn(active);
    });
    platform.lifecycle.onBack(() => this.back());
    this.applySettings();
    this.systemReducedMotion?.addEventListener('change', () => this.applySettings());
    // Browsers only allow audio after a user gesture.
    const unlock = () => this.audio.start();
    window.addEventListener('pointerdown', unlock, { once: false });
    window.addEventListener('keydown', unlock, { once: false });
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) this.audio.suspend();
    });
  }

  register(screen: Route['screen'], factory: (app: App, route: Route) => Screen): void {
    this.factories.set(screen, factory);
  }

  /** Unlocks every level: a dev build, or the full game was bought. */
  get unlocked(): boolean {
    return import.meta.env.DEV || this.progress.fullGame;
  }

  /** Calls `fn` when the app goes to the background (false) or returns (true). */
  onActive(fn: (active: boolean) => void): () => void {
    this.activeListeners.add(fn);
    return () => this.activeListeners.delete(fn);
  }

  /** Android back button: close a dialog, else step back a screen; false exits the app. */
  private back(): boolean {
    const modal = document.querySelector<HTMLButtonElement>('.modal-layer .modal-head .icon-btn');
    if (modal) {
      modal.click();
      return true;
    }
    switch (this.route.screen) {
      case 'play':
        this.go(this.route.custom ? { screen: 'editor' } : { screen: 'select' });
        return true;
      case 'select':
      case 'editor':
        this.go({ screen: 'title' });
        return true;
      default:
        return false;
    }
  }

  /** Records a result; on improvement, unlocks achievements and updates the cloud save. */
  recordResult(levelId: string, stars: number): void {
    if (!this.progress.record(levelId, stars)) return;
    void this.games.sync(earnedAchievements(this.catalog, (id) => this.progress.stars(id)));
    window.clearTimeout(this.cloudTimer);
    this.cloudTimer = window.setTimeout(() => void this.games.save(JSON.stringify(this.progress.snapshot())), 2000);
  }

  /** Startup work for the app: restore a purchase and merge the cloud save. */
  async syncAccounts(): Promise<void> {
    if (this.store.available && (await this.store.restore())) this.progress.setFullGame(true);
    if (this.games.available && (await this.games.signedIn())) {
      const cloud = await this.games.load();
      if (cloud) {
        try {
          this.progress.merge(JSON.parse(cloud) as Progress);
        } catch {
          // Unreadable cloud save: keep the local one, which overwrites it on the next result.
        }
      }
      await this.games.sync(earnedAchievements(this.catalog, (id) => this.progress.stars(id)));
    }
  }

  go(route: Route): void {
    this.route = route;
    this.current?.destroy();
    this.root.replaceChildren();
    this.audio.leaveLevel();
    const factory = this.factories.get(route.screen);
    if (!factory) throw new Error(`no screen ${route.screen}`);
    try {
      this.current = factory(this, route);
    } catch (e) {
      // A level the core rejects (or any screen that fails to build) shows the reason
      // instead of leaving a blank page.
      console.error(e);
      this.current = this.errorScreen(e);
    }
    const hash =
      route.screen === 'play'
        ? route.custom
          ? '#/editor/test'
          : `#/play/${route.levelId}`
        : route.screen === 'select'
          ? '#/levels'
          : route.screen === 'editor'
            ? '#/editor'
            : '#/';
    if (location.hash !== hash) history.replaceState(null, '', hash);
  }

  private errorScreen(e: unknown): Screen {
    const msg = e instanceof Error ? e.message : String(e);
    this.root.replaceChildren();
    const box = document.createElement('div');
    box.className = 'fatal';
    const title = document.createElement('h1');
    title.textContent = 'This screen couldn’t open';
    const detail = document.createElement('pre');
    detail.textContent = msg;
    const hint = document.createElement('p');
    hint.textContent = 'If you are running from source, rebuild the core with `pnpm wasm`.';
    const back = document.createElement('button');
    back.className = 'btn';
    back.textContent = 'Back to levels';
    back.addEventListener('click', () => this.go({ screen: 'select' }));
    box.append(title, detail, hint, back);
    this.root.append(box);
    return { destroy() {} };
  }

  /** Reads the route from the URL hash, so reloads keep the player's place. */
  routeFromHash(): Route {
    const m = /^#\/play\/([^?]+)(?:\?s=([A-Za-z0-9_-]+))?$/.exec(location.hash);
    if (m && [...this.catalog.levels.values()].some((l) => l.id === m[1])) {
      const layout = m[2] ? decodeLayout(m[2]) : null;
      return layout ? { screen: 'play', levelId: m[1]!, layout } : { screen: 'play', levelId: m[1]! };
    }
    if (location.hash === '#/levels') return { screen: 'select' };
    if (location.hash.startsWith('#/editor')) return { screen: 'editor' };
    return { screen: 'title' };
  }

  toggleMute(): boolean {
    const muted = !this.audio.muted;
    this.setSetting('muted', muted);
    return muted;
  }

  get settings(): Settings {
    return this.progress.settings;
  }

  /** Whether to calm the visuals: the player's choice, or the system setting by default. */
  get reducedMotion(): boolean {
    return this.settings.reducedMotion ?? this.systemReducedMotion?.matches ?? false;
  }

  setSetting<K extends keyof Settings>(name: K, value: Settings[K]): void {
    this.progress.setSetting(name, value);
    this.applySettings();
  }

  /** Calls `fn` whenever a setting changes; returns a function that stops listening. */
  onSettings(fn: () => void): () => void {
    this.settingsListeners.add(fn);
    return () => this.settingsListeners.delete(fn);
  }

  private applySettings(): void {
    const s = this.settings;
    this.audio.setMuted(s.muted);
    this.audio.setVolume(s.volume);
    this.haptics.enabled = s.haptics;
    setPalette(s.palette);
    document.documentElement.classList.toggle('reduce-motion', this.reducedMotion);
    for (const fn of this.settingsListeners) fn();
  }
}
