/**
 * Mock of @tauri-apps/api/core for the standalone UI preview (no Rust runtime).
 * Aliased in via vite.preview.config.ts — never bundled into the real app.
 */
import type { TabKind, TabMeta } from "../ipc";

/** Minimal stand-in for @tauri-apps/api/core's Channel (preview only). */
export class Channel<T = unknown> {
  onmessage: (msg: T) => void = () => {};
}

let nextId = 8;
const tabs: TabMeta[] = [
  { id: 1, kind: "browser", url: "https://news.ycombinator.com", title: "Hacker News", pinned: true, cluster: null },
  { id: 2, kind: "browser", url: "https://github.com/flux-browser/flux", title: "flux-browser/flux", pinned: true, cluster: null },
  { id: 3, kind: "browser", url: "https://rust-lang.org", title: "Rust Programming Language", pinned: false, cluster: { id: 0, color: 0x5bc0eb } },
  { id: 5, kind: "terminal", url: "~/Flux", title: "term #5", pinned: false, cluster: null },
  { id: 4, kind: "browser", url: "https://docs.rs/tauri", title: "tauri - Rust docs", pinned: false, cluster: { id: 0, color: 0x5bc0eb } },
  { id: 7, kind: "browser", url: "flux://start", title: "New Tab", pinned: false, cluster: null },
];

export function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  switch (cmd) {
    case "tab_list":
      return Promise.resolve(structuredClone(tabs) as T);
    case "launch_intent":
      return Promise.resolve({ urls: [], terminal: false } as T);
    case "tab_create": {
      const kind = args?.kind as TabKind;
      const tab: TabMeta = {
        id: nextId++,
        kind,
        url: (args?.url as string) ?? (kind === "terminal" ? "~/Flux" : "flux://start"),
        title: kind === "terminal" ? `term #${nextId}` : "New Tab",
        pinned: false,
        cluster: null,
      };
      tabs.push(tab);
      return Promise.resolve(tab as T);
    }
    case "tab_set_pinned": {
      const t = tabs.find((t) => t.id === args?.id);
      if (t) t.pinned = args?.pinned as boolean;
      return Promise.resolve(undefined as T);
    }
    case "tab_close": {
      const i = tabs.findIndex((t) => t.id === args?.id);
      if (i >= 0) tabs.splice(i, 1);
      return Promise.resolve(undefined as T);
    }
    case "terminal_spawn": {
      // Echo a styled banner + prompt through the channel so the preview shows
      // a real-looking terminal (no PTY in preview).
      const ch = args?.onData as Channel<number[]> | undefined;
      if (ch) {
        const banner =
          "\x1b[38;2;47;243;255m flux\x1b[0m \x1b[38;2;157;141;241mterminal\x1b[0m — local dev shell\r\n" +
          "\x1b[38;2;106;111;150m $FLUX_TAB_URL, $FLUX_TAB_DIR injected · powered by a real PTY\x1b[0m\r\n\r\n" +
          "\x1b[38;2;124;245;176m➜\x1b[0m \x1b[38;2;47;243;255m~/Flux\x1b[0m $ ";
        setTimeout(() => ch.onmessage(Array.from(new TextEncoder().encode(banner))), 60);
      }
      return Promise.resolve(undefined as T);
    }
    case "terminal_write":
    case "terminal_resize":
    case "terminal_kill":
      return Promise.resolve(undefined as T);
    case "search_resolve": {
      const input = String(args?.input ?? "").trim();
      const hasScheme = /^https?:\/\//.test(input);
      const isUrl = hasScheme || (/\.[a-z]{2,}/i.test(input) && !/\s/.test(input));
      const url = isUrl
        ? hasScheme
          ? input
          : `https://${input}`
        : `https://duckduckgo.com/?q=${encodeURIComponent(input)}`;
      return Promise.resolve({ kind: isUrl ? "navigate" : "search", engine: "ddg", url } as T);
    }
    case "search_default":
      return Promise.resolve("ddg" as T);
    case "search_engines":
      return Promise.resolve([
        { id: "ddg", name: "DuckDuckGo", keyword: "ddg", search_template: "", suggest_template: null },
        { id: "google", name: "Google", keyword: "g", search_template: "", suggest_template: null },
      ] as T);
    case "agent_chat":
      return Promise.resolve(
        "I'm Flux, your local assistant. Ask me anything — or use /act to control the page." as T,
      );
    case "agent_execute":
      return Promise.resolve({
        action: "click",
        selector: "a[href*='unsubscribe']",
        reason: "unsubscribe link",
      } as T);
    default:
      return Promise.resolve(undefined as T);
  }
}
