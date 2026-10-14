//! Moving sources: the solver should produce the Doppler shift on its own.

use wavesmith_core::{Level, Session, SPONGE};

fn level(vel: f32) -> Level {
    let json = format!(
        r#"{{
        "id": "doppler-test", "name": "Doppler test", "chapter": 0,
        "grid": {{ "width": 400, "height": 120 }},
        "medium": {{ "c": 60, "damping": 0.0 }},
        "sources": [{{ "kind": "point", "pos": [200, 60], "vel": [{vel}, 0], "freq": 3 }}],
        "goals": [{{ "kind": "focus", "pos": [395, 5], "radius": 2, "threshold": 100, "hold": 1 }}],
        "inventory": {{}},
        "budget": 0, "par": {{ "cost": 0, "energy": 0 }}, "timeLimit": 600
    }}"#
    );
    Level::from_json(&json).unwrap()
}

/// Frequency heard at play-area cell `x` on the source's line, from upward zero crossings
/// between `t0` and `t1` seconds.
fn heard(vel: f32, x: usize, t0: f64, t1: f64) -> f64 {
    let mut s = Session::new(level(vel)).unwrap();
    let i = (60 + SPONGE) * s.nx() + x + SPONGE;
    let mut crossings = Vec::new();
    let mut last = 0.0f32;
    while s.time() < t1 {
        s.step(1);
        let u = s.field()[i];
        if s.time() > t0 && last < 0.0 && u >= 0.0 {
            // Interpolate the crossing time within the step.
            let frac = last / (last - u);
            crossings.push(s.time() - (1.0 - frac as f64) / 120.0);
        }
        last = u;
    }
    let n = crossings.len() - 1;
    n as f64 / (crossings[n] - crossings[0])
}

#[test]
fn approaching_and_receding_sources_shift_pitch() {
    let (f, c, v) = (3.0f64, 60.0f64, 15.0f64);
    // A listener ahead of the source (to the right) and one behind it (to the left).
    let ahead = heard(v as f32, 380, 4.0, 7.0);
    let behind = heard(v as f32, 20, 4.0, 7.0);
    let still = heard(0.0, 380, 4.0, 7.0);
    let want_ahead = f * c / (c - v);
    let want_behind = f * c / (c + v);
    println!("heard: still {still:.3}, ahead {ahead:.3} (want {want_ahead:.3}), behind {behind:.3} (want {want_behind:.3})");
    assert!((still - f).abs() < 0.02, "still source: {still}");
    assert!(
        (ahead / want_ahead - 1.0).abs() < 0.02,
        "ahead {ahead} vs {want_ahead}"
    );
    assert!(
        (behind / want_behind - 1.0).abs() < 0.02,
        "behind {behind} vs {want_behind}"
    );
}

#[test]
fn moving_sources_stop_at_the_margin() {
    let mut s = Session::new(level(30.0)).unwrap();
    s.step(120 * 9);
    // 200 + 30·9 would be 470, past the 400-cell board; it parks 6 cells from the edge and
    // keeps sounding there.
    let nx = s.nx();
    let near = s.field()[(60 + SPONGE) * nx + 394 + SPONGE].abs();
    assert!(s.solver().max_abs().is_finite() && near < 50.0);
}
