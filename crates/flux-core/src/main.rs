// Windows: release builds must not spawn a console window.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // Context subcommands (`flux dom`, `flux extract-json`, …) read the active
    // page from $FLUX_RPC_DIR and print it — never touch the GUI (#65/#4).
    if let Some(name) = std::env::args().nth(1) {
        if let Some((out, code)) = flux_core::cli::context_command(&name) {
            println!("{out}");
            std::process::exit(code);
        }
    }
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
