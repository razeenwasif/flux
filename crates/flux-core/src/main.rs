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
    // WSL: the GUI is the native Windows build (this Linux/WebKitGTK build is dev-only
    // and can't position webviews). Forward the launch to `flux.exe`, which
    // single-instances into the already-running Windows Flux, instead of spawning a
    // second Linux window (#20). Context subcommands + --help/--version are handled
    // above, so anything reaching here is a GUI launch.
    #[cfg(target_os = "linux")]
    if flux_core::cli::in_wsl() && std::env::var_os("FLUX_LINUX_GUI").is_none() {
        // `FLUX_LINUX_GUI=1` bypasses the forward to run the Linux GUI directly (dev).
        let args: Vec<String> = std::env::args().skip(1).collect();
        match std::process::Command::new("flux.exe").args(&args).status() {
            Ok(status) => std::process::exit(status.code().unwrap_or(0)),
            Err(e) => {
                eprintln!(
                    "flux: couldn't reach the Windows build (flux.exe) to open this — {e}.\n\
                     Make sure flux.exe is on your Windows PATH; under WSL it's the GUI (the \
                     Linux build here only serves the `flux dom`/`extract-json` context commands)."
                );
                std::process::exit(1);
            }
        }
    }
    flux_core::run(intent)
}
