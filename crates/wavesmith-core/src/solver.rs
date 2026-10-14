//! Finite-difference solver for the damped scalar wave equation
//! `u_tt = c(x)² ∇²u − γ(x) u_t + f(x, t)`.
//!
//! Second-order leapfrog in time, a 5-point or isotropic 9-point Laplacian in space, and a
//! semi-implicit damping term:
//! `u⁺ = [2u − (1 − γΔt/2)u⁻ + (cΔt)²∇²u + Δt² f] / (1 + γΔt/2)`.
//! The outermost ring of cells is a fixed `u = 0` boundary; wall cells are pinned to zero by
//! giving them a zero update coefficient.

use crate::{DT, MAX_SPEED};

#[derive(Debug, Clone, PartialEq)]
pub enum SolverError {
    /// Grid too small to hold an interior.
    BadSize { nx: usize, ny: usize },
    /// A cell's wave speed exceeds what the fixed timestep can integrate stably.
    Cfl { speed: f32, max: f32 },
    /// A material field has the wrong length or a non-finite value.
    BadMaterial(&'static str),
}

impl std::fmt::Display for SolverError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            SolverError::BadSize { nx, ny } => write!(f, "grid {nx}x{ny} is too small"),
            SolverError::Cfl { speed, max } => {
                write!(f, "wave speed {speed} exceeds the stable maximum {max}")
            }
            SolverError::BadMaterial(what) => write!(f, "invalid material field: {what}"),
        }
    }
}

impl std::error::Error for SolverError {}

/// Spatial discretization of the Laplacian.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Laplacian {
    /// The 5-point cross. Cheapest; waves run slightly faster along the diagonals than along
    /// the axes, which is invisible at the 20 cells per wavelength sound levels use.
    #[default]
    FivePoint,
    /// The isotropic 9-point stencil `⅔·cross + ⅙·corners − 10/3·center`. Its error is the
    /// same in every direction, so it can be corrected per frequency (see
    /// [`dispersion_corrected_c2`]); light levels need that for accurate refraction at 5–10
    /// cells per wavelength. Along an axis its symbol equals the 5-point one.
    Isotropic,
}

impl Laplacian {
    /// Fastest wave speed the fixed timestep integrates stably: `c·Δt ≤ 0.5` for the cross,
    /// the same margin applied to the 9-point stencil's larger limit (`(cΔt)²·16/3 ≤ 4`).
    pub fn max_speed(self) -> f32 {
        match self {
            Laplacian::FivePoint => MAX_SPEED,
            Laplacian::Isotropic => MAX_SPEED * 1.4,
        }
    }
}

/// The squared speed to give the isotropic scheme so that a wave of angular frequency `omega`
/// travels at `speed` on the grid: the discrete wavenumber then equals `omega / speed`, so
/// wavelengths, refraction (Snell's law), and critical angles come out right. Solves the
/// dispersion relation `sin(ωΔt/2)/(cΔt/2) = 2·sin(k/2)` along an axis, where the stencil is
/// exact enough to stand for every direction.
pub fn dispersion_corrected_c2(speed: f32, omega: f32) -> f32 {
    let k = omega / speed;
    let c = libm::sinf(0.5 * omega * DT) / (DT * libm::sinf(0.5 * k));
    c * c
}

/// Per-cell physical properties on the full solver grid (play area plus sponge).
#[derive(Debug, Clone)]
pub struct Materials {
    pub nx: usize,
    pub ny: usize,
    pub laplacian: Laplacian,
    /// Squared wave speed, cells²/s².
    pub c2: Vec<f32>,
    /// Damping rate γ, 1/s.
    pub gamma: Vec<f32>,
    /// Nonzero where a hard wall pins the field to zero.
    pub wall: Vec<u8>,
}

