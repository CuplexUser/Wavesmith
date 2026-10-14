//! WebAssembly bindings. The field and overlay are exposed as raw pointers into WASM memory so
//! JavaScript can view them as typed arrays without copying.

use wasm_bindgen::prelude::*;
use wavesmith_core::json::parse_items;
use wavesmith_core::{Item, Session};

#[wasm_bindgen]
pub struct Game {
    session: Session,
}

#[wasm_bindgen]
impl Game {
    #[wasm_bindgen(constructor)]
    pub fn new(level_json: &str) -> Result<Game, JsError> {
        let session = Session::from_json(level_json).map_err(|e| JsError::new(&e.to_string()))?;
        Ok(Game { session })
    }

    /// Solver grid width, including the sponge border.
    pub fn width(&self) -> usize {
        self.session.nx()
    }

    pub fn height(&self) -> usize {
        self.session.ny()
    }

    /// Sponge border width, in cells.
    pub fn border(&self) -> usize {
        wavesmith_core::SPONGE
    }

    pub fn steps_per_second(&self) -> u32 {
        wavesmith_core::STEPS_PER_SECOND
    }

    /// Pointer to the current field (`width·height` f32 values). It moves on every step, so
    /// read it again after stepping.
    pub fn field_ptr(&self) -> *const f32 {
        self.session.field().as_ptr()
    }

    /// Pointer to the RGBA material overlay (`4·width·height` bytes). It moves when pieces change.
    pub fn overlay_ptr(&self) -> *const u8 {
        self.session.overlay().as_ptr()
    }

    /// Rasterizes the overlay for a layout (JSON array of items) without applying it, and
    /// returns a pointer to it (`4·width·height` bytes). Used while dragging.
    pub fn preview_overlay(&mut self, json: &str) -> Result<*const u8, JsError> {
        let items: Vec<Item> =
            parse_items(json).map_err(|e| JsError::new(&format!("pieces JSON: {e}")))?;
        self.session
            .preview_overlay(&items)
            .map(|o| o.as_ptr())
            .map_err(|e| JsError::new(&e))
    }

    /// Number of solver channels: 3 (red, green, blue) in light levels, 1 for sound.
    pub fn channels(&self) -> usize {
        self.session.channel_count()
    }

    /// Pointer to the field of one channel (`width·height` f32 values).
    pub fn channel_field_ptr(&self, channel: usize) -> *const f32 {
        self.session.channel_field(channel).as_ptr()
    }

    /// Recomputes the light image and returns a pointer to it: `4·width·height` f32 values,
    /// the squared amplitude of red, green, and blue per cell, then 0.
    pub fn light_ptr(&mut self) -> *const f32 {
        self.session.light_image().as_ptr()
    }

    pub fn step(&mut self, n: u32) {
        self.session.step(n);
    }

    pub fn reset(&mut self) {
        self.session.reset();
    }

    /// Replaces the player's pieces (a JSON array of items) and restarts the run.
    pub fn set_placements(&mut self, json: &str) -> Result<(), JsError> {
        let items: Vec<Item> =
            parse_items(json).map_err(|e| JsError::new(&format!("pieces JSON: {e}")))?;
        self.session
            .set_placements(items)
            .map_err(|e| JsError::new(&e.to_string()))
    }

    /// Retunes the player emitter at `index` (counting emitters only) and restarts the run.
    pub fn set_emitter(&mut self, index: usize, freq: f32, phase: f32) -> Result<(), JsError> {
        let mut items = self.session.placements().to_vec();
        let item = items
            .iter_mut()
            .filter(|i| matches!(i, Item::Emitter { .. }))
            .nth(index)
            .ok_or_else(|| JsError::new("no such emitter"))?;
        if let Item::Emitter {
            freq: f, phase: p, ..
        } = item
        {
            *f = freq;
            *p = phase;
        }
        self.session
            .set_placements(items)
            .map_err(|e| JsError::new(&e.to_string()))
    }

    /// Run status as JSON: time, energy, cost, goal readings, and the result once solved.
    pub fn status(&self) -> String {
        serde_json::to_string(&self.session.status()).unwrap_or_default()
    }

    /// Discrete field energy, for diagnostics.
    pub fn field_energy(&self) -> f64 {
        self.session.field_energy()
    }

    // ---------- WebGPU path ----------
    // The same scheme run on the GPU for display (see web/src/sim/gpuSolver.ts): per-cell
    // coefficients and source stencils, read once after each layout change.

    /// 1 for the isotropic 9-point stencil, 0 for the 5-point one.
    pub fn gpu_isotropic(&self) -> u32 {
        u32::from(
            self.session.channel_solver(0).laplacian()
                == wavesmith_core::solver::Laplacian::Isotropic,
        )
    }

    /// Pointer to one coefficient array of a channel (`width·height` f32): 0 = `(cΔt)²`,
    /// 1 = `1 − γΔt/2`, 2 = `1/(1 + γΔt/2)` (0 in walls).
    pub fn gpu_coeff_ptr(&self, channel: usize, which: u32) -> *const f32 {
        let (k, decay, inv) = self.session.channel_solver(channel).coefficients();
        match which {
            0 => k.as_ptr(),
            1 => decay.as_ptr(),
            _ => inv.as_ptr(),
        }
    }

    /// Sources of a channel as JSON: `[{"cells":[[i,w],...],"force":f,"freq":f,"phase":p,"start":s}]`.
    /// Empty when the board has moving sources or resonators, which the GPU path can't run.
    pub fn gpu_sources(&self, channel: usize) -> String {
        use std::fmt::Write;
        if self.session.has_dynamic_actors() {
            return "null".into();
        }
        let mut out = String::from("[");
        for (n, s) in self.session.channel_sources(channel).iter().enumerate() {
            if n > 0 {
                out.push(',');
            }
            out.push_str(r#"{"cells":["#);
            for (k, (i, w)) in s.cells.iter().enumerate() {
                if k > 0 {
                    out.push(',');
                }
                let _ = write!(out, "[{i},{w}]");
            }
            let _ = write!(
                out,
                r#"],"force":{},"freq":{},"phase":{},"start":{}}}"#,
                s.force, s.freq, s.phase, s.start
            );
        }
        out.push(']');
        out
    }

    /// Amplitude envelope of each player resonator, in placement order.
    pub fn resonator_amplitudes(&self) -> Vec<f32> {
        self.session.resonator_amplitudes()
    }
}
