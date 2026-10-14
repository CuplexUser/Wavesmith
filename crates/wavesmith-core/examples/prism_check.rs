//! Compares the wave solver's prism against geometric optics. A narrow white beam hits a flint
//! prism; for each color the program prints where the light crosses a circle around the prism
//! (intensity peaks) next to where Snell's law says the refracted and reflected rays cross it.
//!
//! `cargo run --release -p wavesmith-core --example prism_check -- [angle_deg] [beam_y]`

use wavesmith_core::light::{Color, Material};
use wavesmith_core::tools::{prism_vertices, V2};
use wavesmith_core::{Item, Level, Session, SPONGE};

const W: f32 = 900.0;
const H: f32 = 700.0;
const CENTER: V2 = [450.0, 350.0];
const RADIUS: f32 = 300.0;

fn main() {
    let mut args = std::env::args().skip(1);
    let angle_deg: f32 = args.next().map_or(0.0, |s| s.parse().unwrap());
    let beam_y: f32 = args.next().map_or(330.0, |s| s.parse().unwrap());
    let material = Material::Flint;
    let size = [220.0, 220.0];
    let angle = angle_deg.to_radians();
    let json = format!(
        r#"{{
        "id": "prism-check", "name": "Prism check", "chapter": 0,
        "grid": {{ "width": {W}, "height": {H} }},
        "medium": {{ "c": 60, "damping": 0.0, "light": true }},
        "sources": [{{ "kind": "beam", "pos": [20, {beam_y}], "angle": 0, "width": 24 }}],
        "goals": [{{ "kind": "focus", "pos": [5, 5], "radius": 2, "threshold": 100, "hold": 1 }}],
        "inventory": {{ "prism": {{ "count": 1, "cost": 1 }} }},
        "budget": 9, "par": {{ "cost": 0, "energy": 0 }}, "timeLimit": 600
    }}"#
    );
    let level = Level::from_json(&json).unwrap();
    let mut s = Session::new(level).unwrap();
    s.set_placements(vec![Item::Prism {
        pos: CENTER,
        size,
        angle,
        material,
    }])
    .unwrap();
    s.step(120 * 30);
    let nx = s.nx();
    let img = s.light_image().to_vec();
    let sample = |p: V2, ch: usize| -> f32 {
        // Bilinear sample of intensity at a play-area point.
        let gx = p[0] + SPONGE as f32 - 0.5;
        let gy = p[1] + SPONGE as f32 - 0.5;
        let (x0, y0) = (gx.floor() as usize, gy.floor() as usize);
        let (fx, fy) = (gx - x0 as f32, gy - y0 as f32);
        let at = |x: usize, y: usize| img[(y * nx + x) * 4 + ch];
        at(x0, y0) * (1.0 - fx) * (1.0 - fy)
            + at(x0 + 1, y0) * fx * (1.0 - fy)
            + at(x0, y0 + 1) * (1.0 - fx) * fy
            + at(x0 + 1, y0 + 1) * fx * fy
    };
    let verts = prism_vertices(CENTER, size, angle);
    println!("prism angle {angle_deg}°, beam y {beam_y}, flint, vertices {verts:?}");
    for color in Color::ALL {
        let ch = color.index();
        let n = material.indices()[ch];
        // Intensity around the circle, 0.5° steps (polar angle, y down).
        let scan: Vec<(f32, f32)> = (0..720)
            .map(|k| {
                let th = (k as f32 * 0.5 - 180.0).to_radians();
                let p = [CENTER[0] + RADIUS * th.cos(), CENTER[1] + RADIUS * th.sin()];
                let inside = p[0] > 1.0 && p[0] < W - 1.0 && p[1] > 1.0 && p[1] < H - 1.0;
                (
                    k as f32 * 0.5 - 180.0,
                    if inside { sample(p, ch) } else { 0.0 },
                )
            })
            .collect();
        let peak = scan.iter().map(|v| v.1).fold(0.0, f32::max);
        let mut peaks = Vec::new();
        for i in 1..scan.len() - 1 {
            let v = scan[i].1;
            if v > 0.08 * peak && v >= scan[i - 1].1 && v > scan[i + 1].1 {
                peaks.push((scan[i].0, v / peak));
            }
        }
        // Ignore the incoming beam where it crosses the circle on the left.
        let rays = trace(verts, [20.0, beam_y], [1.0, 0.0], n);
        print!("{color:?} (n {n}): measured peaks");
        for (a, v) in &peaks {
            print!(" {a:+.1}°({v:.2})");
        }
        println!();
        for (label, o, d) in rays {
            if let Some(th) = circle_hit(o, d) {
                println!(
                    "    Snell {label:<26} crosses at {th:+.1}°, heading {:+.1}°",
                    d[1].atan2(d[0]).to_degrees()
                );
            }
        }
    }
}

