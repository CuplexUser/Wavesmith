//! WebAssembly bindings. The field and overlay are exposed as raw pointers into WASM memory so
//! JavaScript can view them as typed arrays without copying.

use wasm_bindgen::prelude::*;
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

    /// Pointer to the material overlay (`width·height` bytes). It moves when pieces change.
    pub fn overlay_ptr(&self) -> *const u8 {
        self.session.overlay().as_ptr()
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
            serde_json::from_str(json).map_err(|e| JsError::new(&format!("pieces JSON: {e}")))?;
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
        self.session.solver().energy()
    }

    /// Amplitude envelope of each player resonator, in placement order.
    pub fn resonator_amplitudes(&self) -> Vec<f32> {
        self.session.resonator_amplitudes()
    }
}
