//! Runs a level with a layout for a fixed time and prints each goal's reading, one line of
//! JSON, for scripted tuning: `{"values":[..],"solved":bool,"energy":e}`.
//!
//! `cargo run --release -p wavesmith-core --example goal_values -- <level.json> '<pieces>' [seconds]`

use wavesmith_core::{Item, Level, Session, STEPS_PER_SECOND};

fn main() {
    let mut args = std::env::args().skip(1);
    let path = args.next().expect("level path");
    let pieces: Vec<Item> =
        wavesmith_core::json::parse(&args.next().unwrap_or_else(|| "[]".into())).expect("pieces");
    let level =
        Level::from_json(&std::fs::read_to_string(&path).expect("read level")).expect("level");
    let secs: f32 = args
        .next()
        .map_or(level.time_limit, |s| s.parse().expect("seconds"));
    let mut s = Session::new(level).expect("session");
    if let Err(e) = s.set_placements(pieces) {
        println!(r#"{{"error":"{e}"}}"#);
        return;
    }
    s.step((STEPS_PER_SECOND as f32 * secs) as u32);
    let st = s.status();
    let values: Vec<String> = st.goals.iter().map(|g| format!("{:.4}", g.value)).collect();
    let extra: Vec<String> = st
        .goals
        .iter()
        .map(|g| g.extra.map_or("null".into(), |e| format!("{e:.4}")))
        .collect();
    println!(
        r#"{{"values":[{}],"extra":[{}],"solved":{},"energy":{:.1},"time":{:.2}}}"#,
        values.join(","),
        extra.join(","),
        st.solved.is_some(),
        st.energy,
        st.solved.map_or(-1.0, |x| x.time)
    );
}
