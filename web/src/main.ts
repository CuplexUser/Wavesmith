import './styles.css';

import { App } from './app';
import { createGames } from './platform/games';
import { createHaptics, createLifecycle, createStorage } from './platform/native';
import { createStore } from './platform/store';
import { loadCatalog } from './levels';
import { loadCore } from './sim/bridge';
import { levelEditorScreen } from './ui/levelEditor';
import { levelSelectScreen } from './ui/levelSelect';
import { playScreen } from './ui/play';
import { titleScreen } from './ui/title';

async function boot(): Promise<void> {
  const root = document.getElementById('app')!;
  try {
    const [catalog, haptics, storage, lifecycle, games] = await Promise.all([
      loadCatalog(),
      createHaptics(),
      createStorage(),
      createLifecycle(),
      createGames(),
      loadCore(),
    ]);
    const app = new App(root, catalog, { haptics, storage, lifecycle, store: createStore(), games });
    app.register('title', (a) => titleScreen(a));
    app.register('select', (a) => levelSelectScreen(a));
    app.register('play', (a, r) =>
      r.screen === 'play' ? playScreen(a, r.levelId, r.layout, r.custom) : playScreen(a, ''),
    );
    app.register('editor', (a) => levelEditorScreen(a));
    app.go(app.routeFromHash());
    // Browser back/forward and edited URLs.
    window.addEventListener('hashchange', () => app.go(app.routeFromHash()));
    // Purchases and cloud saves load in the background; the select screen reflects them
    // the next time it opens.
    void app.syncAccounts();
  } catch (e) {
    console.error(e);
    const msg = e instanceof Error ? e.message : String(e);
    root.innerHTML = '';
    const box = document.createElement('div');
    box.className = 'fatal';
    box.innerHTML = '<h1>Wavesmith couldn’t start</h1><p>This game needs WebAssembly and WebGL2.</p>';
    const detail = document.createElement('pre');
    detail.textContent = msg;
    box.append(detail);
    root.append(box);
  }
}

void boot();
