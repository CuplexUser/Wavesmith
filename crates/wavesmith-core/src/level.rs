//! Level description as stored in `levels/**/*.json`, plus validation of levels and placements.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::goals::Goal;
use crate::source::SourceDef;
use crate::tools::{len, sub, Item, ToolKind, V2};
use crate::MAX_SPEED;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct GridSize {
    pub width: usize,
    pub height: usize,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Medium {
    /// Background wave speed, cells per second.
    pub c: f32,
    /// Background damping rate, 1/s.
    #[serde(default)]
    pub damping: f32,
    /// Light level: solve red, green, and blue channels with dispersive glass.
    #[serde(default)]
    pub light: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InventoryEntry {
    pub count: u32,
    pub cost: u32,
    /// Largest allowed span in cells (segment length, box side, or lens diameter).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_size: Option<f32>,
    /// Material for new glass pieces (prisms, slabs, and glass lenses).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub material: Option<crate::light::Material>,
    /// Starting frequency of new emitters and resonators (default: the first source's).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub freq: Option<f32>,
    /// Settings the player may change on emitters and resonators. Anything not listed stays
    /// at its starting value. By default emitters tune frequency and phase, resonators
    /// frequency.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tune: Option<Vec<Tune>>,
    /// Rectangle `[x0, y0, x1, y1]` the piece's handles must stay inside.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub area: Option<[f32; 4]>,
}

/// A setting on a tunable piece.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Tune {
    Freq,
    Phase,
    /// Emitter strength.
    Amp,
    /// Emitter velocity: speed and heading.
    Speed,
}

impl InventoryEntry {
    /// Whether `t` may be changed on pieces of `kind`.
    pub fn tunes(&self, kind: ToolKind, t: Tune) -> bool {
        match &self.tune {
            Some(list) => list.contains(&t),
            None => match kind {
                ToolKind::Emitter => matches!(t, Tune::Freq | Tune::Phase),
                ToolKind::Resonator => t == Tune::Freq,
                _ => false,
            },
        }
    }
}

/// How the board is drawn: purely visual, ignored by the solver.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
pub struct Display {
    /// Brightness multiplier for the field.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub gain: Option<f32>,
    /// Color scheme: `"sound"` (default for sound levels) or `"water"`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub palette: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Par {
    /// Part cost at or under which the second star is earned.
    pub cost: u32,
    /// Source work at or under which the third star is earned.
    pub energy: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Level {
    pub id: String,
    pub name: String,
    pub chapter: u32,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub hint: String,
    pub grid: GridSize,
    pub medium: Medium,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub display: Option<Display>,
    pub sources: Vec<SourceDef>,
    #[serde(default)]
    pub fixed: Vec<Item>,
    pub goals: Vec<Goal>,
    #[serde(default)]
    pub inventory: BTreeMap<ToolKind, InventoryEntry>,
    pub budget: u32,
    pub par: Par,
    /// Seconds allowed to meet every goal.
    pub time_limit: f32,
}

#[derive(Debug, Clone, PartialEq)]
pub enum PlacementError {
    NotInInventory(ToolKind),
    TooMany {
        kind: ToolKind,
        max: u32,
    },
    OverBudget {
        cost: u32,
        budget: u32,
    },
    OutOfBounds(usize),
    /// Outside the area the level allows for that piece.
    OutsideArea(usize),
    TooBig {
        index: usize,
        max: f32,
    },
    Shape(usize, String),
    Covers {
        index: usize,
        what: &'static str,
    },
    /// A setting the level fixes was changed.
    Locked {
        index: usize,
        what: &'static str,
    },
}

impl std::fmt::Display for PlacementError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            PlacementError::NotInInventory(k) => write!(f, "{k:?} is not available in this level"),
            PlacementError::TooMany { kind, max } => write!(f, "at most {max} × {kind:?} allowed"),
            PlacementError::OverBudget { cost, budget } => {
                write!(f, "cost {cost} is over the budget of {budget}")
            }
            PlacementError::OutOfBounds(i) => write!(f, "piece {i} is outside the play area"),
            PlacementError::OutsideArea(i) => {
                write!(f, "piece {i} is outside the area allowed for it")
            }
            PlacementError::TooBig { index, max } => {
                write!(f, "piece {index} is larger than {max} cells")
            }
            PlacementError::Shape(i, m) => write!(f, "piece {i}: {m}"),
            PlacementError::Covers { index, what } => write!(f, "piece {index} covers a {what}"),
            PlacementError::Locked { index, what } => {
                write!(f, "piece {index}: this level fixes its {what}")
            }
        }
    }
}

