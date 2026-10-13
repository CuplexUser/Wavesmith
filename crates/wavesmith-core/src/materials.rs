//! Rasterizes a level's medium, sponge, and pieces into solver material fields, plus a compact
//! per-cell overlay for the renderer.
//!
//! The overlay is RGBA8, four bytes per cell, so the GPU can filter it linearly:
//! - R: signed distance to the nearest fixed wall (the level's own), mapped from
//!   `±OVERLAY_SDF_RANGE` cells to `0..=255` (the surface sits at 127.5). Drawing the wall where
//!   this crosses zero gives smooth, anti-aliased edges that follow the true geometry instead
//!   of the cell grid.
//! - G: absorber coverage, 0..=255 (the absorber's edge is at 50%).
//! - B: lens or glass strength, 255 for the slowest allowed medium.
//! - A: like R, for the player's walls and reflectors, so they can be drawn differently.

use crate::level::Level;
use crate::light::SOUND_CHANNEL;
use crate::solver::Materials;
use crate::tools::{ellipse_rho, Item, Medium, V2};
use crate::SPONGE;

/// Bytes per cell in the overlay.
pub const OVERLAY_CHANNELS: usize = 4;
/// Wall distances are clamped to this many cells on either side of the surface.
pub const OVERLAY_SDF_RANGE: f32 = 4.0;

/// Target reflection of the sponge layer for a wave hitting it head-on.
const SPONGE_REFLECTION: f32 = 1e-4;

/// Solver grid dimensions for a level: the play area plus the sponge on every side.
pub fn grid_dims(level: &Level) -> (usize, usize) {
    (
        level.grid.width + 2 * SPONGE,
        level.grid.height + 2 * SPONGE,
    )
}

pub struct Rasterized {
    /// One set of materials per channel (one for sound, red/green/blue for light). Walls and
    /// damping are shared; wave speed differs in dispersive glass.
    pub materials: Vec<Materials>,
    pub overlay: Vec<u8>,
}

fn smoothstep(e0: f32, e1: f32, x: f32) -> f32 {
    let t = ((x - e0) / (e1 - e0)).clamp(0.0, 1.0);
    t * t * (3.0 - 2.0 * t)
}

/// Calls `f(index, play_point)` for every interior cell whose center lies in `[lo, hi]`.
fn for_cells(nx: usize, ny: usize, lo: V2, hi: V2, mut f: impl FnMut(usize, V2)) {
    let pad = SPONGE as f32;
    let x0 = ((lo[0] + pad).floor().max(1.0)) as usize;
    let y0 = ((lo[1] + pad).floor().max(1.0)) as usize;
    let x1 = ((hi[0] + pad).ceil().max(0.0) as usize).min(nx - 2);
    let y1 = ((hi[1] + pad).ceil().max(0.0) as usize).min(ny - 2);
    for y in y0..=y1 {
        for x in x0..=x1 {
            f(y * nx + x, [x as f32 + 0.5 - pad, y as f32 + 0.5 - pad]);
        }
    }
}

