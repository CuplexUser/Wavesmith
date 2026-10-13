// Pointer, touch, and keyboard editing of the player's pieces.
//
// While a piece is dragged it is previewed in place; the layout is only committed to the
// solver on release, because every commit restarts the run from rest. Drags never snap back:
// a move or resize that runs into something stops at the last allowed spot.

import { add, arcFrom, clone, controlPoints, dot, itemDistance, itemSize, len, scale, sub, translate } from '../geometry';
import { checkPlacements, createItem, pinchDelta, remaining, transformItem, type TwoPointer } from '../placement';
import type { Item, ToolKind, V2, Level } from '../types';
import { constrainEndpoint, dragHandle, handlesFor, type HandleId } from './handles';

export type EditSound = 'select' | 'place' | 'move' | 'remove' | 'invalid' | 'pickup';

export interface EditorHost {
  level: Level;
  /** The board element, for detecting drags off the board. */
  board: HTMLElement;
  /** Converts client (CSS pixel) coordinates to play-area cells. */
  toCells(clientX: number, clientY: number): V2;
  /** Cells per CSS pixel at the current zoom. */
  cellsPerPx(): number;
  /** Applies a layout to the simulation. Returns an error message if the core rejects it. */
  commit(items: Item[]): string | null;
  /** Shows a layout without applying it (`null` restores the committed one). */
  preview(items: Item[] | null): void;
  /** Selection, tool, or pieces changed. */
  changed(): void;
  /** Only drag feedback moved; redraw the overlay. */
  redraw(): void;
  toast(message: string): void;
  sound(kind: EditSound, item?: Item): void;
}

type Drag =
  | { type: 'move'; index: number; start: V2; orig: Item; moved: boolean; lastOk: V2 }
  | { type: 'new'; start: V2; orig: Item; lastOk: V2 | null }
  | { type: 'handle'; index: number; id: HandleId; orig: Item; lastOk: V2 | null }
  | { type: 'pinch'; index: number; from: TwoPointer; orig: Item };

/** Movement (CSS px) that turns a press into a drag. */
const DRAG_SLOP_PX = 4;
/** Hit tolerance (CSS px) for pieces and handles, by pointer type. */
const HIT_PX = { mouse: 9, touch: 18 };
/** Endpoints snap to walls and other endpoints within this distance (CSS px). */
const SNAP_PX = 10;
/** Angles snap to multiples of 15° when within this many degrees. */
const ANGLE_SNAP_DEG = 3.5;
/** How far (CSS px) past the board edge a drag turns into "remove". */
const TRASH_PX = 18;

export class Editor {
  items: Item[] = [];
  selected: number | null = null;
  hover: number | null = null;
  armed: ToolKind | null = null;
  ghost: Item | null = null;
  ghostValid = true;
  /** Where the pointer wanted the piece when that spot wasn't allowed. */
  blocked: Item | null = null;
  /** Point an endpoint snapped to. */
  snap: V2 | null = null;
  /** The current drag will remove the piece. */
  trash = false;
  /** Coarse pointers (touch) get bigger targets and handles. */
  coarse = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
  private undoStack: Item[][] = [];
  private drag: Drag | null = null;
  private pointers = new Map<number, { cells: V2; client: V2 }>();
  private pressClient: V2 | null = null;
  private lastBlockedToast = 0;
  private detach: (() => void) | null = null;

  constructor(private host: EditorHost) {}

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  get dragging(): boolean {
    return this.drag !== null;
  }

  /** Handle radius in CSS pixels. */
  get handleSize(): number {
    return this.coarse ? 9 : 6;
  }

  attach(el: HTMLElement): void {
    const down = (e: PointerEvent) => this.onDown(e, el);
    const move = (e: PointerEvent) => this.onMove(e);
    const up = (e: PointerEvent) => this.onUp(e);
    const leave = () => this.setHover(null);
    const wheel = (e: WheelEvent) => this.onWheel(e);
    const menu = (e: MouseEvent) => this.onContextMenu(e);
    el.addEventListener('pointerdown', down);
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
    el.addEventListener('pointerleave', leave);
    el.addEventListener('wheel', wheel, { passive: false });
    el.addEventListener('contextmenu', menu);
    this.detach = () => {
      el.removeEventListener('pointerdown', down);
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
      el.removeEventListener('pointerleave', leave);
      el.removeEventListener('wheel', wheel);
      el.removeEventListener('contextmenu', menu);
    };
  }

