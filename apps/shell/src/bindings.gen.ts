// AUTO-GENERATED from crates/flux-core/src/state.rs (BACKLOG #12).
// Do NOT edit by hand. Regenerate: `FLUX_WRITE_BINDINGS=1 cargo test -p flux-core bindings`.

/**
 * What lives inside a tab. Flux tabs are first-class for BOTH web pages and
 * terminal sessions — a Terminal tab hosts a flux-term surface where a
 * Browser tab hosts a webview, and everything else (pinning, clustering,
 * focus) treats them identically.
 */
export type TabKind = "browser" | "terminal" | "files"
/**
 * A semantic cluster: stable id + the display color the UI paints the tab.
 */
export type ClusterTag = { id: number; color: number }
/**
 * Metadata for one open tab. Small (~100 B) and `Clone` — cheap to hand to
 * the frontend wholesale on every mutation.
 */
export type TabMeta = { id: number; kind: TabKind; url: string; title: string; pinned: boolean; cluster: ClusterTag | null; group?: number | null; folder?: number | null; custom_title?: string | null; workspace?: number; private?: boolean; container?: number }
export type ShellSnapshot = { tabs: TabMeta[]; active_tab: number | null; groups: TabGroup[]; folders: TabFolder[]; workspaces: Workspace[]; active_workspace: number; panels: WebPanel[]; containers: Container[] }
/**
 * An Arc-style workspace (BACKLOG #44): a named, colored set of tabs. Only the
 * active workspace's tabs hold live webviews — inactive ones are pure metadata
 * (kilobytes), so switching is cheap.
 */
export type Workspace = { id: number; name: string; color: number }
/**
 * A manual, user-controlled tab group (BACKLOG #56) — named, colored,
 * collapsible. Distinct from the auto semantic `cluster`, though "group by
 * topic" can seed groups from clusters.
 */
export type TabGroup = { id: number; name: string; color: number; collapsed?: boolean }
/**
 * A tab folder — a named bucket whose tabs are kept hibernated to save RAM.
 * Distinct from [`TabGroup`] (inline, colored, strip-resident): folders live in
 * a collapsible section above the footer and exist to park tabs out of memory.
 */
export type TabFolder = { id: number; name: string; collapsed?: boolean }
/**
 * A multi-account container (BACKLOG #59): tabs in a container share an isolated
 * cookie/storage jar (a per-webview `data_directory`), so you can be logged into
 * two accounts of the same site at once. Container 0 = "Default" (implicit, no
 * isolation) and is never stored here.
 */
export type Container = { id: number; name: string; color: number }
/**
 * A pinned web panel (BACKLOG #48): a site (chat, docs, music, …) you can show
 * in a slim pane beside any tab. Persists across restart; only the *open* panel
 * holds a live webview (RAM-conscious — inactive pins are just metadata).
 */
export type WebPanel = { id: number; url: string; title: string }
/**
 * What the Flux Agent is currently doing. The UI maps this 1:1 to the
 * magenta/violet "Liquid AI" visual states.
 */
export type AgentStatus = { state: "idle" } | { state: "thinking"; prompt: string } | { state: "acting"; description: string; selector: string } | { state: "error"; message: string }
export type Bookmark = { id: number; title: string; url: string; folder: string; added_ms: number }
/**
 * A subscribed feed. Only the subscription is persisted (id, url, title).
 */
export type Feed = { id: number; url: string; title: string }
/**
 * One entry of a feed — fetched live, never persisted.
 */
export type FeedItem = { feed_id: number; feed_title: string; title: string; link: string; summary: string; published: string }
export type PwaApp = { id: number; name: string; url: string }
export type HistoryEntry = { url: string; title: string; last_visit_ms: number; visits: number }
export type SavedTab = { url: string; title: string; pinned: boolean }
export type SavedSession = { id: number; name: string; created_ms: number; tabs: SavedTab[] }
export type DaySnapshot = { day: number; captured_ms: number; tabs: SavedTab[] }
/**
 * One running process, as shown in the task manager.
 */
export type ProcInfo = { pid: number; name: string; cpu: number; mem_mb: number; is_flux: boolean; current: boolean }
/**
 * System-wide CPU / memory / swap / network snapshot for the task manager.
 */
export type SysStats = { cpu: number; per_core: number[]; cpu_brand: string; mem_used_mb: number; mem_total_mb: number; mem_pct: number; swap_used_mb: number; swap_total_mb: number; cores: number; uptime_secs: number; net_rx_bps: number; net_tx_bps: number }
/**
 * One GPU's live stats (NVIDIA via `nvidia-smi`).
 */
