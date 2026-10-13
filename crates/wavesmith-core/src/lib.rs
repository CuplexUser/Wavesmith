//! Wavesmith core: a deterministic 2D wave solver plus the level model, goals, and scoring.
//!
//! Units: space is measured in grid cells (h = 1) and time in seconds. The solver advances in
//! fixed steps of [`DT`], so a run is fully determined by the level, the placements, and the
//! number of steps taken.

pub mod goals;
pub mod level;
pub mod materials;
pub mod oscillator;
pub mod scoring;
pub mod session;
pub mod solver;
pub mod source;
pub mod tools;
pub mod verify;

/// Solver steps per simulated second.
pub const STEPS_PER_SECOND: u32 = 120;
/// Fixed timestep in seconds.
pub const DT: f32 = 1.0 / STEPS_PER_SECOND as f32;
/// Fastest wave speed (cells per second) the fixed timestep supports: `c·Δt ≤ 0.5`,
/// comfortably inside the 2D CFL limit of `1/√2`.
pub const MAX_SPEED: f32 = 0.5 * STEPS_PER_SECOND as f32;
/// Width of the absorbing sponge layer wrapped around the play area, in cells.
pub const SPONGE: usize = 24;

pub use level::Level;
pub use session::{Session, Status};
pub use tools::{Item, ToolKind};
