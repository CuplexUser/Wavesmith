// The play screen: live field, piece editing, goal HUD, and results.

import type { App, Screen } from '../app';
import { itemCenter } from '../geometry';
import { Editor } from '../input/editor';
import { chapterLevels, nextLevel } from '../levels';
import { countOf, remaining, totalCost } from '../placement';
import { FieldRenderer } from '../render/fieldRenderer';
import { colorsHex, OverlayRenderer } from '../render/overlay';
import { Sim } from '../sim/bridge';
import { Stepper } from '../sim/stepper';
import {
  TOOL_ORDER,
  type Color,
  type Goal,
  type Item,
  type Level,
  type Material,
  type Status,
  type ToolKind,
  type V2,
} from '../types';
import { h, setStyle, setText } from './dom';
import { ICONS, TOOL_ICONS, TOOL_NAMES } from './icons';

const GOAL_LABEL: Record<Goal['kind'], string> = {
  focus: 'Focus',
  silence: 'Silence',
  resonate: 'Resonate',
  sustain: 'Sustain',
};

const MATERIAL_NAME: Record<Material, string> = {
  water: 'Water (n 1.28–1.39)',
  crown: 'Crown glass (n 1.42–1.64)',
  flint: 'Flint glass (n 1.50–1.85)',
};

function colorWords(colors: Color[] | undefined): string {
  if (!colors || colors.length === 3) return 'white';
  return colors.join(' + ');
}

function goalLabel(g: Goal, light: boolean): string {
  if (light && g.kind === 'focus') return `Light · ${colorWords(g.colors)}`;
  if (light && g.kind === 'silence') return `Dark · ${colorWords(g.colors)}`;
  return GOAL_LABEL[g.kind];
}

