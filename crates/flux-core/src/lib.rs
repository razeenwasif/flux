//! flux-core library surface — exposed so benches/integration tests can call
//! commands without booting a window.

pub mod agent;
pub mod agent_bridge;
#[cfg(target_os = "android")]
mod android_jni;
pub mod archive;
pub mod audioviz;
pub mod bindings;
pub mod bookmarks;
pub mod boosts;
pub mod broker;
pub mod cache;
pub mod calendar;
pub mod cli;
pub mod commands;
pub mod cookies;
#[cfg(feature = "crsync")]
pub mod crsync;
pub mod currency;
pub mod darkmode;
pub mod dom;
pub mod downloads;
pub mod embedding;
pub mod error;
pub mod exec;
pub mod extensions;
pub mod favicon;
pub mod feeds;
pub mod files;
pub mod hibernate;
pub mod history;
pub mod https;
pub mod kb;
pub mod leanmode;
pub mod lens;
pub mod macros;
pub mod mem;
pub mod memory;
pub mod nav;
pub mod netfilter;
pub mod netspeed;
pub mod notes;
pub mod omni;
pub mod pdf;
pub mod peek;
pub mod permissions;
pub mod persist;
pub mod porcupine;
pub mod prefetch;
pub mod proxy;
pub mod pwa;
pub mod reminders;
pub mod rpc;
pub mod screenshot;
pub mod scribe;
pub mod search;
pub mod semfind;
pub mod sentinel;
pub mod services;
pub mod session;
pub mod sessions;
pub mod shellhist;
pub mod shields;
pub mod specialists;
pub mod spotify;
pub mod state;
pub mod storage;
pub mod stt;
pub mod sync;
pub mod taskmgr;
pub mod terminal;
pub mod todos;
pub mod tombstone;
pub mod trace;
pub mod trackers;
pub mod tracking;
pub mod tts;
pub mod tui_apps;
pub mod vault;
pub mod voice;
pub mod watch;
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
    // `FLUX_NO_QUIC=1` drops the flag. A forced network flag with no off switch
    // can't be ruled out when a page dies with STATUS_ACCESS_VIOLATION — and
    // since H3 is already the WebView2 default, dropping it is close to a no-op.
    let quic = !env_is_true("FLUX_NO_QUIC");
    let args = compose_browser_args(
        &std::env::var(KEY).unwrap_or_default(),
        &std::env::var("FLUX_WEBVIEW2_ARGS").unwrap_or_default(),
        quic,
    );
    std::env::set_var(KEY, &args);
    tracing::info!(target: "flux::net", args = %args, quic, "WebView2 browser args set");
}

/// Is an env var set to something that means yes?
fn env_is_true(key: &str) -> bool {
    std::env::var(key)
        .map(|v| {
            let v = v.trim();
            v == "1" || v.eq_ignore_ascii_case("true") || v.eq_ignore_ascii_case("yes")
        })
        .unwrap_or(false)
}

