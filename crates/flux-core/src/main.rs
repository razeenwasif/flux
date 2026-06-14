// Windows: release builds must not spawn a console window.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // Parse CLI before any GUI work so `flux --help` in a terminal is instant
    // and never flashes a window.
    let intent = match flux_core::cli::parse(std::env::args().skip(1)) {
        Ok(intent) => intent,
        Err((text, code)) => {
            println!("{text}");
            std::process::exit(code);
        }
    };
    flux_core::run(intent)
}
