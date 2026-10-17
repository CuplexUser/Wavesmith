// Settings dialog: sound, haptics, motion, light colors, diagnostics, and progress reset.
// Opens over any screen; changes apply immediately and persist.

import type { App } from '../app';
import { PRIVACY_URL } from '../links';
import { appVersion } from '../platform/native';
import type { Settings } from '../progress/store';
import { h } from './dom';
import { ICONS } from './icons';

type Choice<T> = { value: T; label: string };

/** Play Games sign-in, achievements, and leaderboards. */
function playGamesRow(app: App): HTMLElement {
  const row = h('div', { class: 'setting-actions' });
  const render = async () => {
    if (await app.games.signedIn()) {
      row.replaceChildren(
        h('button', { class: 'btn small', type: 'button', onclick: () => void app.games.showAchievements() }, 'Achievements'),
        h('button', { class: 'btn small', type: 'button', onclick: () => void app.games.showLeaderboards() }, 'Leaderboards'),
      );
      return;
    }
    row.replaceChildren(
      h(
        'button',
        {
          class: 'btn small',
          type: 'button',
          onclick: async () => {
            if (await app.games.signIn()) await app.syncAccounts();
            void render();
          },
        },
        'Sign in to Play Games',
      ),
    );
  };
  void render();
  return row;
}

export function openSettings(app: App, opts: { onTutorial?: () => void } = {}): void {
  const previous = document.activeElement as HTMLElement | null;
  const layer = h('div', { class: 'modal-layer' });

  const toggle = (name: 'muted' | 'haptics' | 'perfStats' | 'gpu', label: string, invert = false, note?: string) => {
    const input = h('input', { type: 'checkbox', role: 'switch' });
    input.checked = invert ? !app.settings[name] : app.settings[name];
    input.addEventListener('change', () => {
      app.setSetting(name, invert ? !input.checked : input.checked);
      app.audio.click();
    });
    return h(
      'label',
      { class: 'setting-row' },
      h('span', { class: 'setting-text' }, h('span', {}, label), note ? h('small', {}, note) : null),
      h('span', { class: 'switch' }, input, h('span', { class: 'switch-track', 'aria-hidden': 'true' })),
    );
  };

  const segmented = <K extends keyof Settings>(name: K, label: string, choices: Choice<Settings[K]>[], note?: string) => {
    const group = h('div', { class: 'segmented', role: 'radiogroup', 'aria-label': label });
    const render = () => {
      group.replaceChildren(
        ...choices.map((c) =>
          h(
            'button',
            {
              type: 'button',
              role: 'radio',
              class: app.settings[name] === c.value ? 'on' : '',
              'aria-checked': app.settings[name] === c.value ? 'true' : 'false',
              onclick: () => {
                app.setSetting(name, c.value);
                app.audio.click();
                render();
              },
            },
            c.label,
          ),
        ),
      );
    };
    render();
    return h(
      'div',
      { class: 'setting-row' },
      h('span', { class: 'setting-text' }, h('span', {}, label), note ? h('small', {}, note) : null),
      group,
    );
  };

  const volume = h('input', {
    type: 'range',
    min: 0,
    max: 1,
    step: 0.05,
    value: app.settings.volume,
    'aria-label': 'Volume',
  });
  volume.addEventListener('input', () => app.setSetting('volume', Number(volume.value)));

  const vibration = typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function';
  let resetArmed = false;
  const resetBtn = h('button', { class: 'btn small danger', type: 'button' }, 'Reset progress');
  resetBtn.addEventListener('click', () => {
    if (!resetArmed) {
      resetArmed = true;
      resetBtn.textContent = 'Tap again to erase all stars';
      return;
    }
    app.progress.resetProgress();
    resetBtn.textContent = 'Progress reset';
    resetBtn.disabled = true;
  });

  const close = () => {
    layer.remove();
    window.removeEventListener('keydown', onKey, true);
    previous?.focus?.();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close();
    }
  };

  const card = h(
    'div',
    { class: 'modal-card settings', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'settings-title' },
    h(
      'header',
      { class: 'modal-head' },
      h('h2', { id: 'settings-title' }, 'Settings'),
      h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Close settings', html: ICONS.close, onclick: close }),
    ),
    h('h3', { class: 'label' }, 'Sound'),
    toggle('muted', 'Sound', true),
    h('label', { class: 'setting-row' }, h('span', { class: 'setting-text' }, 'Volume'), volume),
    toggle('haptics', 'Vibration', false, vibration ? undefined : 'Not supported in this browser'),
    h('h3', { class: 'label' }, 'Display'),
    segmented(
      'reducedMotion',
      'Motion',
      [
        { value: null, label: 'System' },
        { value: false, label: 'Full' },
        { value: true, label: 'Reduced' },
      ],
      'Reduced stills the moving wavefronts and animations',
    ),
    segmented(
      'palette',
      'Light colors',
      [
        { value: 'standard', label: 'Standard' },
        { value: 'colorblind', label: 'Color-blind' },
      ],
      'Red, green, and blue light shown as orange, yellow, and blue',
    ),
    toggle('perfStats', 'Performance stats', false, 'Frame rate and solver timing over the board (P)'),
    'gpu' in navigator
      ? toggle('gpu', 'Use the GPU for backgrounds', false, 'WebGPU, for the title screen. Levels always run on the exact solver.')
      : null,
    app.games.available || app.store.available ? h('h3', { class: 'label' }, 'Google Play') : null,
    app.games.available ? playGamesRow(app) : null,
    app.store.available
      ? h(
          'div',
          { class: 'setting-actions' },
          h(
            'button',
            {
              class: 'btn small',
              type: 'button',
              onclick: async (e: Event) => {
                const b = e.currentTarget as HTMLButtonElement;
                const owned = await app.store.restore();
                if (owned) app.progress.setFullGame(true);
                b.textContent = owned ? 'Full game restored' : 'No purchase found';
              },
            },
            'Restore purchase',
          ),
        )
      : null,
    h('h3', { class: 'label' }, 'Progress'),
    h(
      'div',
      { class: 'setting-actions' },
      opts.onTutorial
        ? h(
            'button',
            {
              class: 'btn small',
              type: 'button',
              onclick: () => {
                close();
                opts.onTutorial?.();
              },
            },
            'Show the tutorial',
          )
        : null,
      resetBtn,
    ),
  );
  // The privacy policy link, and in the Android app the version, to match a phone to a Play release.
  const foot = h(
    'p',
    { class: 'settings-foot' },
    h('a', { href: PRIVACY_URL, target: '_blank', rel: 'noopener' }, 'Privacy policy'),
  );
  card.append(foot);
  void appVersion().then((v) => {
    if (v) foot.prepend(h('span', {}, `Wavesmith ${v}`));
  });
  layer.append(card);
  layer.addEventListener('pointerdown', (e) => {
    if (e.target === layer) close();
  });
  window.addEventListener('keydown', onKey, true);
  document.body.append(layer);
  (card.querySelector('input, button') as HTMLElement | null)?.focus();
}