impl Materials {
    /// A homogeneous medium with no walls.
    pub fn uniform(nx: usize, ny: usize, c: f32, gamma: f32) -> Self {
        let n = nx * ny;
        Self {
            nx,
            ny,
            laplacian: Laplacian::FivePoint,
            c2: vec![c * c; n],
            gamma: vec![gamma; n],
            wall: vec![0; n],
        }
    }

    #[inline]
    pub fn idx(&self, x: usize, y: usize) -> usize {
        y * self.nx + x
    }
}

pub struct Solver {
    nx: usize,
    ny: usize,
    laplacian: Laplacian,
    prev: Vec<f32>,
    cur: Vec<f32>,
    next: Vec<f32>,
    c2: Vec<f32>,
    /// `(cΔt)²`
    k: Vec<f32>,
    /// `1 − γΔt/2`
    decay: Vec<f32>,
    /// `1 / (1 + γΔt/2)`, or 0 for wall cells.
    inv: Vec<f32>,
}

impl Solver {
    pub fn new(m: &Materials) -> Result<Self, SolverError> {
        let n = m.nx * m.ny;
        let mut s = Self {
            nx: m.nx,
            ny: m.ny,
            laplacian: m.laplacian,
            prev: vec![0.0; n],
            cur: vec![0.0; n],
            next: vec![0.0; n],
            c2: Vec::new(),
            k: Vec::new(),
            decay: Vec::new(),
            inv: Vec::new(),
        };
        s.set_materials(m)?;
        Ok(s)
    }

    /// Replaces the material coefficients, keeping the current field.
    pub fn set_materials(&mut self, m: &Materials) -> Result<(), SolverError> {
        if m.nx < 3 || m.ny < 3 {
            return Err(SolverError::BadSize { nx: m.nx, ny: m.ny });
        }
        let n = m.nx * m.ny;
        if m.c2.len() != n || m.gamma.len() != n || m.wall.len() != n {
            return Err(SolverError::BadMaterial("length mismatch"));
        }
        if m.nx != self.nx || m.ny != self.ny {
            return Err(SolverError::BadSize { nx: m.nx, ny: m.ny });
        }
        let max = m.laplacian.max_speed();
        let max2 = max * max;
        let dt2 = DT * DT;
        let mut k = Vec::with_capacity(n);
        let mut decay = Vec::with_capacity(n);
        let mut inv = Vec::with_capacity(n);
        for i in 0..n {
            let c2 = m.c2[i];
            let g = m.gamma[i];
            if !c2.is_finite() || c2 < 0.0 {
                return Err(SolverError::BadMaterial("wave speed"));
            }
            if !g.is_finite() || g < 0.0 {
                return Err(SolverError::BadMaterial("damping"));
            }
            if c2 > max2 * 1.000_001 {
                return Err(SolverError::Cfl {
                    speed: c2.sqrt(),
                    max,
                });
            }
            let b = 0.5 * g * DT;
            k.push(c2 * dt2);
            decay.push(1.0 - b);
            inv.push(if m.wall[i] != 0 { 0.0 } else { 1.0 / (1.0 + b) });
        }
        self.laplacian = m.laplacian;
        self.c2 = m.c2.clone();
        self.k = k;
        self.decay = decay;
        self.inv = inv;
        // Walls may have appeared where the field was nonzero.
        for i in 0..n {
            if self.inv[i] == 0.0 {
                self.cur[i] = 0.0;
                self.prev[i] = 0.0;
            }
        }
        Ok(())
    }

    pub fn reset(&mut self) {
        self.prev.fill(0.0);
        self.cur.fill(0.0);
        self.next.fill(0.0);
    }

    pub fn nx(&self) -> usize {
        self.nx
    }

    pub fn ny(&self) -> usize {
        self.ny
    }

    /// The field at the current time level.
    pub fn field(&self) -> &[f32] {
        &self.cur
    }

    /// The field one step earlier.
    pub fn prev_field(&self) -> &[f32] {
        &self.prev
    }

