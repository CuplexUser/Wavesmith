//! Light levels: the field is solved three times, once per color channel, each a monochromatic
//! scalar wave (a 2D TM mode obeys the same equation as sound). Glass slows each color by its
//! own refractive index, so white light genuinely splits in a prism, and mirrors, total
//! internal reflection, and diffraction all come from the same solver.
//!
//! Wavelengths are scaled up to tens of cells so the grid resolves them, and the dispersion of
//! the materials is exaggerated so color separation shows within a single board.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Color {
    Red,
    Green,
    Blue,
}

impl Color {
    pub const ALL: [Color; 3] = [Color::Red, Color::Green, Color::Blue];

    /// Channel index in light levels.
    pub fn index(self) -> usize {
        self as usize
    }

    /// Vacuum wavelength, in cells.
    pub fn wavelength(self) -> f32 {
        match self {
            Color::Red => 12.0,
            Color::Green => 10.0,
            Color::Blue => 8.5,
        }
    }

    /// Frequency in a medium of background speed `c0`.
    pub fn freq(self, c0: f32) -> f32 {
        c0 / self.wavelength()
    }
}

/// Transparent materials for glass pieces.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Material {
    Water,
    Crown,
    Flint,
}

impl Material {
    /// Refractive index for red, green, and blue.
    pub fn indices(self) -> [f32; 3] {
        match self {
            Material::Water => [1.28, 1.33, 1.39],
            Material::Crown => [1.42, 1.52, 1.64],
            Material::Flint => [1.50, 1.66, 1.85],
        }
    }

    /// Wave speed relative to the background for channel `channel` of `channels`. Sound levels
    /// (one channel) use the green index.
    pub fn speed_ratio(self, channel: usize, channels: usize) -> f32 {
        let i = if channels == 3 {
            channel
        } else {
            SOUND_CHANNEL
        };
        1.0 / self.indices()[i]
    }
}

/// Index used for dispersive materials in single-channel (sound) levels.
pub const SOUND_CHANNEL: usize = 1;
