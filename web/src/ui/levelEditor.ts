// Level editor: lay out fixed pieces, sources, and goals on a live board; set the level's
// rules and inventory; play-test it; verify a solution headlessly in the browser; and export
// the level and solution as JSON for `levels/`. The draft is kept in localStorage.

import type { App, Screen } from '../app';
import { len, sub } from '../geometry';
import { Editor } from '../input/editor';
import { FieldRenderer } from '../render/fieldRenderer';
import { OverlayRenderer } from '../render/overlay';
import { Sim } from '../sim/bridge';
import { Stepper } from '../sim/stepper';
import {
  COLORS as LIGHT_COLORS,
  TOOL_ORDER,
  type Color,
  type Goal,
  type InventoryEntry,
  type Item,
  type Level,
  type Material,
  type SourceDef,
  type Status,
  type Tune,
  type V2,
} from '../types';
import { h, setStyle, setText } from './dom';
import { ICONS, TOOL_ICONS, TOOL_NAMES } from './icons';

const DRAFT_KEY = 'wavesmith.editor.v1';

/** The level being edited and the layout last used to play it (its reference solution). */
export interface EditorSession {
  level: Level;
  solution: Item[];
}

export function blankLevel(): Level {
  return {
    id: 'custom-1',
    name: 'Untitled',
    chapter: 0,
    description: '',
    hint: '',
    grid: { width: 256, height: 160 },
    medium: { c: 60, damping: 0.02 },
    sources: [{ kind: 'point', pos: [40, 80], freq: 3 }],
    fixed: [],
    goals: [{ kind: 'focus', pos: [210, 80], radius: 5, threshold: 0.3, hold: 3 }],
    inventory: { wall: { count: 2, cost: 1 } },
    budget: 2,
    par: { cost: 2, energy: 60 },
    timeLimit: 30,
  };
}

export function loadSession(): EditorSession {
  try {
    const raw = localStorage.getItem(DRAFT_KEY);
    if (raw) {
      const s = JSON.parse(raw) as EditorSession;
      if (s && s.level && Array.isArray(s.solution)) return s;
    }
  } catch {
    // Unavailable or corrupt storage: start fresh.
  }
  return { level: blankLevel(), solution: [] };
}

export function saveSession(s: EditorSession): void {
  try {
    localStorage.setItem(DRAFT_KEY, JSON.stringify(s));
  } catch {
    // Only costs persistence.
  }
}

/** Every tool, free and plentiful, for laying out the level's own fixed pieces. */
function designLevel(level: Level): Level {
  const inventory: Level['inventory'] = {};
  for (const k of TOOL_ORDER) {
    inventory[k] = { count: 99, cost: 0, material: level.inventory[k]?.material ?? (k === 'lens' ? undefined : 'crown') };
  }
  return { ...level, fixed: [], inventory, budget: 9999 };
}

type Mode = 'pieces' | 'sources' | 'goals';

/** A draggable point belonging to a source or goal. */
interface PointRef {
  get(): V2;
  set(p: V2): void;
}

export function levelEditorScreen(app: App): Screen {
  return new LevelEditor(app);
}

class LevelEditor implements Screen {
  private session: EditorSession;
  private sim: Sim | null = null;
  private field: FieldRenderer;
  private overlay: OverlayRenderer;
  private editor: Editor;
  private stepper = new Stepper(120);
  private status: Status | null = null;
  private mode: Mode = 'pieces';
  private raf = 0;
  private last = performance.now();
  private rebuildTimer: number | undefined;
  private resizeObs: ResizeObserver;
  private dragPoint: PointRef | null = null;
  /** Source or goal kind to add on the next board tap. */
  private adding: SourceDef['kind'] | Goal['kind'] | null = null;

  private root: HTMLElement;
  private stage: HTMLElement;
  private board = h('div', { class: 'board' });
  private glCanvas = h('canvas', { class: 'layer' });
  private ovCanvas = h('canvas', { class: 'layer overlay' });
  private panel = h('aside', { class: 'panel editor-panel' });
  private errorEl = h('p', { class: 'editor-error', role: 'alert' });
  private statusEl = h('span', { class: 'mono' });
  private toastEl = h('div', { class: 'toast', role: 'status', 'aria-live': 'polite' });
  private toastTimer: number | undefined;

