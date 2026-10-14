//! Placeable pieces and the 2D geometry used to rasterize and validate them.
//!
//! Positions are in play-area cell coordinates: `(0, 0)` is the top-left corner of the play area
//! and the center of cell `(i, j)` is `(i + 0.5, j + 0.5)`.

use serde::{Deserialize, Serialize};

use crate::light::Material;

pub type V2 = [f32; 2];

#[inline]
pub fn sub(a: V2, b: V2) -> V2 {
    [a[0] - b[0], a[1] - b[1]]
}
#[inline]
pub fn add(a: V2, b: V2) -> V2 {
    [a[0] + b[0], a[1] + b[1]]
}
#[inline]
pub fn scale(a: V2, s: f32) -> V2 {
    [a[0] * s, a[1] * s]
}
#[inline]
pub fn dot(a: V2, b: V2) -> f32 {
    a[0] * b[0] + a[1] * b[1]
}
#[inline]
pub fn len(a: V2) -> f32 {
    dot(a, a).sqrt()
}
#[inline]
fn rotate(p: V2, angle: f32) -> V2 {
    let (s, c) = (libm::sinf(angle), libm::cosf(angle));
    [c * p[0] - s * p[1], s * p[0] + c * p[1]]
}

/// Distance from `p` to the segment `a–b`.
pub fn seg_dist(p: V2, a: V2, b: V2) -> f32 {
    let ab = sub(b, a);
    let ap = sub(p, a);
    let l2 = dot(ab, ab);
    let t = if l2 > 0.0 {
        (dot(ap, ab) / l2).clamp(0.0, 1.0)
    } else {
        0.0
    };
    len(sub(ap, scale(ab, t)))
}

/// A circular arc through `a` and `b` whose midpoint sits `bulge` cells off the chord, measured
/// along the chord's left normal (`(-dy, dx)` for `d = b − a`).
#[derive(Debug, Clone, Copy)]
pub struct Arc {
    pub center: V2,
    pub radius: f32,
    /// Unit vector from the center toward the arc's apex.
    pub apex_dir: V2,
    /// Cosine of the arc's half-angle.
    pub cos_half: f32,
    pub apex: V2,
}

/// Bulges smaller than this are treated as straight segments.
const MIN_BULGE: f32 = 0.25;

pub fn arc_from(a: V2, b: V2, bulge: f32) -> Option<Arc> {
    let ab = sub(b, a);
    let chord = len(ab);
    if bulge.abs() < MIN_BULGE || chord < 1e-3 {
        return None;
    }
    let half = 0.5 * chord;
    let n = [-ab[1] / chord, ab[0] / chord];
    let mid = scale(add(a, b), 0.5);
    let r = (half * half + bulge * bulge) / (2.0 * bulge.abs());
    let apex = add(mid, scale(n, bulge));
    let dir = scale(n, bulge.signum());
    let center = sub(apex, scale(dir, r));
    let ca = sub(a, center);
    let cos_half = dot(ca, dir) / len(ca);
    Some(Arc {
        center,
        radius: r,
        apex_dir: dir,
        cos_half,
        apex,
    })
}

/// Distance from `p` to the arc (or segment) through `a` and `b` with the given bulge.
pub fn arc_dist(p: V2, a: V2, b: V2, bulge: f32) -> f32 {
    match arc_from(a, b, bulge) {
        None => seg_dist(p, a, b),
        Some(arc) => {
            let d = sub(p, arc.center);
            let dl = len(d);
            if dl > 1e-6 && dot(d, arc.apex_dir) / dl >= arc.cos_half {
                (dl - arc.radius).abs()
            } else {
                len(sub(p, a)).min(len(sub(p, b)))
            }
        }
    }
}

/// Signed distance to a box centered at `pos` with full `size`, rotated by `angle` radians.
pub fn box_sdf(p: V2, pos: V2, size: V2, angle: f32) -> f32 {
    let q = rotate(sub(p, pos), -angle);
    let dx = q[0].abs() - 0.5 * size[0];
    let dy = q[1].abs() - 0.5 * size[1];
    let outside = len([dx.max(0.0), dy.max(0.0)]);
    let inside = dx.max(dy).min(0.0);
    outside + inside
}

