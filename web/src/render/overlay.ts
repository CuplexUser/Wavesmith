// Canvas2D layer above the field: goals, sources, the art for transparent and soft pieces
// (glass, foam, speakers, tuning forks), selection, and edit handles. Walls and reflectors are
// drawn by the shader from distance fields. Drawing happens in play-area cell coordinates.

import { arcFrom, boxVertices, itemCenter, motionAt, motionRect, motionStop, prismVertices, type Rect } from '../geometry';
import { handlesFor } from '../input/handles';
import { colorsHex, lightHex } from './palette';
import type { GoalStatus, Item, Level, Material, SourceDef, V2 } from '../types';

export const COLORS = {
  piece: '#5ef2c2',
  invalid: '#ff5d73',
  source: '#ffe3b0',
  focus: '#ffb357',
  silence: '#7cc8ff',
  done: '#a8ffbf',
  handle: '#f4f7ff',
};



const GLASS_TINT: Record<Material, string> = {
  water: '90, 190, 255',
  crown: '205, 228, 255',
  flint: '255, 214, 160',
};

export interface OverlayState {
  level: Level;
  items: Item[];
  selected: number | null;
  hover: number | null;
  /** Piece being dragged, drawn in place of `items[selected]` until released. */
  ghost: Item | null;
  ghostValid: boolean;
  /** Where the pointer wanted the piece when that spot wasn't allowed. */
  blocked: Item | null;
  /** Point an endpoint snapped to. */
  snap: V2 | null;
  /** The dragged piece will be removed on release. */
  trash: boolean;
  goals: GoalStatus[];
  /** Time for animating glyphs (frozen at 0 for reduced motion). */
  time: number;
  /** Simulated time, for placing moving sources. */
  simTime: number;
  /** Amplitude of each player resonator, in placement order. */
  resonance: number[];
  /** Handle radius in CSS pixels (bigger for touch). */
  handleSize: number;
  /** Tool being placed, so its allowed area can be shown. */
  armed?: string | null;
}


export class OverlayRenderer {
  private ctx: CanvasRenderingContext2D;
  /** CSS pixels per cell. */
  private scale = 1;
  private dpr = 1;
  /** Play-area size and simulated time of the frame being drawn. */
  private size: V2 = [1, 1];
  private simTime = 0;
  /** Placement area of emitters, which moving emitters keep to. */
  private emitterTrack: Rect | undefined;
  /** The level is drawn as water. */
  private water = false;

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
    this.size = [s.level.grid.width, s.level.grid.height];
    this.simTime = s.simTime;
    this.emitterTrack = s.level.inventory.emitter?.area;
    this.water = s.level.display?.palette === 'water';
    const light = !!s.level.medium.light;

    this.drawAreas(s);
    s.level.goals.forEach((g, i) => this.drawGoal(g, s.goals[i], light));
    for (const item of s.level.fixed ?? []) this.drawArt(item, 1, s.time, 0);

    let res = 0;
    s.items.forEach((item, i) => {
      const amp = item.kind === 'resonator' ? (s.resonance[res++] ?? 0) : 0;
      if (i === s.selected && s.ghost) return;
      this.drawArt(item, 1, s.time, amp);
    });
    this.drawSources(s.level, s.time);

