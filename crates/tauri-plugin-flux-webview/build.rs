// Flux calls the tab commands from Rust (webview.rs) via `run_mobile_plugin`,
// not from the webview. The shell itself calls only `share` (the system share
// sheet, from the ⋯ menu), the folder commands (folders picked through iOS, for
// Files and Sync), `take_opened` (links from the share extension), `set_chrome`
// (the bars' heights, for the pages under them), and listens to the plugin's
// events (`nav`, `scroll`, `back`, `opened`, `page`, `memory`). addPluginListener goes through the two built-in listener commands,
// which need permissions like any other: without them every event was refused
// ("registerListener not allowed"). Granted to the chrome window on phones only,
// by capabilities/mobile.json.
// android_path and ios_path let `cargo tauri android|ios build` find the
// plugin's Gradle project and Swift package and build them into the app.
const COMMANDS: &[&str] = &[
    "register_listener",
    "remove_listener",
    "share",
    "pick_folder",
    "folders",
    "forget_folder",
    "take_opened",
    "set_chrome",
];

fn main() {
    tauri_plugin::Builder::new(COMMANDS)
        .android_path("android")
        .ios_path("ios")
        .build();
}