impl std::error::Error for PlacementError {}

/// Minimum clearance between an obstacle and a source.
const SOURCE_CLEARANCE: f32 = 3.0;
/// Extra clearance beyond a goal's radius.
const GOAL_CLEARANCE: f32 = 1.0;

impl Level {
    pub fn from_json(s: &str) -> Result<Level, String> {
        let level: Level = crate::json::parse(s).map_err(|e| format!("level JSON: {e}"))?;
        level.validate()?;
        Ok(level)
    }

    /// Number of solver channels: three (red, green, blue) for light, one for sound.
    pub fn channels(&self) -> usize {
        if self.medium.light {
            3
        } else {
            1
        }
    }

    pub fn size(&self) -> V2 {
        [self.grid.width as f32, self.grid.height as f32]
    }

    pub fn inside(&self, p: V2) -> bool {
        p[0] >= 0.0
            && p[1] >= 0.0
            && p[0] <= self.grid.width as f32
            && p[1] <= self.grid.height as f32
    }

    pub fn validate(&self) -> Result<(), String> {
        let ctx = |m: String| format!("level {}: {m}", self.id);
        if !(32..=1024).contains(&self.grid.width) || !(32..=1024).contains(&self.grid.height) {
            return Err(ctx("grid size must be 32..=1024".into()));
        }
        if !(self.medium.c > 0.0 && self.medium.c <= MAX_SPEED) {
            return Err(ctx(format!("medium speed must be in (0, {MAX_SPEED}]")));
        }
        if !(self.medium.damping >= 0.0 && self.medium.damping < 50.0) {
            return Err(ctx("medium damping out of range".into()));
        }
        // Levels may leave all the sound to the player's emitters.
        if self.sources.is_empty() && !self.inventory.contains_key(&ToolKind::Emitter) {
            return Err(ctx("a level needs a source or an emitter to place".into()));
        }
        for (i, s) in self.sources.iter().enumerate() {
            s.check(self.medium.light)
                .map_err(|m| ctx(format!("source {i}: {m}")))?;
            for p in s.points() {
                if !self.inside(p) {
                    return Err(ctx(format!("source {i} is outside the play area")));
                }
            }
        }
        if self.goals.is_empty() {
            return Err(ctx("at least one goal is required".into()));
        }
        for (i, g) in self.goals.iter().enumerate() {
            g.check().map_err(|m| ctx(format!("goal {i}: {m}")))?;
            for p in g.points() {
                if !self.inside(p) {
                    return Err(ctx(format!("goal {i} is outside the play area")));
                }
            }
        }
        for (i, item) in self.fixed.iter().enumerate() {
            item.check_shape()
                .map_err(|m| ctx(format!("fixed piece {i}: {m}")))?;
        }
        if !(self.time_limit > 0.0 && self.time_limit <= 600.0) {
            return Err(ctx("time limit must be in (0, 600]".into()));
        }
        if !(self.par.energy.is_finite() && self.par.energy >= 0.0) {
            return Err(ctx("par energy must be finite".into()));
        }
        Ok(())
    }