export type GpuInfo = { name: string; util_pct: number; mem_used_mb: number; mem_total_mb: number; temp_c: number; power_w: number }
export type SpeedResult = { ping_ms: number; jitter_ms: number; download_mbps: number; upload_mbps: number; server: string }
/**
 * List/search row — metadata + a short snippet (the full text stays out of list
 * payloads; fetch it with `archive_get`).
 */
export type ArchiveMeta = { id: number; url: string; title: string; saved_ms: number; snippet: string; score: number }
/**
 * A subscribed calendar (its ICS URL). Only this is persisted.
 */
export type CalFeed = { id: number; url: string; name: string }
/**
 * One event, in the feed's own calendar terms (no tz conversion).
 */
export type CalEvent = { calendar: string; summary: string; date: string; time: string; end: string; location: string; sort_key: number; id: number; editable: boolean; notes: string; rrule?: string }
/**
 * A Flux-local calendar event (on-device, fully editable). Distinct from a
 * read-only ICS `CalEvent` — these are what the grid editor and Gemma write to.
 */
export type LocalEvent = { id: number; title: string; date: string; start: string; end: string; location: string; notes: string; rrule?: string }
export type CurrencyRates = { base: string; date: string; rates: { [key: string]: number } }
/**
 * One ranked match returned to the UI.
 */
export type ShellHistHit = { command: string; score: number; source: string; ts: number | null }
/**
 * One ranked passage match.
 */
export type FindHit = { tab_id: number; title: string; url: string; passage: string; score: number }
/**
 * UI-facing view (no baseline text — that can be large).
 */
export type WatchItem = { id: number; url: string; title: string; interval_secs: number; last_checked_ms: number; last_change_ms: number; added: string[]; removed: string[]; error: string | null; seen: boolean }
export type TrackerNode = { id: string; kind: string; requests: number; blocked: number; degree: number }
export type TrackerEdge = { source: number; target: number; requests: number; blocked: number }
export type TrackerGraph = { nodes: TrackerNode[]; edges: TrackerEdge[] }
export type Todo = { id: number; title: string; done: boolean; created_ms: number; due?: string }
/**
 * One unified search result (BACKLOG #66): an open tab, a bookmark, or a
 * history entry, ranked together by embedding similarity to the query.
 */
export type OmniHit = { kind: string; tab_id: number | null; title: string; url: string; snippet: string; score: number }
/**
 * One structured block of a reader-mode extraction (#41): a heading, paragraph,
 * list item, quote, preformatted block, image caption, or image.
 */
export type ReaderBlock = { kind: string; text?: string; level?: number; src?: string }
export type ShieldsStatus = { enabled: boolean; blocked: number; sites_off: string[]; cache_hit_pct: number; cache_len: number; rules_fired: number }
export type HotRule = { rule: string; hits: number }
export type LeanStatus = { enabled: boolean; sites_on: string[] }
export type HttpsStatus = { enabled: boolean; sites_allow_http: string[] }
export type CookieStatus = { clear_on_close: string[] }
/**
 * The permission kinds Flux surfaces. Anything else from the engine maps to
 * [`PermKind::Other`].
 */
export type PermKind = "camera" | "microphone" | "geolocation" | "notifications" | "clipboard_read" | "other"
/**
 * What the user decided for a (site, kind). `Ask` = no remembered decision, so
 * the engine's own prompt is shown.
 */
export type PermDecision = "ask" | "allow" | "deny"
/**
 * One remembered decision, for the manager UI + persistence.
 */
export type SitePerm = { host: string; kind: PermKind; decision: PermDecision }
/**
 * A live Ask, sent to the shell as the `flux://permission-ask` payload. The
 * shell answers with `permission_answer(id, …)`.
 */
export type PermAsk = { id: number; host: string; kind: PermKind }
export type CredentialMeta = { id: string; name: string; urls: string[]; username: string; has_totp: boolean }
export type VaultStatus = { available: boolean; locked: boolean; protection: string; source: string; count: number; autolock_minutes: number }
/**
 * The chrome's "Save password?" bar payload — host + username only; the
 * captured password stays in Rust ([`PendingSave`]) until the user confirms.
 */
export type VaultSavePrompt = { host: string; username: string; update: boolean }
export type ContentScript = { matches: string[]; js?: string[]; css?: string[]; run_at?: string }
export type ToolbarButton = { title: string; icon?: string | null }
export type UiContrib = { toolbar_button?: ToolbarButton | null; panel?: boolean | null }
export type Manifest = { id: string; name: string; version: string; permissions?: string[]; content_scripts?: ContentScript[]; background?: string | null; ui?: UiContrib | null }
/**
 * One installed extension: its manifest, where it lives on disk, and whether
 * it's enabled.
 */