  constructor(private app: App) {
    this.session = loadSession();
    this.board.append(this.glCanvas, this.ovCanvas);
    this.stage = h('div', { class: 'stage' }, this.board, this.toastEl);
    this.field = new FieldRenderer(this.glCanvas);
    this.overlay = new OverlayRenderer(this.ovCanvas);

    this.editor = new Editor({
      level: designLevel(this.session.level),
      board: this.board,
      toCells: (x, y) => this.toCells(x, y),
      cellsPerPx: () => this.session.level.grid.width / Math.max(1, this.board.clientWidth),
      commit: (items) => {
        this.session.level.fixed = items;
        return this.rebuild(true);
      },
      preview: () => {},
      changed: () => this.renderPanel(),
      redraw: () => {},
      toast: (m) => this.toast(m),
      sound: (kind, item) => app.audio.edit(kind, item),
    });
    this.editor.load(this.session.level.fixed ?? []);
    this.editor.attach(this.board);
    // Sources and goals are dragged here, before the piece editor sees the press.
    this.board.addEventListener('pointerdown', this.onPointPress, { capture: true });
    window.addEventListener('pointermove', this.onPointMove);
    window.addEventListener('pointerup', this.onPointUp);

    const btn = (label: string, icon: string, fn: () => void) =>
      h('button', { class: 'icon-btn', 'aria-label': label, title: label, html: icon, onclick: fn });
    const topbar = h(
      'header',
      { class: 'topbar' },
      btn('Back to title', ICONS.back, () => app.go({ screen: 'title' })),
      h('div', { class: 'title-block' }, h('span', { class: 'level-id mono' }, 'Level editor'), h('h1', {}, 'Design a level')),
      h('div', { class: 'editor-actions' },
        h('button', { class: 'btn small', onclick: () => this.playtest() }, 'Play-test'),
        h('button', { class: 'btn small', onclick: () => void this.verify() }, 'Verify'),
        h('button', { class: 'btn small primary', onclick: () => this.exportFiles() }, 'Export'),
      ),
      h('div', { class: 'clock' }, this.statusEl),
    );
    this.root = h('div', { class: 'screen play editor' }, topbar, this.stage, this.panel);
    app.root.append(this.root);
    this.resizeObs = new ResizeObserver(() => this.layout());
    this.resizeObs.observe(this.stage);
    window.addEventListener('keydown', this.onKey);
    this.rebuild(false);
    this.renderPanel();
    this.layout();
    this.raf = requestAnimationFrame(this.frame);
  }

  destroy(): void {
    cancelAnimationFrame(this.raf);
    window.clearTimeout(this.rebuildTimer);
    window.clearTimeout(this.toastTimer);
    window.removeEventListener('keydown', this.onKey);
    window.removeEventListener('pointermove', this.onPointMove);
    window.removeEventListener('pointerup', this.onPointUp);
    this.resizeObs.disconnect();
    this.editor.dispose();
    this.sim?.dispose();
    saveSession(this.session);
  }

  // ---------- Simulation ----------

  /** Rebuilds the live preview from the draft. Returns the core's error, if any. */
  private rebuild(save = true): string | null {
    if (save) saveSession(this.session);
    const level = this.session.level;
    let sim: Sim;
    try {
      sim = new Sim(level);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setText(this.errorEl, msg);
      return msg;
    }
    setText(this.errorEl, '');
    this.sim?.dispose();
    this.sim = sim;
    const water = level.display?.palette === 'water';
    this.field.setGrid(sim.nx, sim.ny, sim.isLight ? 'light' : water ? 'water' : 'sound');
    this.field.gain = level.display?.gain ?? (sim.isLight ? 2.2 : 1.6);
    this.field.uploadOverlay(sim.overlay());
    this.stepper.reset();
    this.status = sim.status();
    this.layout();
    return null;
  }

  private scheduleRebuild(): void {
    window.clearTimeout(this.rebuildTimer);
    this.rebuildTimer = window.setTimeout(() => {
      this.rebuild();
      this.editor.setLevel(designLevel(this.session.level));
    }, 200);
  }

  private frame = (now: number): void => {
    this.raf = requestAnimationFrame(this.frame);
    const sim = this.sim;
    if (!sim) return;
    const n = this.stepper.advance(now - this.last);
    this.last = now;
    if (n > 0) {
      sim.step(n);
      this.status = sim.status();
      setText(this.statusEl, `${this.status.time.toFixed(1)}s`);
    }
    const level = this.session.level;
    this.field.uploadField(sim.image());
    this.field.draw(level.grid.width, level.grid.height, sim.border);
    this.overlay.draw({
      level: { ...level, fixed: [] },
      items: this.editor.items,
      selected: this.editor.selected,
      hover: this.editor.hover,
      ghost: this.editor.ghost,
      ghostValid: this.editor.ghostValid,
      blocked: this.editor.blocked,
      snap: this.editor.snap,
      trash: this.editor.trash,
      goals: this.status?.goals ?? [],
      time: this.status?.time ?? 0,
      simTime: this.status?.time ?? 0,
      resonance: [],
      handleSize: this.editor.handleSize,
      armed: this.editor.armed,
    });
  };

