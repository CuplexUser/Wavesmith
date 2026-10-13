// Loads the WASM core and exposes zero-copy views of the live field.

import init, { Game } from '../wasm/wavesmith';
import type { Item, Level, Status } from '../types';

let memory: WebAssembly.Memory | null = null;
let loading: Promise<void> | null = null;

export function loadCore(): Promise<void> {
  loading ??= init().then((out) => {
    memory = out.memory;
  });
  return loading;
}

export class Sim {
  readonly game: Game;
  /** Solver grid size, including the sponge border. */
  readonly nx: number;
  readonly ny: number;
  readonly border: number;
  readonly stepsPerSecond: number;

  constructor(readonly level: Level) {
    if (!memory) throw new Error('loadCore() must finish before creating a Sim');
    this.game = new Game(JSON.stringify(level));
    this.nx = this.game.width();
    this.ny = this.game.height();
    this.border = this.game.border();
    this.stepsPerSecond = this.game.steps_per_second();
  }

  /**
   * A view of the current field in WASM memory. The solver rotates buffers each step and
   * memory can grow, so take a fresh view every frame instead of keeping one.
   */
  field(): Float32Array {
    return new Float32Array(memory!.buffer, this.game.field_ptr(), this.nx * this.ny);
  }

  /** A view of the material overlay (walls, absorbers, lens strength). */
  overlay(): Uint8Array {
    return new Uint8Array(memory!.buffer, this.game.overlay_ptr(), this.nx * this.ny);
  }

  step(n: number): void {
    if (n > 0) this.game.step(n);
  }

  reset(): void {
    this.game.reset();
  }

  /** Applies pieces and restarts the run. Throws with the core's reason if they are invalid. */
  setPlacements(items: Item[]): void {
    this.game.set_placements(JSON.stringify(items));
  }

  status(): Status {
    return JSON.parse(this.game.status()) as Status;
  }

  dispose(): void {
    this.game.free();
  }
}
