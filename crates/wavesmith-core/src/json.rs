//! JSON entry points and hand-written deserializers for the tagged model enums.
//!
//! Text is parsed into a `serde_json::Value` first and converted from there, so each model
//! type's deserializer is compiled once (for `Value`) instead of once per input reader. The
//! internally tagged enums ([`Item`], [`SourceDef`], [`Goal`]) are converted by hand: serde's
//! derived code for tagged enums buffers and re-dispatches every variant and came to about
//! 90 KB of WebAssembly on its own. Defaults come from the same `default_*` functions the
//! types' `#[serde(default)]` attributes name.

use serde::de::{DeserializeOwned, Error as _};
use serde::{Deserialize, Deserializer};
use serde_json::{Map, Value};

use crate::goals::{self, Goal};
use crate::light::{Color, Material};
use crate::source::{self, SourceDef};
use crate::tools::{self, Item, V2};

/// Parses `T` from JSON text.
pub fn parse<T: DeserializeOwned>(s: &str) -> Result<T, serde_json::Error> {
    let value: Value = serde_json::from_str(s)?;
    serde_json::from_value(value)
}

/// Parses a JSON array of pieces.
pub fn parse_items(s: &str) -> Result<Vec<Item>, serde_json::Error> {
    parse(s)
}

/// Field access on a JSON object, with the error messages serde would give.
struct Obj<'a> {
    map: &'a Map<String, Value>,
    what: &'static str,
}

type R<T> = Result<T, String>;

impl<'a> Obj<'a> {
    fn new(v: &'a Value, what: &'static str) -> R<Obj<'a>> {
        v.as_object()
            .map(|map| Obj { map, what })
            .ok_or_else(|| format!("{what}: expected an object"))
    }

    fn get(&self, key: &str) -> Option<&'a Value> {
        self.map.get(key).filter(|v| !v.is_null())
    }

    fn missing(&self, key: &str) -> String {
        format!("{}: missing field `{key}`", self.what)
    }

    fn f32(&self, key: &str) -> R<f32> {
        self.f32_or(key, None)
    }

    fn f32_or(&self, key: &str, default: Option<f32>) -> R<f32> {
        match self.get(key) {
            Some(v) => v
                .as_f64()
                .map(|x| x as f32)
                .ok_or_else(|| format!("{}: `{key}` must be a number", self.what)),
            None => default.ok_or_else(|| self.missing(key)),
        }
    }

    fn opt_f32(&self, key: &str) -> R<Option<f32>> {
        self.get(key).map(|_| self.f32(key)).transpose()
    }

    fn v2(&self, key: &str) -> R<V2> {
        let v = self.get(key).ok_or_else(|| self.missing(key))?;
        v2(v).ok_or_else(|| format!("{}: `{key}` must be [x, y]", self.what))
    }

    fn v2_or(&self, key: &str, default: V2) -> R<V2> {
        match self.get(key) {
            Some(_) => self.v2(key),
            None => Ok(default),
        }
    }

    fn v2_list(&self, key: &str) -> R<Vec<V2>> {
        let v = self.get(key).ok_or_else(|| self.missing(key))?;
        v.as_array()
            .and_then(|a| a.iter().map(v2).collect())
            .ok_or_else(|| format!("{}: `{key}` must be a list of [x, y]", self.what))
    }

    fn kind(&self) -> R<&'a str> {
        self.get("kind")
            .and_then(Value::as_str)
            .ok_or_else(|| self.missing("kind"))
    }

    fn material(&self, key: &str) -> R<Option<Material>> {
        self.get(key)
            .map(|v| match v.as_str() {
                Some("water") => Ok(Material::Water),
                Some("crown") => Ok(Material::Crown),
                Some("flint") => Ok(Material::Flint),
                _ => Err(format!("{}: unknown material {v}", self.what)),
            })
            .transpose()
    }

    fn colors(&self) -> R<Option<Vec<Color>>> {
        let Some(v) = self.get("colors") else {
            return Ok(None);
        };
        let list = v
            .as_array()
            .ok_or_else(|| format!("{}: `colors` must be a list", self.what))?;
        list.iter()
            .map(|c| match c.as_str() {
                Some("red") => Ok(Color::Red),
                Some("green") => Ok(Color::Green),
                Some("blue") => Ok(Color::Blue),
                _ => Err(format!("{}: unknown color {c}", self.what)),
            })
            .collect::<R<Vec<_>>>()
            .map(Some)
    }
}

