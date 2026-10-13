//! Wave sources: soft sinusoidal forcing spread over a small Gaussian footprint.
//!
//! Amplitudes are normalized so that `amp = 1` gives a field amplitude of about 1 one wavelength
//! from a point source (2D Green's function, `|u| ≈ Q/(4c²)·√(2/(πkr))`), and about 1 for the
//! plane wave launched by a line source (`|u| = q/(4πfc)`).

use std::f64::consts::TAU;

use serde::{Deserialize, Serialize};

use crate::tools::{len, seg_dist, sub, V2};
use crate::{DT, SPONGE};

fn default_amp() -> f32 {
    1.0
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum SourceDef {
    Point {
        pos: V2,
        freq: f32,
        #[serde(default = "default_amp")]
        amp: f32,
        #[serde(default)]
        phase: f32,
        /// Seconds before the source switches on.
        #[serde(default)]
        start: f32,
    },
    Line {
        a: V2,
        b: V2,
        freq: f32,
        #[serde(default = "default_amp")]
        amp: f32,
        #[serde(default)]
        phase: f32,
        #[serde(default)]
        start: f32,
    },
}

impl SourceDef {
    pub fn freq(&self) -> f32 {
        match *self {
            SourceDef::Point { freq, .. } | SourceDef::Line { freq, .. } => freq,
        }
    }

    pub fn points(&self) -> Vec<V2> {
        match *self {
            SourceDef::Point { pos, .. } => vec![pos],
            SourceDef::Line { a, b, .. } => vec![a, b],
        }
    }

    pub fn check(&self) -> Result<(), String> {
        let (freq, amp, phase, start) = match *self {
            SourceDef::Point {
                freq,
                amp,
                phase,
                start,
                ..
            } => (freq, amp, phase, start),
            SourceDef::Line {
                a,
                b,
                freq,
                amp,
                phase,
                start,
            } => {
                if len(sub(b, a)) < 2.0 {
                    return Err("line source is too short".into());
                }
                (freq, amp, phase, start)
            }
        };
        if !(0.25..=10.0).contains(&freq) {
            return Err("frequency must be in 0.25..=10 Hz".into());
        }
        if !(0.0..=4.0).contains(&amp) || !phase.is_finite() || !(0.0..=600.0).contains(&start) {
            return Err("amplitude, phase, or start out of range".into());
        }
        Ok(())
    }
}

/// Footprint width of a source, in cells.
const SIGMA: f32 = 1.2;
/// Seconds over which a source fades in, to avoid a broadband click.
const RAMP: f64 = 0.5;

/// A source rasterized onto the solver grid.
#[derive(Debug, Clone)]
pub struct Stencil {
    pub cells: Vec<(usize, f32)>,
    /// Peak force density.
    pub force: f32,
    pub freq: f32,
    pub phase: f32,
    pub start: f32,
}

impl Stencil {
    /// Footprint of a point at `pos` (play coordinates), weights summing to 1.
    pub fn point_cells(pos: V2, nx: usize, ny: usize) -> Vec<(usize, f32)> {
        footprint(nx, ny, pos, pos, |p| len(sub(p, pos)))
    }

    pub fn from_def(def: &SourceDef, c: f32, nx: usize, ny: usize) -> Stencil {
        match *def {
            SourceDef::Point {
                pos,
                freq,
                amp,
                phase,
                start,
            } => Stencil {
                cells: Self::point_cells(pos, nx, ny),
                force: 4.0 * std::f32::consts::PI * c * c * amp,
                freq,
                phase,
                start,
            },
            SourceDef::Line {
                a,
                b,
                freq,
                amp,
                phase,
                start,
            } => {
                let mut cells = footprint(nx, ny, a, b, |p| seg_dist(p, a, b));
                // Weights integrate to 1 per unit length.
                let l = len(sub(b, a));
                for c in &mut cells {
                    c.1 *= l;
                }
                Stencil {
                    cells,
                    force: 4.0 * std::f32::consts::PI * freq * c * amp,
                    freq,
                    phase,
                    start,
                }
            }
        }
    }

    pub fn emitter(pos: V2, freq: f32, amp: f32, phase: f32, c: f32, nx: usize, ny: usize) -> Self {
        Self::from_def(
            &SourceDef::Point {
                pos,
                freq,
                amp,
                phase,
                start: 0.0,
            },
            c,
            nx,
            ny,
        )
    }

    /// Force density at time `t` (seconds since the run started).
    pub fn value(&self, t: f64) -> f32 {
        let tau = t - self.start as f64;
        if tau < 0.0 {
            return 0.0;
        }
        let r = (tau / RAMP).min(1.0);
        let ramp = r * r * (3.0 - 2.0 * r);
        let arg = TAU * self.freq as f64 * tau + self.phase as f64;
        (self.force as f64 * ramp * libm::sin(arg)) as f32
    }

    /// Appends this step's forces to `out`.
    pub fn push_forces(&self, t: f64, out: &mut Vec<(usize, f32)>) {
        let f = self.value(t);
        out.extend(self.cells.iter().map(|&(i, w)| (i, f * w)));
    }
}

/// Gaussian footprint around the shape whose distance function is `dist`, over the bounding box
/// of `a`/`b` (play coordinates). Weights are normalized to sum to 1.
fn footprint(nx: usize, ny: usize, a: V2, b: V2, dist: impl Fn(V2) -> f32) -> Vec<(usize, f32)> {
    let reach = 3.0 * SIGMA;
    let pad = SPONGE as f32;
    let x0 = ((a[0].min(b[0]) + pad - reach).floor().max(1.0)) as usize;
    let x1 = ((a[0].max(b[0]) + pad + reach).ceil() as usize).min(nx - 2);
    let y0 = ((a[1].min(b[1]) + pad - reach).floor().max(1.0)) as usize;
    let y1 = ((a[1].max(b[1]) + pad + reach).ceil() as usize).min(ny - 2);
    let mut cells = Vec::new();
    let mut total = 0.0f32;
    for y in y0..=y1 {
        for x in x0..=x1 {
            let p = [x as f32 + 0.5 - pad, y as f32 + 0.5 - pad];
            let d = dist(p);
            if d <= reach {
                let w = libm::expf(-d * d / (2.0 * SIGMA * SIGMA));
                cells.push((y * nx + x, w));
                total += w;
            }
        }
    }
    if total > 0.0 {
        for c in &mut cells {
            c.1 /= total;
        }
    }
    cells
}

/// Seconds of simulated time after `steps` steps.
pub fn time_of(steps: u64) -> f64 {
    steps as f64 * DT as f64
}
