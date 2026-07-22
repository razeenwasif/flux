fn main() {
    // Declare an inlined plugin `fluxtab` for the commands a REMOTE tab page may
    // call: DOM capture, app shortcut forwarding, page-initiated new tabs, reader
    // extraction, hibernation capture, and the extension broker (#94). Tauri blocks
    // remote origins from app commands, but plugin commands can be granted to
    // `tab-*` webviews via capabilities/tab.json (`fluxtab:default`). Keeping these
    // in a plugin (not app commands) means the other app commands stay unreachable
    // from page/extension content — the broker is the one authorized door, and it
    // enforces per-call grants itself.
    tauri_build::try_build(
        tauri_build::Attributes::new().plugin(
            "fluxtab",
            tauri_build::InlinedPlugin::new()
                .commands(&[
                    "dom_publish",
                    "macro_record_step",
                    "ext_broker_call",
                    "chrome_key",
                    "chrome_open_url",
                    "chrome_peek_url",
                    "peek_promote",
                    "peek_pin",
                    "peek_close",
                    "find_result",
                    "hibernate_capture",
                    "reader_publish",
                    "panel_badge",
                    "vault_page_info",
                    "vault_fill_page",
                    "vault_suggest_password",
                    "vault_save_from_page",
                    "vault_page_matches",
                    "vault_fill_page_id",
                    "vault_offer_save",
                    "sentinel_input_focus",
                    "trace_drafts_enabled",
                    "draft_publish",
                ])
                .default_permission(tauri_build::DefaultPermissionRule::AllowAllCommands),
        ),
    )
    .expect("failed to run tauri-build");
}
