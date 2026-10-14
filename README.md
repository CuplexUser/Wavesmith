# Wavesmith

A physics puzzle game about waves. Place walls, reflectors, absorbers, and lenses to focus,
silence, and shape waves. Everything on the board is a live 2D wave simulation, so every
solution is real physics rather than scripted rules.

The web version runs the Rust solver compiled to WebAssembly, renders with WebGL2, and has a
TypeScript/Vite shell with mouse, keyboard, and touch input. Six chapters are playable:
Reflection, Interference, Resonance, Refraction (sound and water), Light (prisms and glass),
and Doppler (moving sources), 28 levels in all, each with a reference solution that `cargo test`
checks for three stars. There is an in-browser level editor (`#/editor`), and an Android app
wrapped with Capacitor (see [docs/android.md](docs/android.md)). See [TODO.md](TODO.md) for
milestones and priorities.

## Layout

```
crates/wavesmith-core   Solver, level model, goals, scoring (pure Rust, no wasm deps)
crates/wavesmith-wasm   wasm-bindgen facade; exposes the field as a pointer into WASM memory
levels/                 Level JSON, reference solutions (*.solution.json), chapters.json
web/                    Vite + TypeScript shell (rendering, input, audio, haptics, UI, editor)
web/android/            Capacitor Android project (native billing and Play Games plugins)
scripts/build-wasm.mjs  cargo build --target wasm32 + wasm-bindgen (+ wasm-opt) → web/src/wasm
scripts/*.mjs           Store screenshots and trailer capture (Playwright)
docs/                   Android release guide, store listing draft, store graphics
```

## Prerequisites

- Rust stable (`rust-toolchain.toml` adds the `wasm32-unknown-unknown` target)
- `wasm-bindgen-cli` at the same version as the `wasm-bindgen` crate:
  `cargo install wasm-bindgen-cli --version 0.2.129 --locked`
- Node 22+ and pnpm 11
- `wasm-opt` comes from the `binaryen` dev dependency; `pnpm wasm` runs it.
- Android only: Android Studio (SDK + JDK 21). See [docs/android.md](docs/android.md).

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
pnpm build:native   # web build + `cap sync` into web/android (then `pnpm android`)
```

Development builds (`pnpm dev`) open every chapter; production builds keep paid chapters
locked until the full game is bought in the Android app.

`WAVESMITH_BASE` overrides the production base path (the deploy workflow sets it to the
repository name).

## Physics

- Damped scalar wave equation `u_tt = c²∇²u − γu_t + f`, second-order leapfrog in time, on a
  grid of cells (h = 1) with a fixed step of 1/120 s. Sound levels use the 5-point Laplacian
  (20 cells per wavelength makes its error negligible); light levels use the isotropic
  9-point one with dispersion-corrected speeds (see Light).
- Wave speed is capped at 60 cells/s, so `c·Δt ≤ 0.5`, inside the 2D CFL limit of 1/√2.
  Lenses can only slow waves down.
- A 24-cell graded sponge layer around the board absorbs outgoing waves.
- Walls and reflectors pin the field to zero (hard reflection), absorbers add damping, and
  lenses lower the local wave speed.
- Results depend only on the level, the pieces, and the step count. The renderer's frame rate
  never changes the outcome, and native and WASM builds agree. Source waveforms use `libm`
  for this reason.
- Energy for the third star is the work the sources do until the goal is met.
- Moving sources (Doppler) recompute their footprint every step and travel in a straight line
  until they reach the edge of the board, or of the player's placement area for that piece.
  The Doppler shift is not scripted: `tests/doppler.rs` checks the solver produces
  `f·c/(c ∓ v)` to within 0.2%.

### Light

Light levels (`"medium": { "light": true }`) solve the same equation three times, for red,
green, and blue (a 2D TM mode is a scalar wave). The channels share walls (mirrors) and
absorbers, but glass has a refractive index per color, so dispersion, prisms, lenses, and
total internal reflection all come out of the solver rather than being scripted.

- Wavelengths are scaled to 12 / 10 / 8.5 cells (red / green / blue) so the grid resolves
  them, and material dispersion is exaggerated (flint: n = 1.50 / 1.66 / 1.85) so colors
  separate within one board.
- At 5–10 cells per wavelength the plain 5-point stencil runs blue light in flint about 7%
  too slow along the axes and 3% along the diagonals, which bent it too far and moved its
  critical angle. Light levels instead use the isotropic 9-point stencil, whose error is the
  same in every direction, and give each cell the wave speed that makes the discrete
  wavenumber exact for that color (`dispersion_corrected_c2`). Indices are then right to
  within 0.6% in every direction.
- Glass edges blend over ±0.6 cells. Checked against the Fresnel equations
  (`examples/fresnel_check.rs`), surface reflection is within about 15% at every angle and
  face orientation (a sharp edge reflects up to 30% too much, the 2-cell blend used before
  about 40% too little), and total internal reflection is total.
- Beams are one-way Gaussian sources: two sheets a quarter wavelength apart, the front one a
  quarter period behind, so their waves cancel backward. They spread by real diffraction.
- The renderer shows each channel's amplitude envelope, `A² = u² + (u_t/ω)²` (exact for a
  monochromatic field), mixed additively, plus each color's own phase as faint moving
  wavefronts (packed into the image's fourth value), so beams a prism has split keep their
  own wave spacing.
- Light boards are 400×250 cells with three channels, about ten times the work of a sound
  level. The WASM build uses SIMD; a performance monitor fits the steps per frame to the
  device, runs light levels up to twice as fast where it can, and otherwise drops to slow
  motion (with a badge) rather than skipping steps, so results never change.

### WebGPU

`web/src/sim/gpuSolver.ts` runs the same scheme with the core's coefficients and sources as
compute shaders. It matches the core to about 6×10⁻⁵, but GPU arithmetic isn't bit-identical
across devices, so it only drives display-only boards (the title screen). Levels and scores
always run on the deterministic core.

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

Other tuning tools in `crates/wavesmith-core/examples`:

| Example | Use |
| --- | --- |
| `goal_values` | One line of JSON with each goal's reading after N seconds, for scripted searches |
| `render_level` | A PPM snapshot of a level and layout, colored like the game |
| `light_probe` | Light intensity per color down one column |
| `prism_check`, `fresnel_check` | Refraction and reflection against Snell's law and the Fresnel equations |
| `bench_step` | Milliseconds per solver step for a level |

Levels can also be built in the browser: the level editor (`#/editor`, or *Level editor* on
the title screen) places fixed pieces, sources, and goals on a live board, sets the rules and
inventory (including which emitter settings the player may tune and where pieces may go),
play-tests, verifies a solution, and exports the JSON.

## Controls

| Action | Mouse / keyboard | Touch |
| --- | --- | --- |
| Pick a piece | Click it in the panel, or press 1–8 | Tap it in the panel |
| Place | Click the board (drag to position), or Enter | Tap the board (drag to position) |
| Select pieces | Click, or [ and ] | Tap |
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
| Performance stats | P | Settings |
| Share a layout | Share button (copies a link) | Same |

A move that runs into something it may not cover stops at the last allowed spot; the dashed red
outline shows where you dragged it.

## Roadmap

See [TODO.md](TODO.md).
