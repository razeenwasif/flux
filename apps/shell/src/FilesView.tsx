/**
 * Files tab — a fast, minimal, read-only filesystem explorer (ADR 0006).
 *
 * Rows are virtualized (only the visible slice is in the DOM) so a directory
 * with tens of thousands of entries scrolls at 120fps; listing/sorting/filter
 * are client-side over a compact payload from `fs_list`. The cwd lives in the
 * tab's `url` (via `onPathChange`) so it survives tab switches.
 */
import {
  For,
  Show,
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  onMount,
  type Component,
} from "solid-js";
import { fsList, fsOpen, fsQuickLocations, type DirListing, type FileEntry, type QuickLocation } from "./ipc";

const ROW_H = 30;

type SortKey = "name" | "size" | "modified";

const FilesView: Component<{ path: string; onPathChange: (p: string) => void }> = (props) => {
  const [cwd, setCwd] = createSignal(props.path);
  const [listing, setListing] = createSignal<DirListing | null>(null);
  const [loading, setLoading] = createSignal(true);
  const [error, setError] = createSignal<string | null>(null);
  const [places, setPlaces] = createSignal<QuickLocation[]>([]);
  const [sort, setSort] = createSignal<{ key: SortKey; dir: 1 | -1 }>({ key: "name", dir: 1 });
  const [filter, setFilter] = createSignal("");
  const [showHidden, setShowHidden] = createSignal(false);
  const [sel, setSel] = createSignal(-1);

  // Navigation history (per Files tab).
  let back: string[] = [];
  let fwd: string[] = [];
  const [canBack, setCanBack] = createSignal(false);
  const [canFwd, setCanFwd] = createSignal(false);
  const syncNav = () => {
    setCanBack(back.length > 0);
    setCanFwd(fwd.length > 0);
  };

  const load = async (path: string) => {
    setLoading(true);
    setError(null);
    setSel(-1);
    try {
      const l = await fsList(path);
      setListing(l);
      setCwd(l.path);
      props.onPathChange(l.path);
      if (scroller) scroller.scrollTop = 0;
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  };

  const navigate = (path: string) => {
    if (path === cwd()) return;
    back.push(cwd());
    fwd = [];
    syncNav();
    void load(path);
  };
  const goBack = () => {
    const p = back.pop();
    if (p) { fwd.push(cwd()); syncNav(); void load(p); }
  };
  const goFwd = () => {
    const p = fwd.pop();
    if (p) { back.push(cwd()); syncNav(); void load(p); }
  };
  const goUp = () => {
    const par = listing()?.parent;
    if (par) navigate(par);
  };

  onMount(async () => {
    await load(props.path);
    setPlaces(await fsQuickLocations().catch(() => []));
  });

  // Filter (hidden + search) then sort (folders first, then the chosen key).
  const view = createMemo<FileEntry[]>(() => {
    const l = listing();
    if (!l) return [];
    let es = l.entries;
    if (!showHidden()) es = es.filter((e) => !e.name.startsWith("."));
    const f = filter().trim().toLowerCase();
    if (f) es = es.filter((e) => e.name.toLowerCase().includes(f));
    const { key, dir } = sort();
    return [...es].sort((a, b) => {
      if (a.is_dir !== b.is_dir) return a.is_dir ? -1 : 1;
      let c = 0;
      if (key === "name") c = a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });
      else if (key === "size") c = a.size - b.size;
      else c = (a.modified ?? 0) - (b.modified ?? 0);
      return c * dir;
    });
  });

  const toggleSort = (key: SortKey) =>
    setSort((s) => (s.key === key ? { key, dir: (s.dir === 1 ? -1 : 1) as 1 | -1 } : { key, dir: 1 }));

  const openEntry = (e: FileEntry) => {
    const p = joinPath(cwd(), e.name);
    if (e.is_dir) navigate(p);
    else void fsOpen(p).catch((err) => setError(String(err)));
  };

  // ── Virtualization ──
  let scroller!: HTMLDivElement;
  const [scrollTop, setScrollTop] = createSignal(0);
  const [vh, setVh] = createSignal(480);
  const start = () => Math.max(0, Math.floor(scrollTop() / ROW_H) - 6);
  const end = () => Math.min(view().length, Math.ceil((scrollTop() + vh()) / ROW_H) + 6);
  const slice = () => view().slice(start(), end());

  onMount(() => {
    const ro = new ResizeObserver(() => setVh(scroller.clientHeight));
    ro.observe(scroller);
    setVh(scroller.clientHeight);
    onCleanup(() => ro.disconnect());
  });

  // Keyboard nav: ↑/↓ move selection, Enter opens, Backspace goes up.
  const onKey = (e: KeyboardEvent) => {
    const n = view().length;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSel((i) => Math.min(n - 1, i + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSel((i) => Math.max(0, i < 0 ? 0 : i - 1));
    } else if (e.key === "Enter") {
      const item = view()[sel()];
      if (item) openEntry(item);
    } else if (e.key === "Backspace") {
      e.preventDefault();
      goUp();
    }
  };
  // Keep the keyboard-selected row in view.
  createEffect(() => {
    const i = sel();
    if (i < 0 || !scroller) return;
    const top = i * ROW_H;
    if (top < scroller.scrollTop) scroller.scrollTop = top;
    else if (top + ROW_H > scroller.scrollTop + scroller.clientHeight)
      scroller.scrollTop = top + ROW_H - scroller.clientHeight;
  });

  const counts = () => {
    const es = view();
    const dirs = es.filter((e) => e.is_dir).length;
    return { total: es.length, dirs, files: es.length - dirs };
  };

  return (
    <div class="files" tabindex={0} onKeyDown={onKey}>
      {/* Toolbar: nav + breadcrumb + search */}
      <div class="files-toolbar">
        <button class="files-nav" disabled={!canBack()} title="Back" onClick={goBack}>‹</button>
        <button class="files-nav" disabled={!canFwd()} title="Forward" onClick={goFwd}>›</button>
        <button class="files-nav" disabled={!listing()?.parent} title="Up" onClick={goUp}>↑</button>
        <div class="files-crumbs">
          <For each={crumbs(cwd())}>
            {(c, i) => (
              <>
                <Show when={i() > 0}><span class="files-crumb-sep">›</span></Show>
                <button class="files-crumb" onClick={() => navigate(c.path)}>{c.name}</button>
              </>
            )}
          </For>
        </div>
        <input
          class="files-search"
          value={filter()}
          onInput={(e) => setFilter(e.currentTarget.value)}
          placeholder="Filter"
          spellcheck={false}
        />
      </div>

      <div class="files-body">
        {/* Quick-access rail */}
        <nav class="files-rail">
          <div class="files-rail-section">Quick access</div>
          <For each={places().filter((p) => p.kind !== "drive")}>
            {(p) => (
              <button classList={{ "files-loc": true, active: cwd() === p.path }} onClick={() => navigate(p.path)}>
                <span class="files-loc-icon">{p.kind === "home" ? <HomeIcon /> : <FolderIcon />}</span>
                {p.name}
              </button>
            )}
          </For>
          <Show when={places().some((p) => p.kind === "drive")}>
            <div class="files-rail-section">Drives</div>
            <For each={places().filter((p) => p.kind === "drive")}>
              {(p) => (
                <button classList={{ "files-loc": true, active: cwd() === p.path }} onClick={() => navigate(p.path)}>
                  <span class="files-loc-icon"><DriveIcon /></span>
                  {p.name}
                </button>
              )}
            </For>
          </Show>
        </nav>

        {/* Listing */}
        <main class="files-main">
          <div class="files-head">
            <button classList={{ "files-col": true, name: true, sorted: sort().key === "name" }} onClick={() => toggleSort("name")}>
              Name {sortCaret(sort(), "name")}
            </button>
            <button classList={{ "files-col": true, size: true, sorted: sort().key === "size" }} onClick={() => toggleSort("size")}>
              Size {sortCaret(sort(), "size")}
            </button>
            <button classList={{ "files-col": true, modified: true, sorted: sort().key === "modified" }} onClick={() => toggleSort("modified")}>
              Modified {sortCaret(sort(), "modified")}
            </button>
          </div>

          <div class="files-list" ref={scroller} onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}>
            <Show when={!loading()} fallback={<div class="files-empty">Loading…</div>}>
              <Show when={!error()} fallback={<div class="files-empty files-err">{error()}</div>}>
                <Show when={view().length > 0} fallback={<div class="files-empty">This folder is empty.</div>}>
                  <div class="files-spacer" style={{ height: `${view().length * ROW_H}px` }}>
                    <For each={slice()}>
                      {(entry, i) => {
                        const idx = () => start() + i();
                        return (
                          <div
                            classList={{ "files-row": true, selected: sel() === idx() }}
                            style={{ top: `${idx() * ROW_H}px` }}
                            onClick={() => setSel(idx())}
                            onDblClick={() => openEntry(entry)}
                            title={entry.name}
                          >
                            <span class="files-cell name">
                              <span class="file-icon" style={{ color: entry.is_dir ? "var(--flux-violet)" : iconColor(entry.name) }}>
                                {entry.is_dir ? <FolderIcon /> : <FileIcon />}
                              </span>
                              <span class="files-name">{entry.name}</span>
                              <Show when={entry.symlink}><span class="files-link">↗</span></Show>
                            </span>
                            <span class="files-cell size">{fmtSize(entry.size, entry.is_dir)}</span>
                            <span class="files-cell modified">{fmtDate(entry.modified)}</span>
                          </div>
                        );
                      }}
                    </For>
                  </div>
                </Show>
              </Show>
            </Show>
          </div>
        </main>
      </div>

      {/* Status bar */}
      <div class="files-statusbar">
        <span>{counts().total} items · {counts().dirs} folders · {counts().files} files</span>
        <span style={{ flex: 1 }} />
        <label class="files-toggle">
          <input type="checkbox" checked={showHidden()} onChange={(e) => setShowHidden(e.currentTarget.checked)} />
          Hidden
        </label>
      </div>
    </div>
  );
};

