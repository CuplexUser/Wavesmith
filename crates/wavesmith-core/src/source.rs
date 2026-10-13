//! Wave sources: soft sinusoidal forcing spread over a small Gaussian footprint.
//!
//! Amplitudes are normalized so that `amp = 1` gives a field amplitude of about 1 one wavelength
//! from a point source (2D Green's function, `|u| ≈ Q/(4c²)·√(2/(πkr))`), and about 1 for the
//! plane wave launched by a line source (`|u| = q/(4πfc)`).
//!
//! In light levels a source emits on every color channel it lists, at that color's frequency.

use std::f64::consts::TAU;

use serde::{Deserialize, Serialize};

use crate::light::Color;
use crate::tools::{add, dot, len, scale, seg_dist, sub, V2};
use crate::{DT, SPONGE};

fn default_amp() -> f32 {
    1.0
}

fn default_width() -> f32 {
    22.0
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum SourceDef {
    Point {
        pos: V2,
        /// Hz; ignored in light levels, where each color has its own frequency.
        #[serde(default)]
        freq: f32,
        #[serde(default = "default_amp")]
        amp: f32,
        #[serde(default)]
        phase: f32,
        /// Seconds before the source switches on.
        #[serde(default)]
        start: f32,
        /// Light levels: colors emitted (all three when omitted).
        #[serde(default, skip_serializing_if = "Option::is_none")]
        colors: Option<Vec<Color>>,
    },
    Line {
        a: V2,
        b: V2,
        #[serde(default)]
        freq: f32,
        #[serde(default = "default_amp")]
        amp: f32,
        #[serde(default)]
        phase: f32,
        #[serde(default)]
        start: f32,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        colors: Option<Vec<Color>>,
    },
    /// A one-way Gaussian beam starting at `pos` and heading along `angle` (radians, 0 = +x,
    /// increasing toward +y). `width` is the waist radius in cells.
    Beam {
        pos: V2,
        angle: f32,
        #[serde(default = "default_width")]
        width: f32,
        #[serde(default)]
        freq: f32,
        #[serde(default = "default_amp")]
        amp: f32,
        #[serde(default)]
        phase: f32,
        #[serde(default)]
        start: f32,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        colors: Option<Vec<Color>>,
    },
}

impl SourceDef {
    pub fn freq(&self) -> f32 {
        match *self {
            SourceDef::Point { freq, .. }
            | SourceDef::Line { freq, .. }
            | SourceDef::Beam { freq, .. } => freq,
        }
    }

    fn params(&self) -> (f32, f32, f32) {
        match *self {
            SourceDef::Point {
                amp, phase, start, ..
            }
            | SourceDef::Line {
                amp, phase, start, ..
            }
            | SourceDef::Beam {
                amp, phase, start, ..
            } => (amp, phase, start),
        }
    }

    pub fn colors(&self) -> Option<&[Color]> {
        match self {
            SourceDef::Point { colors, .. }
            | SourceDef::Line { colors, .. }
            | SourceDef::Beam { colors, .. } => colors.as_deref(),
        }
    }

    /// Whether the source emits `color` (always true in sound levels).
    pub fn emits(&self, color: Option<Color>) -> bool {
        match (color, self.colors()) {
            (Some(c), Some(list)) => list.contains(&c),
            _ => true,
        }
    }

    pub fn points(&self) -> Vec<V2> {
        match *self {
            SourceDef::Point { pos, .. } | SourceDef::Beam { pos, .. } => vec![pos],
            SourceDef::Line { a, b, .. } => vec![a, b],
        }
    }

    pub fn check(&self, light: bool) -> Result<(), String> {
        let (amp, phase, start) = self.params();
        match *self {
            SourceDef::Line { a, b, .. } if len(sub(b, a)) < 2.0 => {
                return Err("line source is too short".into());
            }
            SourceDef::Beam { angle, width, .. }
                if !angle.is_finite() || !(2.0..=80.0).contains(&width) =>
            {
                return Err("beam angle or width out of range".into());
            }
            _ => {}
        }
        if !light && !(0.25..=10.0).contains(&self.freq()) {
            return Err("frequency must be in 0.25..=10 Hz".into());
        }
        if !(0.0..=4.0).contains(&amp) || !phase.is_finite() || !(0.0..=600.0).contains(&start) {
            return Err("amplitude, phase, or start out of range".into());
        }
        if light && self.colors().is_some_and(|c| c.is_empty()) {
            return Err("a light source needs at least one color".into());
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

    /// Footprint of a segment, weights summing to its length (1 per unit length).
    fn line_cells(a: V2, b: V2, nx: usize, ny: usize) -> Vec<(usize, f32)> {
        let mut cells = footprint(nx, ny, a, b, |p| seg_dist(p, a, b));
        let l = len(sub(b, a));
        for c in &mut cells {
            c.1 *= l;
        }
        cells
    }

    /// Rasterizes `def` for one channel. `freq` is the channel's frequency in light levels, or
    /// `None` to use the source's own. A beam yields two stencils.
    pub fn from_def(
        def: &SourceDef,
        freq: Option<f32>,
        c: f32,
        nx: usize,
        ny: usize,
    ) -> Vec<Stencil> {
        let f = freq.unwrap_or(def.freq());
        let (amp, phase, start) = def.params();
        let pi4 = 4.0 * std::f32::consts::PI;
        match *def {
            SourceDef::Point { pos, .. } => vec![Stencil {
                cells: Self::point_cells(pos, nx, ny),
                force: pi4 * c * c * amp,
                freq: f,
                phase,
                start,
            }],
            SourceDef::Line { a, b, .. } => vec![Stencil {
                cells: Self::line_cells(a, b, nx, ny),
                force: pi4 * f * c * amp,
                freq: f,
                phase,
                start,
            }],
            SourceDef::Beam {
                pos, angle, width, ..
            } => {
                // Two tapered sheets a quarter wavelength apart, the front one lagging by a
                // quarter period: their waves add going forward and cancel going backward.
                let dir = [libm::cosf(angle), libm::sinf(angle)];
                let perp = [-dir[1], dir[0]];
                let quarter = 0.25 * c / f;
                // Wide enough that the Gaussian taper reaches ~0.2% at the ends (fewer side lobes).
                let half = 2.5 * width;
                let sheet = |center: V2| {
                    let a = add(center, scale(perp, -half));
                    let b = add(center, scale(perp, half));
                    let pad = SPONGE as f32;
                    let mut cells = Self::line_cells(a, b, nx, ny);
                    for (i, w) in &mut cells {
                        let p = [(*i % nx) as f32 + 0.5 - pad, (*i / nx) as f32 + 0.5 - pad];
                        let s = dot(sub(p, center), perp) / width;
                        *w *= libm::expf(-s * s);
                    }
                    cells
                };
                let force = pi4 * f * c * amp * 0.5;
                vec![
                    Stencil {
                        cells: sheet(pos),
                        force,
                        freq: f,
                        phase,
                        start,
                    },
                    Stencil {
                        cells: sheet(add(pos, scale(dir, quarter))),
                        force,
                        freq: f,
                        phase: phase - std::f32::consts::FRAC_PI_2,
                        start,
                    },
                ]
            }
        }
    }

    pub fn emitter(pos: V2, freq: f32, amp: f32, phase: f32, c: f32, nx: usize, ny: usize) -> Self {
        let def = SourceDef::Point {
            pos,
            freq,
            amp,
            phase,
            start: 0.0,
            colors: None,
        };
        Self::from_def(&def, None, c, nx, ny).remove(0)
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
    let x1 = ((a[0].max(b[0]) + pad + reach).ceil().max(0.0) as usize).min(nx - 2);
    let y0 = ((a[1].min(b[1]) + pad - reach).floor().max(1.0)) as usize;
    let y1 = ((a[1].max(b[1]) + pad + reach).ceil().max(0.0) as usize).min(ny - 2);
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
