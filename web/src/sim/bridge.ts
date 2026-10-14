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
  /** Light levels solve red, green, and blue separately. */
  readonly isLight: boolean;

  constructor(readonly level: Level) {
    if (!memory) throw new Error('loadCore() must finish before creating a Sim');
    this.game = new Game(JSON.stringify(level));
    this.nx = this.game.width();
    this.ny = this.game.height();
    this.border = this.game.border();
    this.stepsPerSecond = this.game.steps_per_second();
    this.isLight = this.game.channels() === 3;
  }

  /**
   * A view of the current field in WASM memory. The solver rotates buffers each step and
   * memory can grow, so take a fresh view every frame instead of keeping one.
   */
  field(): Float32Array {
    return new Float32Array(memory!.buffer, this.game.field_ptr(), this.nx * this.ny);
  }

  /** One channel's field (light levels: 0 red, 1 green, 2 blue). */
  channelField(channel: number): Float32Array {
    return new Float32Array(memory!.buffer, this.game.channel_field_ptr(channel), this.nx * this.ny);
  }

  /**
   * Recomputes and views the light image: per cell, the squared amplitude of red, green, and
   * blue, then the green wave's phase (0..1).
   */
  light(): Float32Array {
    const ptr = this.game.light_ptr();
    return new Float32Array(memory!.buffer, ptr, this.nx * this.ny * 4);
  }

  /** What the renderer shows: the light image in light levels, the field otherwise. */
  image(): Float32Array {
    return this.isLight ? this.light() : this.field();
  }

  /** A view of the RGBA material overlay: wall distance, absorber, lens, wall mask. */
  overlay(): Uint8Array {
    return new Uint8Array(memory!.buffer, this.game.overlay_ptr(), this.nx * this.ny * 4);
  }

  /** The overlay for a layout that is being dragged, without applying it. */
  previewOverlay(items: Item[]): Uint8Array | null {
    try {
      const ptr = this.game.preview_overlay(JSON.stringify(items));
      return new Uint8Array(memory!.buffer, ptr, this.nx * this.ny * 4);
    } catch {
      return null;
    }
  }

  /** A copy of one solver coefficient array (see `Game.gpu_coeff_ptr`), for the GPU path. */
  gpuCoefficients(channel: number, which: number): Float32Array {
    return new Float32Array(memory!.buffer, this.game.gpu_coeff_ptr(channel, which), this.nx * this.ny).slice();
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

  /** Amplitude of each player resonator, in placement order. */
  resonatorAmplitudes(): number[] {
    return Array.from(this.game.resonator_amplitudes());
  }

  status(): Status {
    return JSON.parse(this.game.status()) as Status;
  }

  dispose(): void {
    this.game.free();
  }
}
