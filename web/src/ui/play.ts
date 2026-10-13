// The play screen: live field, piece editing, goal HUD, and results.

import type { App, Screen } from '../app';
import { Editor } from '../input/editor';
import { nextLevel } from '../levels';
import { countOf, remaining, totalCost } from '../placement';
import { FieldRenderer } from '../render/fieldRenderer';
import { OverlayRenderer } from '../render/overlay';
import { Sim } from '../sim/bridge';
import { Stepper } from '../sim/stepper';
import { TOOL_ORDER, type Goal, type Item, type Level, type Status, type ToolKind, type V2 } from '../types';
import { h, setStyle, setText } from './dom';
import { ICONS, TOOL_ICONS, TOOL_NAMES } from './icons';

const GOAL_LABEL: Record<Goal['kind'], string> = {
  focus: 'Focus',
  silence: 'Silence',
  resonate: 'Resonate',
  sustain: 'Sustain',
};

function goalText(g: Goal): string {
  switch (g.kind) {
    case 'focus':
      return `Raise the amplitude at the target to ${g.threshold} and hold it ${g.hold}s`;
    case 'silence':
      return `Keep the zone below ${g.threshold} for ${g.hold}s once the waves arrive`;
    case 'resonate':
      return `Shatter the crystal: it rings at ${g.freq} Hz`;
    case 'sustain':
      return `Hold a standing wave for ${g.hold}s`;
  }
}

export function playScreen(app: App, levelId: string): Screen {
  const level = [...app.catalog.levels.values()].find((l) => l.id === levelId);
  if (!level) {
    app.go({ screen: 'select' });
    return { destroy() {} };
  }
  return new PlayScreen(app, level);
}

class PlayScreen implements Screen {
  private sim: Sim;
  private field: FieldRenderer;
  private overlay: OverlayRenderer;
  private editor: Editor;
  private stepper: Stepper;
  private status: Status;
  private raf = 0;
  private last = performance.now();
  private overlayDirty = true;
  private announced = false;
  private resultShown = false;
  private toastTimer: number | undefined;
  private resizeObs: ResizeObserver;

  // DOM.
  private root: HTMLElement;
  private stage: HTMLElement;
  private glCanvas = h('canvas', { class: 'layer' });
  private ovCanvas = h('canvas', { class: 'layer overlay' });
  private board = h('div', { class: 'board' });
  private toastEl = h('div', { class: 'toast', role: 'status', 'aria-live': 'polite' });
  private bannerEl = h('div', { class: 'banner', hidden: true });
  private paletteEl = h('div', { class: 'palette' });
  private budgetEl = h('div', { class: 'budget' });
  private goalEls: { root: HTMLElement; fill: HTMLElement; hold: HTMLElement; value: HTMLElement }[] = [];
  private timeEl = h('span', { class: 'mono' });
  private energyEl = h('span', { class: 'mono' });
  private energyFill = h('div', { class: 'meter-fill' });
  private tuneEl = h('div', { class: 'tune', hidden: true });
  private pauseBtn: HTMLButtonElement;
  private fastBtn: HTMLButtonElement;
  private undoBtn: HTMLButtonElement;
  private deleteBtn: HTMLButtonElement;
  private hintEl: HTMLElement;
  private resultEl = h('div', { class: 'result-layer', hidden: true });