  private layout(): void {
    const { width, height } = this.session.level.grid;
    const cs = getComputedStyle(this.stage);
    const sw = this.stage.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
    const sh = this.stage.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
    const s = Math.max(0.1, Math.min(sw / width, sh / height));
    const w = Math.floor(width * s);
    const hh = Math.floor(height * s);
    setStyle(this.board, 'width', `${w}px`);
    setStyle(this.board, 'height', `${hh}px`);
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.field.resize(w, hh, dpr);
    this.overlay.resize(w, hh, dpr, width);
  }

  private toCells(clientX: number, clientY: number): V2 {
    const r = this.board.getBoundingClientRect();
    const { width, height } = this.session.level.grid;
    return [((clientX - r.left) / r.width) * width, ((clientY - r.top) / r.height) * height];
  }

  // ---------- Dragging sources and goals ----------

  /** Every draggable point of the level's sources and goals. */
  private points(): PointRef[] {
    const level = this.session.level;
    const refs: PointRef[] = [];
    const ref = (target: object, key: string): PointRef => {
      const obj = target as Record<string, unknown>;
      return {
        get: () => obj[key] as V2,
        set: (p) => {
          obj[key] = p;
        },
      };
    };
    for (const s of level.sources) {
      if (s.kind === 'line') refs.push(ref(s, 'a'), ref(s, 'b'));
      else refs.push(ref(s, 'pos'));
    }
    for (const g of level.goals) {
      if (g.kind === 'sustain') {
        g.antinodes.forEach((_, i) => refs.push(ref(g.antinodes, String(i))));
        g.nodes.forEach((_, i) => refs.push(ref(g.nodes, String(i))));
      } else refs.push(ref(g, 'pos'));
    }
    return refs;
  }

  private round(p: V2): V2 {
    const { width, height } = this.session.level.grid;
    return [Math.round(Math.min(width, Math.max(0, p[0])) * 2) / 2, Math.round(Math.min(height, Math.max(0, p[1])) * 2) / 2];
  }

  private onPointPress = (e: PointerEvent): void => {
    if (this.mode === 'pieces') return;
    const p = this.toCells(e.clientX, e.clientY);
    if (this.adding) {
      this.addAt(this.adding, this.round(p));
      this.adding = null;
      e.stopPropagation();
      return;
    }
    const tol = 10 * (this.session.level.grid.width / Math.max(1, this.board.clientWidth));
    const hit = this.points().find((r) => len(sub(r.get(), p)) <= tol);
    if (hit) {
      this.dragPoint = hit;
      e.stopPropagation();
      e.preventDefault();
    }
  };

  private onPointMove = (e: PointerEvent): void => {
    if (!this.dragPoint) return;
    this.dragPoint.set(this.round(this.toCells(e.clientX, e.clientY)));
  };

  private onPointUp = (): void => {
    if (!this.dragPoint) return;
    this.dragPoint = null;
    this.scheduleRebuild();
    this.renderPanel();
  };

  private addAt(kind: SourceDef['kind'] | Goal['kind'], p: V2): void {
    const level = this.session.level;
    const light = !!level.medium.light;
    switch (kind) {
      case 'point':
        level.sources.push({ kind: 'point', pos: p, freq: 3 });
        break;
      case 'line':
        level.sources.push({ kind: 'line', a: [p[0], p[1] - 20], b: [p[0], p[1] + 20], freq: 3 });
        break;
      case 'beam':
        level.sources.push({ kind: 'beam', pos: p, angle: 0, width: 20, ...(light ? {} : { freq: 3 }) });
        break;
      case 'focus':
        level.goals.push({ kind: 'focus', pos: p, radius: 5, threshold: 0.3, hold: 3 });
        break;
      case 'silence':
        level.goals.push({ kind: 'silence', pos: p, radius: 8, threshold: 0.05, hold: 3 });
        break;
      case 'resonate':
        level.goals.push({ kind: 'resonate', pos: p, freq: 2.5, q: 30, threshold: 8 });
        break;
      case 'sustain':
        level.goals.push({
          kind: 'sustain',
          antinodes: [p],
          nodes: [[p[0] + 5, p[1]]],
          radius: 2,
          high: 1,
          low: 0.3,
          hold: 3,
        });
        break;
    }
    this.scheduleRebuild();
    this.renderPanel();
  }