/// Signed distance to a closed polygon (any winding), negative inside.
pub fn poly_sdf(p: V2, verts: &[V2]) -> f32 {
    let n = verts.len();
    let mut d = dot(sub(p, verts[0]), sub(p, verts[0]));
    let mut sign = 1.0f32;
    let mut j = n - 1;
    for i in 0..n {
        let (vi, vj) = (verts[i], verts[j]);
        let e = sub(vj, vi);
        let w = sub(p, vi);
        let t = (dot(w, e) / dot(e, e)).clamp(0.0, 1.0);
        let b = sub(w, scale(e, t));
        d = d.min(dot(b, b));
        // Crossing test for inside/outside.
        let c = [p[1] >= vi[1], p[1] < vj[1], e[0] * w[1] > e[1] * w[0]];
        if (c[0] && c[1] && c[2]) || (!c[0] && !c[1] && !c[2]) {
            sign = -sign;
        }
        j = i;
    }
    sign * d.sqrt()
}

/// Corners of a triangular prism with base `size[0]` and height `size[1]`, centered on its
/// centroid at `pos` and rotated by `angle`. Unrotated, the apex points up (−y).
pub fn prism_vertices(pos: V2, size: V2, angle: f32) -> [V2; 3] {
    let (w, h) = (size[0], size[1]);
    [
        [-0.5 * w, h / 3.0],
        [0.5 * w, h / 3.0],
        [0.0, -2.0 * h / 3.0],
    ]
    .map(|v| add(pos, rotate(v, angle)))
}

/// Normalized elliptical radius: < 1 inside, 1 on the boundary.
pub fn ellipse_rho(p: V2, pos: V2, radii: V2, angle: f32) -> f32 {
    let q = rotate(sub(p, pos), -angle);
    let x = q[0] / radii[0];
    let y = q[1] / radii[1];
    (x * x + y * y).sqrt()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ToolKind {
    Wall,
    Reflector,
    Absorber,
    Lens,
    Prism,
    Slab,
    Resonator,
    Emitter,
}

impl ToolKind {
    pub const ALL: [ToolKind; 8] = [
        ToolKind::Wall,
        ToolKind::Reflector,
        ToolKind::Absorber,
        ToolKind::Lens,
        ToolKind::Prism,
        ToolKind::Slab,
        ToolKind::Resonator,
        ToolKind::Emitter,
    ];
}

/// How a transparent piece slows waves.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Medium {
    /// The same speed ratio for every channel.
    Ratio(f32),
    /// A dispersive material with a refractive index per color.
    Material(Material),
}

pub(crate) fn default_thickness() -> f32 {
    3.0
}
pub(crate) fn default_strength() -> f32 {
    40.0
}
pub(crate) fn default_q() -> f32 {
    25.0
}
pub(crate) fn default_amp() -> f32 {
    1.0
}
pub(crate) fn default_ratio() -> f32 {
    1.0
}
pub(crate) fn is_still(v: &V2) -> bool {
    v[0] == 0.0 && v[1] == 0.0
}

/// Fastest a moving source may travel, in cells per second: well below the wave speed, so
/// sources never outrun their own sound.
pub const MAX_SOURCE_SPEED: f32 = 0.6 * crate::MAX_SPEED;

pub(crate) fn default_material() -> Material {
    Material::Crown
}

