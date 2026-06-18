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
