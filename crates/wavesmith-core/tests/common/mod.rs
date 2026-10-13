#![allow(dead_code)]

use wavesmith_core::solver::Solver;
use wavesmith_core::Level;

/// Sets a Gaussian bump at rest centered on `(cx, cy)` (solver-grid coordinates).
pub fn gaussian_pulse(s: &mut Solver, cx: f32, cy: f32, sigma: f32) {
    let nx = s.nx();
    let ny = s.ny();
    let (cur, prev) = s.fields_mut();
    for y in 1..ny - 1 {
        for x in 1..nx - 1 {
            let dx = x as f32 - cx;
            let dy = y as f32 - cy;
            let v = (-(dx * dx + dy * dy) / (2.0 * sigma * sigma)).exp();
            cur[y * nx + x] = v;
            prev[y * nx + x] = v;
        }
    }
}

/// Tiny deterministic generator for fuzz tests.
pub struct Lcg(pub u64);

impl Lcg {
    pub fn next_f32(&mut self) -> f32 {
        self.0 = self
            .0
            .wrapping_mul(6364136223846793005)
            .wrapping_add(1442695040888963407);
        ((self.0 >> 40) as f32) / ((1u64 << 24) as f32)
    }

    pub fn range(&mut self, lo: f32, hi: f32) -> f32 {
        lo + (hi - lo) * self.next_f32()
    }
}

/// A plain level: one point source, one focus goal, every tool available, no pieces.
pub fn open_level(width: usize, height: usize, freq: f32) -> Level {
    let cy = height / 2;
    let gx = width - 20;
    let json = format!(
        r#"{{
        "id": "test", "name": "Test", "chapter": 0,
        "grid": {{ "width": {width}, "height": {height} }},
        "medium": {{ "c": 60.0, "damping": 0.0 }},
        "sources": [{{ "kind": "point", "pos": [20, {cy}], "freq": {freq} }}],
        "goals": [{{ "kind": "focus", "pos": [{gx}, {cy}], "radius": 3, "threshold": 100.0, "hold": 1 }}],
        "inventory": {{
            "wall": {{ "count": 4, "cost": 1 }}, "reflector": {{ "count": 4, "cost": 1 }},
            "absorber": {{ "count": 4, "cost": 1 }}, "lens": {{ "count": 4, "cost": 1 }},
            "resonator": {{ "count": 4, "cost": 1 }}, "emitter": {{ "count": 4, "cost": 1 }}
        }},
        "budget": 99, "par": {{ "cost": 0, "energy": 0 }}, "timeLimit": 600
    }}"#
    );
    Level::from_json(&json).expect("test level is valid")
}