/// A piece on the board, either fixed by the level or placed by the player.
#[derive(Debug, Clone, PartialEq, Serialize)]
// Deserialized by hand in `crate::json`, which keeps the WebAssembly build small.
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum Item {
    /// Straight hard wall.
    Wall {
        a: V2,
        b: V2,
        #[serde(default = "default_thickness")]
        thickness: f32,
    },
    /// Hard wall bent into a circular arc, for focusing.
    Reflector {
        a: V2,
        b: V2,
        #[serde(default)]
        bulge: f32,
        #[serde(default = "default_thickness")]
        thickness: f32,
    },
    /// Rotated box that damps waves passing through it.
    Absorber {
        pos: V2,
        size: V2,
        #[serde(default)]
        angle: f32,
        #[serde(default = "default_strength")]
        strength: f32,
    },
    /// Ellipse of slower medium: either a fixed speed `ratio` relative to the background, or a
    /// glass `material` whose speed depends on color.
    Lens {
        pos: V2,
        radii: V2,
        #[serde(default)]
        angle: f32,
        #[serde(default = "default_ratio")]
        ratio: f32,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        material: Option<Material>,
    },
    /// Triangular glass prism; `size` is `[base, height]`.
    Prism {
        pos: V2,
        size: V2,
        #[serde(default)]
        angle: f32,
        #[serde(default = "default_material")]
        material: Material,
    },
    /// Rectangular glass block.
    Slab {
        pos: V2,
        size: V2,
        #[serde(default)]
        angle: f32,
        #[serde(default = "default_material")]
        material: Material,
    },
    /// Damped oscillator that stores energy near its natural frequency and reradiates it.
    Resonator {
        pos: V2,
        freq: f32,
        #[serde(default = "default_q")]
        q: f32,
    },
    /// Point source with player-set frequency, phase, and strength. With a velocity it travels
    /// in a straight line from `pos` until it nears the edge of the board (see
    /// [`crate::source::Motion`]), which shifts its pitch by the Doppler effect.
    Emitter {
        pos: V2,
        freq: f32,
        #[serde(default = "default_amp")]
        amp: f32,
        #[serde(default)]
        phase: f32,
        #[serde(default, skip_serializing_if = "is_still")]
        vel: V2,
    },
}

impl Item {
    pub fn kind(&self) -> ToolKind {
        match self {
            Item::Wall { .. } => ToolKind::Wall,
            Item::Reflector { .. } => ToolKind::Reflector,
            Item::Absorber { .. } => ToolKind::Absorber,
            Item::Lens { .. } => ToolKind::Lens,
            Item::Prism { .. } => ToolKind::Prism,
            Item::Slab { .. } => ToolKind::Slab,
            Item::Resonator { .. } => ToolKind::Resonator,
            Item::Emitter { .. } => ToolKind::Emitter,
        }
    }

    /// Whether the piece blocks or swallows waves (and so may not cover sources or goals).
    pub fn is_obstacle(&self) -> bool {
        matches!(
            self,
            Item::Wall { .. } | Item::Reflector { .. } | Item::Absorber { .. }
        )
    }

    /// Distance from `p` to the piece's surface; zero or negative inside it.
    pub fn distance(&self, p: V2) -> f32 {
        match *self {
            Item::Wall { a, b, thickness } => seg_dist(p, a, b) - 0.5 * thickness,
            Item::Reflector {
                a,
                b,
                bulge,
                thickness,
            } => arc_dist(p, a, b, bulge) - 0.5 * thickness,
            Item::Absorber {
                pos, size, angle, ..
            } => box_sdf(p, pos, size, angle),
            Item::Lens {
                pos, radii, angle, ..
            } => (ellipse_rho(p, pos, radii, angle) - 1.0) * radii[0].min(radii[1]),
            Item::Prism {
                pos, size, angle, ..
            } => poly_sdf(p, &prism_vertices(pos, size, angle)),
            Item::Slab {
                pos, size, angle, ..
            } => box_sdf(p, pos, size, angle),
            Item::Resonator { pos, .. } | Item::Emitter { pos, .. } => len(sub(p, pos)),
        }
    }

    /// For transparent pieces, how they slow waves.
    pub fn medium(&self) -> Option<Medium> {
        match *self {
            Item::Lens {
                ratio, material, ..
            } => Some(material.map_or(Medium::Ratio(ratio), Medium::Material)),
            Item::Prism { material, .. } | Item::Slab { material, .. } => {
                Some(Medium::Material(material))
            }
            _ => None,
        }
    }

    /// Largest span of the piece in cells, compared against inventory size caps.
    pub fn size(&self) -> f32 {
        match *self {
            Item::Wall { a, b, .. } | Item::Reflector { a, b, .. } => len(sub(b, a)),
            Item::Absorber { size, .. } => size[0].max(size[1]),
            Item::Lens { radii, .. } => 2.0 * radii[0].max(radii[1]),
            Item::Prism { size, .. } | Item::Slab { size, .. } => size[0].max(size[1]),
            Item::Resonator { .. } | Item::Emitter { .. } => 0.0,
        }
    }