  // ---------- Panel ----------

  private renderPanel(): void {
    const level = this.session.level;
    const tabs = h(
      'div',
      { class: 'segmented editor-tabs', role: 'tablist' },
      ...(['pieces', 'sources', 'goals'] as Mode[]).map((m) =>
        h(
          'button',
          {
            role: 'tab',
            class: this.mode === m ? 'on' : '',
            'aria-selected': this.mode === m ? 'true' : 'false',
            onclick: () => {
              this.mode = m;
              this.adding = null;
              this.editor.arm(null);
              this.editor.select(null);
              this.renderPanel();
            },
          },
          m === 'pieces' ? 'Pieces' : m === 'sources' ? 'Sources' : 'Goals',
        ),
      ),
    );
    const body =
      this.mode === 'pieces' ? this.piecesPanel() : this.mode === 'sources' ? this.sourcesPanel() : this.goalsPanel();
    this.panel.replaceChildren(
      this.errorEl,
      tabs,
      body,
      this.section('Level', this.levelFields(level)),
      this.section('Player inventory', this.inventoryFields(level)),
      this.section('Import', [
        h('p', { class: 'how' }, 'Start from a built-in level or paste level JSON.'),
        this.startFrom(),
        h('button', { class: 'btn small', onclick: () => void this.importJson() }, 'Paste level JSON'),
        h('button', { class: 'btn small danger', onclick: () => this.reset() }, 'New blank level'),
      ]),
    );
  }

  private section(title: string, rows: (HTMLElement | null)[]): HTMLElement {
    return h('section', { class: 'editor-section' }, h('h2', { class: 'label' }, title), ...rows);
  }

  private piecesPanel(): HTMLElement {
    const buttons = TOOL_ORDER.map((kind) =>
      h(
        'button',
        {
          class: `tool${this.editor.armed === kind ? ' armed' : ''}`,
          'aria-pressed': this.editor.armed === kind ? 'true' : 'false',
          onclick: () => this.editor.arm(kind),
        },
        h('span', { class: 'tool-icon', html: TOOL_ICONS[kind] }),
        h('span', { class: 'tool-name' }, TOOL_NAMES[kind]),
      ),
    );
    const sel = this.editor.selected !== null ? this.editor.items[this.editor.selected] : undefined;
    return this.section('Fixed pieces', [
      h('p', { class: 'how' }, 'These belong to the level: walls drawn in stone, glass the player cannot move.'),
      h('div', { class: 'palette' }, ...buttons),
      sel ? this.itemFields(sel) : null,
    ]);
  }

  /** Material and tuning of the selected fixed piece. */
  private itemFields(item: Item): HTMLElement {
    const apply = (next: Item) => this.editor.updateSelected(next);
    const rows: HTMLElement[] = [];
    if (item.kind === 'lens' || item.kind === 'prism' || item.kind === 'slab') {
      rows.push(
        selectField(
          'Material',
          ['none', 'water', 'crown', 'flint'],
          item.material ?? 'none',
          (v) => apply({ ...item, material: v === 'none' ? undefined : (v as Material) } as Item),
        ),
      );
      if (item.kind === 'lens' && !item.material) {
        rows.push(numberField('Speed ratio', item.ratio ?? 1, (v) => apply({ ...item, ratio: v }), 0.05));
      }
    }
    if (item.kind === 'emitter' || item.kind === 'resonator') {
      rows.push(numberField('Frequency', item.freq, (v) => apply({ ...item, freq: v }), 0.05));
    }
    if (item.kind === 'emitter') {
      rows.push(numberField('Phase (rad)', item.phase ?? 0, (v) => apply({ ...item, phase: v }), 0.05));
      rows.push(numberField('Strength', item.amp ?? 1, (v) => apply({ ...item, amp: v }), 0.05));
    }
    if (item.kind === 'wall' || item.kind === 'reflector') {
      rows.push(numberField('Thickness', item.thickness ?? 3, (v) => apply({ ...item, thickness: v }), 0.5));
    }
    if (item.kind === 'absorber') {
      rows.push(numberField('Strength', item.strength ?? 40, (v) => apply({ ...item, strength: v }), 5));
    }
    return h('div', { class: 'editor-rows' }, h('h3', { class: 'label' }, `Selected ${TOOL_NAMES[item.kind].toLowerCase()}`), ...rows);
  }

