// Shapes shared with the Rust core. Field names match the level JSON and `Game.status()`.

export type V2 = [number, number];

export type ToolKind = 'wall' | 'reflector' | 'absorber' | 'lens' | 'prism' | 'slab' | 'resonator' | 'emitter';

export const TOOL_ORDER: ToolKind[] = ['wall', 'reflector', 'absorber', 'lens', 'prism', 'slab', 'resonator', 'emitter'];

export type Color = 'red' | 'green' | 'blue';
export const COLORS: Color[] = ['red', 'green', 'blue'];

/** Glass for light levels; each has its own refractive index per color. */
export type Material = 'water' | 'crown' | 'flint';

export type Item =
  | { kind: 'wall'; a: V2; b: V2; thickness?: number }
  | { kind: 'reflector'; a: V2; b: V2; bulge?: number; thickness?: number }
  | { kind: 'absorber'; pos: V2; size: V2; angle?: number; strength?: number }
  | { kind: 'lens'; pos: V2; radii: V2; angle?: number; ratio?: number; material?: Material }
  | { kind: 'prism'; pos: V2; size: V2; angle?: number; material?: Material }
  | { kind: 'slab'; pos: V2; size: V2; angle?: number; material?: Material }
  | { kind: 'resonator'; pos: V2; freq: number; q?: number }
  /** `vel` (cells/s) makes the emitter travel from `pos`; see `motionAt` in geometry.ts. */
  | { kind: 'emitter'; pos: V2; freq: number; amp?: number; phase?: number; vel?: V2 };

interface SourceCommon {
  /** Hz; light levels use each color's own frequency instead. */
  freq?: number;
  amp?: number;
  phase?: number;
  start?: number;
  /** Light levels: colors emitted (all three when omitted). */
  colors?: Color[];
}

export type SourceDef =
  | ({ kind: 'point'; pos: V2; vel?: V2 } & SourceCommon)
  | ({ kind: 'line'; a: V2; b: V2 } & SourceCommon)
  | ({ kind: 'beam'; pos: V2; angle: number; width?: number } & SourceCommon);

export type Goal =
  | { kind: 'focus'; pos: V2; radius: number; threshold: number; hold: number; colors?: Color[] }
  | {
      kind: 'silence';
      pos: V2;
      radius: number;
      threshold: number;
      hold: number;
      after?: number | null;
      colors?: Color[];
    }
  | { kind: 'resonate'; pos: V2; freq: number; q?: number; threshold: number }
  | {
      kind: 'sustain';
      antinodes: V2[];
      nodes: V2[];
      radius: number;
      high: number;
      low: number;
      hold: number;
    };

/** A setting the player may change on emitters and resonators. */
export type Tune = 'freq' | 'phase' | 'amp' | 'speed';

export interface InventoryEntry {
  count: number;
  cost: number;
  maxSize?: number;
  /** Material for new glass pieces. */
  material?: Material;
  /** Starting frequency of new emitters and resonators (default: the first source's). */
  freq?: number;
  /** Settings the player may change; others stay at their starting values. Defaults:
   * emitters tune frequency and phase, resonators frequency. */
  tune?: Tune[];
  /** Rectangle `[x0, y0, x1, y1]` the piece's handles must stay inside. */
  area?: [number, number, number, number];
}

export interface Level {
  id: string;
  name: string;
  chapter: number;
  description?: string;
  hint?: string;
  grid: { width: number; height: number };
  medium: { c: number; damping?: number; light?: boolean };
  sources: SourceDef[];
  fixed?: Item[];
  goals: Goal[];
  inventory: Partial<Record<ToolKind, InventoryEntry>>;
  budget: number;
  par: { cost: number; energy: number };
  timeLimit: number;
  /** Purely visual: field brightness and color scheme. */
  display?: { gain?: number; palette?: 'sound' | 'water' };
}

export interface GoalStatus {
  kind: Goal['kind'];
  value: number;
  threshold: number;
  extra?: number;
  hold: number;
  met: boolean;
  complete: boolean;
}

export interface SolveInfo {
  time: number;
  energy: number;
  cost: number;
  stars: number;
  costStar: boolean;
  energyStar: boolean;
}

export interface Status {
  time: number;
  steps: number;
  energy: number;
  cost: number;
  budget: number;
  timeLimit: number;
  timedOut: boolean;
  solved: SolveInfo | null;
  goals: GoalStatus[];
}
