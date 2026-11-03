//! Flux builds against the patched Tauri in `vendor/`, which keeps `window.isTauri`
//! out of web pages (vendor/README.md). `[patch.crates-io]` only applies while the
//! dependency graph accepts that version: a plugin wanting a newer Tauri makes
//! Cargo take the published one and record the patch as unused, with nothing but
//! a warning, and pages start seeing the marker again.

#[test]
fn the_patched_tauri_is_the_one_in_the_build() {
    let lock = include_str!("../../../Cargo.lock");
    assert!(
        !lock.contains("[[patch.unused]]"),
        "Cargo.lock lists an unused patch: something needs a newer Tauri than vendor/ has"
    );
    let tauri: Vec<&str> = lock
        .split("[[package]]")
        .filter(|p| p.trim_start().starts_with("name = \"tauri\"\n"))
        .collect();
    assert_eq!(tauri.len(), 1, "one Tauri in the build");
    assert!(
        !tauri[0].contains("source = "),
        "Tauri comes from a registry, not vendor/"
    );
}
