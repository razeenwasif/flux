/**
 * Mock of @tauri-apps/api/core for the standalone UI preview (no Rust runtime).
 * Aliased in via vite.preview.config.ts — never bundled into the real app.
 */
import type { TabKind, TabMeta } from "../ipc";

/** Minimal stand-in for @tauri-apps/api/core's Channel (preview only). */
export class Channel<T = unknown> {
  onmessage: (msg: T) => void = () => {};
}

let nextId = 9;

const DAY = 86_400_000;
const T0 = 1_749_900_000_000; // fixed base so preview dates are stable
interface MockEntry { name: string; is_dir: boolean; symlink: boolean; size: number; modified: number }
// Mutable so the preview reflects file operations (create/rename/delete/copy).
let mockEntries: MockEntry[] = (
  [
    ["Flux", true, 0, 1], ["Omni", true, 0, 2], ["projects", true, 0, 9],
    ["dotfiles", true, 0, 40], [".config", true, 0, 3], [".cache", true, 0, 1],
    ["README.md", false, 2150, 0.2], ["notes.txt", false, 840, 1], ["TODO.md", false, 410, 0.5],
    ["main.rs", false, 4096, 2], ["Cargo.toml", false, 612, 2], ["index.ts", false, 8800, 1.2],
    ["theme.css", false, 14_300, 0.3], ["avatar.png", false, 230_400, 30],
    ["diagram.svg", false, 18_200, 12], ["archive.zip", false, 10_485_760, 60],
    ["dataset.tar.gz", false, 1_073_741_824, 90], ["demo.mp4", false, 52_428_800, 7],
    ["talk.mp3", false, 6_291_456, 14], ["paper.pdf", false, 1_310_720, 5],
    ["sheet.xlsx", false, 44_800, 21], ["slides.pptx", false, 2_900_000, 3],
    ["query.sql", false, 1_200, 4], ["server.go", false, 9_400, 6], ["build.sh", false, 720, 8],
    ["config.yaml", false, 1_900, 2], ["data.json", false, 320_000, 1], ["LICENSE", false, 1_069, 120],
  ] as [string, boolean, number, number][]
).map(([name, is_dir, size, days]) => ({ name, is_dir, symlink: false, size, modified: T0 - days * DAY }));

