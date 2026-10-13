//! Finite-difference solver for the damped scalar wave equation
//! `u_tt = c(x)² ∇²u − γ(x) u_t + f(x, t)`.
//!
//! Second-order leapfrog in time, 5-point Laplacian in space, and a semi-implicit damping term:
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

/// Per-cell physical properties on the full solver grid (play area plus sponge).
#[derive(Debug, Clone)]
pub struct Materials {
    pub nx: usize,
    pub ny: usize,
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
        let max2 = MAX_SPEED * MAX_SPEED;
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
                    max: MAX_SPEED,
                });
            }
            let b = 0.5 * g * DT;
            k.push(c2 * dt2);
            decay.push(1.0 - b);
            inv.push(if m.wall[i] != 0 { 0.0 } else { 1.0 / (1.0 + b) });
        }
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
        for y in 1..self.ny - 1 {
            let row = y * nx;
            for x in 1..nx - 1 {
                let i = row + x;
                let lap = c[i - 1] + c[i + 1] + c[i - nx] + c[i + nx] - 4.0 * c[i];
                n[i] = (2.0 * c[i] - self.decay[i] * p[i] + self.k[i] * lap) * self.inv[i];
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
