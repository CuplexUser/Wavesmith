// WebGPU compute path: runs the solver's update on the GPU for display-only boards (the title
// screen, and larger sandbox grids later). It uses the core's own per-cell coefficients and
// source stencils, so it solves the same equation with the same scheme, but GPU floating point
// is not bit-identical to the WASM core across devices. Gameplay and scoring therefore always
// run on the deterministic core; this path never decides a level.
//
// Limits: sound boards (one channel) with fixed sources only; moving sources and resonators
// need per-step CPU work and fall back to the core.

import type { Sim } from './bridge';

const WG = 16;

const STENCIL_WGSL = /* wgsl */ `
struct Params { nx: u32, ny: u32, iso: u32, dt: f32 };
@group(0) @binding(0) var<uniform> P: Params;
@group(0) @binding(1) var<storage, read> prev: array<f32>;
@group(0) @binding(2) var<storage, read> cur: array<f32>;
@group(0) @binding(3) var<storage, read_write> next: array<f32>;
@group(0) @binding(4) var<storage, read> kk: array<f32>;
@group(0) @binding(5) var<storage, read> decay: array<f32>;
@group(0) @binding(6) var<storage, read> inv: array<f32>;

@compute @workgroup_size(${WG}, ${WG})
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  let x = id.x + 1u;
  let y = id.y + 1u;
  if (x >= P.nx - 1u || y >= P.ny - 1u) { return; }
  let nx = P.nx;
  let i = y * nx + x;
  let c = cur[i];
  let cross = cur[i - 1u] + cur[i + 1u] + cur[i - nx] + cur[i + nx];
  var lap: f32;
  if (P.iso == 1u) {
    let corners = cur[i - nx - 1u] + cur[i - nx + 1u] + cur[i + nx - 1u] + cur[i + nx + 1u];
    lap = (2.0 / 3.0) * cross + (1.0 / 6.0) * corners - (10.0 / 3.0) * c;
  } else {
    lap = cross - 4.0 * c;
  }
  next[i] = (2.0 * c - decay[i] * prev[i] + kk[i] * lap) * inv[i];
}
`;

// Sources are stored per cell (CSR): each cell that any source touches lists its
// (source, weight) pairs, so one invocation owns each cell and no two write the same value.
const FORCE_WGSL = /* wgsl */ `
struct Params { nx: u32, ny: u32, iso: u32, dt: f32 };
struct Src { force: f32, freq: f32, phase: f32, start: f32 };
@group(0) @binding(0) var<uniform> P: Params;
@group(0) @binding(1) var<storage, read_write> next: array<f32>;
@group(0) @binding(2) var<storage, read> inv: array<f32>;
@group(0) @binding(3) var<storage, read> cells: array<u32>;
@group(0) @binding(4) var<storage, read> offsets: array<u32>;
@group(0) @binding(5) var<storage, read> entrySrc: array<u32>;
@group(0) @binding(6) var<storage, read> entryW: array<f32>;
@group(0) @binding(7) var<storage, read> srcs: array<Src>;
@group(0) @binding(8) var<storage, read> clock: array<u32>;

const RAMP: f32 = 0.5;
const TAU: f32 = 6.283185307179586;

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  let n = arrayLength(&cells);
  if (id.x >= n) { return; }
  // Time before this step, as the core uses.
  let t = f32(clock[0]) * P.dt;
  var f = 0.0;
  for (var e = offsets[id.x]; e < offsets[id.x + 1u]; e = e + 1u) {
    let s = srcs[entrySrc[e]];
    let tau = t - s.start;
    if (tau >= 0.0) {
      let r = min(tau / RAMP, 1.0);
      let ramp = r * r * (3.0 - 2.0 * r);
      f = f + entryW[e] * s.force * ramp * sin(TAU * s.freq * tau + s.phase);
    }
  }
  let i = cells[id.x];
  next[i] = next[i] + P.dt * P.dt * f * inv[i];
}
`;

const TICK_WGSL = /* wgsl */ `
@group(0) @binding(0) var<storage, read_write> clock: array<u32>;
@compute @workgroup_size(1)
fn main() { clock[0] = clock[0] + 1u; }
`;

