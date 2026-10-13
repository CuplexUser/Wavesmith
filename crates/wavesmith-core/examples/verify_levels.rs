//! Runs every level with its reference solution and with no pieces, and prints what the goals
//! measured. Used to tune thresholds and par values.
//!
//! `cargo run --release -p wavesmith-core --example verify_levels [levels-dir] [filter] [pieces]`
//!
//! With `pieces` (a JSON array of items), only that layout is run for the matching levels, and
//! the goal readings are printed once per second.

use std::path::PathBuf;

use wavesmith_core::verify::{load_levels, run, Report};
use wavesmith_core::{Item, Level, Session, STEPS_PER_SECOND};

fn describe(r: &Report) -> String {
    let goals: Vec<String> = r
        .last
        .iter()
        .enumerate()
        .map(|(i, g)| {
            format!(
                "{} thr {:.3} peak {:.3} low {:.3} last {:.3}",
                g.kind, g.threshold, r.peak[i], r.low[i], g.value
            )
        })
        .collect();
    let result = match r.solved {
        Some(s) => format!(
            "SOLVED t={:.2}s energy={:.1} cost={} stars={}",
            s.time, s.energy, s.cost, s.stars
        ),
        None => format!("unsolved after {:.1}s (energy {:.1})", r.time, r.energy),
    };
    format!("{result}\n      {}", goals.join("\n      "))
}

fn trace(level: &Level, pieces: Vec<Item>) {
    let mut s = Session::new(level.clone()).expect("level loads");
    if let Err(e) = s.set_placements(pieces) {
        println!("  INVALID {e}");
        return;
    }
    while s.time() < level.time_limit as f64 {
        s.step(STEPS_PER_SECOND);
        let st = s.status();
        let vals: Vec<String> = st.goals.iter().map(|g| format!("{:.3}", g.value)).collect();
        let mark = if st.solved.is_some() { " solved" } else { "" };
        println!(
            "  t={:>4.1} energy={:>6.1} {}{mark}",
            st.time,
            st.energy,
            vals.join(" ")
        );
    }
    if let Some(sol) = s.solved() {
        println!(
            "  SOLVED t={:.2}s energy={:.1} stars={}",
            sol.time, sol.energy, sol.stars
        );
    }
}

fn main() {
    let mut args = std::env::args().skip(1);
    let dir = args
        .next()
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../levels"));
    let filter = args.next().unwrap_or_default();
    let pieces: Option<Vec<Item>> = args
        .next()
        .map(|j| serde_json::from_str(&j).expect("pieces must be a JSON item array"));
    let levels = load_levels(&dir).unwrap_or_else(|e| panic!("{e}"));
    for lf in levels.iter().filter(|l| l.level.id.contains(&filter)) {
        let l = &lf.level;
        println!(
            "== {} {} (par cost {}, par energy {:.1})",
            l.id, l.name, l.par.cost, l.par.energy
        );
        if let Some(p) = &pieces {
            trace(l, p.clone());
            continue;
        }
        match &lf.solution {
            Some(pieces) => match run(l, pieces) {
                Ok(r) => println!("  solution: {}", describe(&r)),
                Err(e) => println!("  solution: INVALID {e}"),
            },
            None => println!("  solution: (none)"),
        }
        match run(l, &[]) {
            Ok(r) => println!("  empty:    {}", describe(&r)),
            Err(e) => println!("  empty:    INVALID {e}"),
        }
    }
}
