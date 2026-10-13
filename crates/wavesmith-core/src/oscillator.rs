//! Damped harmonic oscillators coupled to the wave field.
//!
//! `x'' + (ω₀/Q)·x' + ω₀²·x = ω₀²·ū`, where `ū` is the field averaged over the oscillator's
//! footprint. Driven at resonance the steady amplitude is `Q·|ū|`; off resonance it falls away
//! sharply. Resonators reradiate a small fraction of their motion back into the field; shatter
//! targets only listen.

use std::f32::consts::TAU;

use crate::tools::V2;
use crate::DT;

/// Fraction of a resonator's amplitude fed back into the field as a point source.
pub const RERADIATION: f32 = 0.05;

#[derive(Debug, Clone)]
pub struct Oscillator {
    pub pos: V2,
    pub cells: Vec<(usize, f32)>,
    pub omega: f32,
    pub q: f32,
    pub x: f32,
    pub v: f32,
    /// Peak force density per unit amplitude when reradiating (0 for listeners).
    pub emit: f32,
}

impl Oscillator {
    pub fn new(pos: V2, freq: f32, q: f32, cells: Vec<(usize, f32)>, emit: f32) -> Self {
        Self {
            pos,
            cells,
            omega: TAU * freq,
            q,
            x: 0.0,
            v: 0.0,
            emit,
        }
    }

    pub fn reset(&mut self) {
        self.x = 0.0;
        self.v = 0.0;
    }

    /// Advances one step under the field `u` (semi-implicit Euler, stable for `ω₀Δt < 2`).
    pub fn step(&mut self, u: &[f32]) {
        let drive: f32 = self.cells.iter().map(|&(i, w)| u[i] * w).sum();
        let w2 = self.omega * self.omega;
        let a = w2 * (drive - self.x) - (self.omega / self.q) * self.v;
        self.v += a * DT;
        self.x += self.v * DT;
    }

    /// Instantaneous amplitude envelope `√(x² + (v/ω₀)²)`.
    pub fn amplitude(&self) -> f32 {
        let y = self.v / self.omega;
        (self.x * self.x + y * y).sqrt()
    }

    pub fn push_forces(&self, out: &mut Vec<(usize, f32)>) {
        if self.emit != 0.0 {
            let f = self.emit * self.x;
            out.extend(self.cells.iter().map(|&(i, w)| (i, f * w)));
        }
    }
}
