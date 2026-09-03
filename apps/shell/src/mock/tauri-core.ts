/**
 * Mock of @tauri-apps/api/core for the standalone UI preview (no Rust runtime).
 * Aliased in via vite.preview.config.ts — never bundled into the real app.
 */
import type { TabKind, TabMeta } from "../ipc";

/** Minimal stand-in for @tauri-apps/api/core's Channel (preview only). */
export class Channel<T = unknown> {
  onmessage: (msg: T) => void = () => {};
}

/** Stand-in for the plugin event bridge. There is no `flux-webview` plugin in
 *  the preview — no native webviews exist to emit nav events — so this resolves
 *  to an unsubscribe that does nothing. Its absence broke the whole preview
 *  build, which is worse than a listener that never fires. */
export function addPluginListener<T = unknown>(
  _plugin: string,
  _event: string,
  _handler: (payload: T) => void,
): Promise<{ unregister: () => Promise<void> }> {
  return Promise.resolve({ unregister: () => Promise.resolve() });
}

/**
 * A real, valid multi-page PDF, built byte by byte.
 *
 * The viewer is the one surface that can't be checked with a stub: page jump,
 * restore-where-you-were, bookmarks and zoom are all *scroll* behaviour, so
 * they need a document tall enough to scroll. Hand-built rather than shipping a
 * fixture file because the preview is a build artifact and a checked-in binary
 * would have to be maintained alongside it.
 */
