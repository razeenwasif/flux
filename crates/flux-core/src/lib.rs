//! flux-core library surface — exposed so benches/integration tests can call
//! commands without booting a window.

pub mod agent_bridge;
pub mod archive;
pub mod bindings;
pub mod bookmarks;
pub mod boosts;
pub mod calendar;
pub mod broker;
pub mod cache;
pub mod cli;
pub mod commands;
pub mod proxy;
pub mod cookies;
#[cfg(feature = "crsync")]
pub mod crsync;
pub mod darkmode;
pub mod exec;
pub mod downloads;
pub mod embedding;
pub mod extensions;
pub mod favicon;
pub mod feeds;
pub mod files;
pub mod hibernate;
pub mod history;
pub mod kb;
pub mod leanmode;
pub mod lens;
pub mod macros;
pub mod mem;
pub mod memory;
pub mod netspeed;
pub mod nav;
pub mod notes;
pub mod https;
pub mod netfilter;
pub mod omni;
pub mod pdf;
pub mod peek;
pub mod permissions;
pub mod prefetch;
pub mod pwa;
pub mod reminders;
pub mod rpc;
pub mod screenshot;
pub mod search;
pub mod services;
pub mod session;
pub mod sessions;
pub mod porcupine;
pub mod shields;
pub mod spotify;
pub mod stt;
pub mod sync;
pub mod tts;
pub mod voice;
pub mod taskmgr;
pub mod tombstone;
pub mod tracking;
pub mod state;
pub mod specialists;
pub mod terminal;
pub mod todos;
pub mod tui_apps;
pub mod vault;
pub mod webview;

use tauri::{Emitter, Manager};

/// Ensure the web engine negotiates **HTTP/3 / QUIC** (BACKLOG #100). Research
/// (arXiv 2102.12358, 2306.11643) shows H3 + connection coalescing is a real
/// latency win on high-latency / lossy links, and it compounds with the shields
/// cutting third-party domains.
///
/// On Windows the engine is Chromium-based WebView2: we append `--enable-quic`
/// to `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS` (read when the WebView2
/// environment is created, so this must run before any webview). H3 is on by
/// default in recent WebView2; this makes it explicit and survives an
/// Edge-side default flip. `FLUX_WEBVIEW2_ARGS` lets a user add their own flags.
///
/// On Linux the engine is WebKitGTK, whose QUIC support is limited and not
/// configured this way — so this is a no-op there (documented, not silent).
fn enable_http3() {
    if !cfg!(target_os = "windows") {
        tracing::debug!(target: "flux::net", "HTTP/3 flag skipped (engine is WebKitGTK, not WebView2)");
        return;
    }
    const KEY: &str = "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS";
    let mut args = std::env::var(KEY).unwrap_or_default();
    for flag in ["--enable-quic", &std::env::var("FLUX_WEBVIEW2_ARGS").unwrap_or_default()] {
        if !flag.is_empty() && !args.contains(flag) {
            if !args.is_empty() {
                args.push(' ');
            }
            args.push_str(flag);
        }
    }
    std::env::set_var(KEY, &args);
    tracing::info!(target: "flux::net", args = %args, "HTTP/3: WebView2 browser args set");
}

fn boot_phase<T>(
    phase: &'static str,
    boot_started: std::time::Instant,
    f: impl FnOnce() -> T,
) -> T {
    let phase_started = std::time::Instant::now();
    let out = f();
    tracing::info!(
        target: "flux::boot",
        phase,
        elapsed_ms = phase_started.elapsed().as_millis(),
        total_ms = boot_started.elapsed().as_millis(),
        "setup phase"
    );
    out
}

