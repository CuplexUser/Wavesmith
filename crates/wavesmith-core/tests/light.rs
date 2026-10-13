use wavesmith_core::{Item, Level, Session, SPONGE};

/// An empty 400×250 light level (the size the Light chapter uses) with a white beam from the left edge heading right.
fn light_level(beam_y: f32) -> Level {
    let json = format!(
        r#"{{
        "id": "light-test", "name": "Light test", "chapter": 0,
        "grid": {{ "width": 400, "height": 250 }},
        "medium": {{ "c": 60, "damping": 0.0, "light": true }},
        "sources": [{{ "kind": "beam", "pos": [30, {beam_y}], "angle": 0 }}],
        "goals": [{{ "kind": "focus", "pos": [380, 20], "radius": 3, "threshold": 100, "hold": 1 }}],
        "inventory": {{ "prism": {{ "count": 1, "cost": 1 }}, "slab": {{ "count": 1, "cost": 1 }} }},
        "budget": 9, "par": {{ "cost": 0, "energy": 0 }}, "timeLimit": 600
    }}"#
    );
    Level::from_json(&json).expect("light test level is valid")
}

/// Intensity of `channel` at play-area cell `(x, y)`.
fn intensity(s: &mut Session, channel: usize, x: usize, y: usize) -> f32 {
    let nx = s.nx();
    let img = s.light_image();
    img[((y + SPONGE) * nx + x + SPONGE) * 4 + channel]
}

/// Intensity-weighted mean y along the column `x`, for one channel.
fn centroid(s: &mut Session, channel: usize, x: usize) -> f32 {
    let (mut sum, mut w) = (0.0f32, 0.0f32);
    for y in 0..250 {
        let i = intensity(s, channel, x, y);
        sum += i * y as f32;
        w += i;
    }
    sum / w
}

#[test]
fn beam_is_one_way() {
    let mut s = Session::new(light_level(125.0)).unwrap();
    s.step(120 * 4);
    for ch in 0..3 {
        let ahead = intensity(&mut s, ch, 90, 125);
        let behind = intensity(&mut s, ch, 12, 125);
        assert!(ahead > 0.3, "channel {ch}: beam too weak ({ahead})");
        assert!(
            ahead > 25.0 * behind,
            "channel {ch}: ahead {ahead}, behind {behind}"
        );
    }
}

#[test]
fn beam_stays_narrow_and_centered() {
    let mut s = Session::new(light_level(125.0)).unwrap();
    s.step(120 * 9);
    for ch in 0..3 {
        let c = centroid(&mut s, ch, 330);
        assert!((c - 125.0).abs() < 2.0, "channel {ch} centroid {c}");
        let edge = intensity(&mut s, ch, 330, 225);
        let mid = intensity(&mut s, ch, 330, 125);
        assert!(mid > 20.0 * edge, "channel {ch}: beam spread too far");
    }
}

fn prism(pos: [f32; 2], size: [f32; 2]) -> Item {
    Item::Prism {
        pos,
        size,
        angle: 0.0,
        material: wavesmith_core::light::Material::Flint,
    }
}

#[test]
fn prism_bends_blue_more_than_red() {
    // A slim prism (apex about 37°): every color gets through and bends toward the base.
    let mut s = Session::new(light_level(80.0)).unwrap();
    s.set_placements(vec![prism([175.0, 92.0], [75.0, 112.0])])
        .unwrap();
    s.step(120 * 10);
    let [r, g, b] = [0, 1, 2].map(|ch| centroid(&mut s, ch, 330));
    println!("centroids at x=330: red {r:.1}, green {g:.1}, blue {b:.1}");
    assert!(r > 110.0, "red barely bent ({r})");
    assert!(
        g > r + 10.0 && b > g + 10.0,
        "no dispersion: red {r}, green {g}, blue {b}"
    );
}

#[test]
fn steep_prism_traps_blue_by_total_internal_reflection() {
    // Apex about 60°: red (n 1.50) still exits the far face, but blue (n 1.85) meets it past
    // the critical angle and reflects inside the glass instead.
    let mut s = Session::new(light_level(80.0)).unwrap();
    s.set_placements(vec![prism([175.0, 100.0], [110.0, 95.0])])
        .unwrap();
    s.step(120 * 10);
    // Where red leaves the far face.
    let column =
        |s: &mut Session, ch: usize| -> f32 { (140..250).map(|y| intensity(s, ch, 280, y)).sum() };
    let (red, blue) = (column(&mut s, 0), column(&mut s, 2));
    println!("light leaving the far face: red {red:.3}, blue {blue:.3}");
    assert!(red > 4.0 * blue, "red {red}, blue {blue}");
}

#[test]
fn light_runs_are_deterministic() {
    let mut a = Session::new(light_level(125.0)).unwrap();
    let mut b = Session::new(light_level(125.0)).unwrap();
    a.step(300);
    b.step(150);
    b.step(150);
    for ch in 0..3 {
        assert!(a
            .channel_field(ch)
            .iter()
            .zip(b.channel_field(ch))
            .all(|(x, y)| x.to_bits() == y.to_bits()));
    }
}
