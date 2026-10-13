//! A play session: one level, the player's pieces, and the live simulation.
//!
//! Every change to the pieces rebuilds the materials and restarts the run from rest, so each
//! attempt is a reproducible trial whose outcome depends only on the pieces and the step count.
//!
//! Sound levels run one solver. Light levels run three (red, green, blue) that share walls and
//! absorbers but see their own refractive index in glass.

use serde::Serialize;

use crate::goals::{GoalStatus, Tracker};
use crate::level::{Level, PlacementError};
use crate::light::Color;
use crate::materials::{grid_dims, rasterize};
use crate::oscillator::{Oscillator, RERADIATION};
use crate::scoring::{score, SolveInfo};
use crate::solver::{Solver, SolverError};
use crate::source::{time_of, Stencil};
use crate::tools::Item;
use crate::DT;

/// Energy is reported in these units of solver work, to keep numbers readable.
const ENERGY_UNIT: f64 = 100.0;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub time: f64,
    pub steps: u64,
    /// Work done by all sources so far.
    pub energy: f64,
    pub cost: u32,
    pub budget: u32,
    pub time_limit: f32,
    pub timed_out: bool,
    pub solved: Option<SolveInfo>,
    pub goals: Vec<GoalStatus>,
}

/// One monochromatic solve: its solver, its sources, and its frequency.
struct Channel {
    solver: Solver,
    sources: Vec<Stencil>,
    /// Angular frequency, for the light envelope (sound: the first source's).
    omega: f32,
    color: Option<Color>,
}

pub struct Session {
    level: Level,
    placed: Vec<Item>,
    cost: u32,
    channels: Vec<Channel>,
    overlay: Vec<u8>,
    /// Player resonators couple to channel 0.
    resonators: Vec<Oscillator>,
    trackers: Vec<Tracker>,
    steps: u64,
    work: f64,
    solved: Option<SolveInfo>,
    timed_out: bool,
    forces: Vec<(usize, f32)>,
    light: Vec<f32>,
    preview: Vec<u8>,
}

#[derive(Debug)]
pub enum SessionError {
    Level(String),
    Solver(SolverError),
}

impl std::fmt::Display for SessionError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            SessionError::Level(m) => f.write_str(m),
            SessionError::Solver(e) => write!(f, "{e}"),
        }
    }
}

impl std::error::Error for SessionError {}

impl Session {
    pub fn new(level: Level) -> Result<Session, SessionError> {
        level.validate().map_err(SessionError::Level)?;
        let r = rasterize(&level, &[]);
        let colors: Vec<Option<Color>> = if level.medium.light {
            Color::ALL.iter().copied().map(Some).collect()
        } else {
            vec![None]
        };
        let mut channels = Vec::new();
        for (m, color) in r.materials.iter().zip(colors) {
            let freq = match color {
                Some(c) => c.freq(level.medium.c),
                None => level.sources.first().map_or(1.0, |s| s.freq()),
            };
            channels.push(Channel {
                solver: Solver::new(m).map_err(SessionError::Solver)?,
                sources: Vec::new(),
                omega: std::f32::consts::TAU * freq,
                color,
            });
        }
        let mut s = Session {
            level,
            placed: Vec::new(),
            cost: 0,
            channels,
            overlay: r.overlay,
            resonators: Vec::new(),
            trackers: Vec::new(),
            steps: 0,
            work: 0.0,
            solved: None,
            timed_out: false,
            forces: Vec::new(),
            light: Vec::new(),
            preview: Vec::new(),
        };
        s.rebuild_actors();
        Ok(s)
    }

    pub fn from_json(json: &str) -> Result<Session, SessionError> {
        Session::new(Level::from_json(json).map_err(SessionError::Level)?)
    }

    pub fn level(&self) -> &Level {
        &self.level
    }

    pub fn placements(&self) -> &[Item] {
        &self.placed
    }

    /// Validates and applies the player's pieces, then restarts the run. On error nothing
    /// changes.
    pub fn set_placements(&mut self, items: Vec<Item>) -> Result<(), PlacementError> {
        let cost = self.level.check_placements(&items)?;
        let r = rasterize(&self.level, &items);
        for (ch, m) in self.channels.iter_mut().zip(&r.materials) {
            // Validation keeps every material within the stable range, so this cannot fail.
            ch.solver
                .set_materials(m)
                .expect("validated materials are stable");
        }
        self.overlay = r.overlay;
        self.placed = items;
        self.cost = cost;
        self.rebuild_actors();
        self.reset();
        Ok(())
    }

    fn rebuild_actors(&mut self) {
        let (nx, ny) = grid_dims(&self.level);
        let c = self.level.medium.c;
        for ch in &mut self.channels {
            let freq = ch.color.map(|col| col.freq(c));
            ch.sources = self
                .level
                .sources
                .iter()
                .filter(|d| d.emits(ch.color))
                .flat_map(|d| Stencil::from_def(d, freq, c, nx, ny))
                .collect();
        }
        self.resonators.clear();
        for item in self.level.fixed.iter().chain(&self.placed) {
            match *item {
                Item::Emitter {
                    pos,
                    freq,
                    amp,
                    phase,
                } => {
                    self.channels[0]
                        .sources
                        .push(Stencil::emitter(pos, freq, amp, phase, c, nx, ny));
                }
                Item::Resonator { pos, freq, q } => {
                    let cells = Stencil::point_cells(pos, nx, ny);
                    let emit = 4.0 * std::f32::consts::PI * c * c * RERADIATION;
                    self.resonators
                        .push(Oscillator::new(pos, freq, q, cells, emit));
                }
                _ => {}
            }
        }
        let period = self
            .channels
            .iter()
            .flat_map(|ch| ch.sources.iter().map(|s| 1.0 / s.freq))
            .fold(0.25f32, f32::max);
        let [w, h] = self.level.size();
        let crossing = (w * w + h * h).sqrt() / c;
        let n = self.channels.len();
        self.trackers = self
            .level
            .goals
            .iter()
            .map(|g| Tracker::new(g, nx, ny, period, crossing, n))
            .collect();
    }

