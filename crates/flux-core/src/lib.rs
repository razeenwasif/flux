//! flux-core library surface — exposed so benches/integration tests can call
//! commands without booting a window.

pub mod agent_bridge;
pub mod cli;
pub mod commands;
pub mod search;
pub mod state;
pub mod terminal;
pub mod webview;

use tauri::Manager;

/// Build the Tauri application. Split from `main` for testability.
pub fn run(intent: cli::LaunchIntent) {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "flux=info".into()),
        )
        .init();

    tauri::Builder::default()
        .setup(move |app| {
            // Single source of truth, injected into every command.
            app.manage(state::FluxState::new());
            // CLI launch intent — consumed once by the shell on mount.
            app.manage(intent);
            // Live PTY sessions for the embedded terminal.
            app.manage(terminal::TerminalManager::new());
            // Pluggable search config (persisted to the app config dir).
            app.manage(search::SearchState::load(app.handle()));
            // Native rounded corners (Win11) — the window is opaque, so CSS
            // can't round it.
            if let Some(win) = app.get_webview_window("main") {
                webview::round_window_corners(&win);
            }
            tracing::info!(target: "flux::boot", "state managed, window up");
            Ok(())
        })
        // `dom_publish` lives in the `fluxtab` inlined plugin (see build.rs):
        // it's the one command remote tab pages may call (DOM capture), so it
        // must be plugin-namespaced to be grantable to remote `tab-*` webviews.
        .plugin(
            tauri::plugin::Builder::<tauri::Wry>::new("fluxtab")
                .invoke_handler(tauri::generate_handler![commands::dom_publish])
                .build(),
        )
        .invoke_handler(tauri::generate_handler![
            commands::tab_create,
            commands::tab_focus,
            commands::tab_close,
            commands::tab_list,
            commands::tab_set_pinned,
            commands::launch_intent,
            commands::chrome_import_preview,
            commands::chrome_import_bookmarks,
            commands::dom_active_bytes,
            commands::terminal_env,
            commands::agent_status,
            commands::agent_execute,
            commands::agent_chat,
            commands::tabs_recluster,
            terminal::terminal_spawn,
            terminal::terminal_write,
            terminal::terminal_resize,
            terminal::terminal_kill,
            webview::webview_open,
            webview::webview_set_bounds,
            webview::webview_show,
            webview::webview_hide,
            webview::webview_navigate,
            webview::webview_back,
            webview::webview_forward,
            webview::webview_reload,
            webview::webview_close,
            webview::webview_debug,
            search::search_resolve,
            search::search_engines,
            search::search_default,
            search::search_set_default,
            search::search_add_engine,
            search::search_remove_engine,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Flux");
}
