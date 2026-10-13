// Canvas2D layer above the field: sources, goals, the player's pieces, and edit handles.
// Drawing happens in play-area cell coordinates.

import { arcFrom, itemCenter } from '../geometry';
import { handlesFor } from '../input/handles';
import type { GoalStatus, Item, Level } from '../types';

export const COLORS = {
  piece: '#5ef2c2',
  pieceDim: 'rgba(94, 242, 194, 0.55)',
  invalid: '#ff5d73',
  source: '#ffe3b0',
  focus: '#ffb357',
  silence: '#7cc8ff',
  done: '#a8ffbf',
  handle: '#f4f7ff',
};

export interface OverlayState {
  level: Level;
  items: Item[];
  selected: number | null;
  /** Piece being dragged, drawn in place of `items[selected]` until released. */
  ghost: Item | null;
  ghostValid: boolean;
  goals: GoalStatus[];
  /** Simulated time, for animating source glyphs. */
  time: number;
}

export class OverlayRenderer {
  private ctx: CanvasRenderingContext2D;
  /** CSS pixels per cell. */
  private scale = 1;
  private dpr = 1;

  constructor(readonly canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext('2d')!;
  }

  resize(cssW: number, cssH: number, dpr: number, cellsW: number): void {
    this.scale = cssW / cellsW;
    this.dpr = dpr;
    const w = Math.max(1, Math.round(cssW * dpr));
    const h = Math.max(1, Math.round(cssH * dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
  }

  /** One CSS pixel in cells. */
  private get px(): number {
    return 1 / this.scale;
  }

  draw(s: OverlayState): void {
    const ctx = this.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    const k = this.scale * this.dpr;
    ctx.setTransform(k, 0, 0, k, 0, 0);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    s.level.goals.forEach((g, i) => this.drawGoal(g, s.goals[i]));
    this.drawSources(s.level, s.time);
    s.items.forEach((item, i) => {
      if (i === s.selected && s.ghost) return;
      this.drawPiece(item, i === s.selected, false, true);
    });
    if (s.ghost) {
      this.drawPiece(s.ghost, true, true, s.ghostValid);
    }
    const sel = s.ghost ?? (s.selected !== null ? s.items[s.selected] : undefined);
    if (sel) this.drawHandles(sel);
  }

  private drawSources(level: Level, t: number): void {
    const ctx = this.ctx;
    const px = this.px;
    for (const src of level.sources) {
      const phase = (t * src.freq) % 1;
      if (src.kind === 'point') {
        const [x, y] = src.pos;
        for (const off of [0, 0.5]) {
          const p = (phase + off) % 1;
          ctx.strokeStyle = `rgba(255, 227, 176, ${0.5 * (1 - p)})`;
          ctx.lineWidth = 1.5 * px;
          ctx.beginPath();
          ctx.arc(x, y, 3 + p * 9, 0, Math.PI * 2);
          ctx.stroke();
        }
        ctx.fillStyle = COLORS.source;
        ctx.shadowColor = COLORS.focus;
        ctx.shadowBlur = 12 * this.dpr;
        ctx.beginPath();
        ctx.arc(x, y, 2.4, 0, Math.PI * 2);
        ctx.fill();
        ctx.shadowBlur = 0;
      } else {
        ctx.strokeStyle = COLORS.source;
        ctx.lineWidth = 2.2;
        ctx.setLineDash([3, 3]);
        ctx.lineDashOffset = -phase * 6;
        ctx.shadowColor = COLORS.focus;
        ctx.shadowBlur = 10 * this.dpr;
        ctx.beginPath();
        ctx.moveTo(...src.a);
        ctx.lineTo(...src.b);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.shadowBlur = 0;
      }
    }
  }

  private drawGoal(goal: Level['goals'][number], st: GoalStatus | undefined): void {
    const ctx = this.ctx;
    const px = this.px;
    const done = st?.complete ?? false;
    const ratio = st ? st.value / st.threshold : 0;
    const hold = st?.hold ?? 0;

    const holdArc = (x: number, y: number, r: number, color: string) => {
      if (hold <= 0) return;
      ctx.strokeStyle = color;
      ctx.lineWidth = 3 * px;
      ctx.beginPath();
      ctx.arc(x, y, r, -Math.PI / 2, -Math.PI / 2 + hold * Math.PI * 2);
      ctx.stroke();
    };

    switch (goal.kind) {
      case 'focus': {
        const [x, y] = goal.pos;
        const color = done ? COLORS.done : COLORS.focus;
        const fill = Math.min(1, ratio);
        ctx.fillStyle = `rgba(255, 179, 87, ${0.08 + 0.32 * fill})`;
        ctx.beginPath();
        ctx.arc(x, y, goal.radius, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = color;
        ctx.lineWidth = 1.5 * px;
        ctx.stroke();
        // Crosshair ticks.
        ctx.beginPath();
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
          ctx.moveTo(x + dx * (goal.radius + 2), y + dy * (goal.radius + 2));
          ctx.lineTo(x + dx * (goal.radius + 5), y + dy * (goal.radius + 5));
        }
        ctx.stroke();
        holdArc(x, y, goal.radius + 3.5, color);
        break;
      }
      case 'silence': {
        const [x, y] = goal.pos;
        const loud = ratio > 1;
        const color = done ? COLORS.done : loud ? COLORS.invalid : COLORS.silence;
        ctx.fillStyle = loud ? 'rgba(255, 93, 115, 0.12)' : 'rgba(124, 200, 255, 0.1)';
        ctx.beginPath();
        ctx.arc(x, y, goal.radius, 0, Math.PI * 2);
        ctx.fill();
        ctx.setLineDash([4 * px, 4 * px]);
        ctx.strokeStyle = color;
        ctx.lineWidth = 1.5 * px;
        ctx.stroke();
        ctx.setLineDash([]);
        // A small "hush" bar across the middle.
        ctx.beginPath();
        ctx.moveTo(x - goal.radius * 0.35, y);
        ctx.lineTo(x + goal.radius * 0.35, y);
        ctx.stroke();
        holdArc(x, y, goal.radius + 3, color);
        break;
      }
      case 'resonate': {
        const [x, y] = goal.pos;
        const r = 5;
        const color = done ? COLORS.done : COLORS.focus;
        const shake = done ? 0 : Math.min(1, ratio) * 0.8;
        ctx.save();
        ctx.translate(x + (Math.random() - 0.5) * shake, y + (Math.random() - 0.5) * shake);
        ctx.strokeStyle = color;
        ctx.fillStyle = `rgba(255, 179, 87, ${0.12 + 0.3 * Math.min(1, ratio)})`;
        ctx.lineWidth = 1.5 * px;
        ctx.beginPath();
        ctx.moveTo(0, -r * 1.4);
        ctx.lineTo(r, 0);
        ctx.lineTo(0, r * 1.4);
        ctx.lineTo(-r, 0);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
        ctx.restore();
        break;
      }
      case 'sustain': {
        ctx.lineWidth = 1.5 * px;
        for (const p of goal.antinodes) {
          ctx.strokeStyle = done ? COLORS.done : COLORS.focus;
          ctx.beginPath();
          ctx.arc(p[0], p[1], goal.radius, 0, Math.PI * 2);
          ctx.stroke();
        }
        for (const p of goal.nodes) {
          ctx.strokeStyle = done ? COLORS.done : COLORS.silence;
          ctx.beginPath();
          ctx.arc(p[0], p[1], goal.radius, 0, Math.PI * 2);
          ctx.moveTo(p[0] - goal.radius * 0.6, p[1] - goal.radius * 0.6);
          ctx.lineTo(p[0] + goal.radius * 0.6, p[1] + goal.radius * 0.6);
          ctx.stroke();
        }
        break;
      }
    }
  }

  /** Traces the piece's outline (segments as their centerline). */
  private path(item: Item): void {
    const ctx = this.ctx;
    ctx.beginPath();
    switch (item.kind) {
      case 'wall':
        ctx.moveTo(...item.a);
        ctx.lineTo(...item.b);
        break;
      case 'reflector': {
        const arc = arcFrom(item.a, item.b, item.bulge ?? 0);
        if (arc) {
          ctx.arc(arc.center[0], arc.center[1], arc.radius, arc.start, arc.end, arc.ccw);
        } else {
          ctx.moveTo(...item.a);
          ctx.lineTo(...item.b);
        }
        break;
      }
      case 'absorber':
        ctx.save();
        ctx.translate(...item.pos);
        ctx.rotate(item.angle ?? 0);
        ctx.rect(-item.size[0] / 2, -item.size[1] / 2, item.size[0], item.size[1]);
        ctx.restore();
        break;
      case 'lens':
        ctx.ellipse(item.pos[0], item.pos[1], item.radii[0], item.radii[1], item.angle ?? 0, 0, Math.PI * 2);
        break;
      case 'resonator':
      case 'emitter':
        ctx.arc(item.pos[0], item.pos[1], 3.2, 0, Math.PI * 2);
        break;
    }
  }

  private drawPiece(item: Item, selected: boolean, ghost: boolean, valid: boolean): void {
    const ctx = this.ctx;
    const px = this.px;
    const color = !valid ? COLORS.invalid : selected ? COLORS.piece : COLORS.pieceDim;
    if (item.kind === 'wall' || item.kind === 'reflector') {
      const t = item.thickness ?? 3;
      if (ghost) {
        this.path(item);
        ctx.strokeStyle = valid ? 'rgba(164, 179, 204, 0.85)' : 'rgba(255, 93, 115, 0.7)';
        ctx.lineWidth = t;
        ctx.stroke();
      }
      // A thin accent line along the piece marks it as the player's.
      this.path(item);
      ctx.strokeStyle = color;
      ctx.lineWidth = (selected ? 2 : 1.25) * px;
      ctx.setLineDash(ghost ? [] : [6 * px, 4 * px]);
      ctx.stroke();
      ctx.setLineDash([]);
      return;
    }
    this.path(item);
    if (item.kind === 'absorber' || item.kind === 'lens') {
      if (ghost) {
        ctx.fillStyle = valid
          ? item.kind === 'lens'
            ? 'rgba(158, 107, 255, 0.28)'
            : 'rgba(30, 20, 40, 0.5)'
          : 'rgba(255, 93, 115, 0.25)';
        ctx.fill();
      }
      ctx.setLineDash([5 * px, 4 * px]);
      ctx.strokeStyle = color;
      ctx.lineWidth = (selected ? 2 : 1.25) * px;
      ctx.stroke();
      ctx.setLineDash([]);
      return;
    }
    // Emitters and resonators.
    ctx.fillStyle = item.kind === 'emitter' ? 'rgba(94, 242, 194, 0.9)' : 'rgba(7, 11, 20, 0.85)';
    ctx.fill();
    ctx.strokeStyle = color;
    ctx.lineWidth = 2 * px;
    ctx.stroke();
    if (item.kind === 'resonator') {
      const [x, y] = item.pos;
      ctx.beginPath();
      ctx.moveTo(x - 1.4, y + 1.8);
      ctx.lineTo(x - 1.4, y - 1.8);
      ctx.moveTo(x + 1.4, y + 1.8);
      ctx.lineTo(x + 1.4, y - 1.8);
      ctx.stroke();
    }
  }

  private drawHandles(item: Item): void {
    const ctx = this.ctx;
    const px = this.px;
    const r = 6 * px;
    const center = itemCenter(item);
    for (const h of handlesFor(item)) {
      if (h.id === 'rotate') {
        ctx.strokeStyle = 'rgba(244, 247, 255, 0.35)';
        ctx.lineWidth = 1 * px;
        ctx.beginPath();
        ctx.moveTo(...center);
        ctx.lineTo(...h.pos);
        ctx.stroke();
      }
      ctx.beginPath();
      if (h.id === 'bulge' || h.id === 'rotate') {
        ctx.moveTo(h.pos[0], h.pos[1] - r);
        ctx.lineTo(h.pos[0] + r, h.pos[1]);
        ctx.lineTo(h.pos[0], h.pos[1] + r);
        ctx.lineTo(h.pos[0] - r, h.pos[1]);
        ctx.closePath();
      } else {
        ctx.arc(h.pos[0], h.pos[1], r, 0, Math.PI * 2);
      }
      ctx.fillStyle = COLORS.handle;
      ctx.fill();
      ctx.strokeStyle = '#070b14';
      ctx.lineWidth = 2 * px;
      ctx.stroke();
    }
  }
}
