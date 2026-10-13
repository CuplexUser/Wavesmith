// Shared services and screen routing.

import { AudioEngine } from './audio/engine';
import type { Catalog } from './levels';
import { AmplitudeBuckets, WebHaptics } from './platform/haptics';
import { ProgressStore } from './progress/store';

export type Route = { screen: 'title' } | { screen: 'select' } | { screen: 'play'; levelId: string };

export interface Screen {
  destroy(): void;
}

export class App {
  readonly audio = new AudioEngine();
  readonly haptics = new WebHaptics();
  readonly buckets = new AmplitudeBuckets(this.haptics);
  readonly progress = new ProgressStore();
  private current: Screen | null = null;
  private factories = new Map<Route['screen'], (app: App, route: Route) => Screen>();

  constructor(
    readonly root: HTMLElement,
    readonly catalog: Catalog,
  ) {
    const s = this.progress.settings;
    this.audio.setMuted(s.muted);
    this.haptics.enabled = s.haptics;
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
    const hash = route.screen === 'play' ? `#/play/${route.levelId}` : route.screen === 'select' ? '#/levels' : '#/';
    if (location.hash !== hash) history.replaceState(null, '', hash);
  }

  /** Reads the route from the URL hash, so reloads keep the player's place. */
  routeFromHash(): Route {
    const m = /^#\/play\/(.+)$/.exec(location.hash);
    if (m && [...this.catalog.levels.values()].some((l) => l.id === m[1])) {
      return { screen: 'play', levelId: m[1]! };
    }
    if (location.hash === '#/levels') return { screen: 'select' };
    return { screen: 'title' };
  }

  toggleMute(): boolean {
    const muted = !this.audio.muted;
    this.audio.setMuted(muted);
    this.progress.setSetting('muted', muted);
    return muted;
  }
}