// ─── helpers ────────────────────────────────────────────────────────────────

function joinPath(dir: string, name: string): string {
  const sep = dir.includes("\\") ? "\\" : "/";
  return dir.endsWith(sep) ? dir + name : dir + sep + name;
}

/** Breadcrumb segments with their absolute paths (Windows `C:\…` + Unix `/…`). */
function crumbs(path: string): { name: string; path: string }[] {
  const win = path.includes("\\");
  const sep = win ? "\\" : "/";
  const out: { name: string; path: string }[] = [];
  let acc = "";
  path.split(sep).forEach((part, i) => {
    if (i === 0) {
      if (win) { acc = part + sep; out.push({ name: part, path: acc }); }
      else { acc = "/"; out.push({ name: "/", path: "/" }); }
    } else if (part) {
      acc = acc.endsWith(sep) ? acc + part : acc + sep + part;
      out.push({ name: part, path: acc });
    }
  });
  return out;
}

function fmtSize(n: number, isDir: boolean): string {
  if (isDir) return "—";
  if (n < 1024) return `${n} B`;
  const u = ["KB", "MB", "GB", "TB"];
  let v = n;
  let i = -1;
  do { v /= 1024; i++; } while (v >= 1024 && i < u.length - 1);
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${u[i]}`;
}

function fmtDate(ms: number | null): string {
  if (!ms) return "—";
  const d = new Date(ms);
  return (
    d.toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" }) +
    " " +
    d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
  );
}

function iconColor(name: string): string {
  const ext = name.includes(".") ? name.split(".").pop()!.toLowerCase() : "";
  const inSet = (s: string) => s.split(" ").includes(ext);
  if (inSet("rs ts tsx js jsx py go c cpp h hpp java rb php sh json toml yaml yml html css md sql lua")) return "#2ff3ff";
  if (inSet("png jpg jpeg gif svg webp bmp ico avif")) return "#9d8df1";
  if (inSet("mp4 mov mp3 wav flac mkv avi webm")) return "#ec4be0";
  if (inSet("zip tar gz 7z rar xz bz2")) return "#ff9f45";
  if (inSet("pdf doc docx txt xls xlsx ppt pptx csv")) return "#5bc0eb";
  return "var(--flux-text-mute)";
}

function sortCaret(s: { key: SortKey; dir: 1 | -1 }, key: SortKey): string {
  return s.key === key ? (s.dir === 1 ? "▲" : "▼") : "";
}

const FolderIcon = () => (
  <svg viewBox="0 0 24 24" width="17" height="17" fill="currentColor" aria-hidden="true">
    <path d="M10 4H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-8l-2-2z" />
  </svg>
);
const FileIcon = () => (
  <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round" aria-hidden="true">
    <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
    <path d="M14 3v5h5" />
  </svg>
);
const HomeIcon = () => (
  <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round" aria-hidden="true">
    <path d="M3 11l9-7 9 7" /><path d="M5 10v9a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-9" />
  </svg>
);
const DriveIcon = () => (
  <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round" aria-hidden="true">
    <rect x="3" y="5" width="18" height="14" rx="2" /><circle cx="16.5" cy="12" r="1.3" fill="currentColor" stroke="none" />
  </svg>
);

export default FilesView;