  dispose(): void {
    this.detach?.();
  }

  arm(kind: ToolKind | null): void {
    this.armed = this.armed === kind ? null : kind;
    if (this.armed) this.selected = null;
    this.host.changed();
  }

  select(index: number | null): void {
    if (index !== null && index !== this.selected) this.host.sound('select', this.items[index]);
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
      this.host.sound('invalid');
      return false;
    }
    this.undoStack.push(this.items);
    if (this.undoStack.length > 100) this.undoStack.shift();
    this.items = next;
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

  deleteAt(index: number): void {
    const item = this.items[index];
    if (!item) return;
    const next = this.items.filter((_, i) => i !== index);
    this.selected = null;
    this.hover = null;
    if (this.apply(next)) this.host.sound('remove', item);
    this.host.changed();
  }

  deleteSelected(): void {
    if (this.selected !== null) this.deleteAt(this.selected);
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
    this.host.sound('move');
    this.host.changed();
  }

  rotateSelected(angle: number): void {
    if (this.selected === null) return;
    const item = this.items[this.selected]!;
    if (this.updateSelected(transformItem(item, angle, 1))) this.host.sound('move', item);
  }

  /** Flips a reflector's bend to the other side. */
  flipSelected(): void {
    const item = this.selected !== null ? this.items[this.selected] : undefined;
    if (item?.kind === 'reflector' && this.updateSelected({ ...item, bulge: -(item.bulge ?? 0) })) {
      this.host.sound('move', item);
    }
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
    const sel = this.selected !== null;
    switch (e.key) {
      case 'Delete':
      case 'Backspace':
        this.deleteSelected();
        return sel;
      case 'Escape':
        if (!sel && !this.armed) return false;
        this.armed = null;
        this.select(null);
        return true;
      case 'q':
      case 'Q':
        this.rotateSelected(-step);
        return sel;
      case 'e':
      case 'E':
        this.rotateSelected(step);
        return sel;
      case 'x':
      case 'X':
        this.flipSelected();
        return sel;
      case 'ArrowLeft':
        this.nudgeSelected([-nudge, 0]);
        return sel;
      case 'ArrowRight':
        this.nudgeSelected([nudge, 0]);
        return sel;
      case 'ArrowUp':
        this.nudgeSelected([0, -nudge]);
        return sel;
      case 'ArrowDown':
        this.nudgeSelected([0, nudge]);
        return sel;
    }
    return false;
  }

  // ---------- Hit testing ----------

  private tolerance(e: PointerEvent | MouseEvent): number {
    const touch = 'pointerType' in e && e.pointerType !== 'mouse';
    return (touch ? HIT_PX.touch : HIT_PX.mouse) * this.host.cellsPerPx();
  }

  /** The piece nearest to `p` within `tol`, preferring the selected one on ties. */
  private hitPiece(p: V2, tol: number): number | null {
    let best: number | null = null;
    let bestD = tol;
    for (let i = this.items.length - 1; i >= 0; i--) {
      const d = Math.max(0, itemDistance(this.items[i]!, p));
      if (d < bestD || (d === bestD && i === this.selected)) {
        best = i;
        bestD = d;
      }
    }
    return best;
  }

  private hitHandle(p: V2, tol: number): HandleId | null {
    if (this.selected === null) return null;
    let best: HandleId | null = null;
    let bestD = tol + this.handleSize * this.host.cellsPerPx();
    for (const h of handlesFor(this.items[this.selected]!)) {
      const d = len(sub(h.pos, p));
      if (d <= bestD) {
        best = h.id;
        bestD = d;
      }
    }
    return best;
  }

  private setHover(i: number | null): void {
    if (this.hover === i) return;
    this.hover = i;
    this.host.redraw();
  }

  // ---------- Geometry helpers ----------

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