    /// Clears the field and restarts the clock, keeping the pieces.
    pub fn reset(&mut self) {
        for ch in &mut self.channels {
            ch.solver.reset();
        }
        for r in &mut self.resonators {
            r.reset();
        }
        for t in &mut self.trackers {
            t.reset();
        }
        self.steps = 0;
        self.work = 0.0;
        self.solved = None;
        self.timed_out = false;
    }

    pub fn step(&mut self, n: u32) {
        for _ in 0..n {
            self.step_once();
        }
    }

    fn step_once(&mut self) {
        let t = time_of(self.steps);
        for (k, ch) in self.channels.iter_mut().enumerate() {
            self.forces.clear();
            for s in &ch.sources {
                s.push_forces(t, &mut self.forces);
            }
            let metered = self.forces.len();
            if k == 0 {
                for r in &mut self.resonators {
                    r.step(ch.solver.field());
                    r.push_forces(&mut self.forces);
                }
            }
            let power = ch.solver.step(&self.forces, metered);
            self.work += power * DT as f64;
        }
        self.steps += 1;

        let t = time_of(self.steps);
        let fields: Vec<&[f32]> = self.channels.iter().map(|c| c.solver.field()).collect();
        for tr in &mut self.trackers {
            tr.update(&fields, t);
        }
        if self.solved.is_none() && !self.timed_out {
            if t > self.level.time_limit as f64 + 1e-9 {
                self.timed_out = true;
            } else if self.trackers.iter().all(Tracker::complete) {
                self.solved = Some(score(&self.level, t, self.energy(), self.cost));
            }
        }
    }

    pub fn time(&self) -> f64 {
        time_of(self.steps)
    }

    pub fn steps(&self) -> u64 {
        self.steps
    }

    /// Work done by the sources, in display units.
    pub fn energy(&self) -> f64 {
        self.work / ENERGY_UNIT
    }

    pub fn solved(&self) -> Option<SolveInfo> {
        self.solved
    }

    pub fn timed_out(&self) -> bool {
        self.timed_out
    }

    pub fn cost(&self) -> u32 {
        self.cost
    }

    pub fn status(&self) -> Status {
        Status {
            time: self.time(),
            steps: self.steps,
            energy: self.energy(),
            cost: self.cost,
            budget: self.level.budget,
            time_limit: self.level.time_limit,
            timed_out: self.timed_out,
            solved: self.solved,
            goals: self.trackers.iter().map(Tracker::status).collect(),
        }
    }

    /// The solver of channel 0 (the only one in sound levels).
    pub fn solver(&self) -> &Solver {
        &self.channels[0].solver
    }

    pub fn channel_count(&self) -> usize {
        self.channels.len()
    }

    /// Total discrete field energy across channels, for diagnostics.
    pub fn field_energy(&self) -> f64 {
        self.channels.iter().map(|c| c.solver.energy()).sum()
    }

    /// Solver grid width, including the sponge.
    pub fn nx(&self) -> usize {
        self.solver().nx()
    }

    pub fn ny(&self) -> usize {
        self.solver().ny()
    }

    /// The field of channel 0.
    pub fn field(&self) -> &[f32] {
        self.solver().field()
    }

    /// The field of channel `channel` (0 = red, 1 = green, 2 = blue in light levels).
    pub fn channel_field(&self, channel: usize) -> &[f32] {
        self.channels[channel].solver.field()
    }

    pub fn overlay(&self) -> &[u8] {
        &self.overlay
    }

    /// Renders the material overlay for `items` without applying them, so a piece being dragged
    /// can be drawn in place while the run continues with the committed layout. Only shapes are
    /// checked, not inventory or keep-out rules.
    pub fn preview_overlay(&mut self, items: &[Item]) -> Result<&[u8], String> {
        for (i, item) in items.iter().enumerate() {
            item.check_shape().map_err(|m| format!("piece {i}: {m}"))?;
        }
        self.preview = rasterize(&self.level, items).overlay;
        Ok(&self.preview)
    }

    /// Recomputes and returns the light image: four floats per cell holding the squared
    /// amplitude envelope of red, green, and blue, then the green channel's instantaneous phase
    /// as `cos²` (0..1), which the renderer uses to show moving wavefronts. For a monochromatic
    /// field `u = A·cos(ωt + φ)`, the two most recent time levels give `A²` exactly.
    pub fn light_image(&mut self) -> &[f32] {
        let n = self.nx() * self.ny();
        self.light.resize(n * 4, 0.0);
        for (k, ch) in self.channels.iter().enumerate().take(3) {
            let half = 0.5 * ch.omega * DT;
            let (cs, sn) = (libm::cosf(half), libm::sinf(half));
            let (u, p) = (ch.solver.field(), ch.solver.prev_field());
            for i in 0..n {
                let a = (u[i] + p[i]) / (2.0 * cs);
                let b = (u[i] - p[i]) / (2.0 * sn);
                let a2 = a * a + b * b;
                self.light[i * 4 + k] = a2;
                if k == 1 {
                    self.light[i * 4 + 3] = if a2 > 1e-12 { a * a / a2 } else { 0.0 };
                }
            }
        }
        &self.light
    }

    /// Amplitude envelope of each player resonator.
    pub fn resonator_amplitudes(&self) -> Vec<f32> {
        self.resonators.iter().map(Oscillator::amplitude).collect()
    }
}
