// Shared services and screen routing.

import { AudioEngine } from './audio/engine';
import type { Catalog } from './levels';
import { AmplitudeBuckets, WebHaptics } from './platform/haptics';
import { ProgressStore, type Settings } from './progress/store';
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

export class App {
  readonly audio = new AudioEngine();
  readonly haptics = new WebHaptics();
  readonly buckets = new AmplitudeBuckets(this.haptics);
  readonly progress = new ProgressStore();
  private current: Screen | null = null;
  private settingsListeners = new Set<() => void>();
  private systemReducedMotion =
    typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null;
  private factories = new Map<Route['screen'], (app: App, route: Route) => Screen>();

  constructor(
    readonly root: HTMLElement,
    readonly catalog: Catalog,
  ) {
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

  go(route: Route): void {
    this.current?.destroy();
    this.root.replaceChildren();
    this.audio.leaveLevel();
    const factory = this.factories.get(route.screen);
    if (!factory) throw new Error(`no screen ${route.screen}`);
    this.current = factory(this, route);
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
