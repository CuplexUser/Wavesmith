//! Prints a column of light intensity (amplitude per color) for a level and layout, to tune
//! light levels.
//!
//! `cargo run --release -p wavesmith-core --example light_probe -- <level.json> <x> [pieces] [seconds]`

use wavesmith_core::{Item, Level, Session, SPONGE, STEPS_PER_SECOND};

fn main() {
    let mut args = std::env::args().skip(1);
    let path = args.next().expect("level path");
    let x: usize = args
        .next()
        .expect("column x")
        .parse()
        .expect("x is a number");
    let pieces: Vec<Item> = args
        .next()
        .map(|j| serde_json::from_str(&j).expect("pieces must be a JSON item array"))
        .unwrap_or_default();
    let secs: u32 = args.next().map_or(10, |s| s.parse().expect("seconds"));
    let level =
        Level::from_json(&std::fs::read_to_string(&path).expect("read level")).expect("level");
    let h = level.grid.height;
    let mut s = Session::new(level).expect("session");
    s.set_placements(pieces).expect("valid pieces");
    s.step(STEPS_PER_SECOND * secs);
    let nx = s.nx();
    let img = s.light_image().to_vec();
    println!("column x={x} after {secs}s (amplitude = sqrt of intensity)");
    println!("   y     red   green    blue");
    for y in (0..h).step_by(5) {
        let at = |ch: usize| img[((y + SPONGE) * nx + x + SPONGE) * 4 + ch].sqrt();
        let bar = "#".repeat((at(0).max(at(1)).max(at(2)) * 40.0) as usize);
        println!("{y:4} {:7.3} {:7.3} {:7.3} {bar}", at(0), at(1), at(2));
    }
}
