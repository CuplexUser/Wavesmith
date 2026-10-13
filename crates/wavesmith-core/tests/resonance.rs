mod common;

use common::open_level;
use std::f32::consts::TAU;
use wavesmith_core::goals::Goal;
use wavesmith_core::oscillator::Oscillator;
use wavesmith_core::{Session, DT};

fn driven_amplitude(natural: f32, drive: f32) -> f32 {
    let mut o = Oscillator::new([0.0, 0.0], natural, 25.0, vec![(0, 1.0)], 0.0);
    let mut peak = 0.0f32;
    for n in 0..(120 * 20) {
        let u = [(TAU * drive * n as f32 * DT).sin()];
        o.step(&u);
        if n > 120 * 15 {
            peak = peak.max(o.amplitude());
        }
    }
    peak
}

#[test]
fn oscillator_peaks_at_its_natural_frequency() {
    let on = driven_amplitude(2.0, 2.0);
    let low = driven_amplitude(2.0, 1.0);
    let high = driven_amplitude(2.0, 4.0);
    assert!(on > 15.0, "resonant amplitude only {on}");
    assert!(
        on > 8.0 * low && on > 8.0 * high,
        "on {on}, low {low}, high {high}"
    );
}

fn shatters(source_freq: f32) -> bool {
    let mut level = open_level(160, 100, source_freq);
    level.goals = vec![Goal::Resonate {
        pos: [70.0, 50.0],
        freq: 2.0,
        q: 30.0,
        threshold: 4.0,
    }];
    level.time_limit = 20.0;
    let mut s = Session::new(level).unwrap();
    s.step(120 * 20);
    s.solved().is_some()
}

#[test]
fn resonate_goal_needs_matching_frequency() {
    assert!(shatters(2.0));
    assert!(!shatters(3.0));
    assert!(!shatters(1.3));
}
