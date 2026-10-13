// Pointer, touch, and keyboard editing of the player's pieces.
//
// While a piece is dragged it is drawn as a ghost; the layout is only committed to the solver
// on release, because every commit restarts the run from rest.

import { clone, controlPoints, itemDistance, itemSize, len, sub, translate } from '../geometry';
import { checkPlacements, createItem, pinchDelta, remaining, transformItem, type TwoPointer } from '../placement';
import type { Item, Level, ToolKind, V2 } from '../types';
import { dragHandle, handlesFor, type HandleId } from './handles';

export interface EditorHost {
  level: Level;
  /** Converts client (CSS pixel) coordinates to play-area cells. */
  toCells(clientX: number, clientY: number): V2;
  /** Cells per CSS pixel at the current zoom. */
  cellsPerPx(): number;
  /** Applies a layout to the simulation. Returns an error message if the core rejects it. */
  commit(items: Item[]): string | null;
  /** Selection, tool, or pieces changed. */
  changed(): void;
  /** Only the dragged ghost moved; redraw the overlay. */
  redraw(): void;
  toast(message: string): void;
  tick(): void;
}

type Drag =
  | { type: 'move'; index: number; start: V2; orig: Item; moved: boolean }
  | { type: 'new'; start: V2; orig: Item }
  | { type: 'handle'; index: number; id: HandleId; orig: Item }
  | { type: 'pinch'; index: number; from: TwoPointer; orig: Item };

const LONG_PRESS_MS = 550;
/** Movement (CSS px) that turns a press into a drag. */
const DRAG_SLOP_PX = 4;
const HIT_PX = 12;

export class Editor {
  items: Item[] = [];
  selected: number | null = null;
  armed: ToolKind | null = null;
  ghost: Item | null = null;
  ghostValid = true;
  private undoStack: Item[][] = [];
  private drag: Drag | null = null;
  private pointers = new Map<number, { cells: V2; client: V2 }>();
  private pressClient: V2 | null = null;
  private longPress: number | undefined;
  private detach: (() => void) | null = null;

  constructor(private host: EditorHost) {}

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  attach(el: HTMLElement): void {
    const down = (e: PointerEvent) => this.onDown(e, el);
    const move = (e: PointerEvent) => this.onMove(e);
    const up = (e: PointerEvent) => this.onUp(e);
    const wheel = (e: WheelEvent) => this.onWheel(e);
    const menu = (e: Event) => e.preventDefault();
    el.addEventListener('pointerdown', down);
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
    el.addEventListener('wheel', wheel, { passive: false });
    el.addEventListener('contextmenu', menu);
    this.detach = () => {
      el.removeEventListener('pointerdown', down);
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
      el.removeEventListener('wheel', wheel);
      el.removeEventListener('contextmenu', menu);
    };
  }

  dispose(): void {
    this.detach?.();
    window.clearTimeout(this.longPress);
  }

  arm(kind: ToolKind | null): void {
    this.armed = this.armed === kind ? null : kind;
    if (this.armed) this.selected = null;
    this.host.changed();
  }

  select(index: number | null): void {
    this.selected = index;
    this.host.changed();
  }

  /** Replaces the whole layout without recording undo (used when loading a level). */
  load(items: Item[]): void {
    this.items = items.map(clone);
    this.undoStack = [];
    this.selected = null;
    this.ghost = null;
    this.host.changed();
  }

  /** Validates and commits a layout. Returns true on success. */
  private apply(next: Item[]): boolean {
    const err = checkPlacements(this.host.level, next) ?? this.host.commit(next);
    if (err) {
      this.host.toast(err);
      return false;
    }
    this.undoStack.push(this.items);
    if (this.undoStack.length > 100) this.undoStack.shift();
    this.items = next;
    this.host.tick();
    return true;
  }

  /** Replaces the selected piece, e.g. after retuning an emitter. */
  updateSelected(item: Item): boolean {
    if (this.selected === null) return false;
    const next = this.items.slice();
    next[this.selected] = item;
    const ok = this.apply(next);
    this.host.changed();
    return ok;
  }

  deleteSelected(): void {
    if (this.selected === null) return;
    const next = this.items.filter((_, i) => i !== this.selected);
    this.selected = null;
    this.apply(next);
    this.host.changed();
  }