    pub fn laplacian(&self) -> Laplacian {
        self.laplacian
    }

    /// Per-cell update coefficients `((cΔt)², 1 − γΔt/2, 1/(1 + γΔt/2))`, for running the same
    /// scheme elsewhere (the WebGPU path).
    pub fn coefficients(&self) -> (&[f32], &[f32], &[f32]) {
        (&self.k, &self.decay, &self.inv)
    }

    /// Mutable access to both time levels, for setting initial conditions.
    pub fn fields_mut(&mut self) -> (&mut [f32], &mut [f32]) {
        (&mut self.cur, &mut self.prev)
    }

    /// Advances one step. `forces` lists `(cell, f)` source terms for this step. Returns the
    /// power delivered by the first `metered` forces, `Σ f·u_t / c²`, in the units of
    /// [`Solver::energy`].
    pub fn step(&mut self, forces: &[(usize, f32)], metered: usize) -> f64 {
        let nx = self.nx;
        let (p, c, n) = (&self.prev, &self.cur, &mut self.next);
        match self.laplacian {
            Laplacian::FivePoint => {
                for y in 1..self.ny - 1 {
                    let row = y * nx;
                    for x in 1..nx - 1 {
                        let i = row + x;
                        let lap = c[i - 1] + c[i + 1] + c[i - nx] + c[i + nx] - 4.0 * c[i];
                        n[i] = (2.0 * c[i] - self.decay[i] * p[i] + self.k[i] * lap) * self.inv[i];
                    }
                }
            }
            Laplacian::Isotropic => {
                // ⅔·cross + ⅙·corners − 10/3·center, written as ⅙·(3×3 block sum) + ½·cross
                // − 7/2·center. Row slices and 3-wide windows let the compiler drop bounds
                // checks and vectorize across cells.
                const SIXTH: f32 = 1.0 / 6.0;
                for y in 1..self.ny - 1 {
                    let row = y * nx;
                    let up = &c[row - nx..row];
                    let mid = &c[row..row + nx];
                    let dn = &c[row + nx..row + 2 * nx];
                    let inner = row + 1..row + nx - 1;
                    let cells = n[inner.clone()]
                        .iter_mut()
                        .zip(up.windows(3).zip(mid.windows(3)).zip(dn.windows(3)))
                        .zip(p[inner.clone()].iter().zip(&self.k[inner.clone()]))
                        .zip(self.decay[inner.clone()].iter().zip(&self.inv[inner]));
                    for (((out, ((u, m), d)), (&pv, &k)), (&decay, &inv)) in cells {
                        let center = m[1];
                        let cross = m[0] + m[2] + u[1] + d[1];
                        let block =
                            (u[0] + u[1] + u[2]) + (m[0] + center + m[2]) + (d[0] + d[1] + d[2]);
                        let lap = SIXTH * block + 0.5 * cross - 3.5 * center;
                        *out = (2.0 * center - decay * pv + k * lap) * inv;
                    }
                }
            }
        }
        let dt2 = DT * DT;
        let mut power = 0.0f64;
        for (j, &(i, f)) in forces.iter().enumerate() {
            n[i] += dt2 * f * self.inv[i];
            if j < metered && self.c2[i] > 0.0 {
                let ut = (n[i] - p[i]) / (2.0 * DT);
                power += f as f64 * ut as f64 / self.c2[i] as f64;
            }
        }
        // Rotate: prev ← cur, cur ← next, next ← old prev (scratch).
        std::mem::swap(&mut self.prev, &mut self.cur);
        std::mem::swap(&mut self.cur, &mut self.next);
        power
    }

