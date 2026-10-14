//! Measures how much of a beam a flat glass surface reflects in the solver, against the Fresnel
//! equations. The scalar wave equation with a speed jump is the s-polarized (TE) case.
//!
//! Each case runs twice, with and without the interface; the difference is the reflected wave
//! alone (the solver is linear), so incident and reflected beams never need to be separated.
//!
//! `cargo run --release -p wavesmith-core --example fresnel_check -- [n] [wavelength] [sharp]`

use wavesmith_core::solver::{dispersion_corrected_c2, Laplacian, Materials, Solver};
use wavesmith_core::source::{SourceDef, Stencil};
use wavesmith_core::tools::V2;
use wavesmith_core::{DT, SPONGE};

const W: usize = 1200;
const H: usize = 800;
const C0: f32 = 60.0;
const YI: f32 = 500.0;
const HIT: V2 = [600.0, YI];
const D: f32 = 300.0;
const WIDTH: f32 = 25.0;

/// Tilt of the whole setup (interface and beam) about the hit point, from `ROT` (degrees).
fn rot() -> f32 {
    std::env::var("ROT")
        .ok()
        .and_then(|v| v.parse::<f32>().ok())
        .unwrap_or(0.0)
        .to_radians()
}

fn turn(v: V2) -> V2 {
    let (s, c) = (rot().sin(), rot().cos());
    [c * v[0] - s * v[1], s * v[0] + c * v[1]]
}

fn main() {
    let mut args = std::env::args().skip(1);
    let n: f32 = args.next().map_or(1.66, |s| s.parse().unwrap());
    let lambda: f32 = args.next().map_or(10.0, |s| s.parse().unwrap());
    let mode = args.next().unwrap_or_else(|| "smooth".into());
    let sharp = mode.as_str();
    let freq = C0 / lambda;
    println!("n {n}, vacuum wavelength {lambda} cells, {sharp} interface");
    println!("  side      angle   solver R   Fresnel R");
    for (inside, angles) in [
        (false, &[15.0f32, 45.0, 70.0][..]),
        (true, &[15.0, 30.0, 36.0, 45.0][..]),
    ] {
        for &deg in angles {
            let th = deg.to_radians();
            let (n1, n2) = if inside { (n, 1.0) } else { (1.0, n) };
            let r = measure(n1, n2, th, freq, sharp);
            let ci = th.cos();
            let s = n1 / n2 * th.sin();
            let fres = if s >= 1.0 {
                1.0
            } else {
                let ct = (1.0 - s * s).sqrt();
                let rs = (n1 * ci - n2 * ct) / (n1 * ci + n2 * ct);
                rs * rs
            };
            let side = if inside { "inside" } else { "outside" };
            println!("  {side:<8} {deg:5.0}°   {r:8.4}   {fres:8.4}");
        }
    }
}

/// Reflected power over incident power for a beam in medium `n1` hitting `n2` at angle `th`.
fn measure(n1: f32, n2: f32, th: f32, freq: f32, sharp: &str) -> f32 {
    let d_in = turn([th.sin(), th.cos()]);
    let d_r = turn([th.sin(), -th.cos()]);
    let with = run(n1, Some(n2), th, freq, sharp);
    let without = run(n1, None, th, freq, sharp);
    let diff: Vec<(f32, f32)> = with
        .iter()
        .zip(&without)
        .map(|(a, b)| (a.0 - b.0, a.1 - b.1))
        .collect();
    let omega = std::f32::consts::TAU * freq;
    let reflected = flux(
        &diff,
        [HIT[0] + D * d_r[0], HIT[1] + D * d_r[1]],
        d_r,
        omega,
    );
    let incident = flux(
        &without,
        [HIT[0] + D * d_in[0], HIT[1] + D * d_in[1]],
        d_in,
        omega,
    );
    reflected / incident
}

