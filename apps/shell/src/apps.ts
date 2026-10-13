/**
 * Pinned Flux apps (the user's own web apps) — shared registry used by the app
 * dock (bottom-right launcher), the floating app panes, and Gemma. Each app's
 * usage guide for Gemma lives in appGuides.ts, which only AgentPanel loads:
 * the guides are most of this data, and nothing else needs them.
 *
 * Desktop-only: on mobile the app dock/rail is hidden (ADR 0012), so the list is
 * empty there. Edit DESKTOP_APPS below to change your pinned apps.
 */
import { isMobile } from "./platform";

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
  /**
   * The site refuses cross-origin framing (`X-Frame-Options` /
   * `frame-ancestors`), so it can never render in the pane's iframe — Google
   * properties are the common case. Such apps open in the web-panel rail (#48)
   * instead: a real OS webview, which framing rules don't apply to.
   */
  noFrame?: boolean;
};

const DESKTOP_APPS: FluxApp[] = [
  {
    id: "nexus",
    name: "Nexus",
    url: "https://nexus-cluster.web.app",
    host: "nexus-cluster.web.app",
    tagline: "Real-time ML training console for your cluster",
    tint: "#7b61ff",
    iconAsset: "/app-nexus.svg",
  },
  {
    id: "prism",
    name: "Prism",
    url: "https://prism-automl.web.app",
    host: "prism-automl.web.app",
    tagline: "GPU-powered AutoML & entity resolution",
    tint: "#2ff3ff",
    iconAsset: "/app-prism.svg",
  },
  {
    id: "vector",
    name: "Vector",
    url: "https://vector-amaterasu.web.app",
    host: "vector-amaterasu.web.app",
    tagline: "Keyboard-first project & issue tracker",
    tint: "#ec4be0",
  },
  {
    id: "oracle",
    name: "Oracle",
    url: "https://oracle-neuro-sym.web.app",
    host: "oracle-neuro-sym.web.app",
    tagline: "AI plant identification (neuro-symbolic)",
    tint: "#7cf5b0",
    iconAsset: "/app-oracle.svg",
  },
  {
    id: "codevisualizer",
    name: "Code Visualizer",
    url: "https://codevisualizer-app.web.app",
    host: "codevisualizer-app.web.app",
    tagline: "Step through code and watch the stack, heap and struct layout",
    tint: "#6aa3ff",
    iconAsset: "/app-codevisualizer.svg",
    // Floats like the other four. Note it still sends Firebase Hosting's default
    // `X-Frame-Options: SAMEORIGIN` — until that's overridden in its
    // firebase.json, the pane detects the refusal and offers the side panel
    // rather than showing an empty window (#180).
  },
];

/** Pinned apps for this platform: desktop shows them, mobile is barebone. */
export const FLUX_APPS: FluxApp[] = isMobile ? [] : DESKTOP_APPS;

export const appByHost = (host: string): FluxApp | undefined =>
  FLUX_APPS.find((a) => host === a.host || host.endsWith(`.${a.host}`));