  constructor(
    private app: App,
    private level: Level,
  ) {
    this.sim = new Sim(level);
    this.stepper = new Stepper(this.sim.stepsPerSecond);
    this.status = this.sim.status();

    this.board.append(this.glCanvas, this.ovCanvas);
    this.stage = h('div', { class: 'stage' }, this.board, this.toastEl, this.bannerEl);
    this.field = new FieldRenderer(this.glCanvas);
    this.field.setGrid(this.sim.nx, this.sim.ny);
    this.field.uploadOverlay(this.sim.overlay());
    this.overlay = new OverlayRenderer(this.ovCanvas);

    this.editor = new Editor({
      level,
      toCells: (x, y) => this.toCells(x, y),
      cellsPerPx: () => level.grid.width / Math.max(1, this.board.clientWidth),
      commit: (items) => this.commit(items),
      changed: () => this.onEditorChange(),
      redraw: () => {
        this.overlayDirty = true;
      },
      toast: (m) => this.toast(m),
      tick: () => app.haptics.pulse(0.1),
    });
    this.editor.attach(this.board);

    const btn = (label: string, icon: string, onclick: () => void, cls = 'icon-btn') =>
      h('button', { class: cls, 'aria-label': label, title: label, html: icon, onclick });
    this.pauseBtn = btn('Pause (Space)', ICONS.pause, () => this.togglePause());
    this.fastBtn = btn('Fast forward (F)', ICONS.fast, () => this.toggleFast());
    this.undoBtn = btn('Undo (Ctrl+Z)', ICONS.undo, () => this.editor.undo());
    this.deleteBtn = btn('Delete piece (Del)', ICONS.trash, () => this.editor.deleteSelected());
    const soundBtn = btn('Sound (M)', app.audio.muted ? ICONS.muted : ICONS.sound, () => {
      soundBtn.innerHTML = app.toggleMute() ? ICONS.muted : ICONS.sound;
    });

    this.hintEl = h('p', { class: 'hint', hidden: true }, level.hint ?? '');
    const goals = level.goals.map((g) => {
      const fill = h('div', { class: 'meter-fill' });
      const hold = h('div', { class: 'hold-fill' });
      const value = h('span', { class: 'mono goal-value' });
      const root = h(
        'div',
        { class: `goal ${g.kind}`, title: goalText(g) },
        h('span', { class: 'goal-icon', html: ICONS[g.kind] }),
        h(
          'div',
          { class: 'goal-body' },
          h('div', { class: 'goal-row' }, h('span', { class: 'goal-label' }, GOAL_LABEL[g.kind]), value),
          h('div', { class: 'meter' }, fill, h('div', { class: 'meter-mark' })),
          h('div', { class: 'hold' }, hold),
        ),
      );
      this.goalEls.push({ root, fill, hold, value });
      return root;
    });

    const topbar = h(
      'header',
      { class: 'topbar' },
      btn('Back to levels (Esc)', ICONS.back, () => app.go({ screen: 'select' })),
      h('div', { class: 'title-block' }, h('span', { class: 'level-id mono' }, level.id), h('h1', {}, level.name)),
      h('div', { class: 'goals' }, ...goals),
      h('div', { class: 'clock' }, this.timeEl),
    );

    const panel = h(
      'aside',
      { class: 'panel' },
      h(
        'section',
        { class: 'brief' },
        h('p', {}, level.description ?? ''),
        level.hint
          ? h(
              'button',
              {
                class: 'link-btn',
                onclick: () => {
                  this.hintEl.hidden = !this.hintEl.hidden;
                },
              },
              h('span', { html: ICONS.hint }),
              'Hint',
            )
          : null,
        this.hintEl,
      ),
      h('section', { class: 'tools' }, h('h2', { class: 'label' }, 'Pieces'), this.paletteEl, this.budgetEl),
      this.tuneEl,
      h(
        'section',
        { class: 'readouts' },
        h('div', { class: 'readout' }, h('span', { class: 'label' }, 'Energy'), this.energyEl),
        h('div', { class: 'meter energy' }, this.energyFill, h('div', { class: 'meter-mark' })),
      ),
      h(
        'section',
        { class: 'controls' },
        this.undoBtn,
        this.deleteBtn,
        btn('Restart run (R)', ICONS.restart, () => this.restartRun()),
        this.pauseBtn,
        this.fastBtn,
        soundBtn,
      ),
    );

    this.root = h('div', { class: 'screen play' }, topbar, this.stage, panel, this.resultEl);
    app.root.append(this.root);

    this.buildPalette();
    this.resizeObs = new ResizeObserver(() => this.layout());
    this.resizeObs.observe(this.stage);
    this.layout();
    window.addEventListener('keydown', this.onKey);
    app.buckets.reset();
    this.raf = requestAnimationFrame(this.frame);
  }

  destroy(): void {
    cancelAnimationFrame(this.raf);
    window.removeEventListener('keydown', this.onKey);
    this.resizeObs.disconnect();
    this.editor.dispose();
    this.sim.dispose();
    window.clearTimeout(this.toastTimer);
  }

  // --- Layout and coordinates ---

