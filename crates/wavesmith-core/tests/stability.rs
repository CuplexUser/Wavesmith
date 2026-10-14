mod common;

use common::{open_level, Lcg};
use wavesmith_core::{Item, Session};

#[test]
fn random_boards_stay_bounded() {
    let mut rng = Lcg(0x5eed);
    for case in 0..6 {
        let freq = rng.range(1.0, 6.0);
        let level = open_level(200, 140, freq);
        let mut items = Vec::new();
        for _ in 0..2 {
            items.push(Item::Lens {
                pos: [rng.range(60.0, 140.0), rng.range(30.0, 110.0)],
                radii: [rng.range(5.0, 25.0), rng.range(5.0, 25.0)],
                angle: rng.range(0.0, 3.0),
                ratio: rng.range(0.3, 1.0),
                material: None,
            });
        }
        items.push(Item::Absorber {
            pos: [rng.range(80.0, 120.0), rng.range(10.0, 30.0)],
            size: [rng.range(5.0, 30.0), rng.range(5.0, 15.0)],
            angle: rng.range(0.0, 3.0),
            strength: rng.range(5.0, 150.0),
        });
        let (x, y) = (rng.range(60.0, 140.0), rng.range(110.0, 130.0));
        items.push(Item::Reflector {
            a: [x - 20.0, y],
            b: [x + 20.0, y],
            bulge: rng.range(-15.0, 15.0),
            thickness: 3.0,
        });
        items.push(Item::Resonator {
            pos: [rng.range(40.0, 160.0), 20.0],
            freq,
            q: 60.0,
        });
        items.push(Item::Emitter {
            pos: [rng.range(40.0, 160.0), 120.0],
            freq: rng.range(1.0, 6.0),
            amp: 1.0,
            phase: 0.0,
            vel: [0.0, 0.0],
        });
        let mut s = Session::new(level).unwrap();
        s.set_placements(items)
            .unwrap_or_else(|e| panic!("case {case}: {e}"));
        for chunk in 0..30 {
            s.step(200);
            let m = s.solver().max_abs();
            assert!(
                m.is_finite() && m < 200.0,
                "case {case} blew up ({m}) at chunk {chunk}"
            );
        }
    }
}
