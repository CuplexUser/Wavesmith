//! Rasterizes a level's medium, sponge, and pieces into solver material fields, plus a compact
//! per-cell overlay for the renderer.

use crate::level::Level;
use crate::solver::Materials;
use crate::tools::{ellipse_rho, Item, V2};
use crate::SPONGE;

/// Overlay byte for a wall cell.
pub const OVERLAY_WALL: u8 = 255;
/// Overlay bit set where an absorber dominates the cell.
pub const OVERLAY_ABSORBER: u8 = 0x40;
/// Overlay bits holding the lens strength `0..=63` (63 is the slowest allowed medium).
pub const OVERLAY_LENS_MASK: u8 = 0x3f;

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
    pub materials: Materials,
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

    for item in level.fixed.iter().chain(placed) {
        let (lo, hi) = item.bounds();
        match *item {
            Item::Wall { .. } | Item::Reflector { .. } => {
                for_cells(nx, ny, lo, hi, |i, p| {
                    if item.distance(p) <= 0.0 {
                        m.wall[i] = 1;
                    }
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
            Item::Lens {
                pos,
                radii,
                angle,
                ratio,
            } => {
                let edge = 1.5 / radii[0].min(radii[1]);
                for_cells(nx, ny, lo, hi, |i, p| {
                    let rho = ellipse_rho(p, pos, radii, angle);
                    let cover = smoothstep(1.0 + edge, 1.0 - edge, rho);
                    let r = 1.0 + (ratio - 1.0) * cover;
                    m.c2[i] = m.c2[i].min(c0 * c0 * r * r);
                });
            }
            Item::Resonator { .. } | Item::Emitter { .. } => {}
        }
    }

    // Overlay.
    let mut overlay = vec![0u8; nx * ny];
    for i in 0..nx * ny {
        overlay[i] = if m.wall[i] != 0 {
            OVERLAY_WALL
        } else {
            let slow = 1.0 - (m.c2[i] / (c0 * c0)).sqrt();
            let lens = ((slow / 0.75) * 63.0).round().clamp(0.0, 63.0) as u8;
            lens | if absorb[i] >= 0.5 {
                OVERLAY_ABSORBER
            } else {
                0
            }
        };
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
    Rasterized {
        materials: m,
        overlay,
    }
}