  private layoutWith(item: Item, index: number | null): Item[] {
    const next = this.items.slice();
    if (index === null) next.push(item);
    else next[index] = item;
    return next;
  }

  private isValid(item: Item, index: number | null): boolean {
    return checkPlacements(this.host.level, this.layoutWith(item, index)) === null;
  }

  /**
   * Where a dragged endpoint should go: onto a nearby endpoint or wall (to seal gaps),
   * otherwise onto a 15° angle from the fixed end. Sets `this.snap` when it snapped to
   * geometry. Holding Shift or Alt turns snapping off.
   */
  private snapEndpoint(p: V2, fixed: V2, index: number, free: boolean): V2 {
    this.snap = null;
    if (free) return p;
    const r = SNAP_PX * this.host.cellsPerPx();
    let best: V2 | null = null;
    let bestD = r;
    const consider = (q: V2) => {
      const d = len(sub(q, p));
      if (d < bestD) {
        best = q;
        bestD = d;
      }
    };
    const others = [...(this.host.level.fixed ?? []), ...this.items.filter((_, i) => i !== index)];
    // Endpoints first: an exact join is what players usually want.
    for (const o of others) {
      if (o.kind === 'wall' || o.kind === 'reflector') {
        consider(o.a);
        consider(o.b);
      }
    }
    if (!best) {
      for (const o of others) {
        if (o.kind === 'wall') consider(nearestOnSegment(p, o.a, o.b));
        else if (o.kind === 'reflector') consider(nearestOnArc(p, o.a, o.b, o.bulge ?? 0));
      }
    }
    if (best) {
      this.snap = best;
      return best;
    }
    const v = sub(p, fixed);
    const l = len(v);
    if (l < 1) return p;
    const ang = Math.atan2(v[1], v[0]);
    const stepA = Math.PI / 12;
    const snapped = Math.round(ang / stepA) * stepA;
    if (Math.abs(snapped - ang) < (ANGLE_SNAP_DEG * Math.PI) / 180) {
      return add(fixed, [Math.cos(snapped) * l, Math.sin(snapped) * l]);
    }
    return p;
  }

  /** The furthest allowed piece along `make(t)` for t in 0..1, assuming t = 0 is allowed. */
  private slide(make: (t: number) => Item, index: number | null): Item {
    let lo = 0;
    let hi = 1;
    for (let i = 0; i < 10; i++) {
      const mid = (lo + hi) / 2;
      if (this.isValid(make(mid), index)) lo = mid;
      else hi = mid;
    }
    return make(lo);
  }

  /**
   * Shows `want` if it is allowed; otherwise the closest allowed piece along `fallback` (from
   * the last allowed spot at t = 0 toward `want` at t = 1). Returns whether `want` itself was
   * allowed.
   */
  private updateGhost(want: Item, index: number | null, fallback: ((t: number) => Item) | null): boolean {
    const ok = this.isValid(want, index);
    if (ok) {
      this.ghost = want;
      this.ghostValid = true;
      this.blocked = null;
    } else {
      this.blocked = want;
      if (fallback) {
        this.ghost = this.slide(fallback, index);
        this.ghostValid = true;
      } else {
        this.ghost = want;
        this.ghostValid = false;
      }
      this.toastBlocked(want, index);
    }
    this.host.preview(this.layoutWith(this.ghost, index));
    this.host.redraw();
    return ok;
  }

  private toastBlocked(want: Item, index: number | null): void {
    if (this.trash) return;
    const now = performance.now();
    if (now - this.lastBlockedToast < 1500) return;
    this.lastBlockedToast = now;
    const why = checkPlacements(this.host.level, this.layoutWith(want, index));
    if (why) this.host.toast(why);
  }

  private offBoard(client: V2): boolean {
    const r = this.host.board.getBoundingClientRect();
    return (
      client[0] < r.left - TRASH_PX ||
      client[0] > r.right + TRASH_PX ||
      client[1] < r.top - TRASH_PX ||
      client[1] > r.bottom + TRASH_PX
    );
  }

  // ---------- Pointer events ----------

