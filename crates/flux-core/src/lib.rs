//! flux-core library surface — exposed so benches/integration tests can call
//! commands without booting a window.

pub mod agent_bridge;
pub mod broker;
pub mod cli;
pub mod commands;
pub mod cookies;
pub mod downloads;
pub mod extensions;
pub mod favicon;
pub mod files;
pub mod hibernate;
pub mod history;
pub mod mem;
pub mod https;
pub mod netfilter;
pub mod omni;
pub mod permissions;
pub mod search;
pub mod session;
pub mod shields;
pub mod tracking;
pub mod state;
pub mod terminal;
pub mod vault;
pub mod webview;

use tauri::{Emitter, Manager};

/// Build the Tauri application. Split from `main` for testability.
pub fn run(intent: cli::LaunchIntent) {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "flux=info".into()),
        )
        .init();

    tauri::Builder::default()
        // Persist + restore window size/position across launches (open as closed).
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .setup(move |app| {
            // Single source of truth, injected into every command. Restored
            // from the persisted session so tabs survive a restart (#19).
            let session_path = app
                .path()
                .app_data_dir()
                .map(|d| d.join("session.json"))
                .unwrap_or_else(|_| std::path::PathBuf::from("flux-session.json"));
            app.manage(state::FluxState::restore(session_path));
            // CLI launch intent — consumed once by the shell on mount.
            app.manage(intent);
            // Live PTY sessions for the embedded terminal.
            app.manage(terminal::TerminalManager::new());
            // Pluggable search config (persisted to the app config dir).
            app.manage(search::SearchState::load(app.handle()));
            app.manage(omni::IngestState::new());
            // Files tab: live directory watchers + the file-op undo stack.
            app.manage(files::FsWatchers::default());
            app.manage(files::UndoStack::default());
            // Content-blocker shields: the filter engine + per-site policy (#57).
            let filters_dir = app.path().app_data_dir().ok().map(|d| d.join("filters"));
            app.manage(shields::ShieldsState::new(filters_dir));
            // Fetch/refresh the big filter lists (EasyList/EasyPrivacy) off the
            // main thread — parsing tens of thousands of rules is heavy.
            {
                let handle = app.handle().clone();
                std::thread::spawn(move || handle.state::<shields::ShieldsState>().refresh());
            }
            // HTTPS-only mode (#58) — shares the request interceptor with shields.
            app.manage(https::HttpsState::new());
            // Tracking prevention (#58) — native WebView2 3rd-party blocking.
            app.manage(tracking::TrackingState::new());
            // Per-site cookie flags (clear-on-close, #58).
            app.manage(cookies::CookieState::new());
            // Site-permission hardening (#58) — block camera/mic/geo on demand.
            app.manage(permissions::PermState::new());
            // Mini-extension registry (#92) — installed extensions + enabled state.
            let ext_path = app
                .path()
                .app_data_dir()
                .map(|d| d.join("extensions").join("registry.json"))
                .unwrap_or_else(|_| std::path::PathBuf::from("flux-extensions.json"));
            app.manage(extensions::ExtRegistry::restore(ext_path));
            // Extension broker (#94) — capability tokens + grant-checked flux.*
            // API + per-extension persisted storage.
            let storage_path = app
                .path()
                .app_data_dir()
                .map(|d| d.join("extensions").join("storage.json"))
                .unwrap_or_else(|_| std::path::PathBuf::from("flux-ext-storage.json"));
            app.manage(broker::BrokerState::restore(storage_path));
            // Per-tab scroll/form state for hibernation wake (#45) — RAM only.
            app.manage(hibernate::HibernateStore::new());
            // System memory monitor for memory-pressure eviction (#45).
            app.manage(mem::SysMon::new());
            // Favicon cache (#21) — fetched cookielessly, cached per host on disk.
            let fav_dir = app.path().app_data_dir().ok().map(|d| d.join("favicons"));
            app.manage(favicon::FaviconCache::new(fav_dir));
            // Download manager (#34) — WebView2 DownloadStarting + progress.
            app.manage(downloads::DownloadState::new());
            // Browsing history (#39) — recorded from dom_publish, persisted.
            let history_path = app
                .path()
                .app_data_dir()
                .map(|d| d.join("history.json"))
                .unwrap_or_else(|_| std::path::PathBuf::from("flux-history.json"));
            app.manage(history::HistoryStore::restore(history_path));
            {
                // Debounced background save: flush history to disk if it changed.
                let handle = app.handle().clone();
                std::thread::spawn(move || loop {
                    std::thread::sleep(std::time::Duration::from_secs(15));
                    if let Some(h) = handle.try_state::<history::HistoryStore>() {
                        h.persist_if_dirty();
                    }
                });
            }
            // Password vault (#61) — OS-keychain data key + decrypted-in-memory
            // for autofill; persists to app_data/vault/vault.bin.
            app.manage(vault::VaultState::load(app.handle()));
            // Idle auto-lock watchdog (master-password mode): clears the
            // decrypted vault from memory after the configured idle timeout.
            {
                let handle = app.handle().clone();
                std::thread::spawn(move || loop {
                    std::thread::sleep(std::time::Duration::from_secs(20));
                    if let Some(v) = handle.try_state::<vault::VaultState>() {
                        if v.maybe_autolock() {
                            let _ = handle.emit("flux://vault-locked", ());
                        }
                    }
                });
            }
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
                .invoke_handler(tauri::generate_handler![
                    commands::dom_publish,
                    broker::ext_broker_call,
                    commands::chrome_key,
                    commands::find_result,
                    hibernate::hibernate_capture
                ])
                .build(),
        )
        .invoke_handler(tauri::generate_handler![
            commands::tab_create,
            commands::tab_focus,
            commands::tab_close,
            commands::tab_list,
            commands::tab_set_pinned,
            commands::tab_set_url,
            commands::tab_active,
            commands::tab_reorder,
            commands::groups_list,
            commands::group_create,
            commands::group_update,
            commands::group_delete,
            commands::tab_set_group,
            commands::groups_from_clusters,
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
            webview::webview_hibernate,
            webview::webview_capture_state,
            mem::mem_status,
            favicon::favicon,
            history::history_recent,
            history::history_search,
            history::history_delete,
            history::history_clear,
            downloads::downloads_list,
            downloads::downloads_clear,
            downloads::download_open,
            downloads::download_reveal,
            downloads::download_cancel,
            downloads::download_pause,
            downloads::download_resume,
            webview::webview_navigate,
            webview::webview_stop,
            webview::webview_find,
            webview::webview_back,
            webview::webview_forward,
            webview::webview_reload,
            webview::webview_close,
            webview::webview_debug,
            search::search_resolve,
            search::search_suggest,
            search::search_engines,
            search::search_default,
            search::search_set_default,
            search::search_add_engine,
            search::search_remove_engine,
            omni::omni_stats,
            omni::omni_sites,
            omni::omni_ingest_status,
            omni::omni_ingest_set_auto,
            omni::omni_ingest_active,
            shields::shields_status,
            shields::shields_set_enabled,
            shields::shields_set_site,
            shields::shields_check,
            shields::shields_refresh,
            https::https_status,
            https::https_set_enabled,
            https::https_allow_site,
            cookies::cookies_clear_site,
            cookies::cookies_clear_all,
            cookies::cookies_set_clear_on_close,
            cookies::cookies_status,
            tracking::tracking_status,
            tracking::tracking_set_level,
            permissions::permissions_status,
            permissions::permissions_set_block,
            extensions::ext_install,
            extensions::ext_list,
            extensions::ext_set_enabled,
            extensions::ext_remove,
            vault::vault_status,
            vault::vault_list,
            vault::vault_for_host,
            vault::vault_reveal,
            vault::vault_add,
            vault::vault_remove,
            vault::vault_import_proton,
            vault::vault_fill,
            vault::vault_unlock,
            vault::vault_lock,
            vault::vault_set_master_password,
            vault::vault_disable_master_password,
            vault::vault_set_autolock,
            files::fs_list,
            files::fs_home,
            files::fs_quick_locations,
            files::fs_open,
            files::fs_create_dir,
            files::fs_create_file,
            files::fs_rename,
            files::fs_move,
            files::fs_copy,
            files::fs_trash,
            files::fs_delete,
            files::fs_undo,
            files::fs_watch,
            files::fs_unwatch,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Flux");
}
