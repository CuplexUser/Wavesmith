# Wavesmith roadmap

Milestones run roughly in order; each builds on the last. Within a milestone, items are listed
by priority (P1 first). Android work starts only once the web version passes the
"web is good enough" gate at the end of milestone 4.

Legend: `[x]` done · `[~]` in progress · `[ ]` not started

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

## M2 · Feel and light (current)

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
- [ ] Chapter 5 · a sixth light level (three color sensors: a full spectrum)
- [ ] Playtest the light levels on a phone: they run three solvers on a 400×250 board
      (SIMD WASM); check the frame rate and whether slow motion kicks in

P2
- [ ] Light speed: beams cross the board in about 7 s; consider a faster default sim speed
      for light levels on devices that can afford it
- [ ] Shrink the WASM binary (now about 510 KB; wasm-opt in CI, trim serde_json)
- [ ] Settings panel: sound, haptics, reduced motion, color-blind palette
- [ ] First-run tutorial overlay for Chapter 1

## M3 · Content: the sound chapters

P1
- [ ] Chapter 2 · Interference (silence goals with tunable emitters: phase, frequency)
- [ ] Chapter 3 · Resonance (resonators, shatter targets, standing waves / sustain goals)
- [ ] Chapter 4 · Refraction (slow media and lenses for sound and water)
- [ ] Decide the free tier: Light (Chapter 5) is marked free for now so it can be played
P2
- [ ] Chapter 6 · Doppler (moving sources; needs moving-source support in the solver)
- [ ] Per-level display tuning (gain, palette) and level thumbnails on the select screen

## M4 · Tools and polish

P1
- [ ] Level editor (place fixed geometry, sources, goals; export JSON; run verify in browser)
- [ ] Performance pass on low-end phones (profile, adaptive steps per frame, lower DPR)
- [ ] Accessibility pass (keyboard-only play, screen reader labels, contrast)
P2
- [ ] WebGPU compute path for larger grids where supported
- [ ] Shareable solutions (encode a layout in the URL)

### Gate: "web is good enough"

Move on to Android when all of these hold:
- Chapters 1–6 are playable, tuned, and verified by `cargo test`
- 60 fps on a mid-range Android phone in Chrome
- No known input bugs on touch; audio and haptics checked on a real device
- Playtested by people who didn't build it, with the feedback addressed

## M5 · Android

P1
- [ ] Capacitor wrapper around the Vite build (offline assets, no CDN fonts)
- [ ] Native haptics via the Capacitor Haptics plugin, behind `platform/haptics.ts`
- [ ] Lifecycle: pause the sim and audio in the background, resume cleanly
- [ ] Persist progress natively (Capacitor Preferences) with web storage as a fallback
- [ ] One-time purchase that unlocks the full game (Play Billing); free chapters stay free
P2
- [ ] Play Games Services: sign-in, achievements (stars, chapter completion), cloud save
- [ ] App icon, splash screen, store listing, screenshots, trailer capture
- [ ] Release pipeline: signed AAB built in GitHub Actions, internal testing track

## M6 · Launch and after

- [ ] Closed beta on Play, then production release
- [ ] Web: keep free chapters on GitHub Pages as a demo linking to the store
- [ ] Future chapters as free updates for buyers