  private layout(): void {
    const { width, height } = this.level.grid;
    const cs = getComputedStyle(this.stage);
    const sw = this.stage.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
    const sh = this.stage.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
    const s = Math.max(0.1, Math.min(sw / width, sh / height));
    const w = Math.floor(width * s);
    const hgt = Math.floor(height * s);
    setStyle(this.board, 'width', `${w}px`);
    setStyle(this.board, 'height', `${hgt}px`);
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.field.resize(w, hgt, dpr);
    this.overlay.resize(w, hgt, dpr, width);
    this.overlayDirty = true;
  }

  private toCells(clientX: number, clientY: number): V2 {
    const r = this.board.getBoundingClientRect();
    const { width, height } = this.level.grid;
    return [((clientX - r.left) / r.width) * width, ((clientY - r.top) / r.height) * height];
  }

  // --- Simulation ---

  private commit(items: Item[]): string | null {
    try {
      this.sim.setPlacements(items);
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    }
    this.afterRestart();
    return null;
  }

  private restartRun(): void {
    this.sim.reset();
    this.afterRestart();
  }

  private afterRestart(): void {
    this.field.uploadOverlay(this.sim.overlay());
    this.stepper.reset();
    this.announced = false;
    this.hideResult();
    this.app.buckets.reset();
    this.status = this.sim.status();
    this.overlayDirty = true;
  }

  private frame = (now: number): void => {
    this.raf = requestAnimationFrame(this.frame);
    const n = this.resultShown ? 0 : this.stepper.advance(now - this.last);
    this.last = now;
    if (n > 0) {
      this.sim.step(n);
      this.status = this.sim.status();
      this.onStatus();
    }
    this.field.uploadField(this.sim.field());
    this.field.draw(this.level.grid.width, this.level.grid.height, this.sim.border);
    // Source glyphs animate, so the overlay redraws every frame while running.
    if (n > 0 || this.overlayDirty) {
      this.overlay.draw({
        level: this.level,
        items: this.editor.items,
        selected: this.editor.selected,
        ghost: this.editor.ghost,
        ghostValid: this.editor.ghostValid,
        goals: this.status.goals,
        time: this.status.time,
      });
      this.overlayDirty = false;
    }
  };

  private onStatus(): void {
    const st = this.status;
    // HUD.
    st.goals.forEach((g, i) => {
      const el = this.goalEls[i];
      if (!el) return;
      // The threshold sits at two thirds of the bar.
      const pct = Math.min(1, g.value / g.threshold / 1.5) * 100;
      setStyle(el.fill, 'width', `${pct.toFixed(1)}%`);
      setStyle(el.hold, 'width', `${(g.hold * 100).toFixed(1)}%`);
      setText(el.value, `${g.value.toFixed(g.threshold < 0.1 ? 3 : 2)} / ${g.threshold}`);
      el.root.classList.toggle('met', g.met);
      el.root.classList.toggle('complete', g.complete);
      el.root.classList.toggle('over', g.kind === 'silence' && g.value > g.threshold);
    });
    setText(this.timeEl, `${st.time.toFixed(1)}s / ${st.timeLimit}s`);
    const par = this.level.par.energy;
    setText(this.energyEl, `${st.energy.toFixed(1)} / ${par} par`);
    setStyle(this.energyFill, 'width', `${Math.min(100, (st.energy / par / 1.5) * 100).toFixed(1)}%`);
    this.energyFill.classList.toggle('over', st.energy > par);

    // Sound and haptics follow the first goal.
    const g0 = st.goals[0];
    if (g0) {
      const level = g0.kind === 'silence' ? Math.min(1.5, g0.value / g0.threshold) * 0.6 : g0.value / g0.threshold;
      this.app.audio.update(this.level.sources[0]?.freq ?? 3, level);
      if (g0.kind !== 'silence') this.app.buckets.update(level);
    }

    if (st.solved && !this.announced) {
      this.announced = true;
      this.app.progress.record(this.level.id, st.solved.stars);
      this.app.audio.chime();
      this.app.haptics.success();
      window.setTimeout(() => this.showResult(), 700);
    }
    this.bannerEl.hidden = !st.timedOut;
    if (st.timedOut) {
      this.bannerEl.replaceChildren(
        h('span', {}, 'Out of time. Move a piece or restart the run.'),
        h('button', { class: 'btn small', onclick: () => this.restartRun() }, 'Restart'),
      );
    }
  }