interface SourceJson {
  cells: [number, number][];
  force: number;
  freq: number;
  phase: number;
  start: number;
}

/** Whether this browser offers WebGPU at all (an adapter may still be refused). */
export function webgpuAvailable(): boolean {
  return typeof navigator !== 'undefined' && 'gpu' in navigator;
}

export class GpuSolver {
  private rot = 0;
  private stagingBusy = false;
  private latest: Float32Array;
  /** Steps run on the GPU so far. */
  steps = 0;

  private constructor(
    private device: GPUDevice,
    readonly nx: number,
    readonly ny: number,
    private fields: GPUBuffer[],
    private stencilGroups: GPUBindGroup[],
    private forceGroups: GPUBindGroup[] | null,
    private forceCount: number,
    private tickGroup: GPUBindGroup,
    private pipelines: { stencil: GPUComputePipeline; force: GPUComputePipeline; tick: GPUComputePipeline },
    private staging: GPUBuffer,
    private owned: GPUBuffer[],
  ) {
    this.latest = new Float32Array(nx * ny);
  }

  /**
   * Builds a GPU solver for the board `sim` currently holds, or null when WebGPU is missing
   * or the board needs CPU-only features.
   */
  static async create(sim: Sim): Promise<GpuSolver | null> {
    if (!webgpuAvailable() || sim.isLight) return null;
    const sources = JSON.parse(sim.game.gpu_sources(0)) as SourceJson[] | null;
    if (!sources) return null;
    const adapter = await navigator.gpu.requestAdapter();
    const device = await adapter?.requestDevice();
    if (!device) return null;

    const { nx, ny } = sim;
    const n = nx * ny;
    const owned: GPUBuffer[] = [];
    const buffer = (data: ArrayBufferView | number, usage: number): GPUBuffer => {
      const size = typeof data === 'number' ? data : Math.max(16, Math.ceil(data.byteLength / 4) * 4);
      const b = device.createBuffer({ size, usage, mappedAtCreation: typeof data !== 'number' });
      if (typeof data !== 'number') {
        new Uint8Array(b.getMappedRange()).set(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
        b.unmap();
      }
      owned.push(b);
      return b;
    };
    const STORAGE = GPUBufferUsage.STORAGE;
    const coeff = (which: number) => sim.gpuCoefficients(0, which);
    const k = buffer(coeff(0), STORAGE);
    const decay = buffer(coeff(1), STORAGE);
    const inv = buffer(coeff(2), STORAGE);
    const fields = [0, 1, 2].map(() => buffer(n * 4, STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST));
    const params = new ArrayBuffer(16);
    new Uint32Array(params, 0, 3).set([nx, ny, sim.game.gpu_isotropic()]);
    new Float32Array(params, 12, 1)[0] = 1 / sim.stepsPerSecond;
    const uniform = buffer(new Uint8Array(params), GPUBufferUsage.UNIFORM);
    const clock = buffer(new Uint32Array(4), STORAGE);

    // Per-cell lists of (source, weight).
    const byCell = new Map<number, [number, number][]>();
    sources.forEach((s, si) => {
      for (const [i, w] of s.cells) {
        const list = byCell.get(i) ?? [];
        list.push([si, w]);
        byCell.set(i, list);
      }
    });
    const cellIds = [...byCell.keys()].sort((a, b) => a - b);
    const offsets = new Uint32Array(cellIds.length + 1);
    const entrySrc: number[] = [];
    const entryW: number[] = [];
    cellIds.forEach((c, j) => {
      offsets[j] = entrySrc.length;
      for (const [si, w] of byCell.get(c)!) {
        entrySrc.push(si);
        entryW.push(w);
      }
    });
    offsets[cellIds.length] = entrySrc.length;
    const srcData = new Float32Array(Math.max(1, sources.length) * 4);
    sources.forEach((s, i) => srcData.set([s.force, s.freq, s.phase, s.start], i * 4));

    const module = (code: string) => device.createShaderModule({ code });
    const pipelines = {
      stencil: device.createComputePipeline({ layout: 'auto', compute: { module: module(STENCIL_WGSL), entryPoint: 'main' } }),
      force: device.createComputePipeline({ layout: 'auto', compute: { module: module(FORCE_WGSL), entryPoint: 'main' } }),
      tick: device.createComputePipeline({ layout: 'auto', compute: { module: module(TICK_WGSL), entryPoint: 'main' } }),
    };
    const group = (pipeline: GPUComputePipeline, buffers: GPUBuffer[]) =>
      device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: buffers.map((b, binding) => ({ binding, resource: { buffer: b } })),
      });
    // Rotation r: prev = fields[r], cur = fields[r+1], next = fields[r+2].
    const at = (r: number, d: number) => fields[(r + d) % 3]!;
    const stencilGroups = [0, 1, 2].map((r) =>
      group(pipelines.stencil, [uniform, at(r, 0), at(r, 1), at(r, 2), k, decay, inv]),
    );
    let forceGroups: GPUBindGroup[] | null = null;
    if (cellIds.length > 0) {
      const cells = buffer(new Uint32Array(cellIds), STORAGE);
      const offs = buffer(offsets, STORAGE);
      const es = buffer(new Uint32Array(entrySrc), STORAGE);
      const ew = buffer(new Float32Array(entryW), STORAGE);
      const srcs = buffer(srcData, STORAGE);
      forceGroups = [0, 1, 2].map((r) => group(pipelines.force, [uniform, at(r, 2), inv, cells, offs, es, ew, srcs, clock]));
    }
    const tickGroup = group(pipelines.tick, [clock]);
    const staging = device.createBuffer({ size: n * 4, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    owned.push(staging);
    return new GpuSolver(device, nx, ny, fields, stencilGroups, forceGroups, cellIds.length, tickGroup, pipelines, staging, owned);
  }

  /** Queues `n` steps. */
  step(n: number): void {
    if (n <= 0) return;
    const enc = this.device.createCommandEncoder();
    const gx = Math.ceil((this.nx - 2) / WG);
    const gy = Math.ceil((this.ny - 2) / WG);
    for (let s = 0; s < n; s++) {
      const r = this.rot;
      const pass = enc.beginComputePass();
      pass.setPipeline(this.pipelines.stencil);
      pass.setBindGroup(0, this.stencilGroups[r]!);
      pass.dispatchWorkgroups(gx, gy);
      if (this.forceGroups) {
        pass.setPipeline(this.pipelines.force);
        pass.setBindGroup(0, this.forceGroups[r]!);
        pass.dispatchWorkgroups(Math.ceil(this.forceCount / 64));
      }
      pass.setPipeline(this.pipelines.tick);
      pass.setBindGroup(0, this.tickGroup);
      pass.dispatchWorkgroups(1);
      pass.end();
      this.rot = (r + 1) % 3;
    }
    this.steps += n;
    this.device.queue.submit([enc.finish()]);
  }

  /**
   * The most recent field copied back from the GPU. Reading back is asynchronous, so this is
   * typically a frame behind; call every frame and draw what it returns.
   */
  field(): Float32Array {
    if (!this.stagingBusy) {
      this.stagingBusy = true;
      const enc = this.device.createCommandEncoder();
      // After the last step the current field is fields[rot + 1].
      enc.copyBufferToBuffer(this.fields[(this.rot + 1) % 3]!, 0, this.staging, 0, this.latest.byteLength);
      this.device.queue.submit([enc.finish()]);
      this.staging
        .mapAsync(GPUMapMode.READ)
        .then(() => {
          this.latest.set(new Float32Array(this.staging.getMappedRange()));
          this.staging.unmap();
        })
        .catch(() => {
          // Device lost: keep showing the last field.
        })
        .finally(() => {
          this.stagingBusy = false;
        });
    }
    return this.latest;
  }

  /** Waits for queued work and returns the current field (for tests). */
  async readNow(): Promise<Float32Array> {
    await this.device.queue.onSubmittedWorkDone();
    while (this.stagingBusy) await new Promise((r) => setTimeout(r, 1));
    this.field();
    while (this.stagingBusy) await new Promise((r) => setTimeout(r, 1));
    return this.latest.slice();
  }

  dispose(): void {
    for (const b of this.owned) b.destroy();
    this.device.destroy();
  }
}
