// Level thumbnails for the select screen: a schematic of the board drawn with Canvas2D (walls,
// fixed glass, sources, goals), cheap enough to draw every card without running the solver.

import { arcFrom, boxVertices, prismVertices } from '../geometry';
import type { Item, Level, V2 } from '../types';
import { colorsHex } from './palette';

const BG = { sound: '#0b1424', light: '#05070f', water: '#06243a' };

export function drawThumbnail(canvas: HTMLCanvasElement, level: Level, dpr = Math.min(2, window.devicePixelRatio || 1)): void {
  const cssW = canvas.clientWidth || 160;
  const { width, height } = level.grid;
  const cssH = (cssW * height) / width;
  canvas.width = Math.round(cssW * dpr);
  canvas.height = Math.round(cssH * dpr);
  canvas.style.height = `${cssH}px`;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const k = canvas.width / width;
  const light = !!level.medium.light;
  const water = level.display?.palette === 'water';
  ctx.fillStyle = light ? BG.light : water ? BG.water : BG.sound;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.setTransform(k, 0, 0, k, 0, 0);
  ctx.lineCap = 'round';
  const px = 1 / k;

  for (const item of level.fixed ?? []) drawItem(ctx, item, px);

  for (const src of level.sources) {
    const hue = light ? colorsHex(src.colors) : '#ffe3b0';
    ctx.strokeStyle = hue;
    ctx.fillStyle = hue;
    if (src.kind === 'point') {
      ring(ctx, src.pos, 3, 1.6 * px, hue, true);
      for (const r of [9, 17]) {
        ctx.globalAlpha = r === 9 ? 0.5 : 0.25;
        ring(ctx, src.pos, r, 1.2 * px, hue, false);
      }
      ctx.globalAlpha = 1;
    } else if (src.kind === 'line') {
      ctx.lineWidth = 3 * px;
      ctx.beginPath();
      ctx.moveTo(...src.a);
      ctx.lineTo(...src.b);
      ctx.stroke();
    } else {
      // A beam: a short bright ray in its direction.
      const len = Math.max(width, height) * 0.22;
      const end: V2 = [src.pos[0] + Math.cos(src.angle) * len, src.pos[1] + Math.sin(src.angle) * len];
      const grad = ctx.createLinearGradient(src.pos[0], src.pos[1], end[0], end[1]);
      grad.addColorStop(0, hue);
      grad.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.strokeStyle = grad;
      ctx.lineWidth = (src.width ?? 22) * 0.9;
      ctx.beginPath();
      ctx.moveTo(...src.pos);
      ctx.lineTo(...end);
      ctx.stroke();
    }
  }

  for (const g of level.goals) {
    const color =
      g.kind === 'silence' ? '#7cc8ff' : light && g.kind === 'focus' ? colorsHex(g.colors) : g.kind === 'resonate' ? '#ffd9a0' : '#ffb357';
    if (g.kind === 'sustain') {
      for (const p of g.antinodes) ring(ctx, p, Math.max(4, g.radius), 1.6 * px, '#ffb357', false);
      for (const p of g.nodes) ring(ctx, p, Math.max(4, g.radius), 1.6 * px, '#7cc8ff', false);
    } else if (g.kind === 'resonate') {
      diamond(ctx, g.pos, 7, color, px);
    } else {
      ring(ctx, g.pos, Math.max(5, g.radius), 2 * px, color, false);
      ctx.globalAlpha = 0.2;
      ring(ctx, g.pos, Math.max(5, g.radius), 0, color, true);
      ctx.globalAlpha = 1;
    }
  }
}

function ring(ctx: CanvasRenderingContext2D, p: V2, r: number, w: number, color: string, fill: boolean): void {
  ctx.beginPath();
  ctx.arc(p[0], p[1], r, 0, Math.PI * 2);
  if (fill) {
    ctx.fillStyle = color;
    ctx.fill();
  } else {
    ctx.strokeStyle = color;
    ctx.lineWidth = w;
    ctx.stroke();
  }
}

function diamond(ctx: CanvasRenderingContext2D, p: V2, r: number, color: string, px: number): void {
  ctx.beginPath();
  ctx.moveTo(p[0], p[1] - r);
  ctx.lineTo(p[0] + r * 0.7, p[1]);
  ctx.lineTo(p[0], p[1] + r);
  ctx.lineTo(p[0] - r * 0.7, p[1]);
  ctx.closePath();
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.8 * px;
  ctx.stroke();
}

function drawItem(ctx: CanvasRenderingContext2D, item: Item, px: number): void {
  ctx.strokeStyle = '#5b6680';
  ctx.fillStyle = 'rgba(160, 190, 255, 0.18)';
  switch (item.kind) {
    case 'wall':
      ctx.lineWidth = Math.max(item.thickness ?? 3, 2.5 * px);
      ctx.beginPath();
      ctx.moveTo(...item.a);
      ctx.lineTo(...item.b);
      ctx.stroke();
      break;
    case 'reflector': {
      ctx.lineWidth = Math.max(item.thickness ?? 3, 2.5 * px);
      const arc = arcFrom(item.a, item.b, item.bulge ?? 0);
      ctx.beginPath();
      if (arc) ctx.arc(arc.center[0], arc.center[1], arc.radius, arc.start, arc.end, arc.ccw);
      else {
        ctx.moveTo(...item.a);
        ctx.lineTo(...item.b);
      }
      ctx.stroke();
      break;
    }
    case 'absorber':
    case 'slab':
    case 'prism': {
      const v = item.kind === 'prism' ? prismVertices(item.pos, item.size, item.angle ?? 0) : boxVertices(item.pos, item.size, item.angle ?? 0);
      ctx.beginPath();
      v.forEach((p, i) => (i === 0 ? ctx.moveTo(...p) : ctx.lineTo(...p)));
      ctx.closePath();
      ctx.fillStyle = item.kind === 'absorber' ? 'rgba(160, 140, 190, 0.35)' : 'rgba(160, 190, 255, 0.18)';
      ctx.fill();
      break;
    }
    case 'lens':
      ctx.beginPath();
      ctx.ellipse(item.pos[0], item.pos[1], item.radii[0], item.radii[1], item.angle ?? 0, 0, Math.PI * 2);
      ctx.fill();
      break;
    default:
      break;
  }
}