export type InstalledExt = { manifest: Manifest; dir: string; enabled: boolean }
/**
 * One recorded action. Tagged enum → clean JSON for the UI + persistence.
 */
export type Step = { kind: "navigate"; url: string } | { kind: "click"; selector: string } | { kind: "type"; selector: string; text: string } | { kind: "wait"; ms: number }
export type Macro = { id: number; name: string; steps: Step[] }
export type MacroStatus = { recording: boolean; step_count: number }
export type Boost = { id: number; host: string; name: string; css?: string; js?: string; enabled: boolean }
export type DownloadItem = { id: number; url: string; filename: string; path: string; received: number; total: number; state: string; started_ms: number }
/**
 * One directory entry. Compact on purpose — see module docs.
 */
export type FileEntry = { name: string; is_dir: boolean; symlink: boolean; size: number | null; modified: number | null }
/**
 * A directory's contents plus where it sits.
 */
export type DirListing = { path: string; parent: string | null; entries: FileEntry[] }
/**
 * A pinned spot in the left rail.
 */
export type QuickLocation = { name: string; path: string; kind: string }
/**
 * A search hit (wire type) — metadata + a snippet, never the whole corpus.
 */
export type KbHit = { source: string; doc_id: string; title: string; path: string; snippet: string; score: number }
/**
 * Per-source counts for the Notebook view's status strip.
 */
export type KbSourceStat = { source: string; docs: number; chunks: number; last_ms: number; error: string | null; location: string | null }
export type KbStatus = { sources: KbSourceStat[]; embedder: string; indexing: boolean }
/**
 * A recently-indexed document, for the weekly digest (#125).
 */
export type KbRecentItem = { source: string; title: string; path: string; indexed_at: number; snippet: string }
/**
 * Result of a save-time novelty/contradiction check (#124).
 */
export type KbCheck = { verdict: string; note: string; related: KbHit[] }
/**
 * One launchable terminal app.
 */
export type TuiApp = { id: string; name: string; icon: string; cmd: string; cwd: string }
/**
 * A discovered specialist available to route to.
 */
export type Specialist = { domain: string; label: string; model: string }
export type ServiceStatus = { name: string; label: string; running: boolean }
/**
 * Structured playback state for the mini-player bubble (#125). `/me/player`
 * returns 204 (→ `None` → default) when there's no active device, so polling this
 * never trips the no-device auto-launch.
 */
export type SpotifyState = { playing: boolean; track: string; artist: string; art: string; progress_ms: number; duration_ms: number; volume: number; shuffle: boolean; repeat: string; has_device: boolean }
/**
 * One of the user's playlists (for the bubble's playlist menu).
 */
export type SpotifyPlaylist = { name: string; uri: string; art: string }
export type SyncStatus = { folder: string | null; unlocked: boolean; last_ms: number; auto: boolean }
export type SyncReport = { bookmarks_added: number; sessions_added: number; history_added: number }
/**
 * The wire shape of a full archived page (BACKLOG #12): the reader-facing fields
 * only. The persisted [`ArchiveEntry`] also carries the embedding vector +
 * embedder tag, which are an on-disk concern the frontend never needs — keeping
 * them off the wire is the persist/wire split, and lets this be the
 * specta-generated type (`ArchiveEntry` can't derive `Type` cleanly with the
 * private embedding fields).
 */
export type ArchiveEntryWire = { id: number; url: string; title: string; saved_ms: number; text: string }
/**
 * What the user asked for at launch. Managed into Tauri state; the shell
 * pulls it once on mount (`launch_intent` command) and materializes tabs.
 */
export type LaunchIntent = { urls: string[]; terminal: boolean }
export type Reminder = { id: string; text: string; due: number | null; fired?: boolean; created?: number }
export type MemInfo = { total_mb: number; available_mb: number; process_mb: number; available_pct: number }
/**
 * A background tab the frontend is considering hibernating.
 */
export type HibernateCandidate = { tab_id: number; url: string; idle_secs: number }
/**
 * One candidate's eviction priority. Higher `score` → evict sooner.
 */
export type EvictionRank = { tab_id: number; score: number; protected: boolean }
/**
 * A predicted next host worth preconnecting, with the model's confidence (%).
 */