  private addButtons(kinds: (SourceDef['kind'] | Goal['kind'])[], names: string[]): HTMLElement {
    return h(
      'div',
      { class: 'setting-actions' },
      ...kinds.map((k, i) =>
        h(
          'button',
          {
            class: `btn small${this.adding === k ? ' primary' : ''}`,
            onclick: () => {
              this.adding = this.adding === k ? null : k;
              if (this.adding) this.toast(`Tap the board to add a ${names[i]!.toLowerCase()}`);
              this.renderPanel();
            },
          },
          `+ ${names[i]}`,
        ),
      ),
    );
  }

  private sourcesPanel(): HTMLElement {
    const level = this.session.level;
    const light = !!level.medium.light;
    const changed = () => this.scheduleRebuild();
    const rows = level.sources.map((s, i) => {
      const fields: HTMLElement[] = [];
      if (s.kind === 'line') {
        fields.push(pointField('From', s.a, (p) => ((s.a = p), changed())), pointField('To', s.b, (p) => ((s.b = p), changed())));
      } else fields.push(pointField('Position', s.pos, (p) => ((s.pos = p), changed())));
      if (s.kind === 'beam') {
        fields.push(numberField('Angle (°)', (s.angle * 180) / Math.PI, (v) => ((s.angle = (v * Math.PI) / 180), changed()), 5));
        fields.push(numberField('Width', s.width ?? 22, (v) => ((s.width = v), changed()), 1));
      }
      if (!light) fields.push(numberField('Frequency', s.freq ?? 3, (v) => ((s.freq = v), changed()), 0.05));
      fields.push(numberField('Strength', s.amp ?? 1, (v) => ((s.amp = v), changed()), 0.05));
      fields.push(numberField('Phase (rad)', s.phase ?? 0, (v) => ((s.phase = v), changed()), 0.05));
      fields.push(numberField('Starts at (s)', s.start ?? 0, (v) => ((s.start = v), changed()), 0.5));
      if (s.kind === 'point') {
        fields.push(pointField('Velocity', s.vel ?? [0, 0], (p) => ((s.vel = p[0] || p[1] ? p : undefined), changed())));
      }
      if (light) fields.push(colorsField(s.colors, (c) => ((s.colors = c), changed())));
      return this.card(`${i + 1}. ${s.kind} source`, fields, () => {
        level.sources.splice(i, 1);
        changed();
        this.renderPanel();
      });
    });
    return this.section('Sources', [
      this.addButtons(['point', 'line', 'beam'], ['Point', 'Line', 'Beam']),
      h('p', { class: 'how' }, 'Drag a source on the board to move it.'),
      ...rows,
    ]);
  }

  private goalsPanel(): HTMLElement {
    const level = this.session.level;
    const light = !!level.medium.light;
    const changed = () => this.scheduleRebuild();
    const rows = level.goals.map((g, i) => {
      const f: HTMLElement[] = [];
      switch (g.kind) {
        case 'focus':
        case 'silence':
          f.push(pointField('Position', g.pos, (p) => ((g.pos = p), changed())));
          f.push(numberField('Radius', g.radius, (v) => ((g.radius = v), changed()), 0.5));
          f.push(numberField('Threshold', g.threshold, (v) => ((g.threshold = v), changed()), 0.01));
          f.push(numberField('Hold (s)', g.hold, (v) => ((g.hold = v), changed()), 0.5));
          if (g.kind === 'silence') {
            f.push(numberField('Counts from (s)', g.after ?? -1, (v) => ((g.after = v < 0 ? undefined : v), changed()), 0.5));
          }
          if (light) f.push(colorsField(g.colors, (c) => ((g.colors = c), changed())));
          break;
        case 'resonate':
          f.push(pointField('Position', g.pos, (p) => ((g.pos = p), changed())));
          f.push(numberField('Frequency', g.freq, (v) => ((g.freq = v), changed()), 0.05));
          f.push(numberField('Q', g.q ?? 30, (v) => ((g.q = v), changed()), 1));
          f.push(numberField('Threshold', g.threshold, (v) => ((g.threshold = v), changed()), 0.5));
          break;
        case 'sustain':
          f.push(
            textField('Antinodes', JSON.stringify(g.antinodes), (t) => {
              const v = parsePoints(t);
              if (v) (g.antinodes = v), changed();
            }),
            textField('Nodes', JSON.stringify(g.nodes), (t) => {
              const v = parsePoints(t);
              if (v) (g.nodes = v), changed();
            }),
            numberField('Radius', g.radius, (v) => ((g.radius = v), changed()), 0.5),
            numberField('High', g.high, (v) => ((g.high = v), changed()), 0.05),
            numberField('Low', g.low, (v) => ((g.low = v), changed()), 0.05),
            numberField('Hold (s)', g.hold, (v) => ((g.hold = v), changed()), 0.5),
          );
          break;
      }
      return this.card(`${i + 1}. ${g.kind}`, f, () => {
        level.goals.splice(i, 1);
        changed();
        this.renderPanel();
      });
    });
    return this.section('Goals', [
      this.addButtons(['focus', 'silence', 'resonate', 'sustain'], ['Focus', 'Silence', 'Resonate', 'Sustain']),
      h('p', { class: 'how' }, 'Drag a goal on the board to move it. Live readings show while the level runs.'),
      ...rows,
    ]);
  }

