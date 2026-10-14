// Native (Capacitor/Android) services behind the same interfaces the web build uses. Plugin
// modules load only inside the app, so the web bundle doesn't carry them.

import { Capacitor } from '@capacitor/core';
import type { StorageLike } from '../progress/store';
import { WebHaptics, type Haptics } from './haptics';

export function isNative(): boolean {
  return Capacitor.isNativePlatform();
}

/** Haptics through the Capacitor plugin: real impact effects instead of buzzes. */
class NativeHaptics implements Haptics {
  enabled = true;
  constructor(private plugin: typeof import('@capacitor/haptics')) {}

  pulse(strength: number): void {
    if (!this.enabled) return;
    const { ImpactStyle } = this.plugin;
    const style = strength > 0.6 ? ImpactStyle.Heavy : strength > 0.3 ? ImpactStyle.Medium : ImpactStyle.Light;
    void this.plugin.Haptics.impact({ style }).catch(() => {});
  }

  success(): void {
    if (!this.enabled) return;
    void this.plugin.Haptics.notification({ type: this.plugin.NotificationType.Success }).catch(() => {});
  }
}

export async function createHaptics(): Promise<Haptics & { enabled: boolean }> {
  if (!isNative()) return new WebHaptics();
  try {
    return new NativeHaptics(await import('@capacitor/haptics'));
  } catch {
    return new WebHaptics();
  }
}

/**
 * Progress storage. In the app it is kept in native preferences (which survive WebView data
 * clears and app updates), mirrored to localStorage; reads are served from memory because
 * the store is synchronous. On the web it is plain localStorage.
 */
export async function createStorage(): Promise<StorageLike | null> {
  let local: StorageLike | null = null;
  try {
    local = globalThis.localStorage ?? null;
  } catch {
    local = null;
  }
  if (!isNative()) return local;
  try {
    const { Preferences } = await import('@capacitor/preferences');
    const memory = new Map<string, string>();
    const { keys } = await Preferences.keys();
    for (const key of keys) {
      const { value } = await Preferences.get({ key });
      if (value !== null) memory.set(key, value);
    }
    return {
      getItem: (key) => memory.get(key) ?? safeGet(local, key),
      setItem: (key, value) => {
        memory.set(key, value);
        void Preferences.set({ key, value }).catch(() => {});
        try {
          local?.setItem(key, value);
        } catch {
          // Mirror only.
        }
      },
    };
  } catch {
    return local;
  }
}

function safeGet(s: StorageLike | null, key: string): string | null {
  try {
    return s?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

export interface Lifecycle {
  /** The app went to the background (false) or came back (true). */
  onActive(fn: (active: boolean) => void): void;
  /** The Android back button; return true when handled. */
  onBack(fn: () => boolean): void;
  exit(): void;
}

/** App lifecycle: background/foreground and the back button (browser tabs: visibility only). */
export async function createLifecycle(): Promise<Lifecycle> {
  const active: ((a: boolean) => void)[] = [];
  const back: (() => boolean)[] = [];
  document.addEventListener('visibilitychange', () => active.forEach((f) => f(!document.hidden)));
  let exit = () => {};
  if (isNative()) {
    try {
      const { App } = await import('@capacitor/app');
      void App.addListener('appStateChange', ({ isActive }) => active.forEach((f) => f(isActive)));
      void App.addListener('backButton', () => {
        if (!back.some((f) => f())) void App.exitApp();
      });
      exit = () => void App.exitApp();
    } catch {
      // Lifecycle events are a nicety; the visibility listener still pauses.
    }
  }
  return {
    onActive: (fn) => active.push(fn),
    onBack: (fn) => back.push(fn),
    exit,
  };
}
