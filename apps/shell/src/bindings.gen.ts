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
export type CalEvent = { calendar: string; summary: string; date: string; time: string; end: string; location: string; sort_key: number; id: number; editable: boolean; notes: string }
/**
 * A Flux-local calendar event (on-device, fully editable). Distinct from a
 * read-only ICS `CalEvent` — these are what the grid editor and Gemma write to.
 */
export type LocalEvent = { id: number; title: string; date: string; start: string; end: string; location: string; notes: string }
export type CurrencyRates = { base: string; date: string; rates: { [key: string]: number } }
/**
 * One ranked match returned to the UI.
 */
export type ShellHistHit = { command: string; score: number; source: string; ts: number | null }
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
export type CredentialMeta = { id: string; name: string; urls: string[]; username: string; has_totp: boolean }
export type VaultStatus = { available: boolean; locked: boolean; protection: string; source: string; count: number; autolock_minutes: number }
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
