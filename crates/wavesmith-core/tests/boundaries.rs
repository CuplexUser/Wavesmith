mod common;

use common::{gaussian_pulse, open_level};
use wavesmith_core::materials::{rasterize, OVERLAY_CHANNELS};
use wavesmith_core::solver::{Materials, Solver, SolverError};
use wavesmith_core::{Item, Session, MAX_SPEED, SPONGE};

#[test]
fn sponge_absorbs_outgoing_pulse() {
    let level = open_level(160, 160, 3.0);
    let r = rasterize(&level, &[]);
    let mut s = Solver::new(&r.materials).unwrap();
    let c = (SPONGE + 80) as f32;
    gaussian_pulse(&mut s, c, c, 3.0);
    s.step(&[], 0);
    let e0 = s.energy();
    for _ in 0..(120 * 6) {
        s.step(&[], 0);
    }
    let left = s.energy() / e0;
    assert!(left < 0.03, "{:.2}% of the energy is left", left * 100.0);
}

#[test]
fn wall_blocks_completely() {
    let mut m = Materials::uniform(160, 96, 60.0, 0.0);
    for y in 0..96 {
        m.wall[y * 160 + 80] = 1;
        m.wall[y * 160 + 81] = 1;
    }
    let mut s = Solver::new(&m).unwrap();
    gaussian_pulse(&mut s, 40.0, 48.0, 4.0);
    {
        // Start with nothing past the wall, not even the pulse's far tail.
        let (cur, prev) = s.fields_mut();
        for y in 0..96 {
            for x in 80..160 {
                cur[y * 160 + x] = 0.0;
                prev[y * 160 + x] = 0.0;
            }
        }
    }
    let mut reflected = 0.0f32;
    for step in 0..600 {
        s.step(&[], 0);
        let u = s.field();
        for y in 0..96 {
            for x in 80..160 {
                assert_eq!(u[y * 160 + x], 0.0, "field crossed the wall at step {step}");
            }
        }
        // After bouncing, the pulse comes back past its start point.
        if step > 120 {
            reflected = reflected.max(u[48 * 160 + 40].abs());
        }
    }
    assert!(reflected > 0.05, "no reflection seen");
}

#[test]
fn walls_stay_pinned_with_sources() {
    let level = open_level(128, 96, 3.0);
    let mut session = Session::new(level).unwrap();
    session
        .set_placements(vec![Item::Wall {
            a: [60.0, 10.0],
            b: [60.0, 86.0],
            thickness: 3.0,
        }])
        .unwrap();
    session.step(240);
    let overlay = session.overlay().as_chunks::<OVERLAY_CHANNELS>().0;
    let mut walls = 0;
    for (u, px) in session.field().iter().zip(overlay) {
        if px[3] == 255 {
            walls += 1;
            assert_eq!(*u, 0.0);
            // The drawn surface (distance zero, byte 127.5) agrees with the solver's mask.
            assert!(px[0] <= 128, "wall cell drawn outside the wall");
        } else {
            assert!(px[0] >= 127, "open cell drawn inside a wall");
        }
    }
    assert!(walls > 0);
}

/// Peak arrival time of a plane pulse uniform in y, released at `x0` and probed at `xp`.
fn arrival(m: &Materials, x0: f32, xp: usize) -> f32 {
    let mut s = Solver::new(m).unwrap();
    let (nx, ny) = (m.nx, m.ny);
    {
        let (cur, prev) = s.fields_mut();
        for y in 1..ny - 1 {
            for x in 1..nx - 1 {
                let d = x as f32 - x0;
                let v = (-d * d / (2.0 * 16.0)).exp();
                cur[y * nx + x] = v;
                prev[y * nx + x] = v;
            }
        }
    }
    let probe = (ny / 2) * nx + xp;
    let mut best = (0.0f32, 0usize);
    for step in 1..=400 {
        s.step(&[], 0);
        let v = s.field()[probe];
        if v > best.0 {
            best = (v, step);
        }
    }
    best.1 as f32 * wavesmith_core::DT
}

#[test]
fn pulse_travels_at_wave_speed() {
    let m = Materials::uniform(240, 256, 60.0, 0.0);
    let t = arrival(&m, 60.0, 120);
    assert!((t - 1.0).abs() < 0.03, "arrived at {t}s, expected 1s");
}

#[test]
fn slow_medium_delays_pulse() {
    let mut m = Materials::uniform(240, 256, 60.0, 0.0);
    for y in 0..256 {
        for x in 90..240 {
            m.c2[y * 240 + x] = 30.0 * 30.0;
        }
    }
    // 30 cells at 60 c/s plus 30 cells at 30 c/s.
    let t = arrival(&m, 60.0, 120);
    assert!((t - 1.5).abs() < 0.05, "arrived at {t}s, expected 1.5s");
}

#[test]
fn rejects_unstable_speed() {
    let m = Materials::uniform(32, 32, MAX_SPEED * 1.1, 0.0);
    assert!(matches!(Solver::new(&m), Err(SolverError::Cfl { .. })));
    let mut level = open_level(64, 64, 3.0);
    level.medium.c = MAX_SPEED * 1.2;
    assert!(level.validate().is_err());
}
