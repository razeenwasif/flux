fn main() {
    // Declare an inlined plugin `fluxtab` whose only command is `dom_publish`,
    // with an allow-all default permission. This is how a REMOTE tab page is
    // permitted to publish its DOM back to Flux: Tauri blocks remote origins
    // from app commands, but a plugin command can be granted to `tab-*`
    // webviews via capabilities/tab.json (`fluxtab:default`). Keeping it a
    // plugin (not an app command) means the other ~26 app commands stay
    // unrestricted for the local chrome — no per-command enumeration.
    tauri_build::try_build(
        tauri_build::Attributes::new().plugin(
            "fluxtab",
            tauri_build::InlinedPlugin::new()
                .commands(&["dom_publish"])
                .default_permission(tauri_build::DefaultPermissionRule::AllowAllCommands),
        ),
    )
    .expect("failed to run tauri-build");
}
