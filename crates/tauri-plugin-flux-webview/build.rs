// No JS-invokable commands: Flux calls this plugin from Rust (webview.rs) via
// `run_mobile_plugin`, not from the webview, so there's no command ACL surface.
// The android_path lets `cargo tauri android build` find + merge android/.
const COMMANDS: &[&str] = &[];

fn main() {
    tauri_plugin::Builder::new(COMMANDS)
        .android_path("android")
        .build();
}
