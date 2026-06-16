fn main() {
    // Declare an inlined plugin `fluxtab` for the commands a REMOTE tab page may
    // call: `dom_publish` (DOM capture) and `ext_broker_call` (the extension
    // broker, #94). Tauri blocks remote origins from app commands, but a plugin
    // command can be granted to `tab-*` webviews via capabilities/tab.json
    // (`fluxtab:default`). Keeping these in a plugin (not app commands) means the
    // other ~26 app commands stay unreachable from page/extension content — the
    // broker is the one authorized door, and it enforces per-call grants itself.
    tauri_build::try_build(
        tauri_build::Attributes::new().plugin(
            "fluxtab",
            tauri_build::InlinedPlugin::new()
                .commands(&["dom_publish", "ext_broker_call", "chrome_key", "find_result", "hibernate_capture"])
                .default_permission(tauri_build::DefaultPermissionRule::AllowAllCommands),
        ),
    )
    .expect("failed to run tauri-build");
}