    /// Axis-aligned bounds `(min, max)` that contain the whole piece.
    pub fn bounds(&self) -> (V2, V2) {
        fn span(points: &[V2], pad: f32) -> (V2, V2) {
            let mut lo = [f32::INFINITY; 2];
            let mut hi = [f32::NEG_INFINITY; 2];
            for p in points {
                for k in 0..2 {
                    lo[k] = lo[k].min(p[k]);
                    hi[k] = hi[k].max(p[k]);
                }
            }
            ([lo[0] - pad, lo[1] - pad], [hi[0] + pad, hi[1] + pad])
        }
        match *self {
            Item::Wall { a, b, thickness } => span(&[a, b], thickness),
            Item::Reflector {
                a,
                b,
                bulge,
                thickness,
            } => match arc_from(a, b, bulge) {
                Some(arc) => span(&[a, b, arc.apex], thickness),
                None => span(&[a, b], thickness),
            },
            Item::Absorber { pos, size, .. } => span(&[pos], 0.5 * len(size) + 2.0),
            Item::Lens { pos, radii, .. } => span(&[pos], radii[0].max(radii[1]) + 2.0),
            Item::Prism { pos, size, .. } | Item::Slab { pos, size, .. } => {
                span(&[pos], len(size) + 2.0)
            }
            Item::Resonator { pos, .. } | Item::Emitter { pos, .. } => span(&[pos], 1.0),
        }
    }

    /// The points a player drags, used for bounds checks.
    pub fn control_points(&self) -> Vec<V2> {
        match *self {
            Item::Wall { a, b, .. } => vec![a, b],
            Item::Reflector { a, b, bulge, .. } => match arc_from(a, b, bulge) {
                Some(arc) => vec![a, b, arc.apex],
                None => vec![a, b],
            },
            Item::Absorber { pos, .. }
            | Item::Lens { pos, .. }
            | Item::Prism { pos, .. }
            | Item::Slab { pos, .. }
            | Item::Resonator { pos, .. }
            | Item::Emitter { pos, .. } => vec![pos],
        }
    }