/// Build the Tauri application. Split from `main` for testability.
pub fn run(intent: cli::LaunchIntent) {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "flux=info".into()),
        )
        .init();

    enable_http3();

    tauri::Builder::default()
        // Single-instance (#20): a second `flux <url>` forwards its URLs to the
        // already-running window (open as tabs + focus it) instead of spawning a
        // second process. Registered first so it intercepts before any other setup.
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            use tauri::{Emitter, Manager};
            // Reuse the same argv parser as cold launch; skip argv[0] (the exe path).
            if let Ok(intent) = crate::cli::parse(argv.into_iter().skip(1)) {
                for url in intent.urls {
                    let _ = app.emit("flux://open-url", (url, false));
                }
                // `flux -t` on a second launch → open a terminal tab in the window.
                if intent.terminal {
                    let _ = app.emit("flux://shortcut", "new-terminal");
                }
            }
            if let Some(win) = app.get_webview_window("main") {
                let _ = win.unminimize();
                let _ = win.show();
                let _ = win.set_focus();
            }
        }))
        // Persist + restore window size/position across launches (open as closed).
        .plugin(tauri_plugin_window_state::Builder::default().build())
        // OS notifications (used by the reminder scheduler).
        .plugin(tauri_plugin_notification::init())
        .setup(move |app| {
            // Background reminder scheduler — fires due reminders even with the
            // agent panel closed (event + OS toast).
            reminders::start_scheduler(app.handle().clone());
            let boot_started = std::time::Instant::now();
            // Single source of truth, injected into every command. Restored
            // from the persisted session so tabs survive a restart (#19).
            let session_path = app
                .path()
                .app_data_dir()
                .map(|d| d.join("session.json"))
                .unwrap_or_else(|_| std::path::PathBuf::from("flux-session.json"));
            app.manage(boot_phase("session.restore", boot_started, || state::FluxState::restore(session_path)));
            // CLI launch intent — consumed once by the shell on mount.
            app.manage(intent);
            // Live PTY sessions for the embedded terminal.
            app.manage(terminal::TerminalManager::new());
            // Pluggable search config (persisted to the app config dir).
            app.manage(boot_phase("search.load", boot_started, || search::SearchState::load(app.handle())));
            app.manage(omni::IngestState::new());
            // Files tab: live directory watchers + the file-op undo stack.
            app.manage(files::FsWatchers::default());
            app.manage(files::UndoStack::default());
            // Optional outbound proxy (#63) — persisted endpoint, applied at webview creation.
            app.manage(match app.path().app_data_dir().ok().map(|d| d.join("proxy.txt")) {
                Some(p) => proxy::ProxyState::restore(p),
                None => proxy::ProxyState::default(),
            });
            // Content-blocker shields: the filter engine + per-site policy (#57).
            let filters_dir = app.path().app_data_dir().ok().map(|d| d.join("filters"));
            app.manage(boot_phase("shields.init", boot_started, || shields::ShieldsState::new(filters_dir)));
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
            let perms_path = app
                .path()
                .app_data_dir()
                .map(|d| d.join("permissions.json"))
                .unwrap_or_else(|_| std::path::PathBuf::from("flux-permissions.json"));
            app.manage(boot_phase("permissions.restore", boot_started, || permissions::PermState::restore(perms_path)));
            // Mini-extension registry (#92) — installed extensions + enabled state.
            let ext_path = app
                .path()
                .app_data_dir()
                .map(|d| d.join("extensions").join("registry.json"))
                .unwrap_or_else(|_| std::path::PathBuf::from("flux-extensions.json"));
            app.manage(boot_phase("extensions.restore", boot_started, || extensions::ExtRegistry::restore(ext_path)));
            // Extension broker (#94) — capability tokens + grant-checked flux.*
            // API + per-extension persisted storage.
            let storage_path = app
                .path()
                .app_data_dir()
                .map(|d| d.join("extensions").join("storage.json"))
                .unwrap_or_else(|_| std::path::PathBuf::from("flux-ext-storage.json"));
            app.manage(boot_phase("broker.restore", boot_started, || broker::BrokerState::restore(storage_path)));
            // Per-tab scroll/form state for hibernation wake (#45) — RAM only.
            app.manage(hibernate::HibernateStore::new());
            // System memory monitor for memory-pressure eviction (#45).
            app.manage(mem::SysMon::new());
            // Predictive-prefetch Markov model (#103) — per-origin next-host
            // prediction for confidence-gated preconnect.
            app.manage(prefetch::PrefetchModel::new());
            // DOM-aware terminal bridge (#65/#4) — Flux writes the active page's
            // context here for the `flux` CLI to read inside the terminal.
            let rpc_dir = app
                .path()
                .app_data_dir()
                .map(|d| d.join("rpc"))
                .unwrap_or_else(|_| std::path::PathBuf::from("flux-rpc"));
            let _ = std::fs::create_dir_all(&rpc_dir);
            app.manage(rpc::RpcDir(rpc_dir));
            // Offline page archive + semantic search (#69).
            let archive_path = app
                .path()
                .app_data_dir()
                .map(|d| d.join("archive").join("archive.json"))
                .unwrap_or_else(|_| std::path::PathBuf::from("flux-archive.json"));
            if let Some(parent) = archive_path.parent() {
                let _ = std::fs::create_dir_all(parent);
            }
            app.manage(boot_phase("archive.empty", boot_started, || archive::ArchiveStore::empty(archive_path)));
            {
                let handle = app.handle().clone();
                std::thread::spawn(move || {
                    if let Some(a) = handle.try_state::<archive::ArchiveStore>() {
                        boot_phase("archive.hydrate", boot_started, || a.hydrate());
                    }
                });
            }
            // TUI app launcher — curated bar of the user's terminal apps.
            let tui_apps_path = app
                .path()
                .app_data_dir()
                .map(|d| d.join("tui-apps.json"))
                .unwrap_or_else(|_| std::path::PathBuf::from("flux-tui-apps.json"));
            if let Some(parent) = tui_apps_path.parent() {
                let _ = std::fs::create_dir_all(parent);
            }
            app.manage(tui_apps::TuiAppsStore::empty(tui_apps_path));
            // Knowledge Base — local RAG over the user's corpora (ADR 0010).
            let kb_path = app
                .path()
                .app_data_dir()
                .map(|d| d.join("kb").join("kb-index.json"))
                .unwrap_or_else(|_| std::path::PathBuf::from("flux-kb.json"));
            if let Some(parent) = kb_path.parent() {
                let _ = std::fs::create_dir_all(parent);
            }
            app.manage(boot_phase("kb.empty", boot_started, || kb::KbStore::empty(kb_path)));
            {
                let handle = app.handle().clone();
                std::thread::spawn(move || {
                    if let Some(k) = handle.try_state::<kb::KbStore>() {
                        boot_phase("kb.hydrate", boot_started, || k.hydrate());
                    }
                });
            }
            // Auto-start the user's local services (Omni / Scroll) if they're down,
            // off-thread so a slow probe never delays boot. Opt out: FLUX_NO_AUTOSTART=1.
            std::thread::spawn(services::autostart_down_services);
            // Per-site boosts (#49) — agent-authored CSS/JS injected per host.
            let boosts_path = app
                .path()
                .app_data_dir()
                .map(|d| d.join("boosts.json"))
                .unwrap_or_else(|_| std::path::PathBuf::from("flux-boosts.json"));
            app.manage(boot_phase("boosts.restore", boot_started, || boosts::BoostStore::restore(boosts_path)));
            // Scriptable macros (#67) — record/replay browsing flows.
            let macros_path = app
                .path()
                .app_data_dir()
                .map(|d| d.join("macros.json"))
                .unwrap_or_else(|_| std::path::PathBuf::from("flux-macros.json"));
            app.manage(boot_phase("macros.restore", boot_started, || macros::MacroState::restore(macros_path)));
            // E2E sync (#62) — encrypted bookmarks/sessions via a BYO folder.
            let sync_path = app
                .path()
                .app_data_dir()
                .map(|d| d.join("sync.json"))
                .unwrap_or_else(|_| std::path::PathBuf::from("flux-sync-config.json"));
            app.manage(boot_phase("sync.restore", boot_started, || sync::SyncState::restore(sync_path)));
            // Auto-sync timer (#62): quietly re-syncs every few minutes when on +
            // unlocked. No-op until the user enables it + unlocks.
            sync::spawn_auto(app.handle().clone());
            // Install-site-as-app / PWAs (#42).
            let pwa_path = app
                .path()
                .app_data_dir()
                .map(|d| d.join("pwas.json"))
                .unwrap_or_else(|_| std::path::PathBuf::from("flux-pwas.json"));
            app.manage(boot_phase("pwa.restore", boot_started, || pwa::PwaStore::restore(pwa_path)));
            // Native RSS / Atom reader (#72) — subscriptions persisted; items fetched live.
            let feeds_path = app
                .path()
                .app_data_dir()
                .map(|d| d.join("feeds.json"))
                .unwrap_or_else(|_| std::path::PathBuf::from("flux-feeds.json"));
            app.manage(boot_phase("feeds.restore", boot_started, || feeds::FeedStore::restore(feeds_path)));
            // Calendar (#114) — subscribed ICS feed URLs; events fetched live.
            let cal_path = app
                .path()
                .app_data_dir()
                .map(|d| d.join("calendars.json"))
                .unwrap_or_else(|_| std::path::PathBuf::from("flux-calendars.json"));
            app.manage(boot_phase("calendar.restore", boot_started, || calendar::CalStore::restore(cal_path)));
            // Local tasks / to-dos (#114) — on-device task list.
            let todos_path = app
                .path()
                .app_data_dir()
                .map(|d| d.join("todos.json"))
                .unwrap_or_else(|_| std::path::PathBuf::from("flux-todos.json"));
            app.manage(boot_phase("todos.restore", boot_started, || todos::TodoStore::restore(todos_path)));
            // Per-site lean mode (#105) — opt-in heavy-3rd-party-script blocking.
            app.manage(leanmode::LeanState::new());
            // Built-in task manager (#107) — system process monitor.
            app.manage(boot_phase("taskmgr.init", boot_started, taskmgr::TaskManager::new));
            // Favicon cache (#21) — fetched cookielessly, cached per host on disk.
            let fav_dir = app.path().app_data_dir().ok().map(|d| d.join("favicons"));
            app.manage(favicon::FaviconCache::new(fav_dir));
            // Bookmarks (#22) — persisted store + Chrome import.
            let bm_path = app
                .path()
                .app_data_dir()
                .map(|d| d.join("bookmarks.json"))
                .unwrap_or_else(|_| std::path::PathBuf::from("flux-bookmarks.json"));
            app.manage(boot_phase("bookmarks.restore", boot_started, || bookmarks::BookmarkStore::restore(bm_path)));
            // Named sessions (#47) — save/restore bundles of tabs.
            let sessions_path = app
                .path()
                .app_data_dir()
                .map(|d| d.join("sessions.json"))
                .unwrap_or_else(|_| std::path::PathBuf::from("flux-sessions.json"));
            app.manage(boot_phase("sessions.restore", boot_started, || sessions::SessionStore::restore(sessions_path)));
            // Daily auto-snapshots (#47): quietly snapshot the open tabs into a
            // per-day bucket every few minutes (keeps a week), so "reopen yesterday"
            // works without having saved anything.
            let snaps_path = app
                .path()
                .app_data_dir()
                .map(|d| d.join("snapshots.json"))
                .unwrap_or_else(|_| std::path::PathBuf::from("flux-snapshots.json"));
            app.manage(boot_phase("snapshots.restore", boot_started, || sessions::SnapshotStore::restore(snaps_path)));
            {
                let handle = app.handle().clone();
                std::thread::spawn(move || loop {
                    std::thread::sleep(std::time::Duration::from_secs(300));
                    if let (Some(snaps), Some(st)) =
                        (handle.try_state::<sessions::SnapshotStore>(), handle.try_state::<state::FluxState>())
                    {
                        snaps.capture(sessions::snapshot(&st));
                    }
                });
            }
            // Download manager (#34) — WebView2 DownloadStarting + progress.
            app.manage(downloads::DownloadState::new());
            // Native dark mode (#40) — WebView2 PreferredColorScheme.
            app.manage(darkmode::DarkState::new());
            // Navigation toggles (#51/#52) — vim link-hints + mouse gestures.
            app.manage(nav::NavState::new());
            // Per-page notes (#53).
            let notes_path = app
                .path()
                .app_data_dir()
                .map(|d| d.join("notes.json"))
                .unwrap_or_else(|_| std::path::PathBuf::from("flux-notes.json"));
            app.manage(boot_phase("notes.restore", boot_started, || notes::NoteStore::restore(notes_path)));
            // Browsing history (#39) — recorded from dom_publish, persisted.
            let history_path = app
                .path()
                .app_data_dir()
                .map(|d| d.join("history.json"))
                .unwrap_or_else(|_| std::path::PathBuf::from("flux-history.json"));
            // Empty now (no disk I/O on the boot thread — a large history.json
            // would delay window show); hydrated from disk on the thread below.
            app.manage(history::HistoryStore::empty(history_path));
            {
                // Load history off the boot path, then flush to disk if it changed
                // every 60s (was 15s) — fewer idle wakeups; the write is skipped
                // unless dirty, so worst case is ~60s of unsaved history on a crash.
                let handle = app.handle().clone();
                std::thread::spawn(move || {
                    if let Some(h) = handle.try_state::<history::HistoryStore>() {
                        h.hydrate();
                    }
                    loop {
                        std::thread::sleep(std::time::Duration::from_secs(60));
                        if let Some(h) = handle.try_state::<history::HistoryStore>() {
                            h.persist_if_dirty();
                        }
                    }
                });
            }
            // Password vault (#61) — OS-keychain data key + decrypted-in-memory
            // for autofill; persists to app_data/vault/vault.bin.
            app.manage(boot_phase("vault.load", boot_started, || vault::VaultState::load(app.handle())));
            {
                let handle = app.handle().clone();
                std::thread::spawn(move || {
                    if let Some(v) = handle.try_state::<vault::VaultState>() {
                        v.hydrate_keychain();
                        let _ = handle.emit("flux://vault-ready", ());
                    }
                });
            }
            // Idle auto-lock watchdog (master-password mode): clears the
            // decrypted vault from memory after the configured idle timeout.
            {
                let handle = app.handle().clone();
                std::thread::spawn(move || loop {
                    let sleep = if let Some(v) = handle.try_state::<vault::VaultState>() {
                        if v.maybe_autolock() {
                            let _ = handle.emit("flux://vault-locked", ());
                        }
                        v.autolock_watch_interval()
                    } else {
                        std::time::Duration::from_secs(60)
                    };
                    std::thread::sleep(sleep);
                });
            }
            // Native rounded corners (Win11) — the window is opaque, so CSS
            // can't round it.
            boot_phase("window.decorate", boot_started, || {
                if let Some(win) = app.get_webview_window("main") {
                    webview::round_window_corners(&win);
                }
            });
            // dev=false means the embedded frontend is served (custom-protocol);
            // dev=true means it's loading devUrl (localhost:1420) — a release
            // binary must show dev=false or it'll ERR_CONNECTION_REFUSED.
            tracing::info!(target: "flux::boot", dev = tauri::is_dev(), total_ms = boot_started.elapsed().as_millis(), "state managed, window up");
            Ok(())
        })
        // `dom_publish` lives in the `fluxtab` inlined plugin (see build.rs):
        // it's the one command remote tab pages may call (DOM capture), so it
        // must be plugin-namespaced to be grantable to remote `tab-*` webviews.
        .plugin(
            tauri::plugin::Builder::<tauri::Wry>::new("fluxtab")
                .invoke_handler(tauri::generate_handler![
                    commands::dom_publish,
                    commands::chrome_open_url,
                    peek::peek_open,
                    peek::chrome_peek_url,
                    peek::peek_promote,
                    peek::peek_pin,
                    peek::peek_close,
                    macros::macro_record_step,
                    broker::ext_broker_call,
                    commands::chrome_key,
                    commands::find_result,
                    commands::reader_publish,
                    hibernate::hibernate_capture
                ])
                .build(),
        )
        .invoke_handler(tauri::generate_handler![
            commands::shell_snapshot,
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
            commands::chrome_focus,
            commands::tab_set_group,
            commands::folders_list,
            commands::folder_create,
            commands::folder_update,
            commands::folder_delete,
            commands::tab_set_folder,
            commands::tab_rename,
            commands::tab_set_workspace,
            commands::group_set_workspace,
            commands::groups_from_clusters,
            commands::workspaces_list,
            commands::workspace_active,
            commands::workspace_switch,
            commands::workspace_create,
            commands::workspace_update,
            commands::workspace_delete,
            commands::panels_list,
            commands::panel_add,
            commands::panel_remove,
            commands::panel_reorder,
            commands::containers_list,
            commands::container_create,
            commands::container_update,
            commands::container_delete,
            commands::launch_intent,
            commands::chrome_import_preview,
            commands::chrome_import_bookmarks,
            commands::dom_active_bytes,
            commands::tab_dom_sizes,
            commands::terminal_env,
            commands::agent_status,
            commands::agent_execute,
            commands::agent_plan,
            commands::agent_task_step,
            commands::agent_run_action,
            commands::agent_chat,
            commands::agent_chat_stream,
            commands::agent_shell_plan,
            commands::agent_plan_steps,
            proxy::proxy_get,
            proxy::proxy_set,
            commands::agent_next_step,
            commands::agent_edit_plan,
            commands::agent_translate,
            commands::agent_chat_tabs,
            commands::agent_chat_tabs_stream,
            commands::agent_models,
            commands::agent_model,
            commands::agent_set_model,
            commands::omni_search,
            commands::tabs_recluster,
            terminal::terminal_spawn,
            terminal::terminal_write,
            terminal::terminal_resize,
            terminal::terminal_kill,
            webview::webview_open,
            webview::webview_set_bounds,
            webview::webview_show,
            webview::webview_hide,
            webview::webview_preconnect,
            webview::webview_devtools,
            webview::webview_hibernate,
            webview::webview_capture_state,
            mem::mem_status,
            mem::system_stats,
            darkmode::darkmode_status,
            darkmode::darkmode_set,
            nav::nav_status,
            nav::nav_set,
            notes::note_get,
            notes::note_set,
            notes::notes_list,
            feeds::feeds_list,
            feeds::feed_add,
            feeds::feed_remove,
            feeds::feed_items,
            calendar::cal_list,
            calendar::cal_add,
            calendar::cal_remove,
            calendar::cal_events,
            todos::todos_list,
            todos::todo_add,
            todos::todo_toggle,
            todos::todo_remove,
            todos::todos_clear_done,
            favicon::favicon,
            history::history_recent,
            history::history_search,
            history::history_delete,
            history::history_clear,
            bookmarks::bookmarks_list,
            bookmarks::bookmark_folders,
            bookmarks::bookmark_add,
            bookmarks::bookmark_remove,
            bookmarks::bookmark_rename,
            bookmarks::bookmarks_clear,
            bookmarks::bookmarks_import_chrome,
            sessions::sessions_list,
            sessions::session_save,
            sessions::session_delete,
            sessions::session_restore,
            sessions::snapshots_list,
            sessions::snapshot_restore,
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
            webview::webview_zoom,
            webview::webview_extract_reader,
            screenshot::webview_capture,
            webview::webview_close,
            webview::webview_debug,
            webview::panel_open,
            webview::panel_badge,
            webview::panel_set_bounds,
            webview::panel_show,
            webview::panel_hide,
            webview::panel_navigate,
            webview::panel_close,
            search::search_resolve,
            search::search_suggest,
            search::search_engines,
            search::search_default,
            search::search_set_default,
            search::search_add_engine,
            search::search_remove_engine,
            omni::omni_stats,
            omni::omni_sites,
            omni::omni_graph,
            omni::omni_answer,
            omni::omni_ingest_status,
            omni::omni_ingest_set_auto,
            omni::omni_ingest_active,
            shields::shields_status,
            shields::shields_set_enabled,
            shields::shields_set_site,
            shields::shields_check,
            shields::shields_refresh,
            shields::shields_hot_rules,
            prefetch::prefetch_record,
            prefetch::prefetch_hints,
            prefetch::prefetch_set_pressure,
            pdf::pdf_fetch,
            pdf::pdf_save,
            archive::archive_save,
            archive::archive_list,
            archive::archive_get,
            archive::archive_delete,
            archive::archive_search,
            boosts::boosts_list,
            boosts::boosts_for_host,
            boosts::boost_save,
            boosts::boost_delete,
            boosts::boost_set_enabled,
            boosts::boost_author,
            macros::macros_list,
            macros::macros_status,
            macros::macro_start_record,
            macros::macro_stop_record,
            macros::macro_cancel_record,
            macros::macro_delete,
            macros::macro_rename,
            macros::macro_run,
            sync::sync_status,
            sync::sync_set_folder,
            sync::sync_unlock,
            sync::sync_lock,
            sync::sync_now,
            sync::sync_set_auto,
            lens::agent_lens,
            lens::agent_vision,
            voice::voice_transcribe,
            voice::wake_transcribe,
            exec::run_shell,
            exec::shell_guard,
            memory::memory_read,
            memory::memory_append,
            memory::memory_write,
            memory::memory_path_str,
            reminders::reminders_list,
            reminders::reminders_add,
            reminders::reminders_remove,
            reminders::reminders_import,
            stt::stt_whisper,
            porcupine::porcupine_set_key,
            porcupine::porcupine_has_key,
            porcupine::porcupine_config,
            tts::voice_speak,
            tts::elevenlabs_set_key,
            tts::elevenlabs_has_key,
            tts::elevenlabs_verify_key,
            tts::elevenlabs_verify_key_value,
            tts::elevenlabs_voices,
            tts::elevenlabs_import_voice,
            tts::elevenlabs_speak,
            spotify::spotify_set_dir,
            spotify::spotify_play,
            spotify::spotify_pause,
            spotify::spotify_resume,
            spotify::spotify_next,
            spotify::spotify_prev,
            spotify::spotify_now_playing,
            spotify::spotify_shuffle,
            spotify::spotify_repeat,
            spotify::spotify_volume,
            spotify::spotify_play_liked,
            spotify::spotify_play_playlist,
            spotify::spotify_launch,
            pwa::pwa_list,
            pwa::pwa_install,
            pwa::pwa_launch,
            pwa::pwa_remove,
            hibernate::hibernate_rank,
            leanmode::lean_status,
            leanmode::lean_set_enabled,
            leanmode::lean_set_site,
            leanmode::lean_active_for,
            taskmgr::tasks_list,
            taskmgr::tasks_kill,
            taskmgr::tasks_stats,
            taskmgr::gpu_stats,
            netspeed::netspeed_run,
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
            permissions::permissions_list,
            permissions::permissions_set,
            permissions::permissions_clear_host,
            permissions::permissions_clear_all,
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
            files::fs_list_stream,
            files::fs_search,
            kb::kb_status,
            kb::kb_reindex,
            kb::kb_set_source,
            kb::kb_query,
            kb::kb_related,
            kb::kb_answer,
            kb::scroll_clip,
            kb::onyx_new_note,
            kb::kb_check,
            specialists::agent_specialists,
            services::services_status,
            services::services_start,
            tui_apps::tui_apps_list,
            tui_apps::tui_apps_set,
            tui_apps::tui_apps_detect,
            files::attachment_read,
            files::read_text_file,
            files::write_text_file,
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
