//! Times solver steps for a level, to compare stencils and track performance.
//!
//! `cargo run --release -p wavesmith-core --example bench_step -- <level.json> [steps]`

use std::time::Instant;

use wavesmith_core::{Level, Session};

fn main() {
    let mut args = std::env::args().skip(1);
    let path = args.next().expect("level path");
    let steps: u32 = args.next().map_or(600, |s| s.parse().expect("steps"));
    let level =
        Level::from_json(&std::fs::read_to_string(&path).expect("read level")).expect("level");
    let mut s = Session::new(level).expect("session");
    s.step(60);
    let t = Instant::now();
    s.step(steps);
    let ms = t.elapsed().as_secs_f64() * 1000.0 / steps as f64;
    let cells = s.nx() * s.ny() * s.channel_count();
    println!(
        "{path}: {ms:.3} ms/step, {:.2} ns/cell, {} channels",
        ms * 1e6 / cells as f64,
        s.channel_count()
    );
}