/// Runs to steady state and returns `(u, u_prev)` per cell.
fn run(n1: f32, n2: Option<f32>, th: f32, freq: f32, sharp: &str) -> Vec<(f32, f32)> {
    let (nx, ny) = (W + 2 * SPONGE, H + 2 * SPONGE);
    let mut m = Materials::uniform(nx, ny, C0, 0.0);
    let iso = sharp.starts_with("iso");
    let sharp = sharp.trim_start_matches("iso-");
    if iso {
        m.laplacian = Laplacian::Isotropic;
    }
    let omega = std::f32::consts::TAU * freq;
    let l = SPONGE as f32;
    let gmax = 3.0 * C0 / (2.0 * l) * (1e4f32).ln();
    for y in 0..ny {
        for x in 0..nx {
            let px = x as f32 + 0.5 - l;
            let py0 = y as f32 + 0.5 - l;
            let dx = (-px).max(px - W as f32).max(0.0);
            let dy = (-py0).max(py0 - H as f32).max(0.0);
            // Height relative to the (tilted) interface, plus YI.
            let nrm = turn([0.0, 1.0]);
            let py = YI + (px - HIT[0]) * nrm[0] + (py0 - HIT[1]) * nrm[1];
            let d = dx.max(dy).min(l) / l;
            let i = y * nx + x;
            m.gamma[i] = gmax * d * d;
            // Medium 1 above the interface, medium 2 below.
            let ratio = |n: f32| 1.0 / n;
            let below = match n2 {
                None => 0.0,
                Some(_) if sharp == "sharp" => f32::from(py > YI),
                Some(_) => {
                    let hw: f32 = sharp
                        .strip_prefix('h')
                        .and_then(|v| v.parse().ok())
                        .unwrap_or(1.0);
                    let t = ((py - YI + hw) / (2.0 * hw)).clamp(0.0, 1.0);
                    t * t * (3.0 - 2.0 * t)
                }
            };
            let n2 = n2.unwrap_or(n1);
            m.c2[i] = if iso {
                let r = ratio(n1) + (ratio(n2) - ratio(n1)) * below;
                dispersion_corrected_c2(C0 * r, omega)
            } else if sharp == "eps" {
                // Area fraction of the cell below the interface, then average n².
                let f = (py - YI + 0.5).clamp(0.0, 1.0);
                let f = if n2 == n1 { 0.0 } else { f };
                C0 * C0 / (n1 * n1 + (n2 * n2 - n1 * n1) * f)
            } else {
                let r = ratio(n1) + (ratio(n2) - ratio(n1)) * below;
                C0 * C0 * r * r
            };
        }
    }
    for x in 0..nx {
        m.wall[x] = 1;
        m.wall[(ny - 1) * nx + x] = 1;
    }
    for y in 0..ny {
        m.wall[y * nx] = 1;
        m.wall[y * nx + nx - 1] = 1;
    }
    let mut solver = Solver::new(&m).unwrap();
    let c1 = C0 / n1;
    let start_dist = D + 80.0;
    let dir = turn([th.sin(), th.cos()]);
    let pos = [HIT[0] - start_dist * dir[0], HIT[1] - start_dist * dir[1]];
    let def = SourceDef::Beam {
        pos,
        angle: dir[1].atan2(dir[0]),
        width: WIDTH,
        freq,
        amp: 1.0,
        phase: 0.0,
        start: 0.0,
        colors: None,
    };
    let stencils = Stencil::from_def(&def, None, c1, nx, ny);
    let secs = (start_dist + D + 2.5 * WIDTH) / c1 + 6.0;
    let steps = (secs / DT) as u64;
    let mut forces = Vec::new();
    for k in 0..steps {
        let t = k as f64 * DT as f64;
        forces.clear();
        for s in &stencils {
            s.push_forces(t, &mut forces);
        }
        solver.step(&forces, 0);
    }
    solver
        .field()
        .iter()
        .zip(solver.prev_field())
        .map(|(&a, &b)| (a, b))
        .collect()
}

/// Integrated squared amplitude across the line through `p` perpendicular to `dir`.
fn flux(f: &[(f32, f32)], p: V2, dir: V2, omega: f32) -> f32 {
    let nx = W + 2 * SPONGE;
    let half = 0.5 * omega * DT;
    let (cs, sn) = (half.cos(), half.sin());
    let amp2 = |i: usize| {
        let (u, pr) = f[i];
        let a = (u + pr) / (2.0 * cs);
        let b = (u - pr) / (2.0 * sn);
        a * a + b * b
    };
    let perp = [-dir[1], dir[0]];
    let mut total = 0.0;
    let ds = 0.5;
    let reach = 4.0 * WIDTH;
    let mut s = -reach;
    while s <= reach {
        let q = [p[0] + s * perp[0], p[1] + s * perp[1]];
        let gx = q[0] + SPONGE as f32 - 0.5;
        let gy = q[1] + SPONGE as f32 - 0.5;
        let (x0, y0) = (gx.floor() as usize, gy.floor() as usize);
        let (fx, fy) = (gx - x0 as f32, gy - y0 as f32);
        let at = |x: usize, y: usize| amp2(y * nx + x);
        total += (at(x0, y0) * (1.0 - fx) * (1.0 - fy)
            + at(x0 + 1, y0) * fx * (1.0 - fy)
            + at(x0, y0 + 1) * (1.0 - fx) * fy
            + at(x0 + 1, y0 + 1) * fx * fy)
            * ds;
        s += ds;
    }
    total
}
