// Title screen with a live interference pattern behind it.

import type { App, Screen } from '../app';
import { FieldRenderer } from '../render/fieldRenderer';
import { Sim } from '../sim/bridge';
import { GpuSolver } from '../sim/gpuSolver';
import { Stepper } from '../sim/stepper';
import type { Level } from '../types';
import { h } from './dom';
import { openSettings } from './settings';
import { ICONS } from './icons';

/** Three sources with slightly different pitches, so the pattern slowly drifts. */
const DEMO: Level = {
  id: 'demo',
  name: 'Demo',
  chapter: 0,
  grid: { width: 288, height: 162 },
  medium: { c: 60, damping: 0.05 },
  sources: [
    { kind: 'point', pos: [104, 70], freq: 2.4, amp: 0.6 },
    { kind: 'point', pos: [184, 70], freq: 2.4, amp: 0.6, phase: 1.2 },
    { kind: 'point', pos: [144, 122], freq: 2.46, amp: 0.5 },
  ],
  goals: [{ kind: 'focus', pos: [144, 20], radius: 2, threshold: 1000, hold: 1 }],
  inventory: {},
  budget: 0,
  par: { cost: 0, energy: 0 },
  timeLimit: 600,
};

export function titleScreen(app: App): Screen {
  const canvas = h('canvas', { class: 'title-bg', 'aria-hidden': 'true' });
  const total = Object.values(app.progress.all()).reduce((a, b) => a + b, 0);
  const max = [...app.catalog.levels.values()].length * 3;
  const soundBtn = h('button', {
    class: 'icon-btn',
    'aria-label': 'Toggle sound',
    html: app.audio.muted ? ICONS.muted : ICONS.sound,
    onclick: () => {
      soundBtn.innerHTML = app.toggleMute() ? ICONS.muted : ICONS.sound;
    },
  });
  const root = h(
    'div',
    { class: 'screen title' },
    canvas,
    h('div', { class: 'title-scrim' }),
    h(
      'main',
      { class: 'title-card' },
      h('p', { class: 'eyebrow' }, 'A puzzle game about real waves'),
      h('h1', { class: 'wordmark' }, 'Wavesmith'),
      h(
        'p',
        { class: 'tagline' },
        'Bend, focus, and silence sound. Every ripple on screen is a live simulation, so every solution is real physics.',
      ),
      h(
        'div',
        { class: 'title-actions' },
        h('button', { class: 'btn primary', onclick: () => app.go({ screen: 'select' }) }, total > 0 ? 'Continue' : 'Play'),
        soundBtn,
        h('button', { class: 'icon-btn', 'aria-label': 'Settings', html: ICONS.gear, onclick: () => openSettings(app) }),
      ),
      total > 0 ? h('p', { class: 'title-progress' }, `${total} / ${max} stars`) : null,
      h('button', { class: 'link-btn title-editor', onclick: () => app.go({ screen: 'editor' }) }, 'Level editor'),
    ),
  );
  app.root.append(root);

  let renderer: FieldRenderer | null = null;
  let sim: Sim | null = null;
  let raf = 0;
  try {
    renderer = new FieldRenderer(canvas);
    sim = new Sim(DEMO);
    renderer.setGrid(sim.nx, sim.ny);
    renderer.uploadOverlay(sim.overlay());
    renderer.gain = 3;
    // Warm up so the pattern is already formed.
    sim.step(sim.stepsPerSecond * 4);
  } catch (e) {
    console.warn('Title background disabled:', e);
  }
  // The background is display-only, so it may run on the GPU when WebGPU is available
  // (gameplay always uses the deterministic WASM core). Until it is ready, the core runs it.
  let gpu: GpuSolver | null = null;
  let disposed = false;
  if (sim && app.settings.gpu) {
    void GpuSolver.create(sim)
      .then((g) => {
        if (disposed) g?.dispose();
        else if (g) {
          // Catch up to the core's warm-up so the pattern doesn't restart.
          g.step(sim!.stepsPerSecond * 4);
          gpu = g;
        }
      })
      .catch(() => {});
  }
  const stepper = new Stepper(sim?.stepsPerSecond ?? 120);
  stepper.speed = 0.6;
  let last = performance.now();
  const frame = (now: number) => {
    raf = requestAnimationFrame(frame);
    if (!renderer || !sim) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    renderer.resize(DEMO.grid.width * 3, DEMO.grid.height * 3, dpr);
    // Reduced motion: a still frame of the pattern.
    const n = app.reducedMotion ? 0 : stepper.advance(now - last);
    last = now;
    if (gpu) {
      gpu.step(n);
      renderer.uploadField(gpu.field());
    } else {
      sim.step(n);
      renderer.uploadField(sim.field());
    }
    renderer.draw(DEMO.grid.width, DEMO.grid.height, sim.border);
  };
  raf = requestAnimationFrame(frame);

  return {
    destroy() {
      cancelAnimationFrame(raf);
      disposed = true;
      gpu?.dispose();
      sim?.dispose();
    },
  };
}
