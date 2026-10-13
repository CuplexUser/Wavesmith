mod common;

use common::gaussian_pulse;
use wavesmith_core::solver::{Materials, Solver};

#[test]
fn undamped_box_conserves_energy() {
    let m = Materials::uniform(128, 128, 60.0, 0.0);
    let mut s = Solver::new(&m).unwrap();
    gaussian_pulse(&mut s, 50.0, 70.0, 4.0);
    s.step(&[], 0);
    let e0 = s.energy();
    assert!(e0 > 0.0);
    let mut worst = 0.0f64;
    for _ in 0..20_000 {
        s.step(&[], 0);
        worst = worst.max(((s.energy() - e0) / e0).abs());
    }
    assert!(worst < 0.01, "energy drifted by {:.4}%", worst * 100.0);
}

#[test]
fn damping_never_adds_energy() {
    let m = Materials::uniform(96, 96, 45.0, 0.8);
    let mut s = Solver::new(&m).unwrap();
    gaussian_pulse(&mut s, 48.0, 48.0, 3.0);
    s.step(&[], 0);
    let mut last = s.energy();
    let e0 = last;
    for _ in 0..5_000 {
        s.step(&[], 0);
        let e = s.energy();
        assert!(
            e <= last * (1.0 + 1e-6) + 1e-12,
            "energy rose from {last} to {e}"
        );
        last = e;
    }
    assert!(last < 0.5 * e0, "damping removed too little energy");
}

#[test]
fn variable_speed_conserves_energy() {
    let mut m = Materials::uniform(128, 96, 60.0, 0.0);
    for y in 0..96 {
        for x in 64..128 {
            m.c2[y * 128 + x] = 30.0 * 30.0;
        }
    }
    let mut s = Solver::new(&m).unwrap();
    gaussian_pulse(&mut s, 40.0, 48.0, 4.0);
    s.step(&[], 0);
    let e0 = s.energy();
    for _ in 0..10_000 {
        s.step(&[], 0);
    }
    let drift = ((s.energy() - e0) / e0).abs();
    assert!(drift < 0.01, "energy drifted by {:.4}%", drift * 100.0);
}