    const selected = s.ghost ?? (s.selected !== null ? s.items[s.selected] : undefined);
    if (s.hover !== null && s.hover !== s.selected && !s.ghost) {
      const h = s.items[s.hover];
      if (h) this.outline(h, 'rgba(244, 247, 255, 0.35)', 3);
    }
    if (s.ghost) {
      this.drawArt(s.ghost, s.trash ? 0.35 : 0.92, s.time, 0);
    }
    if (s.blocked) {
      this.ctx.setLineDash([4 * this.px, 4 * this.px]);
      this.outline(s.blocked, 'rgba(255, 93, 115, 0.75)', 1.5);
      this.ctx.setLineDash([]);
    }
    if (selected) {
      const color = s.trash || !s.ghostValid ? COLORS.invalid : COLORS.piece;
      this.glow(selected, color);
      if (!s.trash) this.drawHandles(selected, s.handleSize);
    }
    if (s.snap) this.drawSnap(s.snap);
  }

  // ---------- Paths ----------

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
      case 'slab':
        this.poly(boxVertices(item.pos, item.size, item.angle ?? 0));
        break;
      case 'prism':
        this.poly(prismVertices(item.pos, item.size, item.angle ?? 0));
        break;
      case 'lens':
        ctx.ellipse(item.pos[0], item.pos[1], item.radii[0], item.radii[1], item.angle ?? 0, 0, Math.PI * 2);
        break;
      case 'resonator':
      case 'emitter':
        ctx.arc(item.pos[0], item.pos[1], 4.2, 0, Math.PI * 2);
        break;
    }
  }

  private poly(verts: V2[]): void {
    const ctx = this.ctx;
    verts.forEach((v, i) => (i === 0 ? ctx.moveTo(...v) : ctx.lineTo(...v)));
    ctx.closePath();
  }

  /** Width (cells) a segment piece occupies. */
  private bodyWidth(item: Item): number {
    return item.kind === 'wall' || item.kind === 'reflector' ? (item.thickness ?? 3) : 0;
  }

  private outline(item: Item, color: string, widthPx: number): void {
    const ctx = this.ctx;
    this.path(item);
    ctx.strokeStyle = color;
    ctx.lineWidth = this.bodyWidth(item) + widthPx * this.px;
    ctx.stroke();
  }

  private glow(item: Item, color: string): void {
    const ctx = this.ctx;
    ctx.save();
    ctx.shadowColor = color;
    ctx.shadowBlur = 10 * this.dpr;
    ctx.globalAlpha = 0.85;
    this.path(item);
    ctx.strokeStyle = color;
    ctx.lineWidth = this.bodyWidth(item) + 2.5 * this.px;
    if (this.bodyWidth(item) > 0) {
      // Segments: a halo hugging the metal, drawn behind by stroking wider and translucent.
      ctx.globalAlpha = 0.35;
      ctx.lineWidth = this.bodyWidth(item) + 6 * this.px;
    }
    ctx.stroke();
    ctx.restore();
  }

  // ---------- Piece art ----------

  private drawArt(item: Item, alpha: number, t: number, amp: number): void {
    const ctx = this.ctx;
    ctx.save();
    ctx.globalAlpha = alpha;
    switch (item.kind) {
      case 'absorber':
        this.drawFoam(item.pos, item.size, item.angle ?? 0);
        break;
      case 'lens':
      case 'prism':
      case 'slab':
        this.drawGlass(item);
        break;
      case 'emitter':
        if (item.vel && (item.vel[0] !== 0 || item.vel[1] !== 0)) {
          const rect = motionRect(this.size, this.emitterTrack);
          this.drawPath(item.pos, item.vel, rect, COLORS.piece);
          this.drawSpeaker(motionAt(item.pos, item.vel, this.simTime, rect), item.freq, item.phase ?? 0, t);
        } else {
          this.drawSpeaker(item.pos, item.freq, item.phase ?? 0, t);
        }
        break;
      case 'resonator':
        this.drawFork(item.pos, item.freq, amp, t);
        break;
      case 'wall':
      case 'reflector':
        // Drawn by the shader; while dragging, the shader shows the preview layout.
        break;
    }
    ctx.restore();
  }

  /** Acoustic foam: a field of little pyramids, lit from the top-left. */
  private drawFoam(pos: V2, size: V2, angle: number): void {
    const ctx = this.ctx;
    const [w, h] = size;
    ctx.save();
    ctx.translate(...pos);
    ctx.rotate(angle);
    ctx.beginPath();
    ctx.roundRect(-w / 2, -h / 2, w, h, 1.5);
    ctx.fillStyle = 'rgba(16, 13, 22, 0.86)';
    ctx.fill();
    ctx.clip();
    const cell = 4;
    const shades = ['#3b3449', '#2a2434', '#1d1925', '#141119'];
    for (let y = -h / 2; y < h / 2; y += cell) {
      for (let x = -w / 2; x < w / 2; x += cell) {
        const cx = x + cell / 2;
        const cy = y + cell / 2;
        const tri = (ax: number, ay: number, bx: number, by: number, fill: string) => {
          ctx.beginPath();
          ctx.moveTo(ax, ay);
          ctx.lineTo(bx, by);
          ctx.lineTo(cx, cy);
          ctx.closePath();
          ctx.fillStyle = fill;
          ctx.fill();
        };
        tri(x, y, x + cell, y, shades[0]!); // top, lit
        tri(x, y, x, y + cell, shades[1]!); // left
        tri(x + cell, y, x + cell, y + cell, shades[2]!); // right
        tri(x, y + cell, x + cell, y + cell, shades[3]!); // bottom, shaded
      }
    }
    ctx.restore();
    ctx.save();
    ctx.translate(...pos);
    ctx.rotate(angle);
    ctx.strokeStyle = 'rgba(160, 140, 190, 0.45)';
    ctx.lineWidth = 1 * this.px;
    ctx.strokeRect(-w / 2, -h / 2, w, h);
    ctx.restore();
  }

  /** Glass: tinted body, light edge on the lit side, dark edge opposite, and a glint. */
  private drawGlass(item: Item & { kind: 'lens' | 'prism' | 'slab' }): void {
    const ctx = this.ctx;
    // Slow regions without a material: purple gel for sound, sand-colored shallows for water.
    const tint = item.material ? GLASS_TINT[item.material] : this.water ? '214, 190, 130' : '170, 140, 255';
    const c = itemCenter(item);
    const r = item.kind === 'lens' ? Math.max(...item.radii) : Math.max(...item.size) / 2;
    const grad = ctx.createLinearGradient(c[0] - r, c[1] - r, c[0] + r, c[1] + r);
    grad.addColorStop(0, `rgba(${tint}, 0.22)`);
    grad.addColorStop(0.5, `rgba(${tint}, 0.08)`);
    grad.addColorStop(1, `rgba(${tint}, 0.16)`);
    this.path(item);
    ctx.fillStyle = grad;
    ctx.fill();
    // Rim: bright where the edge faces the light, dimmer elsewhere.
    const rim = ctx.createLinearGradient(c[0] - r, c[1] - r, c[0] + r, c[1] + r);
    rim.addColorStop(0, 'rgba(255, 255, 255, 0.85)');
    rim.addColorStop(0.55, `rgba(${tint}, 0.45)`);
    rim.addColorStop(1, 'rgba(40, 60, 100, 0.6)');
    ctx.strokeStyle = rim;
    ctx.lineWidth = 1.3 * this.px;
    ctx.stroke();
    // Glint.
    ctx.save();
    this.path(item);
    ctx.clip();
    const gx = c[0] - r * 0.35;
    const gy = c[1] - r * 0.4;
    const glint = ctx.createRadialGradient(gx, gy, 0, gx, gy, r * 0.45);
    glint.addColorStop(0, 'rgba(255, 255, 255, 0.28)');
    glint.addColorStop(1, 'rgba(255, 255, 255, 0)');
    ctx.fillStyle = glint;
    ctx.fillRect(c[0] - r, c[1] - r, 2 * r, 2 * r);
    ctx.restore();
  }

  /** Dashed outlines of the areas some pieces are limited to: always faint, brighter while
   * that piece is being placed or edited. */
  private drawAreas(s: OverlayState): void {
    const ctx = this.ctx;
    const active = s.ghost?.kind ?? (s.selected !== null ? s.items[s.selected]?.kind : undefined) ?? s.armed;
    for (const [kind, entry] of Object.entries(s.level.inventory)) {
      const a = entry?.area;
      if (!a) continue;
      const on = kind === active;
      ctx.save();
      ctx.setLineDash([4 * this.px, 4 * this.px]);
      ctx.strokeStyle = COLORS.piece;
      ctx.globalAlpha = on ? 0.75 : 0.28;
      ctx.lineWidth = 1.2 * this.px;
      ctx.strokeRect(a[0], a[1], a[2] - a[0], a[3] - a[1]);
      if (on) {
        ctx.globalAlpha = 0.07;
        ctx.fillStyle = COLORS.piece;
        ctx.fillRect(a[0], a[1], a[2] - a[0], a[3] - a[1]);
      }
      ctx.restore();
    }
  }

  /** A dashed track from a moving source's start to where it stops, with an arrowhead. */
  private drawPath(from: V2, vel: V2, rect: Rect, color: string): void {
    const stop = motionStop(from, vel, rect);
    if (!Number.isFinite(stop) || stop <= 0) return;
    const ctx = this.ctx;
    const to: V2 = [from[0] + vel[0] * stop, from[1] + vel[1] * stop];
    ctx.save();
    ctx.strokeStyle = color;
    ctx.globalAlpha = 0.45;
    ctx.lineWidth = 1.2 * this.px;
    ctx.setLineDash([3 * this.px, 4 * this.px]);
    ctx.beginPath();
    ctx.moveTo(...from);
    ctx.lineTo(...to);
    ctx.stroke();
    ctx.setLineDash([]);
    const a = Math.atan2(vel[1], vel[0]);
    const head = 5;
    ctx.beginPath();
    ctx.moveTo(to[0] - head * Math.cos(a - 0.45), to[1] - head * Math.sin(a - 0.45));
    ctx.lineTo(...to);
    ctx.lineTo(to[0] - head * Math.cos(a + 0.45), to[1] - head * Math.sin(a + 0.45));
    ctx.stroke();
    // Start marker: where the piece is grabbed.
    ctx.globalAlpha = 0.6;
    ctx.beginPath();
    ctx.arc(from[0], from[1], 3, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }

  /** A small speaker whose rings pulse at its frequency and phase. */
  private drawSpeaker(pos: V2, freq: number, phase: number, t: number): void {
    const ctx = this.ctx;
    const [x, y] = pos;
    const cycle = (((t * freq + phase / (Math.PI * 2)) % 1) + 1) % 1;
    for (const off of [0, 0.5]) {
      const p = (cycle + off) % 1;
      ctx.strokeStyle = `rgba(94, 242, 194, ${0.5 * (1 - p)})`;
      ctx.lineWidth = 1.4 * this.px;
      ctx.beginPath();
      ctx.arc(x, y, 5 + p * 8, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.beginPath();
    ctx.arc(x, y, 4.2, 0, Math.PI * 2);
    ctx.fillStyle = '#0d1828';
    ctx.fill();
    ctx.strokeStyle = COLORS.piece;
    ctx.lineWidth = 1.6 * this.px;
    ctx.stroke();
    const cone = ctx.createRadialGradient(x - 0.8, y - 0.8, 0.2, x, y, 3.2);
    cone.addColorStop(0, '#c9fff0');
    cone.addColorStop(0.4, '#5ef2c2');
    cone.addColorStop(1, '#14513f');
    ctx.beginPath();
    ctx.arc(x, y, 2.9, 0, Math.PI * 2);
    ctx.fillStyle = cone;
    ctx.fill();
  }

  /** A tuning fork that glows and shivers as it stores energy. */
  private drawFork(pos: V2, freq: number, amp: number, t: number): void {
    const ctx = this.ctx;
    const [x, y] = pos;
    const level = Math.min(1, amp / 2);
    if (level > 0.02) {
      const halo = ctx.createRadialGradient(x, y, 0, x, y, 9);
      halo.addColorStop(0, `rgba(255, 179, 87, ${0.55 * level})`);
      halo.addColorStop(1, 'rgba(255, 179, 87, 0)');
      ctx.fillStyle = halo;
      ctx.beginPath();
      ctx.arc(x, y, 9, 0, Math.PI * 2);
      ctx.fill();
    }
    const wobble = Math.sin(t * freq * Math.PI * 2) * 0.6 * level;
    const metal = ctx.createLinearGradient(x - 2, y - 4, x + 2, y + 4);
    metal.addColorStop(0, '#f2f6ff');
    metal.addColorStop(1, '#7d8aa3');
    ctx.strokeStyle = metal;
    ctx.lineWidth = 1.1;
    ctx.beginPath();
    ctx.moveTo(x - 1.5 - wobble, y - 4.5);
    ctx.lineTo(x - 1.5, y + 0.5);
    ctx.quadraticCurveTo(x - 1.5, y + 2, x, y + 2);
    ctx.quadraticCurveTo(x + 1.5, y + 2, x + 1.5, y + 0.5);
    ctx.lineTo(x + 1.5 + wobble, y - 4.5);
    ctx.moveTo(x, y + 2);
    ctx.lineTo(x, y + 5);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(x, y + 5.3, 0.9, 0, Math.PI * 2);
    ctx.fillStyle = '#c3cbda';
    ctx.fill();
  }

  // ---------- Sources and goals ----------

  private drawSources(level: Level, t: number): void {
    const ctx = this.ctx;
    const px = this.px;
    const light = !!level.medium.light;
    for (const src of level.sources) {
      const hue = light ? colorsHex(src.colors) : COLORS.source;
      const freq = light ? 4 : (src.freq ?? 3);
      const phase = (t * freq) % 1;
      if (src.kind === 'point') {
        const rect = motionRect([level.grid.width, level.grid.height]);
        if (src.vel) this.drawPath(src.pos, src.vel, rect, COLORS.source);
        const [x, y] = motionAt(src.pos, src.vel, this.simTime, rect);
        for (const off of [0, 0.5]) {
          const p = (phase + off) % 1;
          ctx.globalAlpha = 0.5 * (1 - p);
          ctx.strokeStyle = hue;
          ctx.lineWidth = 1.5 * px;
          ctx.beginPath();
          ctx.arc(x, y, 3 + p * 9, 0, Math.PI * 2);
          ctx.stroke();
        }
        ctx.globalAlpha = 1;
        ctx.fillStyle = light ? hue : COLORS.source;
        ctx.shadowColor = light ? hue : COLORS.focus;
        ctx.shadowBlur = 12 * this.dpr;
        ctx.beginPath();
        ctx.arc(x, y, 2.4, 0, Math.PI * 2);
        ctx.fill();
        ctx.shadowBlur = 0;
      } else if (src.kind === 'line') {
        ctx.strokeStyle = hue;
        ctx.lineWidth = 2.2;
        ctx.setLineDash([3, 3]);
        ctx.lineDashOffset = -phase * 6;
        ctx.shadowColor = light ? hue : COLORS.focus;
        ctx.shadowBlur = 10 * this.dpr;
        ctx.beginPath();
        ctx.moveTo(...src.a);
        ctx.lineTo(...src.b);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.shadowBlur = 0;
      } else {
        this.drawProjector(src, hue);
      }
    }
  }

  /** Beam source: a lamp housing behind the emitting face. */
  private drawProjector(src: SourceDef & { kind: 'beam' }, hue: string): void {
    const ctx = this.ctx;
    const w = (src.width ?? 18) * 1.1;
    ctx.save();
    ctx.translate(...src.pos);
    ctx.rotate(src.angle);
    const body = ctx.createLinearGradient(0, -w, 0, w);
    body.addColorStop(0, '#3a4256');
    body.addColorStop(0.5, '#1b2131');
    body.addColorStop(1, '#0d111b');
    ctx.beginPath();
    ctx.roundRect(-14, -w * 0.62, 13, w * 1.24, 2.5);
    ctx.fillStyle = body;
    ctx.fill();
    ctx.strokeStyle = 'rgba(160, 186, 230, 0.4)';
    ctx.lineWidth = 1 * this.px;
    ctx.stroke();
    // Cooling fins.
    ctx.strokeStyle = 'rgba(160, 186, 230, 0.18)';
    for (let i = -10; i <= -4; i += 2.5) {
      ctx.beginPath();
      ctx.moveTo(i, -w * 0.5);
      ctx.lineTo(i, w * 0.5);
      ctx.stroke();
    }
    // Emitting face.
    ctx.shadowColor = hue;
    ctx.shadowBlur = 14 * this.dpr;
    ctx.fillStyle = hue;
    ctx.beginPath();
    ctx.roundRect(-2.2, -w * 0.5, 2.6, w, 1.2);
    ctx.fill();
    ctx.restore();
  }

  private drawGoal(goal: Level['goals'][number], st: GoalStatus | undefined, light: boolean): void {
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
        const hue = light ? colorsHex(goal.colors) : COLORS.focus;
        const color = done ? COLORS.done : hue;
        const fill = Math.min(1, ratio);
        ctx.save();
        ctx.globalAlpha = 0.1 + 0.35 * fill;
        ctx.fillStyle = hue;
        ctx.beginPath();
        ctx.arc(x, y, goal.radius, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
        ctx.strokeStyle = color;
        ctx.lineWidth = 1.5 * px;
        ctx.beginPath();
        ctx.arc(x, y, goal.radius, 0, Math.PI * 2);
        ctx.stroke();
        // Crosshair ticks.
        ctx.beginPath();
        for (const [dx, dy] of [
          [1, 0],
          [-1, 0],
          [0, 1],
          [0, -1],
        ] as const) {
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
        const base = light ? '#9aa6c4' : COLORS.silence;
        const color = done ? COLORS.done : loud ? COLORS.invalid : base;
        ctx.fillStyle = loud ? 'rgba(255, 93, 115, 0.12)' : 'rgba(124, 200, 255, 0.08)';
        ctx.beginPath();
        ctx.arc(x, y, goal.radius, 0, Math.PI * 2);
        ctx.fill();
        ctx.setLineDash([4 * px, 4 * px]);
        ctx.strokeStyle = color;
        ctx.lineWidth = 1.5 * px;
        ctx.stroke();
        ctx.setLineDash([]);
        if (light && goal.colors && goal.colors.length < 3) {
          // Show which colors must stay out: small crossed dots.
          goal.colors.forEach((c, i) => {
            const cx = x + (i - (goal.colors!.length - 1) / 2) * 4;
            ctx.fillStyle = lightHex(c);
            ctx.beginPath();
            ctx.arc(cx, y, 1.4, 0, Math.PI * 2);
            ctx.fill();
          });
        } else {
          ctx.beginPath();
          ctx.moveTo(x - goal.radius * 0.35, y);
          ctx.lineTo(x + goal.radius * 0.35, y);
          ctx.stroke();
        }
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

  // ---------- Editing aids ----------

  private drawHandles(item: Item, sizePx: number): void {
    const ctx = this.ctx;
    const px = this.px;
    const r = sizePx * px;
    const center = itemCenter(item);
    for (const h of handlesFor(item)) {
      if (h.id === 'bulge' && item.kind === 'reflector') {
        // Tie the bend handle to the reflector's apex.
        const apex = arcFrom(item.a, item.b, item.bulge ?? 0)?.apex ?? [
          (item.a[0] + item.b[0]) / 2,
          (item.a[1] + item.b[1]) / 2,
        ];
        ctx.strokeStyle = 'rgba(244, 247, 255, 0.35)';
        ctx.lineWidth = 1 * px;
        ctx.setLineDash([2 * px, 3 * px]);
        ctx.beginPath();
        ctx.moveTo(apex[0], apex[1]);
        ctx.lineTo(...h.pos);
        ctx.stroke();
        ctx.setLineDash([]);
      }
      if (h.id === 'rotate') {
        ctx.strokeStyle = 'rgba(244, 247, 255, 0.35)';
        ctx.lineWidth = 1 * px;
        ctx.setLineDash([3 * px, 3 * px]);
        ctx.beginPath();
        ctx.moveTo(...center);
        ctx.lineTo(...h.pos);
        ctx.stroke();
        ctx.setLineDash([]);
      }
      ctx.beginPath();
      if (h.id === 'bulge' || h.id === 'rotate') {
        ctx.moveTo(h.pos[0], h.pos[1] - r);
        ctx.lineTo(h.pos[0] + r, h.pos[1]);
        ctx.lineTo(h.pos[0], h.pos[1] + r);
        ctx.lineTo(h.pos[0] - r, h.pos[1]);
        ctx.closePath();
      } else {
        ctx.arc(h.pos[0], h.pos[1], r * 0.85, 0, Math.PI * 2);
      }
      ctx.fillStyle = COLORS.handle;
      ctx.shadowColor = 'rgba(0, 0, 0, 0.6)';
      ctx.shadowBlur = 4 * this.dpr;
      ctx.fill();
      ctx.shadowBlur = 0;
      ctx.strokeStyle = '#0b2a22';
      ctx.lineWidth = 2 * px;
      ctx.stroke();
      if (h.id === 'rotate') {
        // A tiny curved arrow marks the rotate handle.
        ctx.strokeStyle = '#0b2a22';
        ctx.lineWidth = 1.4 * px;
        ctx.beginPath();
        ctx.arc(h.pos[0], h.pos[1], r * 0.45, -Math.PI * 0.9, Math.PI * 0.4);
        ctx.stroke();
      }
    }
  }

  private drawSnap(p: V2): void {
    const ctx = this.ctx;
    const px = this.px;
    ctx.strokeStyle = COLORS.piece;
    ctx.lineWidth = 1.5 * px;
    ctx.beginPath();
    ctx.arc(p[0], p[1], 6 * px, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(p[0] - 9 * px, p[1]);
    ctx.lineTo(p[0] + 9 * px, p[1]);
    ctx.moveTo(p[0], p[1] - 9 * px);
    ctx.lineTo(p[0], p[1] + 9 * px);
    ctx.stroke();
  }
}
