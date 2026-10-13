mod common;

use common::open_level;
use wavesmith_core::{Item, Session};

fn board() -> Vec<Item> {
    vec![
        Item::Reflector {
            a: [100.0, 20.0],
            b: [100.0, 80.0],
            bulge: 8.0,
            thickness: 3.0,
        },
        Item::Lens {
            pos: [60.0, 30.0],
            radii: [12.0, 8.0],
            angle: 0.4,
            ratio: 0.6,
        },
        Item::Absorber {
            pos: [60.0, 80.0],
            size: [20.0, 6.0],
            angle: 0.0,
            strength: 40.0,
        },
    ]
}

fn fresh() -> Session {
    let mut s = Session::new(open_level(160, 100, 2.5)).unwrap();
    s.set_placements(board()).unwrap();
    s
}

fn same_field(a: &Session, b: &Session) -> bool {
    a.field()
        .iter()
        .zip(b.field())
        .all(|(x, y)| x.to_bits() == y.to_bits())
}

#[test]
fn identical_runs_are_bit_identical() {
    let mut a = fresh();
    let mut b = fresh();
    a.step(1500);
    b.step(1500);
    assert!(same_field(&a, &b));
    assert_eq!(a.energy().to_bits(), b.energy().to_bits());
}

#[test]
fn batching_does_not_change_results() {
    let mut a = fresh();
    let mut b = fresh();
    for _ in 0..1000 {
        a.step(1);
    }
    for n in [7u32, 300, 1, 692] {
        b.step(n);
    }
    assert_eq!(a.steps(), b.steps());
    assert!(same_field(&a, &b));
}

#[test]
fn editing_restarts_from_rest() {
    let mut a = fresh();
    a.step(500);
    a.set_placements(board()).unwrap();
    assert_eq!(a.steps(), 0);
    assert!(a.field().iter().all(|&v| v == 0.0));
    let mut b = fresh();
    a.step(400);
    b.step(400);
    assert!(same_field(&a, &b));
}
