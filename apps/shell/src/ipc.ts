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
