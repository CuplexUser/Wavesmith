//! Level goals and the trackers that measure them on the live field.
//!
//! Amplitudes are smoothed with an exponential moving average of `u²` over about one wave period
//! and reported as `√(2·⟨u²⟩)`, which equals the peak amplitude of a steady sinusoid.

use serde::Serialize;

use crate::light::Color;
use crate::oscillator::Oscillator;
use crate::tools::{len, sub, V2};
use crate::{DT, SPONGE};

#[derive(Debug, Clone, PartialEq, Serialize)]
// Deserialized by hand in `crate::json`, which keeps the WebAssembly build small.
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum Goal {
    /// Amplitude at the target reaches `threshold` and holds for `hold` seconds.
    Focus {
        pos: V2,
        radius: f32,
        threshold: f32,
        hold: f32,
        /// Light levels: the colors measured (all three when omitted), averaged.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        colors: Option<Vec<Color>>,
    },
    /// Amplitude in the zone stays at or below `threshold` for `hold` seconds, counted from
    /// `after` seconds (by default, once waves could have crossed the whole board).
    Silence {
        pos: V2,
        radius: f32,
        threshold: f32,
        hold: f32,
        #[serde(default)]
        after: Option<f32>,
        /// Light levels: the colors that must stay dark (all three when omitted).
        #[serde(default, skip_serializing_if = "Option::is_none")]
        colors: Option<Vec<Color>>,
    },
    /// An object with natural frequency `freq` shatters once its amplitude reaches `threshold`.
    Resonate {
        pos: V2,
        freq: f32,
        #[serde(default = "default_q")]
        q: f32,
        threshold: f32,
    },
    /// A standing wave: every antinode at or above `high` and every node at or below `low`,
    /// held for `hold` seconds.
    Sustain {
        antinodes: Vec<V2>,
        nodes: Vec<V2>,
        radius: f32,
        high: f32,
        low: f32,
        hold: f32,
    },
}

pub(crate) fn default_q() -> f32 {
    30.0
}

impl Goal {
    pub fn kind_name(&self) -> &'static str {
        match self {
            Goal::Focus { .. } => "focus",
            Goal::Silence { .. } => "silence",
            Goal::Resonate { .. } => "resonate",
            Goal::Sustain { .. } => "sustain",
        }
    }

    pub fn points(&self) -> Vec<V2> {
        self.zones().into_iter().map(|(p, _)| p).collect()
    }

    /// Circles the player may not cover.
    pub fn zones(&self) -> Vec<(V2, f32)> {
        match self {
            Goal::Focus { pos, radius, .. } | Goal::Silence { pos, radius, .. } => {
                vec![(*pos, *radius)]
            }
            Goal::Resonate { pos, .. } => vec![(*pos, 3.0)],
            Goal::Sustain {
                antinodes,
                nodes,
                radius,
                ..
            } => antinodes
                .iter()
                .chain(nodes)
                .map(|p| (*p, *radius))
                .collect(),
        }
    }

    pub fn check(&self) -> Result<(), String> {
        let ok = |v: f32| v.is_finite() && v > 0.0;
        let good = match self {
            Goal::Focus {
                radius,
                threshold,
                hold,
                ..
            } => ok(*radius) && ok(*threshold) && *hold >= 0.0,
            Goal::Silence {
                radius,
                threshold,
                hold,
                after,
                ..
            } => ok(*radius) && ok(*threshold) && *hold >= 0.0 && after.is_none_or(|a| a >= 0.0),
            Goal::Resonate {
                freq, q, threshold, ..
            } => (0.25..=10.0).contains(freq) && ok(*q) && ok(*threshold),
            Goal::Sustain {
                antinodes,
                radius,
                high,
                low,
                hold,
                ..
            } => !antinodes.is_empty() && ok(*radius) && ok(*high) && *low >= 0.0 && *hold >= 0.0,
        };
        if good {
            Ok(())
        } else {
            Err(format!("{} goal has invalid parameters", self.kind_name()))
        }
    }
}

/// Mean-square probe over a disk of cells, averaged over a set of channels.
#[derive(Debug, Clone)]
struct Probe {
    cells: Vec<usize>,
    channels: Vec<usize>,
    ms: f64,
}

impl Probe {
    fn disk(pos: V2, radius: f32, nx: usize, ny: usize, channels: Vec<usize>) -> Probe {
        let pad = SPONGE as f32;
        let r = radius.max(0.75);
        let x0 = ((pos[0] + pad - r).floor().max(1.0)) as usize;
        let x1 = ((pos[0] + pad + r).ceil() as usize).min(nx - 2);
        let y0 = ((pos[1] + pad - r).floor().max(1.0)) as usize;
        let y1 = ((pos[1] + pad + r).ceil() as usize).min(ny - 2);
        let mut cells = Vec::new();
        for y in y0..=y1 {
            for x in x0..=x1 {
                let p = [x as f32 + 0.5 - pad, y as f32 + 0.5 - pad];
                if len(sub(p, pos)) <= r {
                    cells.push(y * nx + x);
                }
            }
        }
        Probe {
            cells,
            channels,
            ms: 0.0,
        }
    }

    fn update(&mut self, fields: &[&[f32]], alpha: f64) {
        if self.cells.is_empty() || self.channels.is_empty() {
            return;
        }
        let mut m = 0.0f64;
        for &ch in &self.channels {
            let u = fields[ch];
            m += self
                .cells
                .iter()
                .map(|&i| (u[i] as f64) * (u[i] as f64))
                .sum::<f64>();
        }
        m /= (self.cells.len() * self.channels.len()) as f64;
        self.ms += (m - self.ms) * alpha;
    }

