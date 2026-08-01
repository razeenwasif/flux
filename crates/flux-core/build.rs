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
                    "vault_probe_report",
                    "sentinel_input_focus",
                    "trace_drafts_enabled",
                    "draft_publish",
                ])
                .default_permission(tauri_build::DefaultPermissionRule::AllowAllCommands),
        ),
    )
    .expect("failed to run tauri-build");

    // A build stamp, so the first line of every log answers "is this the binary I
    // just built?". Three diagnoses in this project have been run against a stale
    // binary and their results thrown away; behaviour is a poor way to tell.
    // Falls back to the source timestamp when git isn't available (a release
    // tarball), rather than failing the build.
    let git = |args: &[&str]| {
        std::process::Command::new("git")
            .args(args)
            .output()
            .ok()
            .filter(|o| o.status.success())
            .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
            .filter(|s| !s.is_empty())
    };
    let mut stamp = git(&["rev-parse", "--short", "HEAD"]).unwrap_or_else(|| "unknown".to_string());
    // A stamp that only names a commit still can't answer "is this the binary I
    // just built?" when the tree has uncommitted edits on top of it. Say so.
    if git(&["status", "--porcelain"]).is_some() {
        stamp.push_str("+dirty");
    }
    println!("cargo:rustc-env=FLUX_BUILD_STAMP={stamp}");

    // Re-run when HEAD moves. `.git/HEAD` alone is NOT enough and was the bug
    // here: committing on the branch you're already on rewrites
    // `.git/refs/heads/<branch>` and appends to `.git/logs/HEAD`, but leaves
    // `.git/HEAD` byte-identical — so cargo never re-ran this script and the
    // stamp silently reported whatever commit it was last built at. A build
    // stamp that lies is worse than no build stamp, because it is believed.
    // `logs/HEAD` is appended on every commit, checkout, reset and merge, which
    // is precisely the set of events that can move the stamp.
    for path in ["HEAD", "logs/HEAD"] {
        if let Some(resolved) = git(&["rev-parse", "--git-path", path]) {
            // Only watch paths that exist: cargo re-runs the script on every
            // build for a missing one, which would defeat caching entirely.
            if std::path::Path::new(&resolved).exists() {
                println!("cargo:rerun-if-changed={resolved}");
            }
        }
    }
}
