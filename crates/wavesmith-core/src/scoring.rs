//! Star rating: one for solving within the time limit, one for staying at or under the par part
//! cost, one for using no more source energy than par.

use serde::Serialize;

use crate::level::Level;

#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SolveInfo {
    pub time: f64,
    pub energy: f64,
    pub cost: u32,
    pub stars: u8,
    pub cost_star: bool,
    pub energy_star: bool,
}

pub fn score(level: &Level, time: f64, energy: f64, cost: u32) -> SolveInfo {
    let cost_star = cost <= level.par.cost;
    let energy_star = energy <= level.par.energy;
    SolveInfo {
        time,
        energy,
        cost,
        stars: 1 + cost_star as u8 + energy_star as u8,
        cost_star,
        energy_star,
    }
}
