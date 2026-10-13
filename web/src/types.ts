// Shapes shared with the Rust core. Field names match the level JSON and `Game.status()`.

export type V2 = [number, number];

export type ToolKind = 'wall' | 'reflector' | 'absorber' | 'lens' | 'resonator' | 'emitter';

export const TOOL_ORDER: ToolKind[] = ['wall', 'reflector', 'absorber', 'lens', 'resonator', 'emitter'];

export type Item =
  | { kind: 'wall'; a: V2; b: V2; thickness?: number }
  | { kind: 'reflector'; a: V2; b: V2; bulge?: number; thickness?: number }
  | { kind: 'absorber'; pos: V2; size: V2; angle?: number; strength?: number }
  | { kind: 'lens'; pos: V2; radii: V2; angle?: number; ratio: number }
  | { kind: 'resonator'; pos: V2; freq: number; q?: number }
  | { kind: 'emitter'; pos: V2; freq: number; amp?: number; phase?: number };

export type SourceDef =
  | { kind: 'point'; pos: V2; freq: number; amp?: number; phase?: number; start?: number }
  | { kind: 'line'; a: V2; b: V2; freq: number; amp?: number; phase?: number; start?: number };

export type Goal =
  | { kind: 'focus'; pos: V2; radius: number; threshold: number; hold: number }
  | { kind: 'silence'; pos: V2; radius: number; threshold: number; hold: number; after?: number | null }
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

export interface InventoryEntry {
  count: number;
  cost: number;
  maxSize?: number;
}

export interface Level {
  id: string;
  name: string;
  chapter: number;
  description?: string;
  hint?: string;
  grid: { width: number; height: number };
  medium: { c: number; damping?: number };
  sources: SourceDef[];
  fixed?: Item[];
  goals: Goal[];
  inventory: Partial<Record<ToolKind, InventoryEntry>>;
  budget: number;
  par: { cost: number; energy: number };
  timeLimit: number;
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