fn sub(a: V2, b: V2) -> V2 {
    [a[0] - b[0], a[1] - b[1]]
}
fn dot(a: V2, b: V2) -> f32 {
    a[0] * b[0] + a[1] * b[1]
}
fn cross(a: V2, b: V2) -> f32 {
    a[0] * b[1] - a[1] * b[0]
}

/// Where a ray from `o` along `d` leaves the circle, as a polar angle in degrees.
fn circle_hit(o: V2, d: V2) -> Option<f32> {
    let f = sub(o, CENTER);
    let b = dot(f, d);
    let c = dot(f, f) - RADIUS * RADIUS;
    let disc = b * b - c;
    if disc < 0.0 {
        return None;
    }
    let t = -b + disc.sqrt();
    let p = [o[0] + t * d[0], o[1] + t * d[1]];
    Some((p[1] - CENTER[1]).atan2(p[0] - CENTER[0]).to_degrees())
}

/// Traces a ray through the prism: returns the external reflection off the first face, every
/// ray that leaves the glass by refraction, and notes total internal reflections.
fn trace(verts: [V2; 3], o: V2, d: V2, n: f32) -> Vec<(String, V2, V2)> {
    let mut out = Vec::new();
    let hit = |o: V2, d: V2| -> Option<(f32, V2)> {
        let mut best: Option<(f32, V2)> = None;
        for i in 0..3 {
            let (a, b) = (verts[i], verts[(i + 1) % 3]);
            let e = sub(b, a);
            let den = cross(d, e);
            if den.abs() < 1e-9 {
                continue;
            }
            let t = cross(sub(a, o), e) / den;
            let u = cross(sub(a, o), d) / den;
            if t > 1e-3 && (0.0..=1.0).contains(&u) && best.is_none_or(|b| t < b.0) {
                let l = dot(e, e).sqrt();
                best = Some((t, [-e[1] / l, e[0] / l]));
            }
        }
        best
    };
    let Some((t, mut nrm)) = hit(o, d) else {
        out.push(("misses the prism".into(), o, d));
        return out;
    };
    let p = [o[0] + t * d[0], o[1] + t * d[1]];
    if dot(nrm, d) > 0.0 {
        nrm = [-nrm[0], -nrm[1]];
    }
    let refl = |d: V2, nrm: V2| {
        let k = 2.0 * dot(d, nrm);
        [d[0] - k * nrm[0], d[1] - k * nrm[1]]
    };
    // Snell with eta = n1/n2; `nrm` faces the incoming ray.
    let refract = |d: V2, nrm: V2, eta: f32| -> Option<V2> {
        let ci = -dot(d, nrm);
        let k = 1.0 - eta * eta * (1.0 - ci * ci);
        if k < 0.0 {
            return None;
        }
        let a = eta * ci - k.sqrt();
        Some([eta * d[0] + a * nrm[0], eta * d[1] + a * nrm[1]])
    };
    out.push(("reflection off entry face".into(), p, refl(d, nrm)));
    let mut d = refract(d, nrm, 1.0 / n).unwrap();
    let mut o = p;
    for bounce in 0..6 {
        let Some((t, mut nrm)) = hit(o, d) else { break };
        let p = [o[0] + t * d[0], o[1] + t * d[1]];
        if dot(nrm, d) > 0.0 {
            nrm = [-nrm[0], -nrm[1]];
        }
        match refract(d, nrm, n) {
            Some(e) => {
                out.push((format!("refracted out (bounce {bounce})"), p, e));
                // Follow the weaker internal reflection only for the first exit.
                if bounce > 0 {
                    break;
                }
                d = refl(d, nrm);
            }
            None => {
                out.push((format!("TIR at bounce {bounce}"), p, refl(d, nrm)));
                d = refl(d, nrm);
            }
        }
        o = p;
    }
    out
}
