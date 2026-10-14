// Chapter and level picker.

import type { App, Screen } from '../app';
import type { Level } from '../types';
import { chapterLevels, levelStates } from '../levels';
import { PLAY_STORE_URL } from '../platform/store';
import { drawThumbnail } from '../render/thumbnail';
import { h } from './dom';
import { openSettings } from './settings';
import { ICONS } from './icons';

function stars(n: number): HTMLElement {
  return h(
    'span',
    { class: 'stars', 'aria-label': `${n} of 3 stars` },
    ...[0, 1, 2].map((i) => h('span', { class: i < n ? 'star on' : 'star', html: ICONS.star })),
  );
}

const thumbs: { canvas: HTMLCanvasElement; level: Level }[] = [];

function thumb(level: Level): HTMLCanvasElement {
  const canvas = h('canvas', { class: 'level-thumb', 'aria-hidden': 'true' });
  thumbs.push({ canvas, level });
  return canvas;
}

/** The way into the paid chapters: the Play purchase in the app, the store listing on the web. */
function unlockBanner(app: App): HTMLElement {
  const box = h('div', { class: 'unlock-banner' });
  if (app.store.available) {
    const buy = h('button', { class: 'btn primary small' }, 'Unlock the full game');
    void app.store.price().then((p) => {
      if (p) buy.textContent = `Unlock the full game · ${p}`;
    });
    buy.addEventListener('click', async () => {
      buy.disabled = true;
      const r = await app.store.buy();
      buy.disabled = false;
      if (r === 'owned') {
        app.progress.setFullGame(true);
        app.go({ screen: 'select' });
      }
    });
    const restore = h('button', { class: 'link-btn' }, 'Restore purchase');
    restore.addEventListener('click', async () => {
      if (await app.store.restore()) {
        app.progress.setFullGame(true);
        app.go({ screen: 'select' });
      } else restore.textContent = 'No purchase found';
    });
    box.append(h('p', {}, 'Part of the full game: one purchase opens every chapter, now and to come.'), buy, restore);
  } else {
    box.append(
      h('p', {}, 'Part of the full game on Android. The free chapters stay free on the web.'),
      h('a', { class: 'btn small', href: PLAY_STORE_URL, target: '_blank', rel: 'noopener' }, 'Get it on Google Play'),
    );
  }
  return box;
}

export function levelSelectScreen(app: App): Screen {
  thumbs.length = 0;
  const states = levelStates(app.catalog, (id) => app.progress.stars(id), app.unlocked);
  const sections = app.catalog.chapters.map((ch) => {
    const levels = chapterLevels(app.catalog, ch);
    const earned = levels.reduce((a, l) => a + app.progress.stars(l.id), 0);
    const header = h(
      'header',
      { class: 'chapter-head' },
      h('span', { class: 'chapter-num' }, `Chapter ${ch.id}`),
      h('h2', {}, ch.name),
      levels.length > 0 ? h('span', { class: 'chapter-stars' }, `${earned} / ${levels.length * 3}`) : null,
    );
    const paidLocked = !ch.free && !app.unlocked && levels.length > 0;
    if (levels.length === 0) {
      return h(
        'section',
        { class: 'chapter soon' },
        header,
        h('p', { class: 'soon-note' }, ch.free ? 'Coming soon' : 'Coming soon in the full game'),
      );
    }
    const cards = levels.map((level, i) => {
      const state = states.get(level.id) ?? 'locked';
      const locked = state === 'locked';
      return h(
        'button',
        {
          class: `level-card ${state}${level.medium.light ? ' light' : ''}`,
          disabled: locked,
          'aria-label': `${level.id} ${level.name}${locked ? ' (locked)' : ''}`,
          onclick: () => app.go({ screen: 'play', levelId: level.id }),
        },
        thumb(level),
        h('span', { class: 'level-num' }, String(i + 1).padStart(2, '0')),
        h('span', { class: 'level-name' }, level.name),
        locked ? h('span', { class: 'lock', html: ICONS.lock }) : stars(app.progress.stars(level.id)),
      );
    });
    return h(
      'section',
      { class: 'chapter' },
      header,
      paidLocked ? unlockBanner(app) : null,
      h('div', { class: 'level-grid' }, ...cards),
    );
  });

  const root = h(
    'div',
    { class: 'screen select' },
    h(
      'header',
      { class: 'select-bar' },
      h('button', {
        class: 'icon-btn',
        'aria-label': 'Back to title',
        html: ICONS.back,
        onclick: () => app.go({ screen: 'title' }),
      }),
      h('h1', {}, 'Levels'),
      h('button', {
        class: 'icon-btn settings-btn',
        'aria-label': 'Settings',
        html: ICONS.gear,
        onclick: () => openSettings(app),
      }),
    ),
    h('main', { class: 'chapters' }, ...sections),
  );
  app.root.append(root);
  // Thumbnails need their laid-out width.
  for (const t of thumbs) drawThumbnail(t.canvas, t.level);
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') app.go({ screen: 'title' });
  };
  window.addEventListener('keydown', onKey);
  return {
    destroy() {
      window.removeEventListener('keydown', onKey);
    },
  };
}
