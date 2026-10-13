//! A play session: one level, the player's pieces, and the live simulation.
//!
//! Every change to the pieces rebuilds the materials and restarts the run from rest, so each
//! attempt is a reproducible trial whose outcome depends only on the pieces and the step count.

use serde::Serialize;

use crate::goals::{GoalStatus, Tracker};
use crate::level::{Level, PlacementError};
use crate::materials::{grid_dims, rasterize};
use crate::oscillator::{Oscillator, RERADIATION};
use crate::scoring::{score, SolveInfo};
use crate::solver::{Solver, SolverError};
use crate::source::{time_of, Stencil};
use crate::tools::Item;

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

pub struct Session {
    level: Level,
    placed: Vec<Item>,
    cost: u32,
    solver: Solver,
    overlay: Vec<u8>,
    sources: Vec<Stencil>,
    resonators: Vec<Oscillator>,
    trackers: Vec<Tracker>,
    steps: u64,
    work: f64,
    solved: Option<SolveInfo>,
    timed_out: bool,
    forces: Vec<(usize, f32)>,
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
        let solver = Solver::new(&r.materials).map_err(SessionError::Solver)?;
        let mut s = Session {
            level,
            placed: Vec::new(),
            cost: 0,
            solver,
            overlay: r.overlay,
            sources: Vec::new(),
            resonators: Vec::new(),
            trackers: Vec::new(),
            steps: 0,
            work: 0.0,
            solved: None,
            timed_out: false,
            forces: Vec::new(),
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
        // Validation keeps every material within the stable range, so this cannot fail.
        self.solver
            .set_materials(&r.materials)
            .expect("validated materials are stable");
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
        self.sources = self
            .level
            .sources
            .iter()
            .map(|d| Stencil::from_def(d, c, nx, ny))
            .collect();
        self.resonators.clear();
        for item in self.level.fixed.iter().chain(&self.placed) {
            match *item {
                Item::Emitter {
                    pos,
                    freq,
                    amp,
                    phase,
                } => {
                    self.sources
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
            .level
            .sources
            .iter()
            .map(|s| 1.0 / s.freq())
            .fold(0.25f32, f32::max);
        let [w, h] = self.level.size();
        let crossing = (w * w + h * h).sqrt() / c;
        self.trackers = self
            .level
            .goals
            .iter()
            .map(|g| Tracker::new(g, nx, ny, period, crossing))
            .collect();
    }

    /// Clears the field and restarts the clock, keeping the pieces.
    pub fn reset(&mut self) {
        self.solver.reset();
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
        self.forces.clear();
        for s in &self.sources {
            s.push_forces(t, &mut self.forces);
        }
        let metered = self.forces.len();
        for r in &mut self.resonators {
            r.step(self.solver.field());
            r.push_forces(&mut self.forces);
        }
        let power = self.solver.step(&self.forces, metered);
        self.work += power * crate::DT as f64;
        self.steps += 1;

        let t = time_of(self.steps);
        let u = self.solver.field();
        for tr in &mut self.trackers {
            tr.update(u, t);
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

    pub fn solver(&self) -> &Solver {
        &self.solver
    }

    /// Solver grid width, including the sponge.
    pub fn nx(&self) -> usize {
        self.solver.nx()
    }

    pub fn ny(&self) -> usize {
        self.solver.ny()
    }

    pub fn field(&self) -> &[f32] {
        self.solver.field()
    }

    pub fn overlay(&self) -> &[u8] {
        &self.overlay
    }

    /// Amplitude envelope of each player resonator.
    pub fn resonator_amplitudes(&self) -> Vec<f32> {
        self.resonators.iter().map(Oscillator::amplitude).collect()
    }
}
