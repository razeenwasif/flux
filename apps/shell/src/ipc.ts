/**
 * Typed IPC layer over Tauri v2. All shapes mirror the Rust structs in
 * crates/flux-core/src/state.rs — keep the two in lockstep (codegen via
 * specta is issue #12).
 */
import { Channel, invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";

export { Channel };

// ─── Window controls (custom chrome — decorations are off) ──────────────────

export type ResizeDir =
  | "North" | "South" | "East" | "West"
  | "NorthEast" | "NorthWest" | "SouthEast" | "SouthWest";

/** True only inside the Tauri runtime — lets the mocked UI preview no-op. */
const inTauri = () => typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

/** macOS-style window controls + custom drag/resize, safe outside Tauri. */
export const win = {
  minimize: () => inTauri() && void getCurrentWindow().minimize(),
  toggleMaximize: () => inTauri() && void getCurrentWindow().toggleMaximize(),
  // destroy() force-closes; close() only emits closeRequested (which wasn't
  // closing the borderless multi-webview window).
  close: () => inTauri() && void getCurrentWindow().destroy(),
  startDragging: () => inTauri() && void getCurrentWindow().startDragging(),
  startResize: (dir: ResizeDir) => inTauri() && void getCurrentWindow().startResizeDragging(dir),
};

/** Reserved session id for the vertical terminal column (see terminal.rs). */
export const PANE_SESSION = 0;

/** Sentinel url for the Flux start page (no webview; renders the dashboard). */
export const START_URL = "flux://start";
export const isStartUrl = (url: string) => url === START_URL || url.startsWith("flux://");

export interface ClusterTag { id: number; color: number }

export type TabKind = "browser" | "terminal" | "files";

export interface TabMeta {
  id: number;
  kind: TabKind;
  /** Page URL for browser tabs; working directory for terminal tabs. */
  url: string;
  title: string;
  pinned: boolean;
  cluster: ClusterTag | null;
}

export interface LaunchIntent {
  urls: string[];
  terminal: boolean;
}

export interface ChromeProfilePreview {
  dir: string;
  name: string;
  bookmark_count: number;
  extension_count: number;
  has_saved_tab_groups: boolean;
}

export interface ChromeBookmark {
  name: string;
  url: string;
  folder: string;
}

export type AgentStatus =
  | { state: "idle" }
  | { state: "thinking"; prompt: string }
  | { state: "acting"; description: string; selector: string }
  | { state: "error"; message: string };

export type AgentAction =
  | { action: "click"; selector: string; reason: string }
  | { action: "extract_table"; selector: string; format: "csv" | "json" }
  | { action: "type"; selector: string; text: string }
  | { action: "reveal"; selector: string }
  | { action: "refuse"; reason: string };

// ─── Commands ────────────────────────────────────────────────────────────

export const tabCreate = (kind: TabKind, url?: string) =>
  invoke<TabMeta>("tab_create", { kind, url: url ?? null });
export const tabFocus = (id: number) => invoke<void>("tab_focus", { id });
export const tabClose = (id: number) => invoke<void>("tab_close", { id });
export const tabList = () => invoke<TabMeta[]>("tab_list");
export const tabSetPinned = (id: number, pinned: boolean) =>
  invoke<void>("tab_set_pinned", { id, pinned });
/** Sync a tab's live url/title to the backend so the persisted session is current. */
export const tabSetUrl = (id: number, url: string, title?: string) =>
  invoke<void>("tab_set_url", { id, url, title: title ?? null });
/** The backend's currently-focused tab id (for restoring focus on boot). */
export const tabActive = () => invoke<number | null>("tab_active");
export const launchIntent = () => invoke<LaunchIntent>("launch_intent");
export const chromeImportPreview = () =>
  invoke<ChromeProfilePreview[]>("chrome_import_preview");
export const chromeImportBookmarks = (profileDir: string) =>
  invoke<ChromeBookmark[]>("chrome_import_bookmarks", { profileDir });
export const terminalEnv = () => invoke<Record<string, string>>("terminal_env");
export const agentExecute = (prompt: string) => invoke<AgentAction>("agent_execute", { prompt });
/** Free-form chat with the local model (no page required). Returns the reply. */
export const agentChat = (prompt: string) => invoke<string>("agent_chat", { prompt });
export const tabsRecluster = () => invoke<void>("tabs_recluster");

/**
 * Publish a DOM snapshot to Rust (plain JSON args — real pages' CSPs block the
 * raw-body IPC path). In practice the tab webview's injected capture.js does
 * this directly via `plugin:fluxtab|dom_publish`; this helper is for the chrome.
 */
export function domPublish(tabId: number, url: string, html: string, text: string) {
  return invoke<void>("plugin:fluxtab|dom_publish", { tabId, url, html, text });
}

// ─── Events (Rust → UI) ──────────────────────────────────────────────────

export const onAgentStatus = (cb: (s: AgentStatus) => void): Promise<UnlistenFn> =>
  listen<AgentStatus>("flux://agent-status", (e) => cb(e.payload));

export const onClustersUpdated = (cb: () => void): Promise<UnlistenFn> =>
  listen("flux://clusters-updated", () => cb());

export const onDomUpdated = (cb: (tabId: number) => void): Promise<UnlistenFn> =>
  listen<number>("flux://dom-updated", (e) => cb(e.payload));

/** An extension asked to open a tab (flux.tabs.open, BACKLOG #94). */
export const onExtOpenTab = (cb: (url: string) => void): Promise<UnlistenFn> =>
  listen<string>("flux://ext-open-tab", (e) => cb(e.payload));

/** An app keyboard chord forwarded from a focused tab webview (BACKLOG #18). */
export const onShortcut = (cb: (action: string) => void): Promise<UnlistenFn> =>
  listen<string>("flux://shortcut", (e) => cb(e.payload));

/** Find-in-page result from the page: [tabId, matchCount, found] (BACKLOG #33). */
export const onFindResult = (
  cb: (tabId: number, count: number, found: boolean) => void,
): Promise<UnlistenFn> =>
  listen<[number, number, boolean]>("flux://find-result", (e) => cb(...e.payload));

// ─── Search (pluggable backend) ─────────────────────────────────────────────

export interface SearchEngine {
  id: string;
  name: string;
  keyword: string | null;
  search_template: string;
  suggest_template: string | null;
}

export type Resolution =
  | { kind: "navigate"; url: string }
  | { kind: "search"; engine: string; url: string };

/** Resolve omnibox input → final URL (navigate vs search vs keyword). */
export const searchResolve = (input: string) => invoke<Resolution>("search_resolve", { input });
/** Live search suggestions from the default engine's suggest endpoint (#32). */
export const searchSuggest = (query: string) => invoke<string[]>("search_suggest", { query });
export const searchEngines = () => invoke<SearchEngine[]>("search_engines");
export const searchDefault = () => invoke<string>("search_default");
export const searchSetDefault = (id: string) => invoke<void>("search_set_default", { id });
/** Register (or replace by id) an engine — e.g. your own search backend. */
export const searchAddEngine = (engine: SearchEngine) =>
  invoke<void>("search_add_engine", { engine });
export const searchRemoveEngine = (id: string) => invoke<void>("search_remove_engine", { id });

// ─── Omni index dashboard (flux://omni) ─────────────────────────────────────

/** Sentinel url for the native Omni dashboard page (no webview). */
export const OMNI_URL = "flux://omni";

export interface OmniStats {
  live_docs: number;
  total_docs: number;
  tombstones: number;
  segments: number;
  embedded: boolean;
  ann: boolean;
  ann_vectors: number;
  dated: number;
  embedder_kind: string;
  embedder_dim: number;
  avg_title_len: number;
  avg_body_len: number;
  segment_sizes: { live: number; total: number }[];
  top_docs: { url: string; title: string; rank: number }[];
}

export interface OmniSite {
  key: string;
  name: string;
  home: string;
  blurb: string;
}

/** Fetch Omni's live `/stats` (proxied through Rust to dodge the webview CSP). */
export const omniStats = async (): Promise<OmniStats> =>
  JSON.parse(await invoke<string>("omni_stats"));

/** Fetch Omni's curated essential-site shortcuts (`/sites`). */
export const omniSites = async (): Promise<OmniSite[]> =>
  JSON.parse(await invoke<string>("omni_sites"));

// ─── Omni live ingest (feed browsed pages into the index) ───────────────────

/** Whether auto-ingest (index every substantial page on load) is on. */
export const omniIngestStatus = () => invoke<boolean>("omni_ingest_status");
/** Toggle auto-ingest for this session. */
export const omniIngestSetAuto = (enabled: boolean) =>
  invoke<void>("omni_ingest_set_auto", { enabled });
/** Explicitly save the active tab's page to Omni; returns Omni's JSON reply. */
export const omniIngestActive = async (): Promise<{ added: number; skipped: number }> =>
  JSON.parse(await invoke<string>("omni_ingest_active"));

// ─── Content blocker / shields (BACKLOG #57) ────────────────────────────────

export interface ShieldsStatus {
  enabled: boolean;
  /** Requests blocked this session. */
  blocked: number;
  /** Hosts the user has allowlisted (shields off). */
  sites_off: string[];
}

export const shieldsStatus = () => invoke<ShieldsStatus>("shields_status");
export const shieldsSetEnabled = (on: boolean) => invoke<void>("shields_set_enabled", { on });
/** Turn shields on/off for one site (`on = false` allowlists it). */
export const shieldsSetSite = (host: string, on: boolean) =>
  invoke<void>("shields_set_site", { host, on });
/** Re-fetch + rebuild the upstream filter lists (background). */
export const shieldsRefresh = () => invoke<void>("shields_refresh");

// ─── HTTPS-only mode (BACKLOG #58) ──────────────────────────────────────────

export interface HttpsStatus {
  enabled: boolean;
  /** Hosts allowlisted to stay on HTTP. */
  sites_allow_http: string[];
}

export const httpsStatus = () => invoke<HttpsStatus>("https_status");
export const httpsSetEnabled = (on: boolean) => invoke<void>("https_set_enabled", { on });
/** Allow (or stop allowing) a host to stay on plain HTTP under HTTPS-only. */
export const httpsAllowSite = (host: string, allow: boolean) =>
  invoke<void>("https_allow_site", { host, allow });

// ─── Cookie controls (BACKLOG #58) ──────────────────────────────────────────

/** Clear cookies for one host (all schemes). */
export const cookiesClearSite = (host: string) => invoke<void>("cookies_clear_site", { host });
/** Clear every cookie in the store. */
export const cookiesClearAll = () => invoke<void>("cookies_clear_all");

export interface CookieStatus {
  /** Hosts whose cookies are wiped when their tab closes. */
  clear_on_close: string[];
}
export const cookiesStatus = () => invoke<CookieStatus>("cookies_status");
/** Flag (or unflag) a host to clear its cookies when its tab closes. */
export const cookiesSetClearOnClose = (host: string, on: boolean) =>
  invoke<void>("cookies_set_clear_on_close", { host, on });

// ─── Tracking prevention (BACKLOG #58) ──────────────────────────────────────
// Level: 0 = Off · 1 = Basic · 2 = Balanced · 3 = Strict.
export const trackingStatus = () => invoke<number>("tracking_status");
export const trackingSetLevel = (level: number) => invoke<void>("tracking_set_level", { level });

// ─── Site permissions (BACKLOG #58) ─────────────────────────────────────────
/** Whether camera/mic/geo permission requests are auto-denied. */
export const permissionsStatus = () => invoke<boolean>("permissions_status");
export const permissionsSetBlock = (on: boolean) => invoke<void>("permissions_set_block", { on });

// ─── Password vault (BACKLOG #61, ADR 0009) ──────────────────────────────────
// Metadata only — passwords never come to the chrome except via vault_reveal
// (explicit) or are injected straight into the page by vault_fill.
export interface CredentialMeta {
  id: string;
  name: string;
  urls: string[];
  username: string;
  has_totp: boolean;
}
export interface VaultStatus {
  available: boolean;
  locked: boolean;
  /** "keychain" | "password" */
  protection: string;
  /** "keychain" | "file" | "password" | "none" */
  source: string;
  count: number;
  autolock_minutes: number;
}
/** Sentinel url for the full-page vault manager (DOM-rendered, no webview). */
export const VAULT_URL = "flux://passwords";
export const vaultStatus = () => invoke<VaultStatus>("vault_status");
/** Unlock a master-password-protected vault. */
export const vaultUnlock = (password: string) => invoke<void>("vault_unlock", { password });
/** Lock now (clears the decrypted vault + key from memory). */
export const vaultLock = () => invoke<void>("vault_lock");
/** Enable/change master-password protection (Argon2id; removes the keychain key). */
export const vaultSetMasterPassword = (password: string) => invoke<void>("vault_set_master_password", { password });
/** Remove master-password protection (verifies it, moves the key back to the keychain). */
export const vaultDisableMasterPassword = (password: string) =>
  invoke<void>("vault_disable_master_password", { password });
/** Idle auto-lock timeout in minutes (0 = never). */
export const vaultSetAutolock = (minutes: number) => invoke<void>("vault_set_autolock", { minutes });
/** Fires when the vault auto-locks after idle. */
export const onVaultLocked = (cb: () => void): Promise<UnlistenFn> =>
  listen("flux://vault-locked", () => cb());
export const vaultList = () => invoke<CredentialMeta[]>("vault_list");
export const vaultForHost = (host: string) => invoke<CredentialMeta[]>("vault_for_host", { host });
/** Reveal one password (explicit user action). */
export const vaultReveal = (id: string) => invoke<string | null>("vault_reveal", { id });
export const vaultAdd = (name: string, url: string, username: string, password: string) =>
  invoke<void>("vault_add", { name, url, username, password });
export const vaultRemove = (id: string) => invoke<void>("vault_remove", { id });
/** Import a Proton Pass export (CSV / ZIP / PGP / JSON) from a file path.
 *  `passphrase` is only needed for a PGP-encrypted export. Returns the count. */
export const vaultImportProton = (path: string, passphrase?: string) =>
  invoke<number>("vault_import_proton", { path, passphrase: passphrase ?? null });
/** Autofill credential `id` into the active tab's login form (same-origin enforced). */
export const vaultFill = (tabId: number, id: string) => invoke<void>("vault_fill", { tabId, id });

// ─── Extensions (BACKLOG #92, ADR 0008) ──────────────────────────────────────
// Shapes mirror crates/flux-core/src/extensions.rs.
export interface ExtContentScript {
  matches: string[];
  js: string[];
  css: string[];
  run_at: string;
}
export interface ExtManifest {
  id: string;
  name: string;
  version: string;
  permissions: string[];
  content_scripts: ExtContentScript[];
  background: string | null;
  ui: { toolbar_button: { title: string; icon: string | null } | null; panel: boolean | null } | null;
}
export interface InstalledExt {
  manifest: ExtManifest;
  dir: string;
  enabled: boolean;
}
/** Install the extension whose folder is `dir` (must hold flux.extension.json). */
export const extInstall = (dir: string) => invoke<ExtManifest>("ext_install", { dir });
export const extList = () => invoke<InstalledExt[]>("ext_list");
export const extSetEnabled = (id: string, on: boolean) => invoke<void>("ext_set_enabled", { id, on });
export const extRemove = (id: string) => invoke<void>("ext_remove", { id });

// ─── Per-tab web content (webviews) ─────────────────────────────────────────

export interface Rect { x: number; y: number; width: number; height: number }

export const webviewOpen = (tabId: number, url: string, r: Rect) =>
  invoke<void>("webview_open", { tabId, url, x: r.x, y: r.y, width: r.width, height: r.height });
export const webviewSetBounds = (tabId: number, r: Rect) =>
  invoke<void>("webview_set_bounds", { tabId, x: r.x, y: r.y, width: r.width, height: r.height });
export const webviewShow = (tabId: number) => invoke<void>("webview_show", { tabId });
export const webviewHide = (tabId: number) => invoke<void>("webview_hide", { tabId });
export const webviewNavigate = (tabId: number, url: string) =>
  invoke<void>("webview_navigate", { tabId, url });
export const webviewBack = (tabId: number) => invoke<void>("webview_back", { tabId });
export const webviewForward = (tabId: number) => invoke<void>("webview_forward", { tabId });
export const webviewReload = (tabId: number) => invoke<void>("webview_reload", { tabId });
export const webviewStop = (tabId: number) => invoke<void>("webview_stop", { tabId });
/** Hibernate a tab: destroy its webview to free RAM (no clear-on-close). #45 */
export const webviewHibernate = (tabId: number) => invoke<void>("webview_hibernate", { tabId });
/** Snapshot a tab's scroll/form state before it sleeps, to restore on wake. #45 */
export const webviewCaptureState = (tabId: number) => invoke<void>("webview_capture_state", { tabId });

export interface MemInfo {
  total_mb: number;
  available_mb: number;
  process_mb: number;
  available_pct: number;
}
/** System + Flux memory, for the memory-pressure tab eviction (#45). */
export const memStatus = () => invoke<MemInfo>("mem_status");

/** A host's favicon as a data: URL (fetched cookielessly + cached), or null. #21 */
export const faviconFetch = (host: string) => invoke<string | null>("favicon", { host });

// ─── Browsing history (BACKLOG #39) ──────────────────────────────────────────
/** Sentinel url for the full-page history view (DOM-rendered, no webview). */
export const HISTORY_URL = "flux://history";
export interface HistoryEntry {
  url: string;
  title: string;
  last_visit_ms: number;
  visits: number;
}
export const historyRecent = (limit?: number) =>
  invoke<HistoryEntry[]>("history_recent", { limit: limit ?? null });
export const historySearch = (query: string, limit?: number) =>
  invoke<HistoryEntry[]>("history_search", { query, limit: limit ?? null });
export const historyDelete = (url: string) => invoke<void>("history_delete", { url });
export const historyClear = () => invoke<void>("history_clear");

// ─── Downloads (BACKLOG #34) ─────────────────────────────────────────────────
export interface DownloadItem {
  id: number;
  url: string;
  filename: string;
  path: string;
  received: number;
  total: number;
  /** "in_progress" | "paused" | "completed" | "interrupted" */
  state: string;
  started_ms: number;
}
export const downloadsList = () => invoke<DownloadItem[]>("downloads_list");
export const downloadsClear = () => invoke<void>("downloads_clear");
export const downloadOpen = (id: number) => invoke<void>("download_open", { id });
export const downloadReveal = (id: number) => invoke<void>("download_reveal", { id });
export const downloadCancel = (id: number) => invoke<void>("download_cancel", { id });
export const downloadPause = (id: number) => invoke<void>("download_pause", { id });
export const downloadResume = (id: number) => invoke<void>("download_resume", { id });
/** Fires (with the download id) on any progress/state change. */
export const onDownloadUpdated = (cb: () => void): Promise<UnlistenFn> =>
  listen<number>("flux://download-updated", () => cb());
/** Find-in-page (BACKLOG #33). Empty query clears the highlight. */
export const webviewFind = (tabId: number, query: string, forward = true) =>
  invoke<void>("webview_find", { tabId, query, forward });
export const webviewClose = (tabId: number) => invoke<void>("webview_close", { tabId });
/** Diagnostic: window scale/size + the tab webview's actual physical bounds. */
export const webviewDebug = (tabId: number) => invoke<string>("webview_debug", { tabId });

/** Page load progress for a tab: [tabId, url, "started" | "finished"]. */
export const onTabLoaded = (
  cb: (tabId: number, url: string, phase: "started" | "finished") => void,
): Promise<UnlistenFn> =>
  listen<[number, string, "started" | "finished"]>("flux://tab-loaded", (e) =>
    cb(e.payload[0], e.payload[1], e.payload[2]),
  );

// ─── Filesystem explorer (Files tab) ────────────────────────────────────────

export interface FileEntry {
  name: string;
  is_dir: boolean;
  symlink: boolean;
  size: number;
  modified: number | null;
}
export interface DirListing {
  path: string;
  parent: string | null;
  entries: FileEntry[];
}
export interface QuickLocation {
  name: string;
  path: string;
  kind: "home" | "folder" | "drive" | "linux";
}

export const fsList = (path: string) => invoke<DirListing>("fs_list", { path });
export const fsHome = () => invoke<string>("fs_home");
export const fsQuickLocations = () => invoke<QuickLocation[]>("fs_quick_locations");
export const fsOpen = (path: string) => invoke<void>("fs_open", { path });

// File operations (BACKLOG #83). Paths are full; `dest` is a directory.
export const fsCreateDir = (path: string) => invoke<void>("fs_create_dir", { path });
export const fsCreateFile = (path: string) => invoke<void>("fs_create_file", { path });
export const fsRename = (from: string, to: string) => invoke<void>("fs_rename", { from, to });
export const fsMove = (paths: string[], dest: string) => invoke<void>("fs_move", { paths, dest });
export const fsCopy = (paths: string[], dest: string) => invoke<void>("fs_copy", { paths, dest });
/** Move to OS trash (recoverable). */
export const fsTrash = (paths: string[]) => invoke<void>("fs_trash", { paths });
/** Permanent delete (no undo). */
export const fsDelete = (paths: string[]) => invoke<void>("fs_delete", { paths });
/** Undo the last reversible op (rename/move/trash); returns a description or null. */
export const fsUndo = () => invoke<string | null>("fs_undo");
/** Live directory watch for a Files tab (#85): one watcher per tab id. */
export const fsWatch = (id: number, path: string) => invoke<void>("fs_watch", { id, path });
export const fsUnwatch = (id: number) => invoke<void>("fs_unwatch", { id });
/** Fires (with the watched directory) when a watched dir's contents change. */
export const onFsChanged = (cb: (path: string) => void): Promise<UnlistenFn> =>
  listen<string>("flux://fs-changed", (e) => cb(e.payload));

// ─── Terminal (PTY) ────────────────────────────────────────────────────────

/** Spawn a PTY for `session`; `onData` streams raw output bytes (number[]). */
export const terminalSpawn = (
  session: number,
  cols: number,
  rows: number,
  onData: Channel<number[]>,
) => invoke<void>("terminal_spawn", { session, cols, rows, onData });

/** Write input bytes (encoded keystrokes/paste) to the session's stdin. */
export const terminalWrite = (session: number, data: Uint8Array) =>
  invoke<void>("terminal_write", { session, data: Array.from(data) });

export const terminalResize = (session: number, cols: number, rows: number) =>
  invoke<void>("terminal_resize", { session, cols, rows });

export const terminalKill = (session: number) => invoke<void>("terminal_kill", { session });

/** Fires when a session's shell exits (EOF). */
export const onTermExit = (cb: (session: number) => void): Promise<UnlistenFn> =>
  listen<number>("flux://term-exit", (e) => cb(e.payload));
