//! Generates the index of embedded pipeline definitions so contributors can add a pipeline by
#![allow(clippy::expect_used)]
//! dropping a JSON file into `data/pipelines/` (no Rust edits needed).

use std::fmt::Write as _;
use std::path::PathBuf;

fn main() {
    let manifest = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR"));
    let dir = manifest.join("data").join("pipelines");
    println!("cargo:rerun-if-changed={}", dir.display());

    let mut files: Vec<PathBuf> = std::fs::read_dir(&dir)
        .expect("data/pipelines must exist")
        .filter_map(Result::ok)
        .map(|e| e.path())
        .filter(|p| p.extension().is_some_and(|x| x == "json"))
        .collect();
    files.sort();

    let mut src = String::from("/// `(file name, JSON text)` of every embedded pipeline.\npub const BUILTIN_PIPELINE_FILES: &[(&str, &str)] = &[\n");
    for f in &files {
        println!("cargo:rerun-if-changed={}", f.display());
        let name = f.file_name().and_then(|n| n.to_str()).expect("utf8 name");
        writeln!(
            src,
            "    ({name:?}, include_str!({:?})),",
            f.to_str().expect("utf8 path")
        )
        .expect("write to String");
    }
    src.push_str("];\n");

    let out = PathBuf::from(std::env::var("OUT_DIR").expect("OUT_DIR")).join("pipeline_files.rs");
    std::fs::write(out, src).expect("write pipeline_files.rs");
}
