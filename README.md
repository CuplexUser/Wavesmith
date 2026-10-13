# Wavesmith

A physics puzzle game about waves. Place walls, reflectors, absorbers, and lenses to focus,
silence, and shape waves. Everything on the board is a live 2D wave simulation, so every
solution is real physics rather than scripted rules.

The web version runs the Rust solver compiled to WebAssembly, renders with WebGL2, and has a
TypeScript/Vite shell with mouse, keyboard, and touch input. Playable now: Chapter 1
(Reflection, six sound levels) and Chapter 5 (Light, five levels with prisms and glass).
See [TODO.md](TODO.md) for milestones and priorities.

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

### Light

Light levels (`"medium": { "light": true }`) solve the same equation three times, for red,
green, and blue (a 2D TM mode is a scalar wave). The channels share walls (mirrors) and
absorbers, but glass has a refractive index per color, so dispersion, prisms, lenses, and
total internal reflection all come out of the solver rather than being scripted.

- Wavelengths are scaled to 12 / 10 / 8.5 cells (red / green / blue) so the grid resolves
  them, and material dispersion is exaggerated (flint: n = 1.50 / 1.66 / 1.85) so colors
  separate within one board. The grid's own numerical dispersion adds a little more.
- Beams are one-way Gaussian sources: two sheets a quarter wavelength apart, the front one a
  quarter period behind, so their waves cancel backward. They spread by real diffraction.
- The renderer shows each channel's amplitude envelope, `A² = u² + (u_t/ω)²` (exact for a
  monochromatic field), mixed additively, plus the green wave's phase as faint wavefronts.
- Light boards are 400×250 cells with three channels, about six times the work of a sound
  level. The WASM build uses SIMD; on slow devices the stepper drops to slow motion rather
  than skipping steps, so results never change.

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
| Pick a piece | Click it in the panel, or press 1–8 | Tap it in the panel |
| Place | Click the board (drag to position) | Tap the board (drag to position) |
| Move / reshape | Drag the piece or its handles | Same |
| Bend a reflector | Drag the diamond handle floating off its face; X flips it | Same, or the flip button |
| Snap | Ends snap to walls, other ends, and 15° steps; hold Shift or Alt for free placement | Automatic |
| Rotate | Q / E (Shift for fine), mouse wheel, toolbar buttons | Two-finger twist, toolbar |
| Resize | Shift + wheel | Pinch |
| Nudge | Arrow keys (Shift ×5) | — |
| Remove | Delete / Backspace, right-click, toolbar trash, or drag off the board | Toolbar trash, or drag off the board |
| Undo | Ctrl+Z | Undo button |
| Pause / restart / fast-forward | Space / R / F | Buttons |
| Sound / hint | M / H | Buttons |

A move that runs into something it may not cover stops at the last allowed spot; the dashed red
outline shows where you dragged it.

## Roadmap

See [TODO.md](TODO.md).