function goalText(g: Goal, light: boolean): string {
  switch (g.kind) {
    case 'focus':
      return light
        ? `Shine ${colorWords(g.colors)} light on the sensor (${g.threshold}) for ${g.hold}s`
        : `Raise the amplitude at the target to ${g.threshold} and hold it ${g.hold}s`;
    case 'silence':
      return light
        ? `Keep ${colorWords(g.colors)} light off the zone for ${g.hold}s`
        : `Keep the zone below ${g.threshold} for ${g.hold}s once the waves arrive`;
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
  private light: boolean;
  private raf = 0;
  private last = performance.now();
  private overlayDirty = true;
  private announced = false;
  private timeoutAnnounced = false;
  private resultShown = false;
  private toastTimer: number | undefined;
  private resizeObs: ResizeObserver;
  /** Cell index of the first goal, for sampling the live wave there. */
  private probeCell = 0;

  // DOM.
  private root: HTMLElement;
  private stage: HTMLElement;
  private glCanvas = h('canvas', { class: 'layer' });
  private ovCanvas = h('canvas', { class: 'layer overlay' });
  private board = h('div', { class: 'board' });
  private toastEl = h('div', { class: 'toast', role: 'status', 'aria-live': 'polite' });
  private bannerEl = h('div', { class: 'banner', hidden: true });
  private trashEl = h('div', { class: 'trash-hint', hidden: true }, 'Release to remove');
  private pieceBar = h('div', { class: 'piece-bar', hidden: true, role: 'toolbar', 'aria-label': 'Selected piece' });
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
    this.light = this.sim.isLight;
    this.stepper = new Stepper(this.sim.stepsPerSecond);
    this.status = this.sim.status();

    this.board.append(this.glCanvas, this.ovCanvas);
    this.stage = h('div', { class: 'stage' }, this.board, this.pieceBar, this.trashEl, this.toastEl, this.bannerEl);
    this.field = new FieldRenderer(this.glCanvas);
    this.field.setGrid(this.sim.nx, this.sim.ny, this.light ? 'light' : 'sound');
    this.field.gain = this.light ? 2.2 : 1.6;
    this.field.uploadOverlay(this.sim.overlay());
    this.overlay = new OverlayRenderer(this.ovCanvas);
    const g0 = level.goals[0];
    if (g0 && 'pos' in g0) {
      const [x, y] = g0.pos;
      this.probeCell = (Math.floor(y) + this.sim.border) * this.sim.nx + Math.floor(x) + this.sim.border;
    }

    this.editor = new Editor({
      level,
      board: this.board,
      toCells: (x, y) => this.toCells(x, y),
      cellsPerPx: () => level.grid.width / Math.max(1, this.board.clientWidth),
      commit: (items) => this.commit(items),
      preview: (items) => this.preview(items),
      changed: () => this.onEditorChange(),
      redraw: () => {
        this.overlayDirty = true;
        this.updatePieceBar();
      },
      toast: (m) => this.toast(m),
      sound: (kind, item) => {
        app.audio.edit(kind, item);
        if (kind === 'place' || kind === 'move') app.haptics.pulse(0.15);
        if (kind === 'invalid') app.haptics.pulse(0.6);
      },
    });
    this.editor.attach(this.board);

    const btn = (label: string, icon: string, onclick: () => void, cls = 'icon-btn') =>
      h('button', {
        class: cls,
        'aria-label': label,
        title: label,
        html: icon,
        onclick: () => {
          app.audio.click();
          onclick();
        },
      });
    this.pauseBtn = btn('Pause (Space)', ICONS.pause, () => this.togglePause());
    this.fastBtn = btn('Fast forward (F)', ICONS.fast, () => this.toggleFast());
    this.undoBtn = btn('Undo (Ctrl+Z)', ICONS.undo, () => this.editor.undo());
    this.deleteBtn = btn('Remove piece (Del)', ICONS.trash, () => this.editor.deleteSelected());
    const soundBtn = btn('Sound (M)', app.audio.muted ? ICONS.muted : ICONS.sound, () => {
      soundBtn.innerHTML = app.toggleMute() ? ICONS.muted : ICONS.sound;
    });

    this.hintEl = h('p', { class: 'hint', hidden: true }, level.hint ?? '');
    const goals = level.goals.map((g) => {
      const fill = h('div', { class: 'meter-fill' });
      const hold = h('div', { class: 'hold-fill' });
      const value = h('span', { class: 'mono goal-value' });
      const icon = this.light && g.kind === 'focus' ? ICONS.sensor : ICONS[g.kind];
      const root = h(
        'div',
        { class: `goal ${g.kind}`, title: goalText(g, this.light) },
        h('span', { class: 'goal-icon', html: icon }),
        h(
          'div',
          { class: 'goal-body' },
          h('div', { class: 'goal-row' }, h('span', { class: 'goal-label' }, goalLabel(g, this.light)), value),
          h('div', { class: 'meter' }, fill, h('div', { class: 'meter-mark' })),
          h('div', { class: 'hold' }, hold),
        ),
      );
      if (this.light && (g.kind === 'focus' || g.kind === 'silence')) {
        root.style.setProperty('--goal-color', colorsHex(g.colors));
      }
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
      h(
        'section',
        { class: 'tools' },
        h('h2', { class: 'label' }, 'Pieces'),
        this.paletteEl,
        this.budgetEl,
        h(
          'p',
          { class: 'how' },
          'Tap a piece to edit it. Drag it off the board, or use ',
          h('span', { class: 'inline-icon', html: ICONS.trash }),
          ', to remove it.',
        ),
      ),
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

    this.root = h(
      'div',
      { class: `screen play${this.light ? ' light' : ''}` },
      topbar,
      this.stage,
      panel,
      this.resultEl,
    );
    app.root.append(this.root);

    this.buildPalette();
    this.onEditorChange();
    this.resizeObs = new ResizeObserver(() => this.layout());
    this.resizeObs.observe(this.stage);
    this.layout();
    window.addEventListener('keydown', this.onKey);
    app.buckets.reset();
    const all = app.catalog.chapters.flatMap((c) => chapterLevels(app.catalog, c));
    app.audio.enterLevel(this.light ? 'light' : 'sound', Math.max(0, all.findIndex((l) => l.id === level.id)));
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
    this.updatePieceBar();
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

  private preview(items: Item[] | null): void {
    const overlay = items ? this.sim.previewOverlay(items) : null;
    this.field.uploadOverlay(overlay ?? this.sim.overlay());
  }

  private restartRun(): void {
    this.sim.reset();
    this.afterRestart();
  }

  private afterRestart(): void {
    this.field.uploadOverlay(this.sim.overlay());
    this.stepper.reset();
    this.announced = false;
    this.timeoutAnnounced = false;
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
    this.field.uploadField(this.sim.image());
    this.field.draw(this.level.grid.width, this.level.grid.height, this.sim.border);
    // Glyphs animate, so the overlay redraws every frame while running.
    if (n > 0 || this.overlayDirty) {
      this.overlay.draw({
        level: this.level,
        items: this.editor.items,
        selected: this.editor.selected,
        hover: this.editor.hover,
        ghost: this.editor.ghost,
        ghostValid: this.editor.ghostValid,
        blocked: this.editor.blocked,
        snap: this.editor.snap,
        trash: this.editor.trash,
        goals: this.status.goals,
        time: this.status.time,
        resonance: this.sim.resonatorAmplitudes(),
        handleSize: this.editor.handleSize,
      });
      this.overlayDirty = false;
      this.trashEl.hidden = !this.editor.trash;
      this.board.classList.toggle('trash', this.editor.trash);
    }
  };

  private onStatus(): void {
    const st = this.status;
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
      const ratio = g0.value / g0.threshold;
      const kind = g0.kind === 'silence' ? 'silence' : g0.kind === 'focus' ? 'focus' : 'other';
      const wave = this.light ? 1 : (this.sim.field()[this.probeCell] ?? 0) / g0.threshold;
      this.app.audio.update(kind, kind === 'silence' ? ratio : ratio, wave);
      if (g0.kind !== 'silence') this.app.buckets.update(ratio);
    }

    if (st.solved && !this.announced) {
      this.announced = true;
      this.app.progress.record(this.level.id, st.solved.stars);
      this.app.audio.fanfare(st.solved.stars);
      this.app.haptics.success();
      window.setTimeout(() => this.showResult(), 700);
    }
    if (st.timedOut && !this.timeoutAnnounced) {
      this.timeoutAnnounced = true;
      this.app.audio.timeout();
    }
    this.bannerEl.hidden = !st.timedOut;
    if (st.timedOut && this.bannerEl.childElementCount === 0) {
      this.bannerEl.replaceChildren(
        h('span', {}, 'Out of time. Move a piece or restart the run.'),
        h('button', { class: 'btn small', onclick: () => this.restartRun() }, 'Restart'),
      );
    } else if (!st.timedOut) {
      this.bannerEl.replaceChildren();
    }
  }

  // --- Editing UI ---

  private onEditorChange(): void {
    this.overlayDirty = true;
    this.buildPalette();
    this.undoBtn.disabled = !this.editor.canUndo;
    this.deleteBtn.disabled = this.editor.selected === null;
    this.buildTune();
    this.updatePieceBar();
  }

  /** Floating buttons next to the selected piece: rotate, flip a reflector, remove. */
  private updatePieceBar(): void {
    const i = this.editor.selected;
    const item = i !== null ? this.editor.items[i] : undefined;
    if (!item || this.editor.dragging) {
      this.pieceBar.hidden = true;
      return;
    }
    if (this.pieceBar.dataset.for !== `${i}:${item.kind}`) {
      this.pieceBar.dataset.for = `${i}:${item.kind}`;
      const b = (label: string, icon: string, fn: () => void, cls = '') =>
        h('button', {
          class: `bar-btn ${cls}`,
          'aria-label': label,
          title: label,
          html: icon,
          onpointerdown: (e: Event) => e.stopPropagation(),
          onclick: (e: Event) => {
            e.stopPropagation();
            fn();
          },
        });
      const rotatable = item.kind !== 'emitter' && item.kind !== 'resonator';
      this.pieceBar.replaceChildren(
        ...(rotatable
          ? [
              b('Rotate left (Q)', ICONS.rotl, () => this.editor.rotateSelected(-Math.PI / 12)),
              b('Rotate right (E)', ICONS.rotr, () => this.editor.rotateSelected(Math.PI / 12)),
            ]
          : []),
        ...(item.kind === 'reflector' ? [b('Flip bend (X)', ICONS.flip, () => this.editor.flipSelected())] : []),
        b('Remove (Del)', ICONS.trash, () => this.editor.deleteSelected(), 'danger'),
      );
    }
    // Position above the piece, inside the stage.
    const br = this.board.getBoundingClientRect();
    const sr = this.stage.getBoundingClientRect();
    const [cx, cy] = itemCenter(item);
    const top = (item.kind === 'wall' || item.kind === 'reflector'
      ? Math.min(item.a[1], item.b[1])
      : cy - ('size' in item ? Math.max(...item.size) / 2 : 'radii' in item ? Math.max(...item.radii) : 6));
    const x = br.left - sr.left + (cx / this.level.grid.width) * br.width;
    // Leave a clear gap so the bar never covers the piece or its handles.
    let y = br.top - sr.top + (top / this.level.grid.height) * br.height - 60;
    if (y < 4) y = br.top - sr.top + (cy / this.level.grid.height) * br.height + 34;
    this.pieceBar.hidden = false;
    const w = this.pieceBar.offsetWidth || 120;
    setStyle(this.pieceBar, 'left', `${Math.max(4, Math.min(sr.width - w - 4, x - w / 2))}px`);
    setStyle(this.pieceBar, 'top', `${Math.max(4, y)}px`);
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
      const name = entry.material && kind !== 'prism' && kind !== 'slab' ? `Glass lens` : TOOL_NAMES[kind];
      return h(
        'button',
        {
          class: `tool${this.editor.armed === kind ? ' armed' : ''}`,
          disabled: !canAdd,
          'aria-pressed': this.editor.armed === kind ? 'true' : 'false',
          title: `${name} (${i + 1})${entry.maxSize ? `, up to ${entry.maxSize} cells` : ''}${
            entry.material ? `, ${MATERIAL_NAME[entry.material]}` : ''
          }`,
          onclick: () => this.armTool(kind),
        },
        h('span', { class: 'tool-icon', html: TOOL_ICONS[kind] }),
        h('span', { class: 'tool-name' }, name),
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
    this.app.audio.click();
    this.editor.arm(kind);
    if (this.editor.armed) {
      this.toast(`Tap the board to place a ${TOOL_NAMES[kind].toLowerCase()}`);
    }
  }

  /** Sliders for tunable pieces, and the material of glass ones. */
  private buildTune(): void {
    const i = this.editor.selected;
    const item = i !== null ? this.editor.items[i] : undefined;
    const tunable =
      item &&
      (item.kind === 'emitter' ||
        item.kind === 'resonator' ||
        item.kind === 'lens' ||
        item.kind === 'prism' ||
        item.kind === 'slab');
    if (!item || !tunable) {
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
    } else if ((item.kind === 'lens' || item.kind === 'prism' || item.kind === 'slab') && item.material) {
      rows.push(h('p', { class: 'material' }, MATERIAL_NAME[item.material]));
    } else if (item.kind === 'lens') {
      rows.push(
        slider('Wave speed', item.ratio ?? 1, 0.3, 1, 0.05, (v) => `${Math.round(v * 100)}%`, (v) => ({
          ...item,
          ratio: v,
        })),
      );
    }
    const title = item.kind === 'lens' && item.material ? 'Glass lens' : TOOL_NAMES[item.kind];
    this.tuneEl.replaceChildren(h('h2', { class: 'label' }, title), ...rows);
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
    if (this.stepper.paused) this.app.audio.silence();
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
        this.app.go({ screen: 'select' });
        break;
    }
  };

  // --- Results ---

  private showResult(): void {
    const s = this.status.solved;
    if (!s) return;
    this.resultShown = true;
    this.app.audio.silence();
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
