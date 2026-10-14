//! Headless runs, used by tests and by the level-tuning example.

use crate::goals::GoalStatus;
use crate::level::{Level, PlacementError};
use crate::scoring::SolveInfo;
use crate::session::{Session, SessionError};
use crate::tools::Item;
use crate::STEPS_PER_SECOND;

#[derive(Debug, Clone)]
pub struct Report {
    pub solved: Option<SolveInfo>,
    pub time: f64,
    pub energy: f64,
    /// Peak value each goal reached during the run.
    pub peak: Vec<f32>,
    /// Lowest value each goal reached after its first second.
    pub low: Vec<f32>,
    pub last: Vec<GoalStatus>,
}

#[derive(Debug)]
pub enum VerifyError {
    Session(SessionError),
    Placement(PlacementError),
}

impl std::fmt::Display for VerifyError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            VerifyError::Session(e) => write!(f, "{e}"),
            VerifyError::Placement(e) => write!(f, "{e}"),
        }
    }
}

impl std::error::Error for VerifyError {}

/// Runs `level` with `items` until it is solved or the time limit passes.
pub fn run(level: &Level, items: &[Item]) -> Result<Report, VerifyError> {
    let mut s = Session::new(level.clone()).map_err(VerifyError::Session)?;
    s.set_placements(items.to_vec())
        .map_err(VerifyError::Placement)?;
    let n = s.status().goals.len();
    let mut peak = vec![0.0f32; n];
    let mut low = vec![f32::INFINITY; n];
    while s.solved().is_none() && !s.timed_out() {
        s.step(STEPS_PER_SECOND / 10);
        let st = s.status();
        for (i, g) in st.goals.iter().enumerate() {
            peak[i] = peak[i].max(g.value);
            if st.time >= 1.0 {
                low[i] = low[i].min(g.value);
            }
        }
    }
    let st = s.status();
    Ok(Report {
        solved: s.solved(),
        time: st.time,
        energy: st.energy,
        peak,
        low,
        last: st.goals,
    })
}

/// A level file plus its reference solution, if one sits next to it.
pub struct LevelFile {
    pub path: std::path::PathBuf,
    pub level: Level,
    pub solution: Option<Vec<Item>>,
}

#[derive(serde::Deserialize)]
struct SolutionFile {
    pieces: Vec<Item>,
}

/// Loads every `*.json` level under `dir`, recursively, sorted by path. Reference
/// solutions live beside each level as `<name>.solution.json`.
pub fn load_levels(dir: &std::path::Path) -> Result<Vec<LevelFile>, String> {
    let mut paths = Vec::new();
    let mut stack = vec![dir.to_path_buf()];
    while let Some(d) = stack.pop() {
        for entry in std::fs::read_dir(&d).map_err(|e| format!("{}: {e}", d.display()))? {
            let p = entry.map_err(|e| e.to_string())?.path();
            if p.is_dir() {
                stack.push(p);
            } else if let Some(name) = p.file_name().and_then(|n| n.to_str()) {
                if name.ends_with(".json")
                    && !name.ends_with(".solution.json")
                    && name != "chapters.json"
                {
                    paths.push(p);
                }
            }
        }
    }
    paths.sort();
    let mut out = Vec::new();
    for path in paths {
        let text =
            std::fs::read_to_string(&path).map_err(|e| format!("{}: {e}", path.display()))?;
        let level = Level::from_json(&text).map_err(|e| format!("{}: {e}", path.display()))?;
        let sol_path = path.with_extension("solution.json");
        let solution = if sol_path.exists() {
            let text = std::fs::read_to_string(&sol_path).map_err(|e| e.to_string())?;
            let sol: SolutionFile =
                crate::json::parse(&text).map_err(|e| format!("{}: {e}", sol_path.display()))?;
            Some(sol.pieces)
        } else {
            None
        };
        out.push(LevelFile {
            path,
            level,
            solution,
        });
    }
    Ok(out)
}
