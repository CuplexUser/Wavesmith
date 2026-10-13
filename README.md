# Wavesmith

A physics puzzle game about waves. Place walls, reflectors, absorbers, and lenses to focus,
silence, and shape waves. Everything on the board is a live 2D wave simulation, so every
solution is real physics rather than scripted rules.

This is milestone 1, a playable web slice: the Rust solver compiled to WebAssembly, a WebGL2
renderer, a TypeScript/Vite shell with mouse, keyboard, and touch input, and Chapter 1
(Reflection, six levels).

## Layout

```
crates/wavesmith-core   Solver, level model, goals, scoring (pure Rust, no wasm deps)
crates/wavesmith-wasm   wasm-bindgen facade; exposes the field as a pointer into WASM memory
levels/                 Level JSON, reference solutions (*.solution.json), chapters.json
web/                    Vite + TypeScript shell (rendering, input, audio, haptics, UI)
scripts/build-wasm.mjs  cargo build --target wasm32 + wasm-bindgen → web/src/wasm
```

## Prerequisites

- Rust stable (`rust-toolchain.toml` adds the `wasm32-unknown-unknown` target)
- `wasm-bindgen-cli` at the same version as the `wasm-bindgen` crate:
  `cargo install wasm-bindgen-cli --version 0.2.129 --locked`
- Node 22+ and pnpm 11
- Optional: `wasm-opt` (Binaryen). The build uses it when it's on `PATH`.

## Commands

```sh
cargo test --workspace                     # solver, level, and determinism tests
cargo run --release -p wavesmith-core --example verify_levels   # level tuning report

cd web
pnpm install
pnpm wasm        # build the core to web/src/wasm
pnpm dev         # http://localhost:5173
pnpm test        # Vitest
pnpm build       # type check + production build into web/dist (base /wavesmith/)
pnpm preview     # serve the production build
```

`WAVESMITH_BASE` overrides the production base path (the deploy workflow sets it to the
repository name).

## Physics

- Damped scalar wave equation `u_tt = c²∇²u − γu_t + f`, second-order leapfrog in time with a
  5-point Laplacian, on a grid of cells (h = 1) with a fixed step of 1/120 s.
- Wave speed is capped at 60 cells/s, so `c·Δt ≤ 0.5`, inside the 2D CFL limit of 1/√2.
  Lenses can only slow waves down.
- A 24-cell graded sponge layer around the board absorbs outgoing waves.
- Walls and reflectors pin the field to zero (hard reflection), absorbers add damping, and
  lenses lower the local wave speed.
- Results depend only on the level, the pieces, and the step count. The renderer's frame rate
  never changes the outcome, and native and WASM builds agree. Source waveforms use `libm`
  for this reason.
- Energy for the third star is the work the sources do until the goal is met.

## Levels

Levels are JSON (see `levels/ch1/*.json`). Each level has a reference solution next to it, and
`cargo test` checks that every solution earns three stars and that no level solves itself with
no pieces. To tune a level, run the example with a level filter and a JSON array of pieces to
see goal readings once per second:

```sh
cargo run --release -p wavesmith-core --example verify_levels -- levels 1-3 \
  '[{"kind":"reflector","a":[215,30],"b":[215,130],"bulge":-15}]'
```

Par energy is set to about 1.15× the reference solution's energy.

## Controls

| Action | Mouse / keyboard | Touch |
| --- | --- | --- |
| Pick a piece | Click it in the panel, or press 1–6 | Tap it in the panel |
| Place | Click the board (drag to position) | Tap the board (drag to position) |
| Move / reshape | Drag the piece or its handles | Same |
| Bend a reflector | Drag the diamond handle | Same |
| Rotate | Q / E (Shift for fine), mouse wheel | Two-finger twist |
| Resize | Shift + wheel | Pinch |
| Nudge | Arrow keys (Shift ×5) | — |
| Delete | Delete / Backspace | Long-press |
| Undo | Ctrl+Z | Undo button |
| Pause / restart / fast-forward | Space / R / F | Buttons |
| Sound / hint | M / H | Buttons |

## Roadmap

- Chapters 2–5: interference, resonance, refraction, moving sources and the Doppler effect
- Level editor
- Android build with Capacitor: Play Games Services, native haptics behind `platform/haptics.ts`,
  and the one-time full-game unlock
- WebGPU compute path for larger grids
