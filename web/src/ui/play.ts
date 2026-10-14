// The play screen: live field, piece editing, goal HUD, and results.

import type { App, Screen } from '../app';
import { itemCenter } from '../geometry';
import { Editor } from '../input/editor';
import { chapterLevels, nextLevel } from '../levels';
import { countOf, remaining, totalCost } from '../placement';
import { FieldRenderer } from '../render/fieldRenderer';
import { OverlayRenderer } from '../render/overlay';
import { colorsHex } from '../render/palette';
import { Sim } from '../sim/bridge';
import { PerfMonitor } from '../sim/perf';
import { Stepper } from '../sim/stepper';
import { shareUrl } from '../share';
import { checkPlacements, tunes } from '../placement';
import { MAX_SOURCE_SPEED } from '../geometry';
import {
  TOOL_ORDER,
  type Tune,
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
import { openSettings } from './settings';
import { Tutorial } from './tutorial';
import { saveSession, type EditorSession } from './levelEditor';
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

export function playScreen(app: App, levelId: string, layout?: Item[], custom?: EditorSession): Screen {
  const level = custom?.level ?? [...app.catalog.levels.values()].find((l) => l.id === levelId);
  if (!level) {
    app.go({ screen: 'select' });
    return { destroy() {} };
  }
  return new PlayScreen(app, level, custom ? custom.solution : layout, custom);
}

class PlayScreen implements Screen {
  private sim: Sim;
  private field: FieldRenderer;
  private overlay: OverlayRenderer;
  private editor: Editor;
  private stepper: Stepper;
  private perf: PerfMonitor;
  /** Normal sim speed: 1, or faster in light levels on devices that can afford it. */
  private baseSpeed = 1;
  private fast = false;
  private speedChosen = false;
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
  private unlisten: () => void;
  /** Set when the level has a walkthrough to replay. */
  private showTutorial: (() => void) | null = null;
  /** Cell index of the first goal, for sampling the live wave there. */
  private probeCell = 0;

  // DOM.
  private root: HTMLElement;
  private stage: HTMLElement;
  private glCanvas = h('canvas', { class: 'layer' });
  private ovCanvas = h('canvas', { class: 'layer overlay' });
  private board = h('div', {
    class: 'board',
    tabindex: 0,
    role: 'application',
    'aria-roledescription': 'puzzle board',
    'aria-describedby': 'board-keys',
  });
  /** Screen-reader announcements: goal progress, results, and the selected piece. */
  private srEl = h('div', { class: 'sr-only', role: 'status', 'aria-live': 'polite' });
  private lastGoalState: string[] = [];
  private lastSelection = '';
  private toastEl = h('div', { class: 'toast', role: 'status', 'aria-live': 'polite' });
  private bannerEl = h('div', { class: 'banner', hidden: true });
  private trashEl = h('div', { class: 'trash-hint', hidden: true }, 'Release to remove');
  private slowEl = h('div', { class: 'slow-badge', hidden: true, title: 'This device is running the simulation slower than real time' }, 'Slow motion');
  private statsEl = h('div', { class: 'perf-stats mono', hidden: true, 'aria-hidden': 'true' });
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
    layout?: Item[],
    /** Set when play-testing a level from the editor: layouts are saved as its solution. */
    private custom?: EditorSession,
  ) {
    this.sim = new Sim(level);
    this.light = this.sim.isLight;
    this.stepper = new Stepper(this.sim.stepsPerSecond);
    this.perf = new PerfMonitor(this.sim.stepsPerSecond, Math.min(window.devicePixelRatio || 1, 2));
    this.status = this.sim.status();

    this.board.append(this.glCanvas, this.ovCanvas);
    this.board.setAttribute('aria-label', `${level.name}: ${level.description ?? ''}`);
    this.stage = h(
      'div',
      { class: 'stage' },
      this.board,
      this.pieceBar,
      this.trashEl,
      this.toastEl,
      this.bannerEl,
      this.slowEl,
      this.statsEl,
    );
    this.field = new FieldRenderer(this.glCanvas);
    const display = level.display ?? {};
    this.field.setGrid(this.sim.nx, this.sim.ny, this.light ? 'light' : display.palette === 'water' ? 'water' : 'sound');
    this.field.gain = display.gain ?? (this.light ? 2.2 : 1.6);
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
    const shareBtn = btn('Copy a link to this layout', ICONS.share, () => void this.share());
    const settingsBtn = btn('Settings', ICONS.gear, () => openSettings(app, { onTutorial: () => this.showTutorial?.() }));
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
      btn(custom ? 'Back to the editor (Esc)' : 'Back to levels (Esc)', ICONS.back, () => this.leave()),
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
        h(
          'p',
          { class: 'how keys', id: 'board-keys' },
          'Keys: number keys pick a piece, Enter places it, [ and ] select pieces, arrows move them (Shift for 5 cells), Q and E rotate, Delete removes, Space pauses, R restarts.',
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
        shareBtn,
        soundBtn,
        settingsBtn,
      ),
    );

    this.root = h(
      'div',
      { class: `screen play${this.light ? ' light' : ''}` },
      topbar,
      this.stage,
      panel,
      this.resultEl,
      this.srEl,
    );
    app.root.append(this.root);

    this.buildPalette();
    if (layout && layout.length > 0) this.loadShared(layout);
    this.onEditorChange();
    this.unlisten = app.onSettings(() => this.applySettings(soundBtn));
    this.applySettings(soundBtn);
    this.resizeObs = new ResizeObserver(() => this.layout());
    this.resizeObs.observe(this.stage);
    this.layout();
    window.addEventListener('keydown', this.onKey);
    app.buckets.reset();
    const all = app.catalog.chapters.flatMap((c) => chapterLevels(app.catalog, c));
    app.audio.enterLevel(this.light ? 'light' : 'sound', Math.max(0, all.findIndex((l) => l.id === level.id)));
    this.raf = requestAnimationFrame(this.frame);
    if (level.id === '1-1') {
      this.showTutorial = () => this.startTutorial();
      if (!app.settings.tutorialSeen && !layout) this.startTutorial();
    }
  }

  /** The Chapter 1 walkthrough. */
  private startTutorial(): void {
    const level = this.level;
    const src = level.sources[0];
    const goal = level.goals[0];
    const boardRect = (p: V2, r: number): DOMRect => {
      const b = this.board.getBoundingClientRect();
      const k = b.width / level.grid.width;
      return new DOMRect(b.left + (p[0] - r) * k, b.top + (p[1] - r) * k, 2 * r * k, 2 * r * k);
    };
    const startCount = this.editor.items.length;
    new Tutorial(
      this.root,
      [
        {
          title: 'Every ripple is real',
          body: 'This speaker sends out sound waves. They spread, bounce off walls, and add up or cancel, just like real sound.',
          target: () => (src && src.kind === 'point' ? boardRect(src.pos, 12) : null),
        },
        {
          title: 'Reach the target',
          body: 'Make the waves strong here and keep them strong. The meter at the top fills as the target gets louder.',
          target: () => (goal && 'pos' in goal ? boardRect(goal.pos, 14) : null),
        },
        {
          title: 'Pick a piece',
          body: 'Choose the wall from your pieces. Each piece costs part of your budget.',
          target: () => this.paletteEl.getBoundingClientRect(),
          done: () => this.editor.armed !== null,
        },
        {
          title: 'Place it on the board',
          body: 'Tap the board to drop it, then drag it to move it or drag its ends to turn it. The run restarts each time you change something.',
          target: () => this.board.getBoundingClientRect(),
          done: () => this.editor.items.length > startCount,
        },
        {
          title: 'Bounce the waves',
          body: 'Angle the wall so the waves reflect down past the barrier onto the target. Solve it, then use fewer parts and less energy for more stars.',
          target: () => this.board.getBoundingClientRect(),
        },
      ],
      () => this.app.setSetting('tutorialSeen', true),
    );
  }

  destroy(): void {
    cancelAnimationFrame(this.raf);
    window.removeEventListener('keydown', this.onKey);
    this.resizeObs.disconnect();
    this.unlisten();
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
    const dpr = this.perf.dpr;
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
    if (this.custom) {
      this.custom.solution = items;
      saveSession(this.custom);
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
    this.lastGoalState = [];
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
    const dt = now - this.last;
    const n = this.resultShown ? 0 : this.stepper.advance(dt);
    this.last = now;
    if (n > 0) {
      const t0 = performance.now();
      this.sim.step(n);
      this.perf.record(dt, n, performance.now() - t0, this.stepper.speed);
      this.stepper.budget = this.perf.stepBudget();
      this.status = this.sim.status();
      this.onStatus();
      this.tunePerformance();
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
        // Reduced motion freezes the pulsing glyphs.
        time: this.app.reducedMotion ? 0 : this.status.time,
        simTime: this.status.time,
        armed: this.editor.armed,
        resonance: this.sim.resonatorAmplitudes(),
        handleSize: this.editor.handleSize,
      });
      this.overlayDirty = false;
      this.trashEl.hidden = !this.editor.trash;
      this.board.classList.toggle('trash', this.editor.trash);
    }
  };

  private applySettings(soundBtn: HTMLElement): void {
    const s = this.app.settings;
    this.field.waves = this.app.reducedMotion ? 0 : 1;
    this.statsEl.hidden = !s.perfStats;
    soundBtn.innerHTML = s.muted ? ICONS.muted : ICONS.sound;
    // Goal accents follow the light palette.
    this.level.goals.forEach((g, i) => {
      const el = this.goalEls[i];
      if (el && this.light && (g.kind === 'focus' || g.kind === 'silence')) {
        el.root.style.setProperty('--goal-color', colorsHex(g.colors));
      }
    });
    this.overlayDirty = true;
  }

  /** Adjusts speed and resolution to what the device sustains, and updates the stats. */
  private tunePerformance(): void {
    if (!this.speedChosen && this.light) {
      const afford = this.perf.affordableSpeed();
      if (!Number.isNaN(afford)) {
        // Light crosses the board in about 7 s at real time; run up to twice as fast when the
        // device can keep a smooth frame rate doing it.
        this.speedChosen = true;
        this.baseSpeed = Math.max(1, Math.min(2, Math.floor(afford * 2) / 2));
        this.applySpeed();
      }
    }
    if (this.perf.suggestDpr() !== null) this.layout();
    const r = this.perf.reading();
    this.slowEl.hidden = !r.slow || this.stepper.paused;
    if (!this.statsEl.hidden) {
      setText(
        this.statsEl,
        `${r.fps.toFixed(0)} fps · ${r.msPerStep.toFixed(2)} ms/step · ×${r.simRate.toFixed(2)} of ×${this.stepper.speed} · dpr ${r.dpr}`,
      );
    }
  }

  private applySpeed(): void {
    this.stepper.speed = this.baseSpeed * (this.fast ? 3 : 1);
    this.fastBtn.classList.toggle('active', this.fast);
  }

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

    const states = st.goals.map((g) => (g.complete ? 'complete' : g.met ? 'met' : 'open'));
    states.forEach((state, i) => {
      if (state !== this.lastGoalState[i] && state !== 'open') {
        const g = this.level.goals[i];
        const name = g ? goalLabel(g, this.light) : 'Goal';
        this.announce(state === 'met' ? `${name} reached. Hold it.` : `${name} done.`);
      }
    });
    this.lastGoalState = states;
    if (st.solved && !this.announced) {
      this.announce(`Solved with ${st.solved.stars} of 3 stars.`);
      this.announced = true;
      if (!this.custom) this.app.progress.record(this.level.id, st.solved.stars);
      this.app.audio.fanfare(st.solved.stars);
      this.app.haptics.success();
      window.setTimeout(() => this.showResult(), 700);
    }
    if (st.timedOut && !this.timeoutAnnounced) {
      this.timeoutAnnounced = true;
      this.announce('Out of time. Move a piece or restart the run.');
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
    const i = this.editor.selected;
    const item = i !== null ? this.editor.items[i] : undefined;
    const sel = item ? `${TOOL_NAMES[item.kind]} ${i! + 1} of ${this.editor.items.length} selected.` : '';
    if (sel && sel !== this.lastSelection) this.announce(sel);
    this.lastSelection = sel;
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
    const can = (t: Tune) => tunes(this.level, item.kind, t);
    if (item.kind === 'emitter') {
      if (can('freq')) {
        rows.push(slider('Frequency', item.freq, 0.5, 8, 0.01, (v) => `${v.toFixed(2)} Hz`, (v) => ({ ...item, freq: v })));
      }
      if (can('phase')) {
        const deg = ((item.phase ?? 0) * 180) / Math.PI;
        rows.push(
          slider('Phase', deg, 0, 360, 5, (v) => `${v.toFixed(0)}°`, (v) => ({ ...item, phase: (v * Math.PI) / 180 })),
        );
      }
      if (can('amp')) {
        rows.push(slider('Strength', item.amp ?? 1, 0, 2, 0.01, (v) => `${Math.round(v * 100)}%`, (v) => ({ ...item, amp: v })));
      }
      if (can('speed')) {
        const vel = item.vel ?? [0, 0];
        const speed = Math.hypot(vel[0], vel[1]);
        const heading = speed > 0 ? Math.atan2(vel[1], vel[0]) : 0;
        const withVel = (s: number, a: number): Item => ({ ...item, vel: [s * Math.cos(a), s * Math.sin(a)] });
        rows.push(
          slider('Speed', speed, 0, MAX_SOURCE_SPEED, 0.5, (v) => `${v.toFixed(1)} cells/s`, (v) => withVel(v, heading)),
          slider(
            'Heading',
            (((heading * 180) / Math.PI) % 360 + 360) % 360,
            0,
            355,
            5,
            (v) => `${v.toFixed(0)}°`,
            (v) => withVel(speed, (v * Math.PI) / 180),
          ),
        );
      }
      if (rows.length === 0) rows.push(h('p', { class: 'material' }, `${item.freq.toFixed(2)} Hz, fixed in this level`));
    } else if (item.kind === 'resonator') {
      rows.push(
        can('freq')
          ? slider('Tuning', item.freq, 0.5, 8, 0.01, (v) => `${v.toFixed(2)} Hz`, (v) => ({ ...item, freq: v }))
          : h('p', { class: 'material' }, `Rings at ${item.freq.toFixed(2)} Hz`),
      );
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

  private leave(): void {
    this.app.go(this.custom ? { screen: 'editor' } : { screen: 'select' });
  }

  /** Places a layout from a shared link, if the level accepts it. */
  private loadShared(items: Item[]): void {
    const err = checkPlacements(this.level, items) ?? this.commit(items);
    if (err) {
      this.toast(`The shared layout doesn't fit this level: ${err}`);
      return;
    }
    this.editor.load(items);
    this.toast('Loaded a shared layout');
  }

  /** Copies a link that reopens this level with the current pieces. */
  private async share(): Promise<void> {
    const url = shareUrl(this.level.id, this.editor.items);
    try {
      await navigator.clipboard.writeText(url);
      this.toast('Link copied');
    } catch {
      // Clipboard access can be blocked; put the link in the address bar instead.
      history.replaceState(null, '', url);
      this.toast('Link is in the address bar');
    }
  }

  private announce(message: string): void {
    // Clear first so repeating the same message is still read out.
    this.srEl.textContent = '';
    window.setTimeout(() => setText(this.srEl, message), 30);
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
    this.fast = !this.fast;
    this.applySpeed();
  }

  private togglePerfStats(): void {
    this.app.setSetting('perfStats', !this.app.settings.perfStats);
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
      case 'p':
      case 'P':
        this.togglePerfStats();
        break;
      case 'h':
      case 'H':
        this.hintEl.hidden = !this.hintEl.hidden;
        break;
      case 'Escape':
        this.leave();
        break;
    }
  };

  // --- Results ---

  private showResult(): void {
    const s = this.status.solved;
    if (!s) return;
    this.resultShown = true;
    this.app.audio.silence();
    const next = this.custom ? null : nextLevel(this.app.catalog, this.level.id);
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
        this.custom
          ? h('button', { class: 'btn primary', onclick: () => this.leave() }, 'Back to the editor')
          : next
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
