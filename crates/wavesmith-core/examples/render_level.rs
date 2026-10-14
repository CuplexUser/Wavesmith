//! Renders a level to a PPM image roughly the way the web shader colors it, with piece
//! outlines, for checking designs without a browser. Light levels show the color envelopes;
//! sound levels show the signed field (warm crests, cool troughs).
//!
//! `cargo run --release -p wavesmith-core --example render_level -- <level.json> [solution.json|-] [seconds] [out.ppm]`

use std::io::Write;

use wavesmith_core::{Item, Level, Session, SPONGE, STEPS_PER_SECOND};

fn main() {
    let mut args = std::env::args().skip(1);
    let path = args.next().expect("level path");
    let solution = args.next().filter(|s| s != "-");
    let secs: f32 = args.next().map_or(12.0, |s| s.parse().expect("seconds"));
    let out = args.next().unwrap_or_else(|| "level.ppm".into());
    let level =
        Level::from_json(&std::fs::read_to_string(&path).expect("read level")).expect("level");
    let pieces: Vec<Item> = solution
        .map(|p| {
            let v: serde_json::Value =
                serde_json::from_str(&std::fs::read_to_string(p).expect("read solution")).unwrap();
            serde_json::from_value(v["pieces"].clone()).expect("pieces")
        })
        .unwrap_or_default();
    let (w, h) = (level.grid.width, level.grid.height);
    let items: Vec<Item> = level.fixed.iter().chain(&pieces).cloned().collect();
    let light = level.medium.light;
    let goals: Vec<([f32; 2], f32)> = level.goals.iter().flat_map(|g| g.zones()).collect();
    let sources: Vec<[f32; 2]> = level.sources.iter().flat_map(|s| s.points()).collect();
    let mut s = Session::new(level).expect("session");
    s.set_placements(pieces).expect("valid pieces");
    s.step((STEPS_PER_SECOND as f32 * secs) as u32);
    let nx = s.nx();
    let img = if light {
        s.light_image().to_vec()
    } else {
        s.field().to_vec()
    };
    let gain = 1.6f32;
    let mut buf = Vec::with_capacity(w * h * 3);
    for y in 0..h {
        for x in 0..w {
            let i = (y + SPONGE) * nx + x + SPONGE;
            let p = [x as f32 + 0.5, y as f32 + 0.5];
            let mut c = if light {
                light_color(&img[i * 4..i * 4 + 4], gain)
            } else {
                sound_color(img[i], gain)
            };
            for item in &items {
                let d = item.distance(p);
                if item.is_obstacle() && d <= 0.0 {
                    c = [0.55, 0.6, 0.65];
                } else if d.abs() < 0.6 {
                    c = [0.85, 0.85, 0.85];
                }
            }
            for &(g, r) in &goals {
                let d = ((p[0] - g[0]).powi(2) + (p[1] - g[1]).powi(2)).sqrt();
                if (d - r).abs() < 0.6 {
                    c = [1.0, 0.85, 0.2];
                }
            }
            for &q in &sources {
                if ((p[0] - q[0]).powi(2) + (p[1] - q[1]).powi(2)).sqrt() < 2.0 {
                    c = [1.0, 1.0, 1.0];
                }
            }
            buf.extend(c.map(|v| (v.clamp(0.0, 1.0) * 255.0) as u8));
        }
    }
    let mut f = std::fs::File::create(&out).expect("create output");
    write!(f, "P6\n{w} {h}\n255\n").unwrap();
    f.write_all(&buf).unwrap();
    println!("wrote {out}");
}

fn sound_color(u: f32, gain: f32) -> [f32; 3] {
    let x = u * gain;
    let s = (x.abs() / (1.0 + x.abs())).powf(0.9);
    let bg = [0.027, 0.043, 0.082];
    let hue = if x >= 0.0 {
        [1.0, 0.62, 0.24]
    } else {
        [0.22, 0.72, 1.0]
    };
    [0, 1, 2].map(|k| bg[k] + (hue[k] - bg[k]) * s)
}

fn light_color(v: &[f32], gain: f32) -> [f32; 3] {
    let (r, g, b) = (
        v[0].max(0.0) * gain,
        v[1].max(0.0) * gain,
        v[2].max(0.0) * gain,
    );
    let c = [
        r + 0.10 * g + 0.14 * b,
        0.13 * r + g + 0.30 * b,
        0.08 * r + 0.24 * g + b,
    ];
    let bg = [0.010, 0.013, 0.028];
    [0, 1, 2].map(|k| bg[k] + (1.0 - (-c[k] * 1.5).exp()))
}