const mockBase = (p: string) => p.split(/[\\/]/).filter(Boolean).pop() ?? p;
const mockNow = () => T0 + DAY; // "just now" relative to the fixed dates above
const tabs: TabMeta[] = [
  { id: 1, kind: "browser", url: "https://news.ycombinator.com", title: "Hacker News", pinned: true, cluster: null },
  { id: 2, kind: "browser", url: "https://github.com/flux-browser/flux", title: "flux-browser/flux", pinned: true, cluster: null },
  { id: 3, kind: "browser", url: "https://rust-lang.org", title: "Rust Programming Language", pinned: false, cluster: { id: 0, color: 0x5bc0eb } },
  { id: 5, kind: "terminal", url: "~/Flux", title: "term #5", pinned: false, cluster: null },
  { id: 4, kind: "browser", url: "https://docs.rs/tauri", title: "tauri - Rust docs", pinned: false, cluster: { id: 0, color: 0x5bc0eb } },
  { id: 7, kind: "browser", url: "flux://start", title: "New Tab", pinned: false, cluster: null },
  { id: 8, kind: "files", url: "/home/amaterasu", title: "amaterasu", pinned: false, cluster: null },
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
    case "tab_set_url": {
      const t = tabs.find((t) => t.id === args?.id);
      if (t) { t.url = args?.url as string; if (args?.title != null) t.title = args.title as string; }
      return Promise.resolve(undefined as T);
    }
    case "tab_active":
      return Promise.resolve((tabs.at(-1)?.id ?? null) as T);
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
    case "fs_home":
      return Promise.resolve("/home/amaterasu" as T);
    case "fs_quick_locations":
      return Promise.resolve([
        { name: "Home", path: "/home/amaterasu", kind: "home" },
        { name: "Desktop", path: "/home/amaterasu/Desktop", kind: "folder" },
        { name: "Documents", path: "/home/amaterasu/Documents", kind: "folder" },
        { name: "Downloads", path: "/home/amaterasu/Downloads", kind: "folder" },
        { name: "Ubuntu-24.04", path: "\\\\wsl.localhost\\Ubuntu-24.04", kind: "linux" },
        { name: "C:", path: "C:\\", kind: "drive" },
      ] as T);
    case "fs_open":
      return Promise.resolve(undefined as T);
    case "fs_list": {
      const path = String(args?.path ?? "/home/amaterasu");
      return Promise.resolve({
        path,
        parent: "/home",
        entries: mockEntries.map((e) => ({ ...e })),
      } as T);
    }
    case "fs_create_dir":
    case "fs_create_file": {
      const name = mockBase(String(args?.path ?? ""));
      if (name && !mockEntries.some((e) => e.name === name))
        mockEntries.push({ name, is_dir: cmd === "fs_create_dir", symlink: false, size: 0, modified: mockNow() });
      return Promise.resolve(undefined as T);
    }
    case "fs_rename": {
      const from = mockBase(String(args?.from ?? "")), to = mockBase(String(args?.to ?? ""));
      const e = mockEntries.find((e) => e.name === from);
      if (e && to) e.name = to;
      return Promise.resolve(undefined as T);
    }
    case "fs_copy": {
      const names = (args?.paths as string[] ?? []).map(mockBase);
      for (const n of names) {
        const src = mockEntries.find((e) => e.name === n);
        if (src) {
          const dot = n.lastIndexOf(".");
          const copy = dot > 0 ? `${n.slice(0, dot)} copy${n.slice(dot)}` : `${n} copy`;
          mockEntries.push({ ...src, name: copy, modified: mockNow() });
        }
      }
      return Promise.resolve(undefined as T);
    }
    case "fs_move":
      return Promise.resolve(undefined as T); // single-dir mock: move is a no-op
    case "fs_trash":
    case "fs_delete": {
      const names = new Set((args?.paths as string[] ?? []).map(mockBase));
      mockEntries = mockEntries.filter((e) => !names.has(e.name));
      return Promise.resolve(undefined as T);
    }
    case "fs_undo":
      return Promise.resolve(null as T); // no op history in the preview mock
    case "fs_watch":
    case "fs_unwatch":
      return Promise.resolve(undefined as T); // no live watch in the preview
    case "omni_stats":
      return Promise.resolve(JSON.stringify({
        live_docs: 591, total_docs: 591, tombstones: 0, segments: 2,
        embedded: true, ann: true, ann_vectors: 591, dated: 12,
        embedder_kind: "hash", embedder_dim: 2560,
        avg_title_len: 7, avg_body_len: 6130,
        segment_sizes: [{ live: 412, total: 412 }, { live: 179, total: 179 }],
        top_docs: [
          { url: "https://arxiv.org/", title: "arXiv.org e-Print archive", rank: 0.0190 },
          { url: "https://arxiv.org/login", title: "Log in to arXiv", rank: 0.0182 },
          { url: "https://en.wikipedia.org/wiki/Inverted_index", title: "Inverted index - Wikipedia", rank: 0.0151 },
          { url: "https://en.wikipedia.org/wiki/PageRank", title: "PageRank - Wikipedia", rank: 0.0144 },
          { url: "https://en.wikipedia.org/wiki/Rust_(programming_language)", title: "Rust (programming language) - Wikipedia", rank: 0.0139 },
          { url: "https://en.wikipedia.org/wiki/Help:Contents", title: "Help Contents - Wikipedia", rank: 0.0131 },
        ],
      }) as T);
    case "shields_status":
      return Promise.resolve({ enabled: true, blocked: 42, sites_off: [] } as T);
    case "shields_set_enabled":
    case "shields_set_site":
    case "shields_refresh":
      return Promise.resolve(undefined as T);
    case "https_status":
      return Promise.resolve({ enabled: false, sites_allow_http: [] } as T);
    case "https_set_enabled":
    case "https_allow_site":
    case "cookies_clear_site":
    case "cookies_clear_all":
    case "cookies_set_clear_on_close":
    case "tracking_set_level":
    case "permissions_set_block":
      return Promise.resolve(undefined as T);
    case "tracking_status":
      return Promise.resolve(2 as T);
    case "permissions_status":
      return Promise.resolve(false as T);
    case "cookies_status":
      return Promise.resolve({ clear_on_close: [] } as T);
    case "omni_sites":
      return Promise.resolve(JSON.stringify([
        { key: "yt", name: "YouTube", home: "https://www.youtube.com", blurb: "video lectures, talks, and tutorials" },
        { key: "gh", name: "GitHub", home: "https://github.com", blurb: "source code, repositories, and projects" },
        { key: "ax", name: "arXiv", home: "https://arxiv.org", blurb: "open-access e-prints in physics, math, CS" },
        { key: "mdn", name: "MDN Web Docs", home: "https://developer.mozilla.org", blurb: "web platform and JavaScript reference" },
      ]) as T);
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
