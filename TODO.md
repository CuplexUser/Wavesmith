# Wavesmith roadmap

Milestones run roughly in order; each builds on the last. Within a milestone, items are listed
by priority (P1 first). Android work starts only once the web version passes the
"web is good enough" gate at the end of milestone 4.

Legend: `[x]` done · `[~]` in progress · `[ ]` not started · **(you)** needs your accounts,
devices, or a decision

---

## M1 · Playable web slice ✅

- [x] Deterministic Rust wave solver (leapfrog, sponge boundary, walls, absorbers, slow media)
- [x] Level model, goals (focus, silence, resonate, sustain), scoring, headless verify tool
- [x] WASM bridge with zero-copy field views
- [x] WebGL2 renderer, Canvas2D overlay, pointer/touch/keyboard editing
- [x] Chapter 1 · Reflection (6 levels, tuned, reference solutions tested)
- [x] Audio probe tone, web haptics, progress storage
- [x] Vitest, cargo tests, CI and GitHub Pages workflows
- [x] Anti-aliased walls from a distance field

## M2 · Feel and light ✅

P1 — fixes and feel the game needs now
- [x] Light: red/green/blue channels with dispersive glass (water, crown, flint)
- [x] Light: one-way Gaussian beam sources, prism and glass-block pieces, color-aware goals
- [x] Light: color rendering (additive beams with moving wavefronts) and glass visuals
- [x] Chapter 5 · Light: Periscope, Burning Glass, Prism, Light Pipe (total internal
      reflection), Red Only (color filtering by total internal reflection)
- [x] Editing: endpoint drags keep the other end fixed; clamp to the board; snap to 15°
- [x] Editing: a blocked move stops at the last valid spot instead of snapping back
- [x] Editing: snap endpoints to nearby walls and pieces to seal gaps (Shift/Alt to disable)
- [x] Editing: the reflector's bend handle floats off its face, so its middle moves it
- [x] Removal: on-board toolbar (rotate, flip bend, remove), drag off the board, right-click,
      Delete key; the dragged piece previews in place while moving
- [x] Piece visuals: polished-metal player mirrors, stone fixed walls, foam absorbers,
      glass lenses and prisms tinted by material, speaker emitters, glowing tuning forks
- [x] Audio: synth voice with reverb, wave-synced pulsing, pentatonic progress, per-material
      placement sounds, invalid buzz, milestone notes, star-dependent fanfare, ambient pad
- [x] Optics accuracy: light levels use an isotropic 9-point stencil with per-color
      dispersion-corrected speeds (refractive indices exact to 0.6% in every direction) and
      a 0.6-cell glass edge (Fresnel reflection within ~15%); each color draws its own
      wavefronts
- [x] Chapter 5 · a sixth light level: Spectrum (three color sensors)
- [~] **(you)** Playtest the light levels on a phone: they run three solvers on a 400×250
      board (SIMD WASM). Settings → Performance stats (or P) shows fps, solver cost, and
      the slow-motion badge

P2
- [x] Light speed: light levels run up to 2× when the device can afford it (measured)
- [x] Shrink the WASM binary: 516 KB → 243 KB (106 KB gzipped): wasm-opt from the binaryen
      dev dependency, JSON parsed through `Value` with hand-written tagged-enum decoding
- [x] Settings panel: sound, volume, haptics, reduced motion, color-blind palette, stats
- [x] First-run tutorial overlay for Chapter 1 (replay from Settings)

## M3 · Content: the sound chapters ✅

P1
- [x] Chapter 2 · Interference: 5 levels (phase, strength, and frequency tuning; anti-noise,
      duct, open window)
- [x] Chapter 3 · Resonance: 4 levels (shatter targets, standing wave, organ pipe)
- [x] Chapter 4 · Refraction: 4 levels (sound lens, waveguide, water shoal, prism steering)
- [ ] **(you)** Decide the free tier. Now: Chapters 1, 2, and 5 free; 3, 4, and 6 paid
      (`"free"` in `levels/chapters.json`)
P2
- [x] Chapter 6 · Doppler: 3 levels; moving sources in the solver (Doppler checked by test)
- [x] Per-level display tuning (`display.gain`, water palette) and schematic thumbnails

## M4 · Tools and polish

P1
- [x] Level editor (`#/editor`: fixed geometry, sources, goals, inventory, play-test,
      in-browser verify, JSON import/export)
- [~] Performance pass: adaptive steps per frame, automatic DPR drop, light speed-up, stats
      overlay done; **(you)** profile on a low-end phone
- [x] Accessibility pass: keyboard-only play (Enter places, [ ] selects), screen-reader
      announcements and labels, text contrast ≥ 4.9:1
P2
- [x] WebGPU compute path (display-only boards; gameplay stays on the deterministic core)
- [x] Shareable solutions (`#/play/<id>?s=<layout>`, Share button)

### Gate: "web is good enough"

Move on to Android when all of these hold:
- [x] Chapters 1–6 are playable, tuned, and verified by `cargo test`
- [ ] **(you)** 60 fps on a mid-range Android phone in Chrome
- [ ] **(you)** No known input bugs on touch; audio and haptics checked on a real device
- [ ] **(you)** Playtested by people who didn't build it, with the feedback addressed

## M5 · Android

P1
See [docs/android.md](docs/android.md) for the steps that need your Google accounts.

P1
- [x] Capacitor wrapper around the Vite build (offline assets, no CDN fonts)
- [x] Native haptics via the Capacitor Haptics plugin, behind `platform/haptics.ts`
- [x] Lifecycle: pause the sim and audio in the background, resume cleanly; back button
- [x] Persist progress natively (Capacitor Preferences) with web storage as a fallback
- [~] One-time purchase that unlocks the full game: Play Billing plugin and unlock flow
      done; **(you)** create the `full_game` product and test with a license tester
P2
- [~] Play Games Services: plugin for sign-in, achievements, and cloud save done;
      **(you)** set up Play Games, paste the project ID and achievement IDs
- [x] App icon, splash screen, store listing draft, screenshots; trailer capture script
      (**(you)** record on a machine with a GPU and upload to YouTube)
- [~] Release pipeline: debug APK on every push and signed AAB in GitHub Actions, upload to
      the internal track; **(you)** add the signing and Play secrets

## M6 · Launch and after

- [ ] **(you)** Closed beta on Play, then production release
- [x] Web: free chapters on GitHub Pages as a demo; paid chapters link to the Play listing
      (update `PLAY_STORE_URL` in `web/src/platform/store.ts` when it is live)
- [ ] Future chapters as free updates for buyers (the purchase unlocks every chapter)