  private card(title: string, fields: HTMLElement[], remove: () => void): HTMLElement {
    return h(
      'div',
      { class: 'editor-card' },
      h(
        'div',
        { class: 'editor-card-head' },
        h('strong', {}, title),
        h('button', { class: 'icon-btn small', 'aria-label': `Remove ${title}`, html: ICONS.trash, onclick: remove }),
      ),
      ...fields,
    );
  }

  private levelFields(level: Level): HTMLElement[] {
    const changed = () => this.scheduleRebuild();
    return [
      textField('Id', level.id, (v) => ((level.id = v), changed())),
      textField('Name', level.name, (v) => ((level.name = v), changed())),
      numberField('Chapter', level.chapter, (v) => ((level.chapter = Math.round(v)), changed()), 1),
      textArea('Description', level.description ?? '', (v) => ((level.description = v), changed())),
      textArea('Hint', level.hint ?? '', (v) => ((level.hint = v), changed())),
      numberField('Width', level.grid.width, (v) => ((level.grid.width = Math.round(v)), changed()), 8),
      numberField('Height', level.grid.height, (v) => ((level.grid.height = Math.round(v)), changed()), 8),
      numberField('Wave speed', level.medium.c, (v) => ((level.medium.c = v), changed()), 1),
      numberField('Damping', level.medium.damping ?? 0, (v) => ((level.medium.damping = v), changed()), 0.01),
      checkField('Light (red, green, blue)', !!level.medium.light, (v) => {
        level.medium.light = v || undefined;
        changed();
        this.renderPanel();
      }),
      selectField('Look', ['sound', 'water'], level.display?.palette ?? 'sound', (v) => {
        level.display = { ...level.display, palette: v as 'sound' | 'water' };
        changed();
      }),
      numberField('Time limit (s)', level.timeLimit, (v) => ((level.timeLimit = v), changed()), 1),
      numberField('Budget', level.budget, (v) => ((level.budget = Math.round(v)), changed()), 1),
      numberField('Par cost', level.par.cost, (v) => ((level.par.cost = Math.round(v)), changed()), 1),
      numberField('Par energy', level.par.energy, (v) => ((level.par.energy = v), changed()), 1),
    ];
  }

  private inventoryFields(level: Level): HTMLElement[] {
    const changed = () => this.scheduleRebuild();
    return TOOL_ORDER.map((kind) => {
      const entry = level.inventory[kind];
      const toggle = checkField(TOOL_NAMES[kind], !!entry, (on) => {
        if (on) level.inventory[kind] = { count: 1, cost: 1 };
        else delete level.inventory[kind];
        changed();
        this.renderPanel();
      });
      if (!entry) return h('div', { class: 'editor-inv' }, toggle);
      const e: InventoryEntry = entry;
      const rows: HTMLElement[] = [
        numberField('Count', e.count, (v) => ((e.count = Math.round(v)), changed()), 1),
        numberField('Cost', e.cost, (v) => ((e.cost = Math.round(v)), changed()), 1),
        numberField('Max size (0 = any)', e.maxSize ?? 0, (v) => ((e.maxSize = v > 0 ? v : undefined), changed()), 5),
      ];
      if (kind === 'lens' || kind === 'prism' || kind === 'slab') {
        rows.push(
          selectField('Material', ['none', 'water', 'crown', 'flint'], e.material ?? 'none', (v) => {
            e.material = v === 'none' ? undefined : (v as Material);
            changed();
          }),
        );
      }
      if (kind === 'emitter' || kind === 'resonator') {
        rows.push(numberField('Start frequency (0 = source)', e.freq ?? 0, (v) => ((e.freq = v > 0 ? v : undefined), changed()), 0.05));
        const all: Tune[] = kind === 'emitter' ? ['freq', 'phase', 'amp', 'speed'] : ['freq'];
        const current = e.tune ?? (kind === 'emitter' ? ['freq', 'phase'] : ['freq']);
        rows.push(
          h(
            'div',
            { class: 'editor-tunes' },
            h('span', { class: 'label' }, 'Player can tune'),
            ...all.map((t) =>
              checkField(t, current.includes(t), (on) => {
                const next = new Set(e.tune ?? current);
                if (on) next.add(t);
                else next.delete(t);
                e.tune = all.filter((x) => next.has(x));
                changed();
              }),
            ),
          ),
        );
        rows.push(
          textField('Area [x0,y0,x1,y1] (blank = anywhere)', e.area ? JSON.stringify(e.area) : '', (t) => {
            const v = t.trim() ? (JSON.parse(t) as unknown) : null;
            e.area = Array.isArray(v) && v.length === 4 && v.every((n) => typeof n === 'number') ? (v as InventoryEntry['area']) : undefined;
            changed();
          }),
        );
      }
      return h('div', { class: 'editor-inv' }, toggle, h('div', { class: 'editor-rows' }, ...rows));
    });
  }