  // --- Editing UI ---

  private onEditorChange(): void {
    this.overlayDirty = true;
    this.buildPalette();
    this.undoBtn.disabled = !this.editor.canUndo;
    this.deleteBtn.disabled = this.editor.selected === null;
    this.buildTune();
  }

  private availableTools(): ToolKind[] {
    return TOOL_ORDER.filter((k) => this.level.inventory[k]);
  }

  private buildPalette(): void {
    const items = this.editor.items;
    const buttons = this.availableTools().map((kind, i) => {
      const entry = this.level.inventory[kind]!;
      const left = entry.count - countOf(items, kind);
      const canAdd = remaining(this.level, items, kind) > 0;
      return h(
        'button',
        {
          class: `tool${this.editor.armed === kind ? ' armed' : ''}`,
          disabled: !canAdd,
          'aria-pressed': this.editor.armed === kind ? 'true' : 'false',
          title: `${TOOL_NAMES[kind]} (${i + 1})${entry.maxSize ? `, up to ${entry.maxSize} cells` : ''}`,
          onclick: () => this.armTool(kind),
        },
        h('span', { class: 'tool-icon', html: TOOL_ICONS[kind] }),
        h('span', { class: 'tool-name' }, TOOL_NAMES[kind]),
        h('span', { class: 'tool-meta mono' }, `×${left} · ${entry.cost}`),
      );
    });
    this.paletteEl.replaceChildren(...buttons);
    const used = totalCost(this.level, items);
    const pips = Array.from({ length: this.level.budget }, (_, i) =>
      h('span', { class: `pip${i < used ? ' used' : ''}${i >= this.level.par.cost ? ' over-par' : ''}` }),
    );
    this.budgetEl.replaceChildren(
      h('span', { class: 'label' }, 'Budget'),
      h('span', { class: 'pips' }, ...pips),
      h('span', { class: 'mono' }, `${used}/${this.level.budget} · par ${this.level.par.cost}`),
    );
  }

  private armTool(kind: ToolKind): void {
    this.editor.arm(kind);
    if (this.editor.armed) {
      this.toast(`Tap the board to place a ${TOOL_NAMES[kind].toLowerCase()}`);
    }
  }

  /** Sliders for tunable pieces (emitter frequency and phase, resonator frequency, lens speed). */
  private buildTune(): void {
    const i = this.editor.selected;
    const item = i !== null ? this.editor.items[i] : undefined;
    if (!item || !(item.kind === 'emitter' || item.kind === 'resonator' || item.kind === 'lens')) {
      this.tuneEl.hidden = true;
      this.tuneEl.replaceChildren();
      return;
    }
    const slider = (
      label: string,
      value: number,
      min: number,
      max: number,
      step: number,
      fmt: (v: number) => string,
      apply: (v: number) => Item,
    ) => {
      const out = h('span', { class: 'mono' }, fmt(value));
      const input = h('input', { type: 'range', min, max, step, value });
      input.addEventListener('input', () => setText(out, fmt(Number(input.value))));
      input.addEventListener('change', () => this.editor.updateSelected(apply(Number(input.value))));
      return h('label', { class: 'slider' }, h('span', { class: 'label' }, label), input, out);
    };
    const rows: HTMLElement[] = [];
    if (item.kind === 'emitter') {
      rows.push(slider('Frequency', item.freq, 0.5, 8, 0.05, (v) => `${v.toFixed(2)} Hz`, (v) => ({ ...item, freq: v })));
      const deg = ((item.phase ?? 0) * 180) / Math.PI;
      rows.push(
        slider('Phase', deg, 0, 360, 5, (v) => `${v.toFixed(0)}°`, (v) => ({ ...item, phase: (v * Math.PI) / 180 })),
      );
    } else if (item.kind === 'resonator') {
      rows.push(slider('Tuning', item.freq, 0.5, 8, 0.05, (v) => `${v.toFixed(2)} Hz`, (v) => ({ ...item, freq: v })));
    } else if (item.kind === 'lens') {
      rows.push(
        slider('Wave speed', item.ratio, 0.3, 1, 0.05, (v) => `${Math.round(v * 100)}%`, (v) => ({ ...item, ratio: v })),
      );
    }
    this.tuneEl.replaceChildren(h('h2', { class: 'label' }, `Tune ${TOOL_NAMES[item.kind]}`), ...rows);
    this.tuneEl.hidden = false;
  }