function mockPdf(pageCount = 12): Uint8Array {
  const objs: string[] = [];
  const fontObj = 3 + pageCount * 2;
  const kids = Array.from({ length: pageCount }, (_, i) => `${3 + i * 2} 0 R`).join(" ");
  objs[1] = "<</Type/Catalog/Pages 2 0 R>>";
  objs[2] = `<</Type/Pages/Kids[${kids}]/Count ${pageCount}>>`;
  for (let i = 0; i < pageCount; i++) {
    const body =
      `BT /F1 44 Tf 60 720 Td (Page ${i + 1} of ${pageCount}) Tj ET\n` +
      `BT /F1 15 Tf 60 660 Td (Flux preview document — scroll, jump, bookmark, zoom.) Tj ET\n` +
      `0.6 0.6 0.9 RG 3 w 60 80 m 535 80 l S\n` +
      `BT /F1 11 Tf 60 55 Td (${i + 1}) Tj ET`;
    objs[3 + i * 2] =
      `<</Type/Page/Parent 2 0 R/MediaBox[0 0 595 842]` +
      `/Resources<</Font<</F1 ${fontObj} 0 R>>>>/Contents ${4 + i * 2} 0 R>>`;
    objs[4 + i * 2] = `<</Length ${body.length}>>\nstream\n${body}\nendstream`;
  }
  objs[fontObj] = "<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>";

  // Offsets must be counted in BYTES, not characters — everything here is
  // ASCII, so they coincide, but building the string first and measuring it is
  // what keeps that true if the text ever isn't.
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (let n = 1; n < objs.length; n++) {
    offsets[n] = out.length;
    out += `${n} 0 obj\n${objs[n]}\nendobj\n`;
  }
  const xref = out.length;
  out += `xref\n0 ${objs.length}\n0000000000 65535 f \n`;
  for (let n = 1; n < objs.length; n++) {
    out += `${String(offsets[n]).padStart(10, "0")} 00000 n \n`;
  }
  out += `trailer\n<</Size ${objs.length}/Root 1 0 R>>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(out);
}

let nextId = 9;

const DAY = 86_400_000;
const T0 = 1_749_900_000_000; // fixed base so preview dates are stable
interface MockEntry {
  name: string;
  is_dir: boolean;
  symlink: boolean;
  size: number;
  modified: number;
}
// Mutable so the preview reflects file operations (create/rename/delete/copy).
let mockEntries: MockEntry[] = (
  [
    ["Flux", true, 0, 1],
    ["Omni", true, 0, 2],
    ["projects", true, 0, 9],
    ["dotfiles", true, 0, 40],
    [".config", true, 0, 3],
    [".cache", true, 0, 1],
    ["README.md", false, 2150, 0.2],
    ["notes.txt", false, 840, 1],
    ["TODO.md", false, 410, 0.5],
    ["main.rs", false, 4096, 2],
    ["Cargo.toml", false, 612, 2],
    ["index.ts", false, 8800, 1.2],
    ["theme.css", false, 14_300, 0.3],
    ["avatar.png", false, 230_400, 30],
    ["diagram.svg", false, 18_200, 12],
    ["archive.zip", false, 10_485_760, 60],
    ["dataset.tar.gz", false, 1_073_741_824, 90],
    ["demo.mp4", false, 52_428_800, 7],
    ["talk.mp3", false, 6_291_456, 14],
    ["paper.pdf", false, 1_310_720, 5],
    ["sheet.xlsx", false, 44_800, 21],
    ["slides.pptx", false, 2_900_000, 3],
    ["query.sql", false, 1_200, 4],
    ["server.go", false, 9_400, 6],
    ["build.sh", false, 720, 8],
    ["config.yaml", false, 1_900, 2],
    ["data.json", false, 320_000, 1],
    ["LICENSE", false, 1_069, 120],
  ] as [string, boolean, number, number][]
).map(([name, is_dir, size, days]) => ({ name, is_dir, symlink: false, size, modified: T0 - days * DAY }));

const mockBase = (p: string) => p.split(/[\\/]/).filter(Boolean).pop() ?? p;

// Installed extensions (BACKLOG #92) — mutable so the preview reflects install/toggle/remove.
let mockExts: {
  manifest: {
    id: string;
    name: string;
    version: string;
    permissions: string[];
    content_scripts: unknown[];
    background: string | null;
    ui: unknown;
  };
  dir: string;
  enabled: boolean;
}[] = [
  {
    manifest: {
      id: "com.flux.reader",
      name: "Reader Mode",
      version: "1.0.0",
      permissions: ["dom:read", "dom:write", "ui:toolbar"],
      content_scripts: [],
      background: null,
      ui: null,
    },
    dir: "~/.flux/extensions/reader",
    enabled: true,
  },
  {
    manifest: {
      id: "com.flux.darkall",
      name: "Dark Everywhere",
      version: "0.3.1",
      permissions: ["dom:write"],
      content_scripts: [],
      background: null,
      ui: null,
    },
    dir: "~/.flux/extensions/darkall",
    enabled: false,
  },
];

// Password vault (BACKLOG #61) — mutable so the preview reflects add/remove.
let mockVault: {
  id: string;
  name: string;
  urls: string[];
  username: string;
  password: string;
  has_totp: boolean;
}[] = [
  {
    id: "c1",
    name: "GitHub",
    urls: ["https://github.com"],
    username: "octocat",
    password: "correct-horse",
    has_totp: true,
  },
  {
    id: "c2",
    name: "Hacker News",
    urls: ["https://news.ycombinator.com"],
    username: "pg",
    password: "battery-staple",
    has_totp: false,
  },
];
const mockNow = () => T0 + DAY; // "just now" relative to the fixed dates above
const tabs: TabMeta[] = [
  {
    id: 1,
    kind: "browser",
    url: "https://news.ycombinator.com",
    title: "Hacker News",
    pinned: true,
    cluster: null,
    group: null,
    folder: null,
    custom_title: null,
    workspace: 1,
    private: false,
    container: 0,
  },
  {
    id: 2,
    kind: "browser",
    url: "https://github.com/flux-browser/flux",
    title: "flux-browser/flux",
    pinned: true,
    cluster: null,
    group: null,
    folder: null,
    custom_title: null,
    workspace: 1,
    private: false,
    container: 0,
  },
  {
    id: 3,
    kind: "browser",
    url: "https://rust-lang.org",
    title: "Rust Programming Language",
    pinned: false,
    cluster: { id: 0, color: 0x5bc0eb },
    group: null,
    folder: null,
    custom_title: null,
    workspace: 1,
    private: false,
    container: 0,
  },
  {
    id: 5,
    kind: "terminal",
    url: "~/Flux",
    title: "term #5",
    pinned: false,
    cluster: null,
    group: null,
    folder: null,
    custom_title: null,
    workspace: 1,
    private: false,
    container: 0,
  },
  {
    id: 4,
    kind: "browser",
    url: "https://docs.rs/tauri",
    title: "tauri - Rust docs",
    pinned: false,
    cluster: { id: 0, color: 0x5bc0eb },
    group: null,
    folder: null,
    custom_title: null,
    workspace: 1,
    private: false,
    container: 0,
  },
  {
    id: 7,
    kind: "browser",
    url: "flux://start",
    title: "New Tab",
    pinned: false,
    cluster: null,
    group: null,
    folder: null,
    custom_title: null,
    workspace: 1,
    private: false,
    container: 0,
  },
  {
    id: 8,
    kind: "files",
    url: "/home/amaterasu",
    title: "amaterasu",
    pinned: false,
    cluster: null,
    group: null,
    folder: null,
    custom_title: null,
    workspace: 1,
    private: false,
    container: 0,
  },
];
// Tab groups (BACKLOG #56).
let mockGroups: { id: number; name: string; color: number; collapsed: boolean }[] = [];
let mockFolders: { id: number; name: string; collapsed: boolean }[] = [];
// Workspaces (BACKLOG #44).
let mockWorkspaces: { id: number; name: string; color: number }[] = [
  { id: 1, name: "Personal", color: 0x9d8df1 },
  { id: 2, name: "Work", color: 0x5bc0eb },
];
let mockActiveWs = 1;
// Multi-account containers (BACKLOG #59).
let mockContainers: { id: number; name: string; color: number }[] = [
  { id: 1, name: "Work", color: 0x7cf5b0 },
];

export function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  switch (cmd) {
    // The shell's whole startup payload. Missing, this returned `undefined` and
    // `refreshTabs` threw on `.tabs` — which aborted store init, so the preview
    // came up with no tabs, no groups and no workspaces and every surface that
    // reads them looked broken for reasons that had nothing to do with them.
    case "shell_snapshot":
      return Promise.resolve({
        tabs: structuredClone(tabs),
        active_tab: tabs.at(-1)?.id ?? null,
        groups: mockGroups,
        folders: mockFolders,
        workspaces: mockWorkspaces,
        active_workspace: mockActiveWs,
        panels: [],
        containers: mockContainers,
      } as T);
    // System stats, for the task manager and the rail's system monitor. Values
    // drift a little per call so the meters visibly move — a frozen number
    // looks identical to a dead poll loop, which is the bug you most want the
    // preview to be able to show you.
    case "tasks_stats": {
      const wob = (base: number, amp: number) => base + Math.sin(Date.now() / 3000) * amp;
      return Promise.resolve({
        cpu: Math.max(0, wob(34, 22)),
        per_core: Array.from({ length: 8 }, (_, i) => Math.max(0, wob(30 + i * 3, 25))),
        cpu_brand: "Mock CPU 9 7950X",
        mem_used_mb: 9800,
        mem_total_mb: 16256,
        mem_pct: 60,
        swap_used_mb: 0,
        swap_total_mb: 8192,
        cores: 8,
        uptime_secs: 93_600,
        nets: [
          { name: "wlan0", rx_bps: 820_000, tx_bps: 74_000 },
          { name: "docker0", rx_bps: 1200, tx_bps: 900 },
        ],
        net_rx_bps: 821_200,
        net_tx_bps: 74_900,
      } as T);
    }
    case "gpu_stats":
      return Promise.resolve([
        {
          name: "Mock RTX 4070",
          util_pct: 41,
          mem_used_mb: 3900,
          mem_total_mb: 12288,
          temp_c: 58,
          power_w: 96,
        },
      ] as T);
    // Named places (#166) — the preview needs a vault with folders to show that
    // "onyx / 00 - Optimization" resolves without a path.
    case "agent_unload":
      return Promise.resolve((args?.model || "gemma4:12b-it-qat") as T);
    case "agent_places":
      return Promise.resolve([
        {
          name: "onyx",
          path: "/home/amaterasu/OnyxVault",
          what: "the user's Onyx markdown vault — where notes are written",
          folders: ["00 - Optimization", "01 - Convex Analysis", "Inbox", "Papers"],
        },
        {
          name: "scribe",
          path: "/home/amaterasu/.local/share/flux/scribe",
          what: "handwritten Scribe notebooks (one file per notebook)",
          folders: [],
        },
        {
          name: "downloads",
          path: "/home/amaterasu/Downloads",
          what: "where Flux saves downloads and edited PDFs",
          folders: [],
        },
      ] as T);
    case "tasks_disks":
      return Promise.resolve([
        { name: "nvme0n1p2", mount: "/", fs: "ext4", total_mb: 953_000, avail_mb: 402_000, removable: false },
        {
          name: "Data",
          mount: "/mnt/d",
          fs: "ntfs",
          total_mb: 1_907_000,
          avail_mb: 121_000,
          removable: false,
        },
      ] as T);
    case "pdf_fetch": {
      const b = mockPdf();
      // A fresh ArrayBuffer, exactly as the Rust side hands one over.
      return Promise.resolve(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as T);
    }
    case "pdf_publish_text":
    case "pdf_save":
      return Promise.resolve("~/Downloads/preview.pdf" as T);
    case "ocr_available":
      return Promise.resolve(false as T);
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
        group: null,
        folder: null,
        custom_title: null,
        workspace: mockActiveWs,
        private: Boolean(args?.private),
        container: Number(args?.container ?? 0),
      };
      tabs.push(tab);
      return Promise.resolve(tab as T);
    }
    case "tab_reorder": {
      const ids = (args?.ids as number[]) ?? [];
      tabs.sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id));
      return Promise.resolve(undefined as T);
    }
    case "groups_list":
      return Promise.resolve(mockGroups as T);
    case "group_create": {
      const id = nextId++;
      mockGroups.push({
        id,
        name: String(args?.name ?? "New group"),
        color: Number(args?.color ?? 0x5bc0eb),
        collapsed: false,
      });
      for (const t of tabs) if (((args?.tabIds as number[]) ?? []).includes(t.id)) t.group = id;
      return Promise.resolve(id as T);
    }
    case "group_update": {
      const g = mockGroups.find((x) => x.id === args?.id);
      if (g) {
        if (args?.name != null) g.name = String(args.name);
        if (args?.color != null) g.color = Number(args.color);
        if (args?.collapsed != null) g.collapsed = Boolean(args.collapsed);
      }
      return Promise.resolve(undefined as T);
    }
    case "group_delete": {
      mockGroups = mockGroups.filter((g) => g.id !== args?.id);
      for (const t of tabs) if (t.group === args?.id) t.group = null;
      return Promise.resolve(undefined as T);
    }
    case "tab_set_group": {
      const t = tabs.find((x) => x.id === args?.tabId);
      if (t) t.group = (args?.group as number | null) ?? null;
      return Promise.resolve(undefined as T);
    }
    case "folders_list":
      return Promise.resolve(mockFolders as T);
    case "folder_create": {
      const id = nextId++;
      mockFolders.push({ id, name: String(args?.name ?? "New folder"), collapsed: false });
      return Promise.resolve(id as T);
    }
    case "folder_update": {
      const f = mockFolders.find((x) => x.id === args?.id);
      if (f) {
        if (args?.name != null) f.name = String(args.name);
        if (args?.collapsed != null) f.collapsed = Boolean(args.collapsed);
      }
      return Promise.resolve(undefined as T);
    }
    case "folder_delete": {
      mockFolders = mockFolders.filter((f) => f.id !== args?.id);
      for (const t of tabs) if (t.folder === args?.id) t.folder = null;
      return Promise.resolve(undefined as T);
    }
    case "tab_set_folder": {
      const t = tabs.find((x) => x.id === args?.tabId);
      if (t) t.folder = (args?.folder as number | null) ?? null;
      return Promise.resolve(undefined as T);
    }
    case "tab_set_workspace": {
      const t = tabs.find((x) => x.id === args?.tabId);
      if (t) {
        t.workspace = Number(args?.workspace ?? 1);
        t.group = null;
      }
      return Promise.resolve(undefined as T);
    }
    case "group_set_workspace": {
      const ws = Number(args?.workspace ?? 1);
      const moved = tabs
        .filter((t) => t.group === args?.group)
        .map((t) => {
          t.workspace = ws;
          return t.id;
        });
      return Promise.resolve(moved as T);
    }
    case "groups_from_clusters":
      return Promise.resolve(0 as T);
    case "tab_dom_sizes":
      return Promise.resolve(
        tabs.filter((t) => t.kind === "browser").map((t) => [t.id, 120_000 + t.id * 40_000]) as T,
      );
    case "containers_list":
      return Promise.resolve(mockContainers as T);
    case "container_create": {
      const id = nextId++;
      mockContainers.push({
        id,
        name: String(args?.name ?? "Container"),
        color: Number(args?.color ?? 0xff8a8a),
      });
      return Promise.resolve(id as T);
    }
    case "container_update": {
      const c = mockContainers.find((x) => x.id === args?.id);
      if (c) {
        if (args?.name != null) c.name = String(args.name);
        if (args?.color != null) c.color = Number(args.color);
      }
      return Promise.resolve(undefined as T);
    }
    case "container_delete": {
      mockContainers = mockContainers.filter((c) => c.id !== args?.id);
      for (const t of tabs) if (t.container === args?.id) t.container = 0;
      return Promise.resolve(undefined as T);
    }
    case "panels_list":
      return Promise.resolve([] as T);
    case "panel_add":
      return Promise.resolve({
        id: nextId++,
        url: String(args?.url ?? ""),
        title: String(args?.title ?? ""),
      } as T);
    case "panel_remove":
    case "panel_open":
    case "panel_set_bounds":
    case "panel_show":
    case "panel_hide":
    case "panel_navigate":
    case "panel_close":
      return Promise.resolve(undefined as T);
    case "workspaces_list":
      return Promise.resolve(mockWorkspaces as T);
    case "workspace_active":
      return Promise.resolve(mockActiveWs as T);
    case "workspace_switch":
      mockActiveWs = Number(args?.id ?? 1);
      return Promise.resolve(undefined as T);
    case "workspace_create": {
      const id = nextId++;
      mockWorkspaces.push({
        id,
        name: String(args?.name ?? "New space"),
        color: Number(args?.color ?? 0x9d8df1),
      });
      return Promise.resolve(id as T);
    }
    case "workspace_update": {
      const w = mockWorkspaces.find((x) => x.id === args?.id);
      if (w) {
        if (args?.name != null) w.name = String(args.name);
        if (args?.color != null) w.color = Number(args.color);
      }
      return Promise.resolve(undefined as T);
    }
    case "workspace_delete": {
      const id = Number(args?.id);
      const closed = tabs.filter((t) => t.workspace === id).map((t) => t.id);
      mockWorkspaces = mockWorkspaces.filter((w) => w.id !== id);
      if (mockActiveWs === id) mockActiveWs = mockWorkspaces[0]?.id ?? 1;
      return Promise.resolve(closed as T);
    }
    case "tab_set_pinned": {
      const t = tabs.find((t) => t.id === args?.id);
      if (t) t.pinned = args?.pinned as boolean;
      return Promise.resolve(undefined as T);
    }
    case "tab_set_url": {
      const t = tabs.find((t) => t.id === args?.id);
      if (t) {
        t.url = args?.url as string;
        if (args?.title != null) t.title = args.title as string;
      }
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
    case "webview_stop":
    case "webview_find":
    case "webview_hibernate":
    case "webview_memory_low":
    case "webview_capture_state":
      return Promise.resolve(undefined as T);
    case "mem_status":
      return Promise.resolve({
        total_mb: 16384,
        available_mb: 9216,
        process_mb: 312,
        available_pct: 56,
      } as T);
    case "favicon":
      return Promise.resolve(null as T); // no network in preview → letter glyphs
    case "darkmode_status":
      return Promise.resolve(false as T);
    case "darkmode_set":
      return Promise.resolve(undefined as T);
    case "chrome_focus":
      return Promise.resolve(undefined as T);
    case "nav_status":
      return Promise.resolve([false, false] as T);
    case "nav_set":
      return Promise.resolve(undefined as T);
    case "note_get":
      return Promise.resolve("" as T);
    case "note_set":
    case "notes_list":
      return Promise.resolve((cmd === "notes_list" ? [] : undefined) as T);
    case "history_recent":
    case "history_search":
      return Promise.resolve([
        { url: "https://news.ycombinator.com", title: "Hacker News", last_visit_ms: T0 + DAY, visits: 12 },
        {
          url: "https://github.com/flux-browser/flux",
          title: "flux-browser/flux",
          last_visit_ms: T0 + DAY - 3600_000,
          visits: 8,
        },
        { url: "https://rust-lang.org", title: "Rust Programming Language", last_visit_ms: T0, visits: 3 },
      ] as T);
    case "history_delete":
    case "history_clear":
      return Promise.resolve(undefined as T);
    // Enough to overflow the bar at any window width — the bar's scrolling
    // behaviour is only testable when there is something to scroll past.
    case "bookmarks_list":
      return Promise.resolve(
        [
          ["Rust", "https://rust-lang.org"],
          ["CI", "https://ci.example.com"],
          ["Docs", "https://docs.example.com"],
          ["Hacker News", "https://news.ycombinator.com"],
          ["GitHub", "https://github.com"],
          ["arXiv", "https://arxiv.org"],
          ["MDN", "https://developer.mozilla.org"],
          ["Tauri", "https://tauri.app"],
          ["SolidJS", "https://solidjs.com"],
          ["crates.io", "https://crates.io"],
          ["Ollama", "https://ollama.com"],
          ["Syncthing", "https://syncthing.net"],
        ].map(([title, url], i) => ({
          id: i + 1,
          title,
          url,
          folder: i % 2 ? "Imported/Work" : "Imported",
          added_ms: T0,
        })) as T,
      );
    case "bookmark_folders":
      return Promise.resolve(["Imported", "Imported/Work"] as T);
    case "bookmark_add":
      return Promise.resolve({
        id: 99,
        title: String(args?.title ?? ""),
        url: String(args?.url ?? ""),
        folder: String(args?.folder ?? ""),
        added_ms: T0,
      } as T);
    case "bookmark_remove":
    case "bookmark_rename":
    case "bookmarks_clear":
      return Promise.resolve(undefined as T);
    case "bookmarks_import_chrome":
      return Promise.resolve(42 as T);
    case "sessions_list":
      return Promise.resolve([
        {
          id: 1,
          name: "Research",
          created_ms: T0,
          tabs: [{ url: "https://rust-lang.org", title: "Rust", pinned: false }],
        },
      ] as T);
    case "session_save":
      return Promise.resolve({
        id: nextId++,
        name: String(args?.name ?? "Untitled"),
        created_ms: T0,
        tabs: [],
      } as T);
    case "session_delete":
      return Promise.resolve(undefined as T);
    case "session_restore":
      return Promise.resolve([{ url: "https://rust-lang.org", title: "Rust", pinned: false }] as T);
    case "chrome_import_preview":
      return Promise.resolve([
        {
          dir: "/mock/Default",
          name: "Default",
          bookmark_count: 1006,
          extension_count: 7,
          has_saved_tab_groups: false,
        },
      ] as T);
    case "search_suggest": {
      const q = String(args?.query ?? "");
      return Promise.resolve((q ? [`${q} tutorial`, `${q} reddit`, `${q} vs alternatives`] : []) as T);
    }
    case "downloads_list":
      return Promise.resolve([
        {
          id: 1,
          url: "https://example.com/flux-setup.exe",
          filename: "flux-setup.exe",
          path: "C:\\Users\\me\\Downloads\\flux-setup.exe",
          received: 7_340_032,
          total: 12_582_912,
          state: "in_progress",
          started_ms: T0 + DAY,
        },
        {
          id: 2,
          url: "https://example.com/report.pdf",
          filename: "report.pdf",
          path: "C:\\Users\\me\\Downloads\\report.pdf",
          received: 1_310_720,
          total: 1_310_720,
          state: "completed",
          started_ms: T0 + DAY - 60_000,
        },
      ] as T);
    case "downloads_clear":
    case "download_open":
    case "download_reveal":
    case "download_cancel":
    case "download_pause":
    case "download_resume":
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
        mockEntries.push({
          name,
          is_dir: cmd === "fs_create_dir",
          symlink: false,
          size: 0,
          modified: mockNow(),
        });
      return Promise.resolve(undefined as T);
    }
    case "fs_rename": {
      const from = mockBase(String(args?.from ?? "")),
        to = mockBase(String(args?.to ?? ""));
      const e = mockEntries.find((e) => e.name === from);
      if (e && to) e.name = to;
      return Promise.resolve(undefined as T);
    }
    case "fs_copy": {
      const names = ((args?.paths as string[]) ?? []).map(mockBase);
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
      const names = new Set(((args?.paths as string[]) ?? []).map(mockBase));
      mockEntries = mockEntries.filter((e) => !names.has(e.name));
      return Promise.resolve(undefined as T);
    }
    case "fs_undo":
      return Promise.resolve(null as T); // no op history in the preview mock
    case "fs_watch":
    case "fs_unwatch":
      return Promise.resolve(undefined as T); // no live watch in the preview
    case "omni_stats":
      return Promise.resolve(
        JSON.stringify({
          live_docs: 591,
          total_docs: 591,
          tombstones: 0,
          segments: 2,
          embedded: true,
          ann: true,
          ann_vectors: 591,
          dated: 12,
          embedder_kind: "hash",
          embedder_dim: 2560,
          avg_title_len: 7,
          avg_body_len: 6130,
          segment_sizes: [
            { live: 412, total: 412 },
            { live: 179, total: 179 },
          ],
          top_docs: [
            { url: "https://arxiv.org/", title: "arXiv.org e-Print archive", rank: 0.019 },
            { url: "https://arxiv.org/login", title: "Log in to arXiv", rank: 0.0182 },
            {
              url: "https://en.wikipedia.org/wiki/Inverted_index",
              title: "Inverted index - Wikipedia",
              rank: 0.0151,
            },
            { url: "https://en.wikipedia.org/wiki/PageRank", title: "PageRank - Wikipedia", rank: 0.0144 },
            {
              url: "https://en.wikipedia.org/wiki/Rust_(programming_language)",
              title: "Rust (programming language) - Wikipedia",
              rank: 0.0139,
            },
            {
              url: "https://en.wikipedia.org/wiki/Help:Contents",
              title: "Help Contents - Wikipedia",
              rank: 0.0131,
            },
          ],
        }) as T,
      );
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
    case "ext_list":
      return Promise.resolve(mockExts as T);
    case "ext_install": {
      const dir = String(args?.dir ?? "");
      const m = {
        id: `local.${mockBase(dir) || "ext"}`,
        name: mockBase(dir) || "Extension",
        version: "1.0.0",
        permissions: ["dom:read"],
        content_scripts: [],
        background: null,
        ui: null,
      };
      mockExts = [...mockExts.filter((e) => e.manifest.id !== m.id), { manifest: m, dir, enabled: true }];
      return Promise.resolve(m as T);
    }
    case "ext_set_enabled": {
      const e = mockExts.find((x) => x.manifest.id === args?.id);
      if (e) e.enabled = args?.on as boolean;
      return Promise.resolve(undefined as T);
    }
    case "ext_remove":
      mockExts = mockExts.filter((x) => x.manifest.id !== args?.id);
      return Promise.resolve(undefined as T);
    case "vault_status":
      return Promise.resolve({
        available: true,
        locked: false,
        protection: "keychain",
        source: "keychain",
        count: mockVault.length,
        autolock_minutes: 0,
      } as T);
    case "vault_unlock":
    case "vault_lock":
    case "vault_set_master_password":
    case "vault_disable_master_password":
    case "vault_set_autolock":
      return Promise.resolve(undefined as T);
    case "vault_list":
      return Promise.resolve(mockVault.map(({ password: _pw, ...m }) => m) as T);
    case "vault_for_host":
      return Promise.resolve(mockVault.map(({ password: _pw, ...m }) => m) as T);
    case "vault_reveal":
      return Promise.resolve((mockVault.find((c) => c.id === args?.id)?.password ?? null) as T);
    case "vault_add": {
      const id = `c${nextId++}`;
      mockVault.push({
        id,
        name: String(args?.name ?? ""),
        urls: args?.url ? [String(args.url)] : [],
        username: String(args?.username ?? ""),
        password: String(args?.password ?? ""),
        has_totp: false,
      });
      return Promise.resolve(undefined as T);
    }
    case "vault_remove":
      mockVault = mockVault.filter((c) => c.id !== args?.id);
      return Promise.resolve(undefined as T);
    case "vault_import_proton":
      return Promise.resolve(0 as T); // no filesystem in the preview
    case "vault_fill":
      return Promise.resolve(undefined as T);
    case "cookies_status":
      return Promise.resolve({ clear_on_close: [] } as T);
    case "omni_sites":
      return Promise.resolve(
        JSON.stringify([
          {
            key: "yt",
            name: "YouTube",
            home: "https://www.youtube.com",
            blurb: "video lectures, talks, and tutorials",
          },
          {
            key: "gh",
            name: "GitHub",
            home: "https://github.com",
            blurb: "source code, repositories, and projects",
          },
          {
            key: "ax",
            name: "arXiv",
            home: "https://arxiv.org",
            blurb: "open-access e-prints in physics, math, CS",
          },
          {
            key: "mdn",
            name: "MDN Web Docs",
            home: "https://developer.mozilla.org",
            blurb: "web platform and JavaScript reference",
          },
        ]) as T,
      );
    case "search_default":
      return Promise.resolve("ddg" as T);
    case "search_engines":
      return Promise.resolve([
        { id: "ddg", name: "DuckDuckGo", keyword: "ddg", search_template: "", suggest_template: null },
        { id: "google", name: "Google", keyword: "g", search_template: "", suggest_template: null },
      ] as T);
    // Unmocked, this resolved to undefined and `memText().trim()` threw inside
    // convoPrompt — which broke *every* chat in the preview and looked like a
    // bug in whatever feature was being tested.
    // The Notebook page had no mocks at all, so it rendered empty in the preview
    // and nothing on it could be checked. One healthy source, one broken, so both
    // states of the location editor are visible.
    // The TUI launcher had no mock, so its rail was empty in the preview. Two
    // entries on icon *names* and one on a literal emoji, so both halves of
    // IconOrGlyph are exercised.
    case "tui_apps_list":
      return Promise.resolve([
        { id: "onyx", name: "Onyx", icon: "onyx", cmd: "onyx", cwd: "" },
        { id: "lazygit", name: "LazyGit", icon: "lazygit", cmd: "lazygit", cwd: "" },
        { id: "tuxedo", name: "Tuxedo", icon: "tuxedo", cmd: "tuxedo", cwd: "" },
        { id: "custom-1", name: "Canopy", icon: "🌳", cmd: "canopy", cwd: "" },
      ] as T);
    case "tui_apps_set":
      return Promise.resolve(undefined as T);
    case "tui_apps_detect":
      return Promise.resolve([] as T);
    case "kb_status":
    case "kb_reindex":
    case "kb_set_source":
      return Promise.resolve({
        embedder: "model",
        indexing: false,
        sources: [
          {
            source: "onyx",
            docs: 1090,
            chunks: 8421,
            last_ms: 60_000,
            error: null,
            location: "C:/Users/you/OnyxVault",
          },
          {
            source: "scroll",
            docs: 0,
            chunks: 0,
            last_ms: 0,
            error: "can't reach http://localhost:3131",
            location: null,
          },
          { source: "web", docs: 42, chunks: 310, last_ms: 900_000, error: null, location: null },
        ],
      } as T);
    case "memory_read":
      return Promise.resolve("- Prefers concise answers.\n- Uses nvim." as T);
    case "memory_write":
      return Promise.resolve(undefined as T);
    case "agent_chat":
      return Promise.resolve(
        "I'm Flux, your local assistant. Ask me anything — or use /act to control the page." as T,
      );
    // The streaming chat had no mock, so *every* ordinary message in the preview
    // ended as "TypeError: … reading 'trim'" — which made the whole chat path
    // unverifiable and looked like a bug in whatever feature was being tested.
    // Echoes back what it was given so a test can tell the context reached it.
    case "agent_chat_stream":
    case "agent_chat_tabs_stream": {
      const ch = args?.onToken as Channel<string> | undefined;
      const prompt = String(args?.prompt ?? "");
      // Quote the tail of the prompt: that's where convoPrompt puts the current
      // message, after the preamble and any file context.
      const tail = prompt.slice(-160).replace(/\s+/g, " ").trim();
      const reply = `(mock reply) I received ${prompt.length} chars of prompt ending: …${tail}`;
      if (ch) {
        // Two chunks, so a caller that assumes one message still gets exercised.
        setTimeout(() => ch.onmessage(reply.slice(0, 30)), 40);
        setTimeout(() => ch.onmessage(reply.slice(30)), 90);
      }
      return new Promise<T>((resolve) => setTimeout(() => resolve(undefined as T), 140));
    }
    case "agent_chat_tabs":
      return Promise.resolve(
        `(mock) Answering "${String(args?.prompt ?? "")}" across ${(args?.tabIds as number[] | undefined)?.length ?? 0} tabs.` as T,
      );
    case "agent_models":
      return Promise.resolve(["gemma4:12b-it-qat", "llama3.2:3b", "qwen2.5:7b"] as T);
    case "agent_model":
      return Promise.resolve("gemma4:12b-it-qat" as T);
    case "agent_set_model":
      return Promise.resolve(undefined as T);
    // Cloud escalation (#175). The preview has no keyring, so it reports the
    // real default state: local, with no key — which is also what the UI must
    // look like on a fresh machine.
    case "agent_cloud_status":
    case "agent_cloud_set":
      return Promise.resolve({ requested: false, available: false, active: false } as T);
    case "gemini_has_key":
      return Promise.resolve(false as T);
    case "gemini_default_model":
      return Promise.resolve("gemini-2.5-flash" as T);
    case "gemini_models":
      return Promise.resolve([] as T);
    // Agent file access (#176). The preview reports the shipped default: off,
    // i.e. unrestricted — which is also what a fresh install looks like.
    case "agent_roots_get":
      return Promise.resolve({ enabled: false, roots: [] } as T);
    case "agent_roots_set":
      return Promise.resolve(undefined as T);
    case "agent_roots_suggested":
      return Promise.resolve(["/home/you/OnyxVault", "/home/you/Downloads"] as T);
    // The gated reads delegate to the ungated ones once the check passes, so in
    // the preview (where nothing is gated) they behave identically.
    case "agent_fs_list":
      return invoke<T>("fs_list", args);
    case "agent_read_text_file":
      return invoke<T>("read_text_file", args);
    case "agent_write_text_file":
      return invoke<T>("write_text_file", args);
    case "agent_pdf_fetch":
      return invoke<T>("pdf_fetch", args);
    // Live editor state (#179). The preview has no PTY, so it stands in for a
    // connected nvim with an unsaved edit — the state worth being able to see.
    // Framing policy (#180). The preview reports framable so panes render; the
    // real check reads the site's headers over HEAD.
    case "frame_policy":
      return Promise.resolve({ framable: true, reason: "" } as T);
    case "nvim_socket":
      return Promise.resolve(`/tmp/flux-nvim-${String(args?.session ?? 0)}.sock` as T);
    case "nvim_state":
      return Promise.resolve({
        connected: true,
        file: "/home/you/Flux/crates/flux-core/src/nvim.rs",
        line: 42,
        col: 7,
        modified: true,
        lines: 118,
        buffers: ["/home/you/Flux/crates/flux-core/src/nvim.rs"],
      } as T);
    case "nvim_selection":
      return Promise.resolve({
        has: true,
        mode: "V",
        file: "/home/you/Flux/crates/flux-core/src/nvim.rs",
        start_line: 6,
        end_line: 8,
        text: 'fn helper(n: i32) {\n    println!("{}", n + 1);\n}',
      } as T);
    case "nvim_buffer":
      return Promise.resolve(
        '//! Reading the editor\'s live state.\n\npub fn socket_path(session: u64) -> String {\n    format!("/tmp/flux-nvim-{session}.sock") // unsaved edit\n}\n' as T,
      );
    case "omni_search": {
      const q = String(args?.query ?? "");
      return Promise.resolve([
        {
          kind: "tab",
          tab_id: tabs[0]?.id ?? 1,
          title: "Hacker News",
          url: "https://news.ycombinator.com",
          snippet: `…mentions ${q}…`,
          score: 0.9,
        },
        {
          kind: "bookmark",
          tab_id: null,
          title: "Rust",
          url: "https://rust-lang.org",
          snippet: "Imported",
          score: 0.7,
        },
        {
          kind: "history",
          tab_id: null,
          title: "flux-browser/flux",
          url: "https://github.com/flux-browser/flux",
          snippet: "",
          score: 0.5,
        },
      ] as T);
    }
    case "agent_execute":
    case "agent_plan":
      return Promise.resolve({
        action: "click",
        selector: "a[href*='unsubscribe']",
        reason: "unsubscribe link",
      } as T);
    case "agent_run_action":
      return Promise.resolve((args?.action ?? { action: "refuse", reason: "n/a" }) as T);
    case "agent_task_step": {
      // First call (no history) does a step; the next one finishes — a 2-step demo.
      const hist = (args?.history as string[]) ?? [];
      return Promise.resolve(
        (hist.length === 0
          ? { action: "reveal", selector: "main" }
          : { action: "finish", summary: `(mock) completed: ${String(args?.goal ?? "task")}` }) as T,
      );
    }
    case "tasks_list":
      return Promise.resolve([
        { pid: 4201, name: "flux", cpu: 6.4, mem_mb: 312, is_flux: true, current: true },
        { pid: 4218, name: "msedgewebview2", cpu: 18.2, mem_mb: 540, is_flux: true, current: false },
        { pid: 4219, name: "msedgewebview2 (gpu)", cpu: 3.1, mem_mb: 180, is_flux: true, current: false },
        { pid: 990, name: "node", cpu: 1.0, mem_mb: 142, is_flux: false, current: false },
        { pid: 712, name: "systemd", cpu: 0.0, mem_mb: 12, is_flux: false, current: false },
      ] as T);
    case "tasks_kill":
      return Promise.resolve(true as T);
    case "tasks_stats":
      return Promise.resolve({
        cpu: 23.5,
        mem_used_mb: 9800,
        mem_total_mb: 16384,
        mem_pct: 60,
        cores: 8,
      } as T);
    case "netspeed_run":
      return Promise.resolve({
        ping_ms: 14,
        jitter_ms: 3,
        download_mbps: 187.4,
        upload_mbps: 42.1,
        server: "speed.cloudflare.com",
      } as T);
    case "shields_hot_rules":
      return Promise.resolve([
        { rule: "||doubleclick.net^", hits: 42 },
        { rule: "||google-analytics.com^", hits: 31 },
        { rule: "/ads/*", hits: 17 },
      ] as T);
    case "lean_status":
      return Promise.resolve({ enabled: true, sites_on: [] } as T);
    case "archive_search":
    case "archive_list":
      return Promise.resolve([
        {
          id: 1,
          url: "https://example.com/rust",
          title: "Rust ownership explained",
          saved_ms: Date.now() - 86400000,
          snippet: "Ownership, borrowing, and lifetimes are the core of Rust's memory safety…",
          score: 92,
        },
        {
          id: 2,
          url: "https://example.com/pasta",
          title: "The perfect pasta",
          saved_ms: Date.now() - 172800000,
          snippet: "Tomato, garlic, basil, and good olive oil…",
          score: 0,
        },
      ] as T);
    case "archive_get":
      return Promise.resolve({
        id: 1,
        url: "https://example.com/rust",
        title: "Rust ownership explained",
        saved_ms: Date.now() - 86400000,
        text: "Ownership is Rust's most distinctive feature.\n\nEach value has a single owner, and when the owner goes out of scope the value is dropped.",
      } as T);
    case "archive_save":
      return Promise.resolve({
        id: 3,
        url: "https://example.com/new",
        title: "Saved page",
        saved_ms: Date.now(),
        snippet: "",
        score: 0,
      } as T);
    case "archive_delete":
      return Promise.resolve(undefined as T);
    case "boosts_for_host":
      return Promise.resolve([
        {
          id: 1,
          host: String(args?.host ?? ""),
          name: "Widen the article",
          css: "main{max-width:90%}",
          js: "",
          enabled: true,
        },
      ] as T);
    case "boost_author":
      return Promise.resolve({
        id: 2,
        host: "example.com",
        name: String(args?.instruction ?? "boost"),
        css: ".ad{display:none}",
        js: "",
        enabled: true,
      } as T);
    case "boost_set_enabled":
    case "boost_delete":
      return Promise.resolve(undefined as T);
    case "pwa_list":
      return Promise.resolve([
        { id: 1, name: "Discord", url: "https://discord.com/app" },
        { id: 2, name: "WhatsApp", url: "https://web.whatsapp.com" },
      ] as T);
    case "pwa_install":
      return Promise.resolve({ id: 3, name: String(args?.name ?? "App"), url: String(args?.url ?? "") } as T);
    case "pwa_launch":
    case "pwa_remove":
      return Promise.resolve(undefined as T);
    case "macros_list":
      return Promise.resolve([
        {
          id: 1,
          name: "HN front page → first comment",
          steps: [
            { kind: "navigate", url: "https://news.ycombinator.com" },
            { kind: "click", selector: ".titleline > a" },
          ],
        },
      ] as T);
    case "macros_status":
      return Promise.resolve({ recording: false, step_count: 0 } as T);
    case "macro_start_record":
    case "macro_cancel_record":
    case "macro_delete":
    case "macro_rename":
    case "macro_run":
      return Promise.resolve(undefined as T);
    case "macro_stop_record":
      return Promise.resolve(null as T);
    case "sync_status":
      return Promise.resolve({ folder: "~/Dropbox/Flux", unlocked: false, last_ms: 0 } as T);
    case "sync_now":
      return Promise.resolve({ bookmarks_added: 3, sessions_added: 1 } as T);
    case "sync_set_folder":
    case "sync_unlock":
    case "sync_lock":
      return Promise.resolve(undefined as T);
    case "agent_translate":
      return Promise.resolve(
        `(mock translation → ${String(args?.target ?? "?")})\n\nThis is where the translated page text would appear, paragraph by paragraph.` as T,
      );
    case "permissions_list":
      return Promise.resolve([
        { host: "meet.google.com", kind: "camera", decision: "allow" },
        { host: "meet.google.com", kind: "microphone", decision: "allow" },
        { host: "ads.example.com", kind: "notifications", decision: "deny" },
      ] as T);
    case "pdf_save":
      return Promise.resolve(`~/Downloads/${String(args?.filename ?? "edited.pdf")}` as T);
    case "feeds_list":
      return Promise.resolve([
        { id: 1, url: "https://blog.rust-lang.org/feed.xml", title: "Rust Blog" },
        { id: 2, url: "https://hnrss.org/frontpage", title: "Hacker News: Front Page" },
      ] as T);
    case "feed_add":
      return Promise.resolve({ id: 3, url: String(args?.url ?? ""), title: "New Feed" } as T);
    case "feed_remove":
      return Promise.resolve(undefined as T);
    case "feed_items":
      return Promise.resolve([
        {
          feed_id: 1,
          feed_title: "Rust Blog",
          title: "Announcing Rust 1.99",
          link: "https://blog.rust-lang.org/2026/01/01/Rust-1.99.html",
          summary: "The Rust team is happy to announce a new version of Rust.",
          published: "Thu, 01 Jan 2026 00:00:00 GMT",
        },
        {
          feed_id: 2,
          feed_title: "Hacker News: Front Page",
          title: "Show HN: Flux, an AI-native browser",
          link: "https://news.ycombinator.com/item?id=1",
          summary: "A small, fast browser with a local agent and a terminal.",
          published: "2026-01-02T08:30:00Z",
        },
      ] as T);
    case "cal_list":
      return Promise.resolve([
        { id: 1, url: "https://calendar.google.com/calendar/ical/x/private/basic.ics", name: "Personal" },
      ] as T);
    case "cal_add":
      return Promise.resolve({
        id: 2,
        url: String(args?.url ?? ""),
        name: String(args?.name ?? "Calendar"),
      } as T);
    case "cal_remove":
      return Promise.resolve(undefined as T);
    case "cal_events": {
      const d = new Date(mockNow());
      const iso = (off: number) => {
        const x = new Date(d.getTime() + off * DAY);
        return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}-${String(x.getDate()).padStart(2, "0")}`;
      };
      return Promise.resolve([
        {
          calendar: "Personal",
          summary: "Team sync",
          date: iso(0),
          time: "10:00",
          location: "Room 4",
          sort_key: 0,
        },
        { calendar: "Personal", summary: "Dentist", date: iso(2), time: "14:30", location: "", sort_key: 1 },
        { calendar: "Personal", summary: "Long weekend", date: iso(5), time: "", location: "", sort_key: 2 },
      ] as T);
    }
    case "todos_list":
      return Promise.resolve([
        { id: 1, title: "Ship the calendar widget", done: false, created_ms: T0, due: "" },
        { id: 2, title: "Reply to Alice", done: true, created_ms: T0, due: "" },
      ] as T);
    case "todo_add":
      return Promise.resolve({
        id: 9,
        title: String(args?.title ?? ""),
        done: false,
        created_ms: mockNow(),
        due: String(args?.due ?? ""),
      } as T);
    case "todo_toggle":
    case "todo_remove":
      return Promise.resolve(undefined as T);
    case "todos_clear_done":
      return Promise.resolve(1 as T);
    case "prefetch_hints":
      return Promise.resolve([] as T);
    case "hibernate_rank":
      return Promise.resolve([] as T);
    case "set_window_acrylic":
      return Promise.resolve(undefined as T);
    default:
      return Promise.resolve(undefined as T);
  }
}