fn v2(v: &Value) -> Option<V2> {
    match v.as_array()?.as_slice() {
        [x, y] => Some([x.as_f64()? as f32, y.as_f64()? as f32]),
        _ => None,
    }
}

fn unknown(what: &str, kind: &str) -> String {
    format!("{what}: unknown kind `{kind}`")
}

pub fn item_from_value(v: &Value) -> R<Item> {
    let o = Obj::new(v, "piece")?;
    Ok(match o.kind()? {
        "wall" => Item::Wall {
            a: o.v2("a")?,
            b: o.v2("b")?,
            thickness: o.f32_or("thickness", Some(tools::default_thickness()))?,
        },
        "reflector" => Item::Reflector {
            a: o.v2("a")?,
            b: o.v2("b")?,
            bulge: o.f32_or("bulge", Some(0.0))?,
            thickness: o.f32_or("thickness", Some(tools::default_thickness()))?,
        },
        "absorber" => Item::Absorber {
            pos: o.v2("pos")?,
            size: o.v2("size")?,
            angle: o.f32_or("angle", Some(0.0))?,
            strength: o.f32_or("strength", Some(tools::default_strength()))?,
        },
        "lens" => Item::Lens {
            pos: o.v2("pos")?,
            radii: o.v2("radii")?,
            angle: o.f32_or("angle", Some(0.0))?,
            ratio: o.f32_or("ratio", Some(tools::default_ratio()))?,
            material: o.material("material")?,
        },
        "prism" => Item::Prism {
            pos: o.v2("pos")?,
            size: o.v2("size")?,
            angle: o.f32_or("angle", Some(0.0))?,
            material: o
                .material("material")?
                .unwrap_or_else(tools::default_material),
        },
        "slab" => Item::Slab {
            pos: o.v2("pos")?,
            size: o.v2("size")?,
            angle: o.f32_or("angle", Some(0.0))?,
            material: o
                .material("material")?
                .unwrap_or_else(tools::default_material),
        },
        "resonator" => Item::Resonator {
            pos: o.v2("pos")?,
            freq: o.f32("freq")?,
            q: o.f32_or("q", Some(tools::default_q()))?,
        },
        "emitter" => Item::Emitter {
            pos: o.v2("pos")?,
            freq: o.f32("freq")?,
            amp: o.f32_or("amp", Some(tools::default_amp()))?,
            phase: o.f32_or("phase", Some(0.0))?,
            vel: o.v2_or("vel", [0.0, 0.0])?,
        },
        k => return Err(unknown("piece", k)),
    })
}

pub fn source_from_value(v: &Value) -> R<SourceDef> {
    let o = Obj::new(v, "source")?;
    let freq = o.f32_or("freq", Some(0.0))?;
    let amp = o.f32_or("amp", Some(source::default_amp()))?;
    let phase = o.f32_or("phase", Some(0.0))?;
    let start = o.f32_or("start", Some(0.0))?;
    let colors = o.colors()?;
    Ok(match o.kind()? {
        "point" => SourceDef::Point {
            pos: o.v2("pos")?,
            vel: o.v2_or("vel", [0.0, 0.0])?,
            freq,
            amp,
            phase,
            start,
            colors,
        },
        "line" => SourceDef::Line {
            a: o.v2("a")?,
            b: o.v2("b")?,
            freq,
            amp,
            phase,
            start,
            colors,
        },
        "beam" => SourceDef::Beam {
            pos: o.v2("pos")?,
            angle: o.f32("angle")?,
            width: o.f32_or("width", Some(source::default_width()))?,
            freq,
            amp,
            phase,
            start,
            colors,
        },
        k => return Err(unknown("source", k)),
    })
}

