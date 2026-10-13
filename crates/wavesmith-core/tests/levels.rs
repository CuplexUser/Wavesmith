use std::path::PathBuf;

use wavesmith_core::verify::{load_levels, run, LevelFile};

fn levels() -> Vec<LevelFile> {
    let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../levels");
    let all = load_levels(&dir).unwrap_or_else(|e| panic!("{e}"));
    assert!(!all.is_empty(), "no levels found in {}", dir.display());
    all
}

#[test]
fn every_level_has_a_three_star_reference_solution() {
    for lf in levels() {
        let id = &lf.level.id;
        let pieces = lf
            .solution
            .as_ref()
            .unwrap_or_else(|| panic!("{id} has no solution file"));
        let report = run(&lf.level, pieces).unwrap_or_else(|e| panic!("{id}: {e}"));
        let solved = report
            .solved
            .unwrap_or_else(|| panic!("{id}: reference solution fails"));
        assert_eq!(
            solved.stars, 3,
            "{id}: reference solution earns {} stars",
            solved.stars
        );
    }
}

#[test]
fn no_level_solves_itself() {
    for lf in levels() {
        let report = run(&lf.level, &[]).unwrap();
        assert!(
            report.solved.is_none(),
            "{} is solved with no pieces",
            lf.level.id
        );
    }
}

#[test]
fn level_ids_are_unique() {
    let mut ids: Vec<String> = levels().into_iter().map(|l| l.level.id).collect();
    let n = ids.len();
    ids.sort();
    ids.dedup();
    assert_eq!(ids.len(), n);
}