    /// Starting frequency for new emitters and resonators of an inventory entry.
    pub fn default_freq(&self, entry: &InventoryEntry) -> f32 {
        entry
            .freq
            .unwrap_or_else(|| self.sources.first().map_or(3.0, |s| s.freq()))
    }

    /// Rejects changes to settings the level keeps fixed.
    fn check_tuning(
        &self,
        index: usize,
        item: &Item,
        entry: &InventoryEntry,
    ) -> Result<(), PlacementError> {
        let kind = item.kind();
        let same = |a: f32, b: f32| (a - b).abs() <= 1e-3;
        let locked = |t: Tune, ok: bool, what: &'static str| {
            if entry.tunes(kind, t) || ok {
                Ok(())
            } else {
                Err(PlacementError::Locked { index, what })
            }
        };
        let f0 = self.default_freq(entry);
        match *item {
            Item::Emitter {
                freq,
                amp,
                phase,
                vel,
                ..
            } => {
                locked(Tune::Freq, same(freq, f0), "frequency")?;
                locked(Tune::Phase, same(phase, 0.0), "phase")?;
                locked(Tune::Amp, same(amp, 1.0), "strength")?;
                locked(Tune::Speed, vel == [0.0, 0.0], "motion")
            }
            Item::Resonator { freq, .. } => locked(Tune::Freq, same(freq, f0), "tuning"),
            _ => Ok(()),
        }
    }

    /// Validates the player's pieces against inventory, budget, bounds, and keep-out zones.
    /// Returns the total part cost.
    pub fn check_placements(&self, items: &[Item]) -> Result<u32, PlacementError> {
        let mut counts: BTreeMap<ToolKind, u32> = BTreeMap::new();
        let mut cost = 0u32;
        for (i, item) in items.iter().enumerate() {
            let kind = item.kind();
            let entry = self
                .inventory
                .get(&kind)
                .ok_or(PlacementError::NotInInventory(kind))?;
            let n = counts.entry(kind).or_insert(0);
            *n += 1;
            if *n > entry.count {
                return Err(PlacementError::TooMany {
                    kind,
                    max: entry.count,
                });
            }
            cost += entry.cost;
            item.check_shape()
                .map_err(|m| PlacementError::Shape(i, m))?;
            if let Some(max) = entry.max_size {
                if item.size() > max + 1e-3 {
                    return Err(PlacementError::TooBig { index: i, max });
                }
            }
            self.check_tuning(i, item, entry)?;
            if !item.control_points().iter().all(|&p| self.inside(p)) {
                return Err(PlacementError::OutOfBounds(i));
            }
            if let Some([x0, y0, x1, y1]) = entry.area {
                let ok = |p: &V2| p[0] >= x0 && p[0] <= x1 && p[1] >= y0 && p[1] <= y1;
                if !item.control_points().iter().all(ok) {
                    return Err(PlacementError::OutsideArea(i));
                }
            }
            if item.is_obstacle() {
                for s in &self.sources {
                    for p in s.points() {
                        if item.distance(p) < SOURCE_CLEARANCE {
                            return Err(PlacementError::Covers {
                                index: i,
                                what: "source",
                            });
                        }
                    }
                }
                for g in &self.goals {
                    for (p, r) in g.zones() {
                        if item.distance(p) < r + GOAL_CLEARANCE {
                            return Err(PlacementError::Covers {
                                index: i,
                                what: "goal",
                            });
                        }
                    }
                }
            } else if let Item::Emitter { pos, .. } | Item::Resonator { pos, .. } = *item {
                for g in &self.goals {
                    for (p, r) in g.zones() {
                        if len(sub(pos, p)) < r + GOAL_CLEARANCE {
                            return Err(PlacementError::Covers {
                                index: i,
                                what: "goal",
                            });
                        }
                    }
                }
            }
        }
        if cost > self.budget {
            return Err(PlacementError::OverBudget {
                cost,
                budget: self.budget,
            });
        }
        Ok(cost)
    }
}