  private startFrom(): HTMLElement {
    const levels = [...this.app.catalog.levels.values()];
    const sel = h('select', { class: 'editor-select', 'aria-label': 'Start from a level' }, h('option', { value: '' }, 'Start from…'));
    for (const l of levels) sel.append(h('option', { value: l.id }, `${l.id} ${l.name}`));
    sel.addEventListener('change', () => {
      const l = levels.find((x) => x.id === sel.value);
      if (!l) return;
      this.loadLevel(JSON.parse(JSON.stringify(l)) as Level, []);
    });
    return sel;
  }

  private loadLevel(level: Level, solution: Item[]): void {
    level.fixed ??= [];
    this.session = { level, solution };
    this.editor.setLevel(designLevel(level));
    this.editor.load(level.fixed);
    this.rebuild();
    this.renderPanel();
  }

  private reset(): void {
    if (!window.confirm('Discard this draft and start a blank level?')) return;
    this.loadLevel(blankLevel(), []);
  }

  private async importJson(): Promise<void> {
    let text = '';
    try {
      text = await navigator.clipboard.readText();
    } catch {
      text = window.prompt('Paste level JSON') ?? '';
    }
    try {
      const v = JSON.parse(text) as Level | { level: Level; solution?: Item[] };
      if ('level' in v) this.loadLevel(v.level, v.solution ?? []);
      else this.loadLevel(v, []);
      this.toast('Level imported');
    } catch {
      this.toast('That is not level JSON');
    }
  }

  // ---------- Actions ----------

  private playtest(): void {
    if (this.rebuild()) {
      this.toast('Fix the level first');
      return;
    }
    saveSession(this.session);
    this.app.go({ screen: 'play', levelId: this.session.level.id, custom: this.session });
  }

  /**
   * Runs the level headlessly with the saved solution (the layout from the last play-test)
   * and with no pieces, the same checks `cargo test` makes for built-in levels.
   */
  private async verify(): Promise<void> {
    const level = this.session.level;
    const run = async (pieces: Item[]): Promise<Status | string> => {
      let sim: Sim;
      try {
        sim = new Sim(level);
        sim.setPlacements(pieces);
      } catch (e) {
        return e instanceof Error ? e.message : String(e);
      }
      try {
        let st = sim.status();
        while (!st.solved && !st.timedOut) {
          sim.step(sim.stepsPerSecond / 2);
          st = sim.status();
          // Yield so the page stays responsive.
          await new Promise((r) => setTimeout(r, 0));
        }
        return st;
      } finally {
        sim.dispose();
      }
    };
    this.toast('Verifying…');
    const withSolution = await run(this.session.solution);
    const empty = await run([]);
    const describe = (r: Status | string) =>
      typeof r === 'string'
        ? `invalid: ${r}`
        : r.solved
          ? `solved in ${r.solved.time.toFixed(1)}s, energy ${r.solved.energy.toFixed(1)}, ${r.solved.stars}★`
          : `not solved (readings ${r.goals.map((g) => g.value.toFixed(3)).join(', ')})`;
    const ok =
      typeof withSolution !== 'string' && withSolution.solved?.stars === 3 && typeof empty !== 'string' && !empty.solved;
    window.alert(
      `${ok ? 'Ready: ' : 'Not ready: '}a reference solution should earn 3 stars and the empty board should fail.\n\n` +
        `Solution (${this.session.solution.length} pieces, from your last play-test): ${describe(withSolution)}\n` +
        `Empty board: ${describe(empty)}`,
    );
  }