  private onDown(e: PointerEvent, el: HTMLElement): void {
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    if (e.pointerType !== 'mouse') this.coarse = true;
    el.setPointerCapture(e.pointerId);
    const cells = this.host.toCells(e.clientX, e.clientY);
    this.pointers.set(e.pointerId, { cells, client: [e.clientX, e.clientY] });

    if (this.pointers.size === 2) {
      const index = this.drag && 'index' in this.drag ? this.drag.index : this.selected;
      if (index === null || index === undefined) return;
      const [p1, p2] = [...this.pointers.values()];
      this.drag = { type: 'pinch', index, from: { a: p1!.client, b: p2!.client }, orig: this.items[index]! };
      return;
    }
    if (this.pointers.size > 2) return;

    this.pressClient = [e.clientX, e.clientY];
    const tol = this.tolerance(e);
    const handle = this.hitHandle(cells, tol);
    if (handle && this.selected !== null) {
      this.drag = { type: 'handle', index: this.selected, id: handle, orig: this.items[this.selected]!, lastOk: null };
      this.host.sound('pickup', this.items[this.selected]);
      return;
    }
    const hit = this.hitPiece(cells, tol);
    if (hit !== null) {
      this.armed = null;
      this.select(hit);
      this.drag = { type: 'move', index: hit, start: cells, orig: this.items[hit]!, moved: false, lastOk: [0, 0] };
      return;
    }
    if (this.armed) {
      if (remaining(this.host.level, this.items, this.armed) <= 0) {
        this.host.toast('None left: remove a piece or pick another tool');
        this.host.sound('invalid');
        return;
      }
      const item = this.moveWithin(createItem(this.host.level, this.armed, cells), [0, 0]);
      this.selected = null;
      const ok = this.updateGhost(item, null, null);
      this.drag = { type: 'new', start: cells, orig: item, lastOk: ok ? [0, 0] : null };
      this.host.changed();
      return;
    }
    this.select(null);
  }

  private onMove(e: PointerEvent): void {
    const cells = this.host.toCells(e.clientX, e.clientY);
    const ptr = this.pointers.get(e.pointerId);
    if (!ptr) {
      // Hovering with a mouse: highlight what a click would grab.
      if (e.pointerType === 'mouse' && !this.drag) {
        const tol = this.tolerance(e);
        const onHandle = this.hitHandle(cells, tol) !== null;
        const hit = onHandle ? this.selected : this.hitPiece(cells, tol);
        this.setHover(hit);
        this.host.board.style.cursor = onHandle ? 'pointer' : hit !== null ? 'grab' : this.armed ? 'copy' : 'crosshair';
      }
      return;
    }
    ptr.cells = cells;
    ptr.client = [e.clientX, e.clientY];
    const d = this.drag;
    if (!d) return;
    const p = cells;
    switch (d.type) {
      case 'move': {
        const slop = this.pressClient ? len(sub(ptr.client, this.pressClient)) : 0;
        if (!d.moved && slop < DRAG_SLOP_PX) return;
        if (!d.moved) this.host.sound('pickup', d.orig);
        d.moved = true;
        this.host.board.style.cursor = 'grabbing';
        this.trash = this.offBoard(ptr.client);
        const want = sub(p, d.start);
        const from = d.lastOk;
        const at = (t: number) => this.moveWithin(d.orig, add(from, scale(sub(want, from), t)));
        this.updateGhost(at(1), d.index, at);
        d.lastOk = sub(controlPoints(this.ghost!)[0]!, controlPoints(d.orig)[0]!);
        break;
      }
      case 'new': {
        this.trash = this.offBoard(ptr.client);
        const want = sub(p, d.start);
        const from = d.lastOk;
        const at = (t: number) => this.moveWithin(d.orig, from ? add(from, scale(sub(want, from), t)) : want);
        this.updateGhost(at(1), null, from ? at : null);
        if (this.ghostValid) d.lastOk = sub(controlPoints(this.ghost!)[0]!, controlPoints(d.orig)[0]!);
        break;
      }
      case 'handle': {
        const orig = d.orig;
        let target = p;
        if ((d.id === 'a' || d.id === 'b') && (orig.kind === 'wall' || orig.kind === 'reflector')) {
          const fixed = d.id === 'a' ? orig.b : orig.a;
          target = this.snapEndpoint(p, fixed, d.index, e.altKey || e.shiftKey);
          target = constrainEndpoint(this.host.level, orig, fixed, target);
        }
        const from = d.lastOk;
        const at = (t: number) => dragHandle(this.host.level, orig, d.id, from ? add(from, scale(sub(target, from), t)) : target);
        if (this.updateGhost(at(1), d.index, from ? at : null)) d.lastOk = target;
        break;
      }
      case 'pinch': {
        const [p1, p2] = [...this.pointers.values()];
        if (!p1 || !p2) return;
        const { angle, factor } = pinchDelta(d.from, { a: p1.client, b: p2.client });
        const cap = this.host.level.inventory[d.orig.kind]?.maxSize ?? Infinity;
        const f = Math.min(factor, cap / Math.max(1e-6, itemSize(d.orig)));
        const at = (t: number) => transformItem(d.orig, angle * t, 1 + (f - 1) * t);
        this.updateGhost(at(1), d.index, at);
        break;
      }
    }
  }