    /// Discrete energy conserved by the undamped leapfrog scheme:
    /// `E = ½ Σ [ (1/c²)((u − u⁻)/Δt)² + ∇u · ∇u⁻ ]`.
    pub fn energy(&self) -> f64 {
        let nx = self.nx;
        let (u, p) = (&self.cur, &self.prev);
        let mut kinetic = 0.0f64;
        let mut potential = 0.0f64;
        for y in 0..self.ny {
            for x in 0..nx {
                let i = y * nx + x;
                if self.c2[i] > 0.0 {
                    let ut = ((u[i] - p[i]) / DT) as f64;
                    kinetic += ut * ut / self.c2[i] as f64;
                }
                if x + 1 < nx {
                    let du = (u[i + 1] - u[i]) as f64;
                    let dp = (p[i + 1] - p[i]) as f64;
                    potential += du * dp;
                }
                if y + 1 < self.ny {
                    let du = (u[i + nx] - u[i]) as f64;
                    let dp = (p[i + nx] - p[i]) as f64;
                    potential += du * dp;
                }
            }
        }
        0.5 * (kinetic + potential)
    }

    /// Largest absolute field value, or infinity if anything went non-finite.
    pub fn max_abs(&self) -> f32 {
        let mut m = 0.0f32;
        for &v in &self.cur {
            if !v.is_finite() {
                return f32::INFINITY;
            }
            m = m.max(v.abs());
        }
        m
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Discrete wavenumber of the isotropic scheme at angular frequency `omega` and squared
    /// speed `c2`, for a plane wave heading `theta` off the x axis.
    fn wavenumber(c2: f32, omega: f32, theta: f32) -> f32 {
        let lhs = (2.0 * (0.5 * omega * DT).sin()).powi(2) / (c2 * DT * DT);
        let symbol = |k: f32| {
            let (kx, ky) = (k * theta.cos(), k * theta.sin());
            let lap = (2.0 / 3.0) * (2.0 * kx.cos() + 2.0 * ky.cos())
                + (1.0 / 6.0) * 4.0 * kx.cos() * ky.cos()
                - 10.0 / 3.0;
            -lap
        };
        let (mut lo, mut hi) = (0.0f32, std::f32::consts::PI);
        for _ in 0..60 {
            let k = 0.5 * (lo + hi);
            if symbol(k) < lhs {
                lo = k;
            } else {
                hi = k;
            }
        }
        0.5 * (lo + hi)
    }

    #[test]
    fn corrected_speeds_give_true_wavelengths_in_every_direction() {
        // Blue light in flint is the hardest case: about 4.6 cells per wavelength.
        let c0 = 60.0f32;
        for (wavelength, n) in [(12.0f32, 1.0f32), (12.0, 1.5), (8.5, 1.0), (8.5, 1.85)] {
            let omega = std::f32::consts::TAU * c0 / wavelength;
            let c2 = dispersion_corrected_c2(c0 / n, omega);
            assert!(c2.sqrt() <= Laplacian::Isotropic.max_speed());
            for deg in [0.0f32, 22.5, 45.0] {
                let k = wavenumber(c2, omega, deg.to_radians());
                let want = std::f32::consts::TAU * n / wavelength;
                assert!(
                    (k / want - 1.0).abs() < 0.006,
                    "λ {wavelength}, n {n}, {deg}°: k {k} vs {want}"
                );
            }
        }
    }

    #[test]
    fn isotropic_stencil_is_stable_at_its_speed_limit() {
        let mut m = Materials::uniform(40, 40, Laplacian::Isotropic.max_speed(), 0.0);
        m.laplacian = Laplacian::Isotropic;
        let mut s = Solver::new(&m).unwrap();
        let (cur, prev) = s.fields_mut();
        for (i, v) in cur.iter_mut().enumerate() {
            // Checkerboard: the stencil's fastest-growing mode if unstable.
            *v = if (i % 40 + i / 40) % 2 == 0 {
                1.0
            } else {
                -1.0
            };
        }
        prev.copy_from_slice(cur);
        for _ in 0..2000 {
            s.step(&[], 0);
        }
        assert!(s.max_abs() < 10.0, "grew to {}", s.max_abs());
    }
}