    /// Checks shape parameters are finite and inside the ranges the game allows.
    pub fn check_shape(&self) -> Result<(), String> {
        let finite = |v: &[f32]| v.iter().all(|x| x.is_finite());
        match *self {
            Item::Wall { a, b, thickness } => {
                if !finite(&[a[0], a[1], b[0], b[1], thickness]) {
                    return Err("wall has a non-finite coordinate".into());
                }
                let l = len(sub(b, a));
                if !(2.0..=400.0).contains(&l) {
                    return Err(format!("wall length {l:.1} is out of range"));
                }
                if !(1.0..=12.0).contains(&thickness) {
                    return Err("wall thickness is out of range".into());
                }
            }
            Item::Reflector {
                a,
                b,
                bulge,
                thickness,
            } => {
                if !finite(&[a[0], a[1], b[0], b[1], bulge, thickness]) {
                    return Err("reflector has a non-finite coordinate".into());
                }
                let l = len(sub(b, a));
                if !(4.0..=400.0).contains(&l) {
                    return Err(format!("reflector length {l:.1} is out of range"));
                }
                if bulge.abs() > 0.5 * l + 1e-3 {
                    return Err("reflector bends more than a half circle".into());
                }
                if !(1.0..=12.0).contains(&thickness) {
                    return Err("reflector thickness is out of range".into());
                }
            }
            Item::Absorber {
                pos,
                size,
                angle,
                strength,
            } => {
                if !finite(&[pos[0], pos[1], size[0], size[1], angle, strength]) {
                    return Err("absorber has a non-finite value".into());
                }
                if size[0] < 2.0 || size[1] < 2.0 || size[0] > 300.0 || size[1] > 300.0 {
                    return Err("absorber size is out of range".into());
                }
                if !(0.0..=200.0).contains(&strength) {
                    return Err("absorber strength is out of range".into());
                }
            }
            Item::Lens {
                pos,
                radii,
                angle,
                ratio,
                ..
            } => {
                if !finite(&[pos[0], pos[1], radii[0], radii[1], angle, ratio]) {
                    return Err("lens has a non-finite value".into());
                }
                if radii[0] < 3.0 || radii[1] < 3.0 || radii[0] > 150.0 || radii[1] > 150.0 {
                    return Err("lens size is out of range".into());
                }
                if !(0.25..=1.0).contains(&ratio) {
                    return Err("lens speed ratio must be between 0.25 and 1".into());
                }
            }
            Item::Prism {
                pos, size, angle, ..
            }
            | Item::Slab {
                pos, size, angle, ..
            } => {
                if !finite(&[pos[0], pos[1], size[0], size[1], angle]) {
                    return Err("glass piece has a non-finite value".into());
                }
                if size[0] < 4.0 || size[1] < 4.0 || size[0] > 300.0 || size[1] > 300.0 {
                    return Err("glass piece size is out of range".into());
                }
            }
            Item::Resonator { pos, freq, q } => {
                if !finite(&[pos[0], pos[1], freq, q]) {
                    return Err("resonator has a non-finite value".into());
                }
                if !(0.25..=10.0).contains(&freq) || !(1.0..=200.0).contains(&q) {
                    return Err("resonator tuning is out of range".into());
                }
            }
            Item::Emitter {
                pos,
                freq,
                amp,
                phase,
                vel,
            } => {
                if !finite(&[pos[0], pos[1], freq, amp, phase, vel[0], vel[1]]) {
                    return Err("emitter has a non-finite value".into());
                }
                if !(0.25..=10.0).contains(&freq) || !(0.0..=4.0).contains(&amp) {
                    return Err("emitter tuning is out of range".into());
                }
                if len(vel) > MAX_SOURCE_SPEED + 1e-3 {
                    return Err("emitter moves too fast".into());
                }
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn arc_passes_through_endpoints_and_apex() {
        let a = [0.0, 0.0];
        let b = [20.0, 0.0];
        let arc = arc_from(a, b, 5.0).unwrap();
        assert!((len(sub(a, arc.center)) - arc.radius).abs() < 1e-3);
        assert!((len(sub(b, arc.center)) - arc.radius).abs() < 1e-3);
        // Left normal of +x is +y.
        assert!((arc.apex[0] - 10.0).abs() < 1e-4 && (arc.apex[1] - 5.0).abs() < 1e-4);
        assert!(arc_dist(arc.apex, a, b, 5.0) < 1e-3);
        // The chord midpoint is off the arc by the bulge.
        assert!((arc_dist([10.0, 0.0], a, b, 5.0) - 5.0).abs() < 1e-3);
    }

    #[test]
    fn box_sdf_signs() {
        assert!(box_sdf([0.0, 0.0], [0.0, 0.0], [10.0, 4.0], 0.3) < 0.0);
        assert!((box_sdf([10.0, 0.0], [0.0, 0.0], [10.0, 4.0], 0.0) - 5.0).abs() < 1e-5);
    }

    #[test]
    fn items_round_trip_json() {
        let items = vec![
            Item::Wall {
                a: [1.0, 2.0],
                b: [3.0, 4.0],
                thickness: 3.0,
            },
            Item::Reflector {
                a: [1.0, 2.0],
                b: [30.0, 4.0],
                bulge: 4.0,
                thickness: 3.0,
            },
            Item::Emitter {
                pos: [5.0, 5.0],
                freq: 3.0,
                amp: 1.0,
                phase: 0.5,
                vel: [0.0, 0.0],
            },
        ];
        let s = serde_json::to_string(&items).unwrap();
        let back: Vec<Item> = serde_json::from_str(&s).unwrap();
        assert_eq!(items, back);
        let w: Item = serde_json::from_str(r#"{"kind":"wall","a":[0,0],"b":[10,0]}"#).unwrap();
        assert_eq!(
            w,
            Item::Wall {
                a: [0.0, 0.0],
                b: [10.0, 0.0],
                thickness: 3.0
            }
        );
    }
}