  private exportFiles(): void {
    const level = this.session.level;
    const stem = level.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'level';
    const download = (name: string, data: unknown) => {
      const blob = new Blob([`${JSON.stringify(data, null, 2)}\n`], { type: 'application/json' });
      const a = h('a', { href: URL.createObjectURL(blob), download: name });
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    };
    download(`${stem}.json`, level);
    if (this.session.solution.length > 0) {
      download(`${stem}.solution.json`, { note: 'Reference solution from the level editor.', pieces: this.session.solution });
    }
    this.toast('Exported. Add the files under levels/ and list the level in chapters.json');
  }

  private toast(message: string): void {
    setText(this.toastEl, message);
    this.toastEl.classList.add('show');
    window.clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => this.toastEl.classList.remove('show'), 2600);
  }

  private onKey = (e: KeyboardEvent): void => {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLSelectElement) {
      return;
    }
    if (this.mode === 'pieces' && this.editor.onKey(e)) e.preventDefault();
  };
}

// ---------- Form fields ----------

function numberField(label: string, value: number, set: (v: number) => void, step = 1): HTMLElement {
  const input = h('input', { type: 'number', step, value: Number.isFinite(value) ? +value.toFixed(4) : 0 });
  input.addEventListener('change', () => {
    const v = Number(input.value);
    if (Number.isFinite(v)) set(v);
  });
  return h('label', { class: 'editor-field' }, h('span', {}, label), input);
}

function textField(label: string, value: string, set: (v: string) => void): HTMLElement {
  const input = h('input', { type: 'text', value });
  input.addEventListener('change', () => {
    try {
      set(input.value);
    } catch {
      input.setCustomValidity('Invalid value');
      input.reportValidity();
    }
  });
  return h('label', { class: 'editor-field' }, h('span', {}, label), input);
}

function textArea(label: string, value: string, set: (v: string) => void): HTMLElement {
  const input = h('textarea', { rows: 3 });
  input.value = value;
  input.addEventListener('change', () => set(input.value));
  return h('label', { class: 'editor-field wide' }, h('span', {}, label), input);
}

function checkField(label: string, value: boolean, set: (v: boolean) => void): HTMLElement {
  const input = h('input', { type: 'checkbox' });
  input.checked = value;
  input.addEventListener('change', () => set(input.checked));
  return h('label', { class: 'editor-check' }, input, h('span', {}, label));
}

function selectField(label: string, options: string[], value: string, set: (v: string) => void): HTMLElement {
  const sel = h('select', {}, ...options.map((o) => h('option', { value: o }, o)));
  sel.value = value;
  sel.addEventListener('change', () => set(sel.value));
  return h('label', { class: 'editor-field' }, h('span', {}, label), sel);
}

function pointField(label: string, p: V2, set: (p: V2) => void): HTMLElement {
  const x = h('input', { type: 'number', step: 0.5, value: p[0], 'aria-label': `${label} x` });
  const y = h('input', { type: 'number', step: 0.5, value: p[1], 'aria-label': `${label} y` });
  const update = () => set([Number(x.value), Number(y.value)]);
  x.addEventListener('change', update);
  y.addEventListener('change', update);
  return h('div', { class: 'editor-field' }, h('span', {}, label), h('span', { class: 'editor-pair' }, x, y));
}

function colorsField(colors: Color[] | undefined, set: (c: Color[] | undefined) => void): HTMLElement {
  const current = new Set<Color>(colors ?? LIGHT_COLORS);
  const boxes = LIGHT_COLORS.map((c) =>
    checkField(c, current.has(c), (on) => {
      if (on) current.add(c);
      else current.delete(c);
      const list = LIGHT_COLORS.filter((x) => current.has(x));
      set(list.length === 3 ? undefined : list);
    }),
  );
  return h('div', { class: 'editor-tunes' }, h('span', { class: 'label' }, 'Colors'), ...boxes);
}

function parsePoints(text: string): V2[] | null {
  try {
    const v = JSON.parse(text) as unknown;
    if (Array.isArray(v) && v.every((p) => Array.isArray(p) && p.length === 2 && p.every((n) => typeof n === 'number'))) {
      return v as V2[];
    }
  } catch {
    // Fall through.
  }
  return null;
}