  private toast(message: string): void {
    setText(this.toastEl, message);
    this.toastEl.classList.add('show');
    window.clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => this.toastEl.classList.remove('show'), 2200);
  }

  private togglePause(): void {
    this.stepper.paused = !this.stepper.paused;
    this.pauseBtn.innerHTML = this.stepper.paused ? ICONS.play : ICONS.pause;
    this.pauseBtn.classList.toggle('active', this.stepper.paused);
    this.stage.classList.toggle('paused', this.stepper.paused);
  }

  private toggleFast(): void {
    this.stepper.speed = this.stepper.speed > 1 ? 1 : 3;
    this.fastBtn.classList.toggle('active', this.stepper.speed > 1);
  }

  private onKey = (e: KeyboardEvent): void => {
    if (e.target instanceof HTMLInputElement) return;
    if (!this.resultEl.hidden) {
      if (e.key === 'Escape' || e.key === 'Enter') {
        e.preventDefault();
        this.hideResult();
      }
      return;
    }
    if (this.editor.onKey(e)) {
      e.preventDefault();
      return;
    }
    const tools = this.availableTools();
    const digit = Number(e.key);
    if (Number.isInteger(digit) && digit >= 1 && digit <= tools.length) {
      this.armTool(tools[digit - 1]!);
      return;
    }
    switch (e.key) {
      case ' ':
        e.preventDefault();
        this.togglePause();
        break;
      case 'r':
      case 'R':
        this.restartRun();
        break;
      case 'f':
      case 'F':
        this.toggleFast();
        break;
      case 'm':
      case 'M':
        this.app.toggleMute();
        break;
      case 'h':
      case 'H':
        this.hintEl.hidden = !this.hintEl.hidden;
        break;
      case 'Escape':
        if (this.editor.selected === null && !this.editor.armed) this.app.go({ screen: 'select' });
        break;
    }
  };

  // --- Results ---

  private showResult(): void {
    const s = this.status.solved;
    if (!s) return;
    this.resultShown = true;
    const next = nextLevel(this.app.catalog, this.level.id);
    const best = this.app.progress.stars(this.level.id);
    const row = (on: boolean, title: string, detail: string) =>
      h(
        'li',
        { class: on ? 'earned' : '' },
        h('span', { class: 'star', html: ICONS.star }),
        h('span', {}, h('strong', {}, title), h('small', { class: 'mono' }, detail)),
      );
    const card = h(
      'div',
      { class: 'result-card', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Level complete' },
      h('p', { class: 'eyebrow' }, `${this.level.id} · Solved in ${s.time.toFixed(1)}s`),
      h('h2', {}, s.stars === 3 ? 'Perfect resonance' : s.stars === 2 ? 'Nicely tuned' : 'Solved'),
      h(
        'ul',
        { class: 'star-list' },
        row(true, 'Solved', `in ${s.time.toFixed(1)}s of ${this.level.timeLimit}s`),
        row(s.costStar, 'Under par cost', `${s.cost} used, par ${this.level.par.cost}`),
        row(s.energyStar, 'Under par energy', `${s.energy.toFixed(1)} used, par ${this.level.par.energy}`),
      ),
      best > s.stars ? h('p', { class: 'best' }, `Your best: ${best} stars`) : null,
      h(
        'div',
        { class: 'result-actions' },
        h('button', { class: 'btn', onclick: () => this.hideResult() }, 'Keep tuning'),
        next
          ? h('button', { class: 'btn primary', onclick: () => this.app.go({ screen: 'play', levelId: next.id }) }, 'Next level')
          : h('button', { class: 'btn primary', onclick: () => this.app.go({ screen: 'select' }) }, 'All levels'),
      ),
    );
    this.resultEl.replaceChildren(card);
    this.resultEl.hidden = false;
    (card.querySelector('.btn.primary') as HTMLButtonElement | null)?.focus();
  }

  private hideResult(): void {
    this.resultShown = false;
    this.resultEl.hidden = true;
    this.last = performance.now();
  }
}