/// Build the WebView2 argument string: whatever was already set, plus our own
/// flags, without duplicating anything. Pure so the precedence is testable —
/// this decides how every page on Windows is fetched and rendered.
fn compose_browser_args(existing: &str, extra: &str, quic: bool) -> String {
    let mut args = existing.to_string();
    let mut push = |flag: &str| {
        if flag.is_empty() || args.split_whitespace().any(|a| a == flag) {
            return;
        }
        if !args.is_empty() {
            args.push(' ');
        }
        args.push_str(flag);
    };
    // `--enable-quic` alone is nearly a no-op (H3 is already the WebView2
    // default), so opting out has to pass the *disable* flag — otherwise
    // FLUX_NO_QUIC would read as "QUIC is off" while HTTP/3 carried on. That
    // mistake cost a round of debugging.
    push(if quic { "--enable-quic" } else { "--disable-quic" });
    // The user's own flags last, so they can add things like --disable-gpu.
    for flag in extra.split_whitespace() {
        push(flag);
    }
    args
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

/// Restore the main window to its last *windowed* geometry only (size +
/// position), so it never reopens maximized/fullscreen. Runs before the event
/// loop pumps, so the geometry is set before the window is shown.
fn restore_window_geometry(app: &tauri::App) {
    // Desktop only: mobile has no floating window geometry to persist/restore,
    // and the window-state plugin isn't linked there (ADR 0012).
    #[cfg(desktop)]
    {
        use tauri_plugin_window_state::{StateFlags, WindowExt};
        if let Some(win) = app.get_webview_window("main") {
            let _ = win.restore_state(StateFlags::SIZE | StateFlags::POSITION);
            let _ = win.unmaximize();
            let _ = win.set_fullscreen(false);
        }
    }
    #[cfg(mobile)]
    let _ = app;
}

/// Reminder scheduler + the root state every command reads: FluxState (tabs,
/// restored session), CLI launch intent, PTY manager, search config, omni
/// ingest, and the files tab's watchers/undo stack.
fn init_core_state(app: &tauri::App, intent: cli::LaunchIntent, boot_started: std::time::Instant) {
    // Background reminder scheduler — fires due reminders even with the
    // agent panel closed (event + OS toast).
    reminders::start_scheduler(app.handle().clone());
    // Single source of truth, injected into every command. Restored
    // from the persisted session so tabs survive a restart (#19).
    let session_path = app
        .path()
        .app_data_dir()
        .map(|d| d.join("session.json"))
        .unwrap_or_else(|_| std::path::PathBuf::from("flux-session.json"));
    app.manage(boot_phase("session.restore", boot_started, || {
        state::FluxState::restore(session_path)
    }));
    // CLI launch intent — consumed once by the shell on mount.
    app.manage(intent);
    // Live PTY sessions for the embedded terminal.
    app.manage(terminal::TerminalManager::new());
    // Pluggable search config (persisted to the app config dir).
    app.manage(boot_phase("search.load", boot_started, || {
        search::SearchState::load(app.handle())
    }));
    app.manage(omni::IngestState::new());
    // Files tab: live directory watchers + the file-op undo stack.
    app.manage(files::FsWatchers::default());
    app.manage(files::UndoStack::default());
}

/// The privacy stack (#57/#58/#63): outbound proxy, shields (+ off-thread
/// filter-list refresh), HTTPS-only, tracking prevention, cookie policy, and
/// site-permission hardening.
fn init_privacy(app: &tauri::App, boot_started: std::time::Instant) {
    // Optional outbound proxy (#63) — persisted endpoint, applied at webview creation.
    app.manage(
        match app.path().app_data_dir().ok().map(|d| d.join("proxy.txt")) {
            Some(p) => proxy::ProxyState::restore(p),
            None => proxy::ProxyState::default(),
        },
    );
    // Content-blocker shields: the filter engine + per-site policy (#57).
    let filters_dir = app.path().app_data_dir().ok().map(|d| d.join("filters"));
    app.manage(boot_phase("shields.init", boot_started, || {
        shields::ShieldsState::new(filters_dir)
    }));
    // Android Shields: let the WebView's JNI shouldInterceptRequest callback reach
    // the managed ShieldsState (ADR 0012, M3).
    #[cfg(target_os = "android")]
    android_jni::set_app_handle(app.handle().clone());
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
    app.manage(boot_phase("permissions.restore", boot_started, || {
        permissions::PermState::restore(perms_path)
    }));
}

/// Mini-extension registry (#92) + the capability broker (#94).
fn init_extensions(app: &tauri::App, boot_started: std::time::Instant) {
    // Mini-extension registry (#92) — installed extensions + enabled state.
    let ext_path = app
        .path()
        .app_data_dir()
        .map(|d| d.join("extensions").join("registry.json"))
        .unwrap_or_else(|_| std::path::PathBuf::from("flux-extensions.json"));
    app.manage(boot_phase("extensions.restore", boot_started, || {
        extensions::ExtRegistry::restore(ext_path)
    }));
    // Extension broker (#94) — capability tokens + grant-checked flux.*
    // API + per-extension persisted storage.
    let storage_path = app
        .path()
        .app_data_dir()
        .map(|d| d.join("extensions").join("storage.json"))
        .unwrap_or_else(|_| std::path::PathBuf::from("flux-ext-storage.json"));
    app.manage(boot_phase("broker.restore", boot_started, || {
        broker::BrokerState::restore(storage_path)
    }));
}

/// Per-page machinery: hibernation state, memory monitor, predictive
/// prefetch, the DOM-aware terminal RPC dir, and the offline archive
/// (+ off-thread hydration).
fn init_page_intel(app: &tauri::App, boot_started: std::time::Instant) {
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
    app.manage(boot_phase("archive.empty", boot_started, || {
        archive::ArchiveStore::empty(archive_path)
    }));
    {
        let handle = app.handle().clone();
        std::thread::spawn(move || {
            if let Some(a) = handle.try_state::<archive::ArchiveStore>() {
                boot_phase("archive.hydrate", boot_started, || a.hydrate());
            }
        });
    }
}

/// The second-brain surface: TUI app launcher, the KB store (ADR 0010,
/// + off-thread hydration), and local-service autostart (Omni/Scroll).
fn init_knowledge(app: &tauri::App, boot_started: std::time::Instant) {
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
    app.manage(boot_phase("kb.empty", boot_started, || {
        kb::KbStore::empty(kb_path)
    }));
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
}

/// User-authored content stores: boosts, macros, E2E sync (+ auto-sync
/// timer), PWAs, feeds, calendars + local events, todos, shell-history
/// search, page watches (+ scheduler), tracker graph, lean mode, task
/// manager, favicon cache.
fn init_user_content(app: &tauri::App, boot_started: std::time::Instant) {
    // Per-site boosts (#49) — agent-authored CSS/JS injected per host.
    let boosts_path = app
        .path()
        .app_data_dir()
        .map(|d| d.join("boosts.json"))
        .unwrap_or_else(|_| std::path::PathBuf::from("flux-boosts.json"));
    app.manage(boot_phase("boosts.restore", boot_started, || {
        boosts::BoostStore::restore(boosts_path)
    }));
    // Scriptable macros (#67) — record/replay browsing flows.
    let macros_path = app
        .path()
        .app_data_dir()
        .map(|d| d.join("macros.json"))
        .unwrap_or_else(|_| std::path::PathBuf::from("flux-macros.json"));
    app.manage(boot_phase("macros.restore", boot_started, || {
        macros::MacroState::restore(macros_path)
    }));
    // E2E sync (#62) — encrypted bookmarks/sessions via a BYO folder.
    let sync_path = app
        .path()
        .app_data_dir()
        .map(|d| d.join("sync.json"))
        .unwrap_or_else(|_| std::path::PathBuf::from("flux-sync-config.json"));
    app.manage(boot_phase("sync.restore", boot_started, || {
        sync::SyncState::restore(sync_path)
    }));
    // Auto-sync timer (#62): quietly re-syncs every few minutes when on +
    // unlocked. No-op until the user enables it + unlocks.
    sync::spawn_auto(app.handle().clone());
    // Install-site-as-app / PWAs (#42).
    let pwa_path = app
        .path()
        .app_data_dir()
        .map(|d| d.join("pwas.json"))
        .unwrap_or_else(|_| std::path::PathBuf::from("flux-pwas.json"));
    app.manage(boot_phase("pwa.restore", boot_started, || {
        pwa::PwaStore::restore(pwa_path)
    }));
    // Native RSS / Atom reader (#72) — subscriptions persisted; items fetched live.
    let feeds_path = app
        .path()
        .app_data_dir()
        .map(|d| d.join("feeds.json"))
        .unwrap_or_else(|_| std::path::PathBuf::from("flux-feeds.json"));
    app.manage(boot_phase("feeds.restore", boot_started, || {
        feeds::FeedStore::restore(feeds_path)
    }));
    // Calendar (#114) — subscribed ICS feed URLs; events fetched live.
    let cal_path = app
        .path()
        .app_data_dir()
        .map(|d| d.join("calendars.json"))
        .unwrap_or_else(|_| std::path::PathBuf::from("flux-calendars.json"));
    app.manage(boot_phase("calendar.restore", boot_started, || {
        calendar::CalStore::restore(cal_path)
    }));
    // Local calendar events (#114) — on-device, editable, Gemma-writable.
    let cal_events_path = app
        .path()
        .app_data_dir()
        .map(|d| d.join("cal_events.json"))
        .unwrap_or_else(|_| std::path::PathBuf::from("flux-cal-events.json"));
    app.manage(boot_phase("calevents.restore", boot_started, || {
        calendar::LocalEventStore::restore(cal_events_path)
    }));
    // Local tasks / to-dos (#114) — on-device task list.
    let todos_path = app
        .path()
        .app_data_dir()
        .map(|d| d.join("todos.json"))
        .unwrap_or_else(|_| std::path::PathBuf::from("flux-todos.json"));
    app.manage(boot_phase("todos.restore", boot_started, || {
        todos::TodoStore::restore(todos_path)
    }));
    // Semantic shell-history search (#122) — corpus built lazily on first use.
    app.manage(shellhist::ShellHistStore::default());
    // Page-watch (#128) — semantic change monitor + background scheduler.
    let watch_path = app
        .path()
        .app_data_dir()
        .map(|d| d.join("watches.json"))
        .unwrap_or_else(|_| std::path::PathBuf::from("flux-watches.json"));
    app.manage(boot_phase("watch.restore", boot_started, || {
        watch::WatchStore::restore(watch_path)
    }));
    watch::start_scheduler(app.handle().clone());
    // Tracker graph (#129) — live first-party→third-party request map.
    app.manage(trackers::TrackerStore::default());
    // Per-site lean mode (#105) — opt-in heavy-3rd-party-script blocking.
    app.manage(leanmode::LeanState::new());
    // Built-in task manager (#107) — system process monitor.
    app.manage(boot_phase(
        "taskmgr.init",
        boot_started,
        taskmgr::TaskManager::new,
    ));
    // Favicon cache (#21) — fetched cookielessly, cached per host on disk.
    let fav_dir = app.path().app_data_dir().ok().map(|d| d.join("favicons"));
    app.manage(favicon::FaviconCache::new(fav_dir));
}

/// Bookmarks, named sessions, daily snapshots (+ capture loop), downloads,
/// dark mode, nav toggles, per-page notes, and browsing history (hydrated +
/// flushed off-thread).
fn init_sessions_history(app: &tauri::App, boot_started: std::time::Instant) {
    // Bookmarks (#22) — persisted store + Chrome import.
    let bm_path = app
        .path()
        .app_data_dir()
        .map(|d| d.join("bookmarks.json"))
        .unwrap_or_else(|_| std::path::PathBuf::from("flux-bookmarks.json"));
    app.manage(boot_phase("bookmarks.restore", boot_started, || {
        bookmarks::BookmarkStore::restore(bm_path)
    }));
    // Named sessions (#47) — save/restore bundles of tabs.
    let sessions_path = app
        .path()
        .app_data_dir()
        .map(|d| d.join("sessions.json"))
        .unwrap_or_else(|_| std::path::PathBuf::from("flux-sessions.json"));
    app.manage(boot_phase("sessions.restore", boot_started, || {
        sessions::SessionStore::restore(sessions_path)
    }));
    // Daily auto-snapshots (#47): quietly snapshot the open tabs into a
    // per-day bucket every few minutes (keeps a week), so "reopen yesterday"
    // works without having saved anything.
    let snaps_path = app
        .path()
        .app_data_dir()
        .map(|d| d.join("snapshots.json"))
        .unwrap_or_else(|_| std::path::PathBuf::from("flux-snapshots.json"));
    app.manage(boot_phase("snapshots.restore", boot_started, || {
        sessions::SnapshotStore::restore(snaps_path)
    }));
    {
        let handle = app.handle().clone();
        std::thread::spawn(move || loop {
            std::thread::sleep(std::time::Duration::from_secs(300));
            if let (Some(snaps), Some(st)) = (
                handle.try_state::<sessions::SnapshotStore>(),
                handle.try_state::<state::FluxState>(),
            ) {
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
    app.manage(boot_phase("notes.restore", boot_started, || {
        notes::NoteStore::restore(notes_path)
    }));
    // Scribe — handwritten per-course notebooks (ADR 0014). One JSON file per
    // notebook under <app_data>/scribe/.
    let scribe_dir = app
        .path()
        .app_data_dir()
        .map(|d| d.join("scribe"))
        .unwrap_or_else(|_| std::path::PathBuf::from("flux-scribe"));
    app.manage(boot_phase("scribe.restore", boot_started, || {
        scribe::ScribeStore::restore(scribe_dir)
    }));
    // Cached storage report, so the resource monitor can warn without re-walking.
    app.manage(storage::StorageWarn::default());
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

    // Browsing provenance spine — "the Trail" (ADR 0011). Recorded from
    // dom_publish alongside history; same empty→hydrate→60s-flush lifecycle.
    let trace_path = app
        .path()
        .app_data_dir()
        .map(|d| d.join("trace").join("trace.json"))
        .unwrap_or_else(|_| std::path::PathBuf::from("flux-trace.json"));
    app.manage(trace::TraceStore::empty(trace_path));
    // Dwell-captured content snapshots (ADR 0011 step 1) — heavier, own file.
    let snap_path = app
        .path()
        .app_data_dir()
        .map(|d| d.join("trace").join("snapshots.json"))
        .unwrap_or_else(|_| std::path::PathBuf::from("flux-trace-snapshots.json"));
    app.manage(trace::TraceSnapshots::empty(snap_path));
    // Per-page chat threads (ADR 0011 step d) — same lifecycle.
    let chats_path = app
        .path()
        .app_data_dir()
        .map(|d| d.join("trace").join("chats.json"))
        .unwrap_or_else(|_| std::path::PathBuf::from("flux-trace-chats.json"));
    app.manage(trace::TraceChats::empty(chats_path));
    // Typed-draft capture (ADR 0011 final phase, opt-in) — sealed at rest.
    let drafts_path = app
        .path()
        .app_data_dir()
        .map(|d| d.join("trace").join("drafts.json"))
        .unwrap_or_else(|_| std::path::PathBuf::from("flux-trace-drafts.json"));
    app.manage(trace::TraceDrafts::empty(drafts_path));
    // Sentinel action audit log (ADR 0013, Pillar 0) — sealed like the trace stores.
    let audit_path = app
        .path()
        .app_data_dir()
        .map(|d| d.join("sentinel").join("audit.json"))
        .unwrap_or_else(|_| std::path::PathBuf::from("flux-sentinel-audit.json"));
    app.manage(sentinel::SentinelAudit::empty(audit_path));
    {
        let handle = app.handle().clone();
        std::thread::spawn(move || {
            if let Some(t) = handle.try_state::<trace::TraceStore>() {
                t.hydrate();
            }
            if let Some(au) = handle.try_state::<sentinel::SentinelAudit>() {
                au.hydrate();
            }
            if let Some(s) = handle.try_state::<trace::TraceSnapshots>() {
                s.hydrate();
            }
            if let Some(c) = handle.try_state::<trace::TraceChats>() {
                c.hydrate();
            }
            if let Some(dr) = handle.try_state::<trace::TraceDrafts>() {
                dr.hydrate();
            }
            // Debounced KB auto-reindex of the `web` source (#136 payoff): fold
            // settled browsing into the Notebook without a manual ↻ Reindex.
            // "Settled" = the snapshot generation is unchanged for one full tick
            // but ahead of what's indexed — so active browsing defers, a pause
            // indexes. Incremental (doc_id = visit id), so only new pages embed.
            // FLUX_TRAIL_AUTOINDEX=0 opts out.
            let autoindex = std::env::var("FLUX_TRAIL_AUTOINDEX")
                .map(|v| v != "0")
                .unwrap_or(true);
            let mut last_seen: u64 = 0;
            let mut last_indexed: u64 = 0;
            loop {
                std::thread::sleep(std::time::Duration::from_secs(60));
                if let Some(t) = handle.try_state::<trace::TraceStore>() {
                    t.persist_if_dirty();
                }
                if let Some(s) = handle.try_state::<trace::TraceSnapshots>() {
                    s.persist_if_dirty();
                }
                if let Some(c) = handle.try_state::<trace::TraceChats>() {
                    c.persist_if_dirty();
                }
                if let Some(dr) = handle.try_state::<trace::TraceDrafts>() {
                    dr.persist_if_dirty();
                }
                if let Some(au) = handle.try_state::<sentinel::SentinelAudit>() {
                    au.persist_if_dirty();
                }
                if !autoindex {
                    continue;
                }
                if let (Some(s), Some(kb)) = (
                    handle.try_state::<trace::TraceSnapshots>(),
                    handle.try_state::<kb::KbStore>(),
                ) {
                    let generation = s.generation();
                    let settled = generation == last_seen && generation != last_indexed;
                    last_seen = generation;
                    if !settled {
                        continue;
                    }
                    // If the embedder changed since the corpus was built (e.g.
                    // Ollama came up), a single-source reindex would clear every
                    // source and rebuild only `web` — heal by rebuilding all.
                    let source = if kb.embedder() != embedding::current() {
                        None
                    } else {
                        Some("web".to_string())
                    };
                    // A None source rebuilds every corpus, so the in-process
                    // ones must both be supplied or the rebuild would wipe them.
                    let scribe_docs = handle
                        .try_state::<scribe::ScribeStore>()
                        .map(|st| kb::scribe_docs(&st))
                        .unwrap_or_default();
                    match kb.reindex(source, s.web_docs(), scribe_docs) {
                        Ok(_) => {
                            last_indexed = generation;
                            tracing::info!(target: "flux::kb", generation, "auto-indexed browsing into the web source");
                        }
                        // Busy (a manual reindex is running) or a source failed —
                        // leave last_indexed behind so the next settled tick retries.
                        Err(e) => {
                            tracing::debug!(target: "flux::kb", "web auto-reindex skipped: {e}")
                        }
                    }
                }
            }
        });
    }
}

/// Password vault (#61): keychain-backed store + off-thread keychain
/// hydration + the idle auto-lock watchdog.
fn init_vault(app: &tauri::App, boot_started: std::time::Instant) {
    // Password vault (#61) — OS-keychain data key + decrypted-in-memory
    // for autofill; persists to app_data/vault/vault.bin.
    app.manage(boot_phase("vault.load", boot_started, || {
        vault::VaultState::load(app.handle())
    }));
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
}

/// Native window decoration (Win11 rounded corners) + the boot log line.
fn finish_boot(app: &tauri::App, boot_started: std::time::Instant) {
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
}

/// Build the Tauri application. Split from `main` for testability.
pub fn run(intent: cli::LaunchIntent) {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "flux=info".into()),
        )
        .init();

    // Before Tauri builds anything: a queued clear must run while the engine
    // still holds no profile files open (see storage.rs).
    storage::apply_pending_clear_early();
    enable_http3();

    let builder = tauri::Builder::default();
    // Single-instance + window-state are desktop-only plugins (no argv, no window
    // geometry on Android — ADR 0012). Gate them so the mobile build links.
    #[cfg(desktop)]
    let builder = builder
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
        // Persist + restore window size/position across launches. We skip the
        // plugin's auto-restore for "main" and restore it ourselves (SIZE|POSITION
        // only, in setup) so Flux always reopens *windowed* at its last floating
        // size — never maximized/fullscreen. The save still tracks all flags, so
        // the un-maximized size is preserved even if you close while maximized.
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .skip_initial_state("main")
                .build(),
        );
    // Mobile: the native android.webkit.WebView stack that renders browser tabs
    // (ADR 0012, Milestone 2); driven by webview.rs's mobile arm.
    #[cfg(mobile)]
    let builder = builder.plugin(tauri_plugin_flux_webview::init());
    builder
        // OS notifications (used by the reminder scheduler).
        .plugin(tauri_plugin_notification::init())
        .setup(move |app| {
            let boot_started = std::time::Instant::now();
            // Boot is a fixed sequence of per-domain init phases (Phase 2
            // refactor: this closure was 330 lines). Order matters — e.g.
            // FluxState before anything that reads it, shields before webviews.
            restore_window_geometry(app);
            init_core_state(app, intent, boot_started);
            init_privacy(app, boot_started);
            init_extensions(app, boot_started);
            init_page_intel(app, boot_started);
            init_knowledge(app, boot_started);
            init_user_content(app, boot_started);
            init_sessions_history(app, boot_started);
            init_vault(app, boot_started);
            finish_boot(app, boot_started);
            Ok(())
        })
        // `dom_publish` lives in the `fluxtab` inlined plugin (see build.rs):
        // it's the one command remote tab pages may call (DOM capture), so it
        // must be plugin-namespaced to be grantable to remote `tab-*` webviews.
        .plugin(
            tauri::plugin::Builder::<tauri::Wry>::new("fluxtab")
                .invoke_handler(tauri::generate_handler![
                    dom::dom_publish,
                    dom::chrome_open_url,
                    peek::chrome_peek_url,
                    peek::peek_promote,
                    peek::peek_pin,
                    peek::peek_close,
                    macros::macro_record_step,
                    broker::ext_broker_call,
                    dom::chrome_key,
                    dom::find_result,
                    dom::reader_publish,
                    hibernate::hibernate_capture,
                    // Page-callable and therefore MUST live in the fluxtab plugin
                    // handler: `plugin:fluxtab|cmd` dispatches only via
                    // `extend_api("fluxtab", …)` with no fallback to the app
                    // handler (tauri webview/mod.rs). panel_badge + the vault
                    // sentinel commands were declared in build.rs's ACL list but
                    // never registered here, so they silently 404'd at runtime.
                    webview::panel_badge,
                    vault::vault_page_info,
                    vault::vault_fill_page,
                    vault::vault_suggest_password,
                    vault::vault_save_from_page,
                    vault::vault_page_matches,
                    vault::vault_fill_page_id,
                    vault::vault_offer_save,
                    vault::vault_probe_report,
                    sentinel::sentinel_input_focus,
                    trace::trace_drafts_enabled,
                    trace::draft_publish
                ])
                .build(),
        )
        .invoke_handler(tauri::generate_handler![
            commands::shell_snapshot,
            commands::close_main_window,
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
            dom::chrome_focus,
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
            dom::dom_active_bytes,
            dom::tab_dom_sizes,
            dom::terminal_env,
            agent::agent_status,
            agent::agent_execute,
            agent::agent_plan,
            agent::agent_task_step,
            agent::agent_run_action,
            agent::agent_chat,
            agent::agent_chat_stream,
            agent::agent_shell_plan,
            agent::agent_pac_plan,
            agent::reader_structure,
            agent::pac_status,
            agent::agent_plan_steps,
            proxy::proxy_get,
            proxy::proxy_set,
            agent::agent_next_step,
            agent::agent_edit_plan,
            agent::agent_translate,
            agent::agent_chat_tabs,
            agent::agent_chat_tabs_stream,
            agent::agent_models,
            agent::agent_model,
            agent::agent_set_model,
            agent::omni_search,
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
            webview::webview_thumbnail,
            sentinel::sentinel_audit_list,
            sentinel::sentinel_audit_clear,
            sentinel::sentinel_on_navigate,
            sentinel::sentinel_after_load,
            sentinel::sentinel_assess_permission,
            sentinel::sentinel_tracker_narrative,
            sentinel::sentinel_policy_flags,
            sentinel::sentinel_reject_consent,
            mem::mem_status,
            mem::system_stats,
            darkmode::darkmode_status,
            darkmode::darkmode_set,
            nav::nav_status,
            nav::nav_set,
            notes::note_get,
            notes::note_set,
            notes::notes_list,
            scribe::scribe_list,
            scribe::scribe_load,
            scribe::scribe_create,
            scribe::scribe_save,
            scribe::scribe_delete,
            scribe::scribe_publish_page,
            scribe::scribe_proofread,
            storage::storage_usage,
            storage::storage_clear,
            storage::storage_clear_cancel,
            storage::storage_last,
            feeds::feeds_list,
            feeds::feed_add,
            feeds::feed_remove,
            feeds::feed_items,
            calendar::cal_list,
            calendar::cal_add,
            calendar::cal_remove,
            calendar::cal_import_feed,
            calendar::cal_events,
            calendar::cal_local_events,
            calendar::cal_event_add,
            calendar::cal_event_update,
            calendar::cal_event_delete,
            currency::currency_rates,
            shellhist::shell_history_search,
            shellhist::shell_history_reindex,
            semfind::semantic_find,
            watch::watch_list,
            watch::watch_is_watched,
            watch::watch_add,
            watch::watch_remove,
            watch::watch_mark_seen,
            watch::watch_check_now,
            trackers::tracker_graph,
            trackers::tracker_clear,
            todos::todos_list,
            todos::todo_add,
            todos::todo_edit,
            todos::todos_reorder,
            todos::todo_set_profile,
            todos::todo_toggle,
            todos::todo_remove,
            todos::todos_clear_done,
            favicon::favicon,
            history::history_recent,
            history::history_search,
            history::history_delete,
            history::history_clear,
            trace::trace_recent,
            trace::trace_visit,
            trace::trace_graph,
            trace::trace_rename_task,
            trace::trace_histogram,
            trace::trace_branches,
            trace::trace_forget,
            trace::trace_snapshot,
            trace::trace_snapshot_get,
            trace::trace_ambient,
            trace::trace_tab_thread,
            trace::trace_drafts,
            trace::trace_drafts_enabled,
            trace::trace_drafts_set,
            trace::trace_chat,
            trace::trace_chat_send,
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
            // Chrome-triggered peek (right-click / Alt-click). A plain app
            // command — the page-side peek trigger is `chrome_peek_url` in the
            // fluxtab plugin handler; keep the two apart (see the fluxtab ACL
            // guard test).
            peek::peek_open,
            webview::panel_open,
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
            reminders::os_notify,
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
            spotify::spotify_state,
            spotify::spotify_playlists,
            spotify::spotify_play_context,
            audioviz::audioviz_stream,
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
            permissions::permission_answer,
            extensions::ext_install,
            extensions::ext_list,
            extensions::ext_set_enabled,
            extensions::ext_remove,
            vault::vault_why,
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
            vault::vault_save_confirm,
            vault::vault_save_dismiss,
            vault::vault_never_save,
            files::fs_list,
            files::fs_list_stream,
            files::fs_search,
            kb::kb_status,
            kb::kb_recent,
            kb::kb_reindex,
            kb::kb_set_source,
            kb::kb_query,
            kb::kb_related,
            kb::kb_answer,
            kb::scroll_clip,
            kb::onyx_new_note,
            kb::onyx_capture_page,
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

/// Android entry point (ADR 0012, rung C). The generated Gradle project's JNI
/// glue calls this — there's no argv on mobile, so we launch with an empty
/// intent (no URLs, no terminal). Desktop keeps using `main.rs` → `run(intent)`.
#[cfg(mobile)]
#[tauri::mobile_entry_point]
pub fn mobile_run() {
    run(cli::LaunchIntent::default());
}

#[cfg(test)]
mod browser_arg_tests {
    use super::compose_browser_args;

    #[test]
    fn quic_is_opt_out_and_user_flags_are_kept() {
        assert_eq!(compose_browser_args("", "", true), "--enable-quic");
        // The whole point of FLUX_NO_QUIC: HTTP/3 must actually be off. Merely
        // omitting --enable-quic leaves it on, since it's the engine default —
        // the opt-out has to say --disable-quic or it silently does nothing.
        assert_eq!(compose_browser_args("", "", false), "--disable-quic");
        assert!(compose_browser_args("", "--disable-gpu", false).contains("--disable-quic"));
        // Pre-existing args survive, and nothing is added twice.
        assert_eq!(
            compose_browser_args("--foo", "--disable-gpu", true),
            "--foo --enable-quic --disable-gpu"
        );
        assert_eq!(
            compose_browser_args("--foo", "", false),
            "--foo --disable-quic"
        );
        assert_eq!(
            compose_browser_args("--enable-quic", "", true),
            "--enable-quic",
            "already present, not repeated"
        );
        // Substring matches must not count as present — `--enable-quic` inside
        // some longer flag isn't the same flag.
        assert_eq!(
            compose_browser_args("--enable-quic-foo", "", true),
            "--enable-quic-foo --enable-quic"
        );
        // Multiple user flags, whitespace-separated.
        assert_eq!(
            compose_browser_args("", "--disable-gpu --disable-features=X", false),
            "--disable-quic --disable-gpu --disable-features=X"
        );
    }
}
