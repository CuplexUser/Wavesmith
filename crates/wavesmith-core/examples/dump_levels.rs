fn main() {
    let dir = std::path::PathBuf::from(std::env::args().nth(1).unwrap());
    for lf in wavesmith_core::verify::load_levels(&dir).unwrap() {
        println!("{:?}\n{:?}", lf.level, lf.solution);
    }
}