pub fn goal_from_value(v: &Value) -> R<Goal> {
    let o = Obj::new(v, "goal")?;
    Ok(match o.kind()? {
        "focus" => Goal::Focus {
            pos: o.v2("pos")?,
            radius: o.f32("radius")?,
            threshold: o.f32("threshold")?,
            hold: o.f32("hold")?,
            colors: o.colors()?,
        },
        "silence" => Goal::Silence {
            pos: o.v2("pos")?,
            radius: o.f32("radius")?,
            threshold: o.f32("threshold")?,
            hold: o.f32("hold")?,
            after: o.opt_f32("after")?,
            colors: o.colors()?,
        },
        "resonate" => Goal::Resonate {
            pos: o.v2("pos")?,
            freq: o.f32("freq")?,
            q: o.f32_or("q", Some(goals::default_q()))?,
            threshold: o.f32("threshold")?,
        },
        "sustain" => Goal::Sustain {
            antinodes: o.v2_list("antinodes")?,
            nodes: o.v2_list("nodes")?,
            radius: o.f32("radius")?,
            high: o.f32("high")?,
            low: o.f32("low")?,
            hold: o.f32("hold")?,
        },
        k => return Err(unknown("goal", k)),
    })
}

macro_rules! deserialize_via_value {
    ($t:ty, $f:ident) => {
        impl<'de> Deserialize<'de> for $t {
            fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
                let v = Value::deserialize(d)?;
                $f(&v).map_err(D::Error::custom)
            }
        }
    };
}

deserialize_via_value!(Item, item_from_value);
deserialize_via_value!(SourceDef, source_from_value);
deserialize_via_value!(Goal, goal_from_value);

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_match_the_documented_ones() {
        let w: Item = parse(r#"{"kind":"wall","a":[0,0],"b":[10,0]}"#).unwrap();
        assert_eq!(
            w,
            Item::Wall {
                a: [0.0, 0.0],
                b: [10.0, 0.0],
                thickness: 3.0
            }
        );
        let p: Item = parse(r#"{"kind":"prism","pos":[1,2],"size":[30,40]}"#).unwrap();
        assert!(matches!(
            p,
            Item::Prism {
                material: Material::Crown,
                angle: 0.0,
                ..
            }
        ));
        let s: SourceDef = parse(r#"{"kind":"beam","pos":[1,2],"angle":0}"#).unwrap();
        assert!(matches!(
            s,
            SourceDef::Beam {
                width: 22.0,
                amp: 1.0,
                colors: None,
                ..
            }
        ));
        let g: Goal = parse(
            r#"{"kind":"silence","pos":[1,2],"radius":3,"threshold":0.1,"hold":1,"after":null}"#,
        )
        .unwrap();
        assert!(matches!(g, Goal::Silence { after: None, .. }));
    }

    #[test]
    fn serialized_pieces_round_trip() {
        let items = vec![
            Item::Lens {
                pos: [5.0, 6.0],
                radii: [10.0, 20.0],
                angle: 0.5,
                ratio: 1.0,
                material: Some(Material::Flint),
            },
            Item::Emitter {
                pos: [5.0, 5.0],
                freq: 3.0,
                amp: 1.0,
                phase: 0.5,
                vel: [4.0, 0.0],
            },
        ];
        let back = parse_items(&serde_json::to_string(&items).unwrap()).unwrap();
        assert_eq!(items, back);
    }

    #[test]
    fn bad_input_is_an_error_not_a_panic() {
        assert!(parse_items(r#"[{"kind":"laser","pos":[0,0]}]"#).is_err());
        assert!(parse_items(r#"[{"kind":"wall","a":[0],"b":[1,1]}]"#).is_err());
        assert!(parse_items(r#"[{"kind":"wall","a":[0,0]}]"#).is_err());
        assert!(parse::<Goal>(r#"{"kind":"focus","pos":[0,0],"radius":"big"}"#).is_err());
        assert!(
            parse::<SourceDef>(r#"{"kind":"point","pos":[0,0],"colors":["ultraviolet"]}"#).is_err()
        );
    }
}
