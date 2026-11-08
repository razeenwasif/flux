// Flux calls this plugin's commands from Rust (webview.rs) via
// `run_mobile_plugin`, not from the webview. The shell only listens to its
// events (`nav`, `scroll`, `back`), and addPluginListener goes through these two
// built-in commands, which need permissions like any other: without them every
// event was refused ("registerListener not allowed"). Granted to the chrome
// window on phones only, by capabilities/mobile.json.
// android_path and ios_path let `cargo tauri android|ios build` find the
// plugin's Gradle project and Swift package and build them into the app.
const COMMANDS: &[&str] = &["register_listener", "remove_listener"];

fn main() {
    tauri_plugin::Builder::new(COMMANDS)
        .android_path("android")
        .ios_path("ios")
        .build();
}