export type PrefetchHint = { host: string; confidence: number }
/**
 * A search engine, defined entirely by templates. `{query}` in a template is
 * replaced with the percent-encoded query.
 * 
 * Example (the user's own engine):
 * ```
 * # use flux_search::SearchEngine;
 * let mine = SearchEngine {
 * id: "flux".into(),
 * name: "Flux Search".into(),
 * keyword: Some("f".into()),
 * search_template: "https://search.example.com/?q={query}".into(),
 * suggest_template: Some("https://search.example.com/ac?q={query}".into()),
 * };
 * assert_eq!(mine.search_url("rust lang"), "https://search.example.com/?q=rust%20lang");
 * ```
 */
export type SearchEngine = { id: string; name: string; keyword?: string | null; search_template: string; suggest_template?: string | null }
/**
 * The result of resolving omnibox input.
 */
export type Resolution = { kind: "navigate"; url: string } | { kind: "search"; engine: string; url: string }
/**
 * The closed action vocabulary. Adding a variant = adding a capability;
 * each one must come with a compile template and a policy review.
 */
export type AgentAction = { action: "click"; selector: string; reason: string } | { action: "extract_table"; selector: string; format: ExtractFormat } | { action: "type"; selector: string; text: string } | { action: "reveal"; selector: string } | { action: "refuse"; reason: string } | { action: "finish"; summary: string }
export type ExtractFormat = "csv" | "json"
/**
 * One surgical file edit: replace the first occurrence of `search` with `replace`.
 */
export type FileEdit = { search: string; replace: string }
/**
 * A planned set of edits the frontend applies after the user approves the diff.
 */
export type EditPlan = { summary: string; edits: FileEdit[] }
/**
 * One iteration of an adaptive goal loop (#115 follow-up): the next command to run,
 * or `done` with a summary when the goal is met / the model is stuck.
 */
export type NextStep = { command?: string; done?: boolean; summary?: string }
/**
 * A planned `pac` invocation for the approval card. `command` may be empty when
 * the request doesn't map to a `pac` operation (`explanation` says why).
 * `danger`/`read_only` are derived in Rust from `command`, not the model.
 */
export type PacPlan = { command: string; explanation: string; danger: string | null; read_only: boolean }
/**
 * Preflight for the `pac` tool: is the CLI installed, and is there an active
 * auth profile? Both checks are read-only `pac` invocations. Lets the agent
 * tell the user to install `pac` or run `pac auth create` before proposing ALM
 * commands, instead of failing opaquely at run time.
 */
export type PacStatus = { installed: boolean; authenticated: boolean; detail: string }
/**
 * Where a visit came from and why — the provenance that turns flat history into
 * a graph. All fields are best-effort; the slice fills `from_visit`/`referrer`
 * (from the tab's prior visit) and `task` (the active workspace). `query` is
 * wired in a later phase.
 */
export type Provenance = { from_visit: number | null; referrer: string | null; query: string | null; task: string | null }
/**
 * One page visit. Kept minimal in the slice; snapshot/chat/marks/entities join
 * in later phases (ADR 0011) as additive fields.
 */
export type Visit = { id: number; url: string; title: string; first_ms: number; last_ms: number; hits: number; why: Provenance; snapshot_id?: number | null }
/**
 * Edge kinds. `Nav` is captured for free on every navigation; the rest are
 * derived in later phases (semantic neighbours, citation/repo detection).
 */
export type EdgeKind = "nav" | "semantic" | "cites" | "implements" | "same"
export type Edge = { from: number; to: number; kind: EdgeKind }
/**
 * The graph read model handed to the Trail view (visits + the edges among them,
 * optionally windowed by time).
 */
export type TraceGraph = { visits: Visit[]; edges: Edge[] }
/**
 * What `trace_forget` removes. Every scope also drops edges touching removed
 * visits and any `by_tab` pointers into them.
 */
export type ForgetScope = { kind: "url"; url: string } | { kind: "host"; host: string } | { kind: "range"; after_ms: number | null; before_ms: number | null } | { kind: "all" }
/**
 * Reader-facing snapshot (node detail); omits the vector + embedder tag.
 */
export type SnapshotWire = { id: number; visit_id: number; url: string; saved_ms: number; text: string }
export type ChromeProfilePreview = { dir: string; name: string; bookmark_count: number; extension_count: number; has_saved_tab_groups: boolean }
/**
 * A flattened bookmark: folder hierarchy preserved as a path string so the
 * Flux bookmark store can rebuild the tree (or just display the path).
 */
export type ChromeBookmark = { name: string; url: string; folder: string }