  undo(): void {
    const prev = this.undoStack.pop();
    if (!prev) return;
    const err = this.host.commit(prev);
    if (err) {
      this.host.toast(err);
      return;
    }
    this.items = prev;
    this.selected = null;
    this.host.changed();
  }

  clearAll(): void {
    if (this.items.length === 0) return;
    this.selected = null;
    this.apply([]);
    this.host.changed();
  }

  rotateSelected(angle: number): void {
    if (this.selected === null) return;
    const item = this.items[this.selected]!;
    this.updateSelected(transformItem(item, angle, 1));
  }

  nudgeSelected(d: V2): void {
    if (this.selected === null) return;
    this.updateSelected(translate(this.items[this.selected]!, d));
  }

  /** Keyboard shortcuts for editing. Returns true when the key was used. */
  onKey(e: KeyboardEvent): boolean {
    const step = e.shiftKey ? Math.PI / 36 : Math.PI / 12;
    const nudge = e.shiftKey ? 5 : 1;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
      this.undo();
      return true;
    }
    switch (e.key) {
      case 'Delete':
      case 'Backspace':
        this.deleteSelected();
        return true;
      case 'Escape':
        this.armed = null;
        this.select(null);
        return true;
      case 'q':
      case 'Q':
        this.rotateSelected(-step);
        return true;
      case 'e':
      case 'E':
        this.rotateSelected(step);
        return true;
      case 'ArrowLeft':
        this.nudgeSelected([-nudge, 0]);
        return this.selected !== null;
      case 'ArrowRight':
        this.nudgeSelected([nudge, 0]);
        return this.selected !== null;
      case 'ArrowUp':
        this.nudgeSelected([0, -nudge]);
        return this.selected !== null;
      case 'ArrowDown':
        this.nudgeSelected([0, nudge]);
        return this.selected !== null;
    }
    return false;
  }

  /** Index of the topmost piece under `p`, if any. */
  private hitPiece(p: V2): number | null {
    const tol = HIT_PX * this.host.cellsPerPx();
    for (let i = this.items.length - 1; i >= 0; i--) {
      if (itemDistance(this.items[i]!, p) <= tol) return i;
    }
    return null;
  }

  private hitHandle(p: V2): HandleId | null {
    if (this.selected === null) return null;
    const tol = HIT_PX * 1.4 * this.host.cellsPerPx();
    for (const h of handlesFor(this.items[this.selected]!)) {
      if (len(sub(h.pos, p)) <= tol) return h.id;
    }
    return null;
  }

  /** Shifts `item` by `d`, shortened so the piece stays on the board. */
  private moveWithin(item: Item, d: V2): Item {
    const { width, height } = this.host.level.grid;
    const pts = controlPoints(item);
    const lo = [Math.min(...pts.map((p) => p[0])), Math.min(...pts.map((p) => p[1]))];
    const hi = [Math.max(...pts.map((p) => p[0])), Math.max(...pts.map((p) => p[1]))];
    const dx = Math.max(-lo[0]!, Math.min(width - hi[0]!, d[0]));
    const dy = Math.max(-lo[1]!, Math.min(height - hi[1]!, d[1]));
    return translate(item, [dx, dy]);
  }

  private setGhost(item: Item, index: number | null): void {
    this.ghost = item;
    const next = this.items.slice();
    if (index === null) next.push(item);
    else next[index] = item;
    this.ghostValid = checkPlacements(this.host.level, next) === null;
    this.host.redraw();
  }

  private onDown(e: PointerEvent, el: HTMLElement): void {
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    el.setPointerCapture(e.pointerId);
    const cells = this.host.toCells(e.clientX, e.clientY);
    this.pointers.set(e.pointerId, { cells, client: [e.clientX, e.clientY] });

    if (this.pointers.size === 2) {
      window.clearTimeout(this.longPress);
      const index = this.drag && 'index' in this.drag ? this.drag.index : this.selected;
      if (index === null || index === undefined) return;
      const [p1, p2] = [...this.pointers.values()];
      this.drag = { type: 'pinch', index, from: { a: p1!.client, b: p2!.client }, orig: this.items[index]! };
      return;
    }
    if (this.pointers.size > 2) return;

    this.pressClient = [e.clientX, e.clientY];
    const handle = this.hitHandle(cells);
    if (handle && this.selected !== null) {
      this.drag = { type: 'handle', index: this.selected, id: handle, orig: this.items[this.selected]! };
      return;
    }
    const hit = this.hitPiece(cells);
    if (hit !== null) {
      this.armed = null;
      this.selected = hit;
      this.drag = { type: 'move', index: hit, start: cells, orig: this.items[hit]!, moved: false };
      this.longPress = window.setTimeout(() => {
        if (this.drag?.type === 'move' && !this.drag.moved) {
          this.drag = null;
          this.ghost = null;
          this.deleteSelected();
          navigator.vibrate?.(25);
        }
      }, LONG_PRESS_MS);
      this.host.changed();
      return;
    }
    if (this.armed) {
      if (remaining(this.host.level, this.items, this.armed) <= 0) {
        this.host.toast('None left: remove a piece or pick another tool');
        return;
      }
      const item = this.moveWithin(createItem(this.host.level, this.armed, cells), [0, 0]);
      this.selected = null;
      this.drag = { type: 'new', start: cells, orig: item };
      this.setGhost(item, null);
      return;
    }
    this.select(null);
  }

  private onMove(e: PointerEvent): void {
    const ptr = this.pointers.get(e.pointerId);
    if (!ptr) return;
    ptr.cells = this.host.toCells(e.clientX, e.clientY);
    ptr.client = [e.clientX, e.clientY];
    const d = this.drag;
    if (!d) return;
    const p = ptr.cells;
    switch (d.type) {
      case 'move': {
        const slop = this.pressClient ? len(sub(ptr.client, this.pressClient)) : 0;
        if (!d.moved && slop < DRAG_SLOP_PX) return;
        d.moved = true;
        window.clearTimeout(this.longPress);
        this.setGhost(this.moveWithin(d.orig, sub(p, d.start)), d.index);
        break;
      }
      case 'new':
        this.setGhost(this.moveWithin(d.orig, sub(p, d.start)), null);
        break;
      case 'handle':
        this.setGhost(dragHandle(this.host.level, d.orig, d.id, p), d.index);
        break;
      case 'pinch': {
        const [p1, p2] = [...this.pointers.values()];
        if (!p1 || !p2) return;
        const { angle, factor } = pinchDelta(d.from, { a: p1.client, b: p2.client });
        let item = transformItem(d.orig, angle, factor);
        const cap = this.host.level.inventory[item.kind]?.maxSize;
        if (cap !== undefined) item = dragClamp(item, d.orig, angle, cap);
        this.setGhost(item, d.index);
        break;
      }
    }
  }

  private onUp(e: PointerEvent): void {
    this.pointers.delete(e.pointerId);
    window.clearTimeout(this.longPress);
    const d = this.drag;
    if (!d) return;
    if (d.type === 'pinch' && this.pointers.size > 0) {
      // Finish the pinch as soon as one finger lifts.
      this.pointers.clear();
    }
    this.drag = null;
    const ghost = this.ghost;
    this.ghost = null;
    if (!ghost || (d.type === 'move' && !d.moved)) {
      this.host.changed();
      return;
    }
    if (d.type === 'new') {
      if (this.apply([...this.items, ghost])) {
        this.selected = this.items.length - 1;
        this.armed = null;
      }
    } else {
      const next = this.items.slice();
      next[d.index] = ghost;
      this.apply(next);
    }
    this.host.changed();
  }

  private onWheel(e: WheelEvent): void {
    if (this.selected === null) return;
    e.preventDefault();
    const dir = Math.sign(e.deltaY);
    if (e.shiftKey) {
      const item = this.items[this.selected]!;
      const scaled = transformItem(item, 0, dir > 0 ? 1 / 1.08 : 1.08);
      const cap = this.host.level.inventory[item.kind]?.maxSize;
      this.updateSelected(cap !== undefined ? dragClamp(scaled, item, 0, cap) : scaled);
    } else {
      this.rotateSelected(dir * (Math.PI / 36));
    }
  }
}

/** Keeps a scaled piece within its size cap by limiting the scale factor. */
function dragClamp(item: Item, orig: Item, angle: number, cap: number): Item {
  if (itemSize(item) <= cap) return item;
  return transformItem(orig, angle, cap / itemSize(orig));
}
