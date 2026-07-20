/**
 * Pinned Flux apps (the user's own web apps) — shared registry used by the app
 * dock (bottom-right launcher), the floating app panes, and Gemma. Each app ships
 * a concise guide so Gemma can assist while the app is open (injected into her
 * chat context by AgentPanel when an app pane is active).
 *
 * The registry ships EMPTY — the previous entries (Nexus / Prism / Vector /
 * Oracle) were fictional demo apps and were removed. Add your own here.
 */
export type FluxApp = {
  id: string;
  name: string;
  /** Deployed URL opened in the floating pane. */
  url: string;
  /** Hostname (favicon source + matching). */
  host: string;
  /** One-line description (dock tooltip + Gemma's app list). */
  tagline: string;
  /** Accent colour for the monogram fallback. */
  tint: string;
  /** Bundled icon (served from /public), preferred over the remote favicon. */
  iconAsset?: string;
  /** Full usage guide (Markdown) — given to Gemma when this app is in use. */
  guide: string;
};

export const FLUX_APPS: FluxApp[] = [];