  private onUp(e: PointerEvent): void {
    this.pointers.delete(e.pointerId);
    const d = this.drag;
    if (!d) return;
    if (d.type === 'pinch' && this.pointers.size > 0) {
      // Finish the pinch as soon as one finger lifts.
      this.pointers.clear();
    }
    this.drag = null;
    const ghost = this.ghost;
    const valid = this.ghostValid;
    const trash = this.trash;
    this.ghost = null;
    this.blocked = null;
    this.snap = null;
    this.trash = false;
    this.host.board.style.cursor = '';
    this.host.preview(null);

    if (d.type === 'move' && !d.moved) {
      this.host.changed();
      return;
    }
    if (trash) {
      if (d.type === 'move') this.deleteAt(d.index);
      this.host.changed();
      return;
    }
    if (!ghost || !valid) {
      if (ghost) {
        const index = d.type === 'new' ? null : d.index;
        this.host.toast(checkPlacements(this.host.level, this.layoutWith(ghost, index)) ?? 'Not allowed here');
        this.host.sound('invalid');
      }
      this.host.changed();
      return;
    }
    if (d.type === 'new') {
      if (this.apply([...this.items, ghost])) {
        this.selected = this.items.length - 1;
        this.armed = null;
        this.host.sound('place', ghost);
      }
    } else if (this.apply(this.layoutWith(ghost, d.index))) {
      this.host.sound('move', ghost);
    }
    this.host.changed();
  }

  private onWheel(e: WheelEvent): void {
    if (this.selected === null) return;
    e.preventDefault();
    const dir = Math.sign(e.deltaY);
    const item = this.items[this.selected]!;
    if (e.shiftKey) {
      const scaled = transformItem(item, 0, dir > 0 ? 1 / 1.08 : 1.08);
      const cap = this.host.level.inventory[item.kind]?.maxSize;
      if (cap === undefined || itemSize(scaled) <= cap) this.updateSelected(scaled);
    } else {
      this.rotateSelected(dir * (Math.PI / 36));
    }
  }

  /** Right-click removes the piece under the pointer. */
  private onContextMenu(e: MouseEvent): void {
    e.preventDefault();
    const hit = this.hitPiece(this.host.toCells(e.clientX, e.clientY), this.tolerance(e));
    if (hit !== null) this.deleteAt(hit);
  }
}

function nearestOnSegment(p: V2, a: V2, b: V2): V2 {
  const ab = sub(b, a);
  const l2 = dot(ab, ab);
  const t = l2 > 0 ? Math.max(0, Math.min(1, dot(sub(p, a), ab) / l2)) : 0;
  return add(a, scale(ab, t));
}

function nearestOnArc(p: V2, a: V2, b: V2, bulge: number): V2 {
  const arc = arcFrom(a, b, bulge);
  if (!arc) return nearestOnSegment(p, a, b);
  const d = sub(p, arc.center);
  const l = len(d);
  if (l > 1e-6 && dot(d, arc.apexDir) / l >= arc.cosHalf) {
    return add(arc.center, scale(d, arc.radius / l));
  }
  return len(sub(p, a)) < len(sub(p, b)) ? a : b;
}