pub fn rasterize(level: &Level, placed: &[Item]) -> Rasterized {
    let (nx, ny) = grid_dims(level);
    let c0 = level.medium.c;
    let mut m = Materials::uniform(nx, ny, c0, level.medium.damping);
    let mut absorb = vec![0.0f32; nx * ny];
    let channels = level.channels();
    let mut c2 = vec![vec![c0 * c0; nx * ny]; channels];
    // Distance fields for fixed and player walls, drawn separately.
    let mut wall_sdf = [
        vec![OVERLAY_SDF_RANGE; nx * ny],
        vec![OVERLAY_SDF_RANGE; nx * ny],
    ];

    // Graded sponge: γ(d) = γmax·(d/L)² with γmax chosen for the target reflection.
    let l = SPONGE as f32;
    let gmax = 3.0 * c0 / (2.0 * l) * (1.0 / SPONGE_REFLECTION).ln();
    let (w, h) = (level.grid.width as f32, level.grid.height as f32);
    for y in 0..ny {
        for x in 0..nx {
            let px = x as f32 + 0.5 - l;
            let py = y as f32 + 0.5 - l;
            let dx = (-px).max(px - w).max(0.0);
            let dy = (-py).max(py - h).max(0.0);
            let d = dx.max(dy).min(l) / l;
            m.gamma[y * nx + x] += gmax * d * d;
        }
    }

    let n_fixed = level.fixed.len();
    for (k, item) in level.fixed.iter().chain(placed).enumerate() {
        let (lo, hi) = item.bounds();
        let sdf = &mut wall_sdf[usize::from(k >= n_fixed)];
        match *item {
            Item::Wall { .. } | Item::Reflector { .. } => {
                let r = OVERLAY_SDF_RANGE;
                let (lo, hi) = ([lo[0] - r, lo[1] - r], [hi[0] + r, hi[1] + r]);
                for_cells(nx, ny, lo, hi, |i, p| {
                    let d = item.distance(p);
                    if d <= 0.0 {
                        m.wall[i] = 1;
                    }
                    sdf[i] = sdf[i].min(d);
                });
            }
            Item::Absorber { strength, .. } => {
                for_cells(nx, ny, lo, hi, |i, p| {
                    // A soft three-cell edge keeps the absorber itself from reflecting much.
                    let cover = smoothstep(1.5, -1.5, item.distance(p));
                    m.gamma[i] += strength * cover;
                    absorb[i] = absorb[i].max(cover);
                });
            }
            Item::Lens { .. } | Item::Prism { .. } | Item::Slab { .. } => {
                let medium = item.medium().expect("transparent pieces have a medium");
                let cover_at = |p: V2| match *item {
                    Item::Lens {
                        pos, radii, angle, ..
                    } => {
                        let edge = 1.5 / radii[0].min(radii[1]);
                        smoothstep(1.0 + edge, 1.0 - edge, ellipse_rho(p, pos, radii, angle))
                    }
                    _ => smoothstep(1.0, -1.0, item.distance(p)),
                };
                for_cells(nx, ny, lo, hi, |i, p| {
                    let cover = cover_at(p);
                    if cover <= 0.0 {
                        return;
                    }
                    for (ch, c2) in c2.iter_mut().enumerate() {
                        let ratio = match medium {
                            Medium::Ratio(r) => r,
                            Medium::Material(mat) => mat.speed_ratio(ch, channels),
                        };
                        let r = 1.0 + (ratio - 1.0) * cover;
                        c2[i] = c2[i].min(c0 * c0 * r * r);
                    }
                });
            }
            Item::Resonator { .. } | Item::Emitter { .. } => {}
        }
    }

    // Overlay.
    let unit = |v: f32| (v.clamp(0.0, 1.0) * 255.0).round() as u8;
    let mut overlay = vec![0u8; nx * ny * OVERLAY_CHANNELS];
    for (i, px) in overlay
        .as_chunks_mut::<OVERLAY_CHANNELS>()
        .0
        .iter_mut()
        .enumerate()
    {
        let shown = if channels == 3 { SOUND_CHANNEL } else { 0 };
        let slow = 1.0 - (c2[shown][i] / (c0 * c0)).sqrt();
        let dist = |d: f32| unit((d + OVERLAY_SDF_RANGE) / (2.0 * OVERLAY_SDF_RANGE));
        px[0] = dist(wall_sdf[0][i]);
        px[1] = unit(absorb[i]);
        px[2] = unit(slow / 0.75);
        px[3] = dist(wall_sdf[1][i]);
    }
    // The outer ring is the fixed boundary.
    for x in 0..nx {
        m.wall[x] = 1;
        m.wall[(ny - 1) * nx + x] = 1;
    }
    for y in 0..ny {
        m.wall[y * nx] = 1;
        m.wall[y * nx + nx - 1] = 1;
    }
    let materials = c2
        .into_iter()
        .map(|c2| Materials { c2, ..m.clone() })
        .collect();
    Rasterized { materials, overlay }
}