    fn amplitude(&self) -> f32 {
        (2.0 * self.ms).sqrt() as f32
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct GoalStatus {
    pub kind: &'static str,
    /// Measured amplitude (for sustain: the weakest antinode).
    pub value: f32,
    pub threshold: f32,
    /// Secondary reading: for sustain, the loudest node.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub extra: Option<f32>,
    /// 0..1 toward the hold time.
    pub hold: f32,
    pub met: bool,
    pub complete: bool,
}

#[derive(Debug, Clone)]
pub struct Tracker {
    goal: Goal,
    probes: Vec<Probe>,
    oscillator: Option<Oscillator>,
    alpha: f64,
    /// Seconds the condition has held continuously.
    held: f64,
    /// Silence goals start counting here.
    after: f64,
    met: bool,
    broken: bool,
}

impl Tracker {
    /// `period` is the smoothing time constant (about one period of the slowest source);
    /// `crossing` is the time for a wave to cross the board, the default silence delay;
    /// `channels` is 3 for light levels and 1 for sound.
    pub fn new(
        goal: &Goal,
        nx: usize,
        ny: usize,
        period: f32,
        crossing: f32,
        channels: usize,
    ) -> Tracker {
        let pick = |colors: &Option<Vec<Color>>| -> Vec<usize> {
            match (channels, colors) {
                (3, Some(list)) => list.iter().map(|c| c.index()).collect(),
                _ => (0..channels).collect(),
            }
        };
        let mut probes = Vec::new();
        let mut oscillator = None;
        let mut after = 0.0;
        match goal {
            Goal::Focus {
                pos,
                radius,
                colors,
                ..
            } => probes.push(Probe::disk(*pos, *radius, nx, ny, pick(colors))),
            Goal::Silence {
                pos,
                radius,
                after: a,
                colors,
                ..
            } => {
                probes.push(Probe::disk(*pos, *radius, nx, ny, pick(colors)));
                after = a.unwrap_or(crossing) as f64;
            }
            Goal::Resonate { pos, freq, q, .. } => {
                let cells = crate::source::Stencil::point_cells(*pos, nx, ny);
                oscillator = Some(Oscillator::new(*pos, *freq, *q, cells, 0.0));
            }
            Goal::Sustain {
                antinodes,
                nodes,
                radius,
                ..
            } => {
                for p in antinodes.iter().chain(nodes) {
                    probes.push(Probe::disk(*p, *radius, nx, ny, pick(&None)));
                }
            }
        }
        let alpha = (DT as f64 / period.max(DT) as f64).min(1.0);
        Tracker {
            goal: goal.clone(),
            probes,
            oscillator,
            alpha,
            held: 0.0,
            after,
            met: false,
            broken: false,
        }
    }

    pub fn reset(&mut self) {
        for p in &mut self.probes {
            p.ms = 0.0;
        }
        if let Some(o) = &mut self.oscillator {
            o.reset();
        }
        self.held = 0.0;
        self.met = false;
        self.broken = false;
    }

    fn hold_time(&self) -> f32 {
        match self.goal {
            Goal::Focus { hold, .. } | Goal::Silence { hold, .. } | Goal::Sustain { hold, .. } => {
                hold
            }
            Goal::Resonate { .. } => 0.0,
        }
    }

    /// Updates with the field after a step; `t` is the time after the step.
    /// `fields` holds the current field of every channel.
    pub fn update(&mut self, fields: &[&[f32]], t: f64) {
        for p in &mut self.probes {
            p.update(fields, self.alpha);
        }
        if let Some(o) = &mut self.oscillator {
            o.step(fields[0]);
        }
        self.met = match &self.goal {
            Goal::Focus { threshold, .. } => self.probes[0].amplitude() >= *threshold,
            Goal::Silence { threshold, .. } => {
                t >= self.after && self.probes[0].amplitude() <= *threshold
            }
            Goal::Resonate { threshold, .. } => {
                let o = self
                    .oscillator
                    .as_ref()
                    .expect("resonate goal has an oscillator");
                if o.amplitude() >= *threshold {
                    self.broken = true;
                }
                self.broken
            }
            Goal::Sustain {
                antinodes,
                high,
                low,
                ..
            } => {
                let (a, n) = self.probes.split_at(antinodes.len());
                a.iter().all(|p| p.amplitude() >= *high) && n.iter().all(|p| p.amplitude() <= *low)
            }
        };
        if self.met {
            self.held += DT as f64;
        } else {
            self.held = 0.0;
        }
    }

    pub fn complete(&self) -> bool {
        self.met && self.held + 1e-9 >= self.hold_time() as f64
    }

    pub fn status(&self) -> GoalStatus {
        let hold = self.hold_time();
        let (value, threshold, extra) = match &self.goal {
            Goal::Focus { threshold, .. } | Goal::Silence { threshold, .. } => {
                (self.probes[0].amplitude(), *threshold, None)
            }
            Goal::Resonate { threshold, .. } => {
                let o = self
                    .oscillator
                    .as_ref()
                    .expect("resonate goal has an oscillator");
                (o.amplitude(), *threshold, None)
            }
            Goal::Sustain {
                antinodes, high, ..
            } => {
                let (a, n) = self.probes.split_at(antinodes.len());
                let weakest = a.iter().map(Probe::amplitude).fold(f32::INFINITY, f32::min);
                let loudest = n.iter().map(Probe::amplitude).fold(0.0, f32::max);
                (weakest, *high, Some(loudest))
            }
        };
        GoalStatus {
            kind: self.goal.kind_name(),
            value,
            threshold,
            extra,
            hold: if hold > 0.0 {
                ((self.held as f32) / hold).min(1.0)
            } else {
                self.met as u8 as f32
            },
            met: self.met,
            complete: self.complete(),
        }
    }
}
