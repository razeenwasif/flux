/**
 * Files tab — a fast, minimal filesystem explorer (ADR 0006).
 *
 * Rows are virtualized (only the visible slice is in the DOM) so a directory
 * with tens of thousands of entries scrolls at 120fps; listing/sorting/filter
 * are client-side over a compact payload from `fs_list`. The cwd lives in the
 * tab's `url` (via `onPathChange`) so it survives tab switches.
 *
 * File operations (BACKLOG #83): new folder/file, rename (inline), copy/cut/
 * paste, drag-move, and delete (→ OS trash, or permanent). Multi-select with
 * click / ⌘-click / shift-click / ⌘A, a right-click context menu, and keyboard
 * shortcuts (F2, ⌫, ⌘C/X/V/A). Destructive ops confirm first.
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
  type JSX,
} from "solid-js";
import {
  fsCopy,
  fsCreateDir,
  fsCreateFile,
  fsDelete,
  fsList,
  fsMove,
  fsOpen,
  fsQuickLocations,
  fsRename,
  fsTrash,
  fsUndo,
  fsUnwatch,
  fsWatch,
  onFsChanged,
  type DirListing,
  type FileEntry,
  type QuickLocation,
} from "./ipc";

const ROW_H = 30;

type SortKey = "name" | "size" | "modified";
type Clipboard = { mode: "copy" | "cut"; paths: string[] } | null;
type Menu = { x: number; y: number; entry: FileEntry | null } | null;
type Creating = { kind: "dir" | "file"; value: string } | null;
type Confirm = { title: string; body: string; danger: boolean; onYes: () => void } | null;

const FilesView: Component<{ id: number; path: string; onPathChange: (p: string) => void }> = (props) => {
  const [cwd, setCwd] = createSignal(props.path);
  const [listing, setListing] = createSignal<DirListing | null>(null);
  const [loading, setLoading] = createSignal(true);
  const [error, setError] = createSignal<string | null>(null);
  const [places, setPlaces] = createSignal<QuickLocation[]>([]);
  const [sort, setSort] = createSignal<{ key: SortKey; dir: 1 | -1 }>({ key: "name", dir: 1 });
  const [filter, setFilter] = createSignal("");
  const [showHidden, setShowHidden] = createSignal(false);

  // Selection: a set of entry names (stable across sort/filter) plus a cursor +
  // anchor (indices into the current view) for keyboard nav and shift-range.
  const [selected, setSelected] = createSignal<Set<string>>(new Set());
  const [cursor, setCursor] = createSignal(-1);
  let anchor = -1;

  const [clipboard, setClipboard] = createSignal<Clipboard>(null);
  const [menu, setMenu] = createSignal<Menu>(null);
  const [creating, setCreating] = createSignal<Creating>(null);
  const [renaming, setRenaming] = createSignal<string | null>(null);
  const [confirm, setConfirm] = createSignal<Confirm>(null);
  const [notice, setNotice] = createSignal<{ kind: "ok" | "err"; text: string } | null>(null);
  const [dropTarget, setDropTarget] = createSignal<string | null>(null);
  let dragPaths: string[] = [];
  let noticeTimer: number | undefined;
  let unlistenFs: (() => void) | undefined;
  let watchTimer: number | undefined;

  // Navigation history (per Files tab).
  let back: string[] = [];
  let fwd: string[] = [];
  const [canBack, setCanBack] = createSignal(false);
  const [canFwd, setCanFwd] = createSignal(false);
  const syncNav = () => {
    setCanBack(back.length > 0);
    setCanFwd(fwd.length > 0);
  };

  const toast = (text: string, kind: "ok" | "err" = "ok") => {
    setNotice({ kind, text });
    clearTimeout(noticeTimer);
    noticeTimer = window.setTimeout(() => setNotice(null), 3600);
  };

  const load = async (path: string, selectName?: string) => {
    setLoading(true);
    setError(null);
    try {
      const l = await fsList(path);
      setListing(l);
      setCwd(l.path);
      props.onPathChange(l.path);
      void fsWatch(props.id, l.path).catch(() => {}); // live watch (#85)
      setSelected(selectName ? new Set([selectName]) : new Set<string>());
      setCursor(-1);
      anchor = -1;
      if (scroller) scroller.scrollTop = 0;
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  };
  /** Reload the current directory, optionally selecting a freshly-made entry. */
  const refresh = (selectName?: string) => load(cwd(), selectName);
  /** Re-list in place (external change / undo): keep scroll + selection. */
  const softRefresh = async () => {
    try {
      const l = await fsList(cwd());
      setListing(l);
      const names = new Set(l.entries.map((e) => e.name));
      setSelected((prev) => new Set([...prev].filter((n) => names.has(n))));
    } catch {
      // Directory may have been removed out from under us — leave it as-is.
    }
  };
  const undo = async () => {
    try {
      const desc = await fsUndo();
      if (desc) { await softRefresh(); toast(desc); }
      else toast("Nothing to undo");
    } catch (e) {
      toast(String(e), "err");
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
    // Live watch: re-list (debounced) when the shown directory changes on disk.
    unlistenFs = await onFsChanged((p) => {
      if (p !== cwd()) return;
      clearTimeout(watchTimer);
      watchTimer = window.setTimeout(() => void softRefresh(), 180);
    }).catch(() => undefined);
  });
  onCleanup(() => {
    unlistenFs?.();
    clearTimeout(watchTimer);
    void fsUnwatch(props.id).catch(() => {});
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
    else void fsOpen(p).catch((err) => toast(String(err), "err"));
  };

  // ── Selection ──
  const nameAt = (i: number) => view()[i]?.name;
  const selectOnly = (i: number) => {
    const n = nameAt(i);
    anchor = i;
    setCursor(i);
    setSelected(n ? new Set([n]) : new Set<string>());
  };
  const selectRange = (i: number) => {
    if (anchor < 0) return selectOnly(i);
    const [lo, hi] = anchor < i ? [anchor, i] : [i, anchor];
    const next = new Set<string>();
    for (let k = lo; k <= hi; k++) { const n = nameAt(k); if (n) next.add(n); }
    setCursor(i);
    setSelected(next);
  };
  const toggleAt = (i: number) => {
    const n = nameAt(i);
    if (!n) return;
    const next = new Set(selected());
    next.has(n) ? next.delete(n) : next.add(n);
    anchor = i;
    setCursor(i);
    setSelected(next);
  };
  const selectAll = () => {
    setSelected(new Set(view().map((e) => e.name)));
    setCursor(view().length - 1);
    anchor = 0;
  };
  const clearSel = () => { setSelected(new Set<string>()); setCursor(-1); anchor = -1; };

  const onRowClick = (i: number, e: MouseEvent) => {
    if (e.shiftKey) selectRange(i);
    else if (e.ctrlKey || e.metaKey) toggleAt(i);
    else selectOnly(i);
  };

  /** Full paths of the current selection, in view order. */
  const selectedPaths = () =>
    view().filter((e) => selected().has(e.name)).map((e) => joinPath(cwd(), e.name));

  // ── File operations ──
  const startCreate = (kind: "dir" | "file") => {
    setMenu(null);
    if (scroller) scroller.scrollTop = 0;
    setCreating({ kind, value: "" });
  };
  const commitCreate = async () => {
    const c = creating();
    if (!c) return;
    const name = c.value.trim();
    setCreating(null);
    if (!name) return;
    if (invalidName(name)) return toast("Invalid name", "err");
    const p = joinPath(cwd(), name);
    try {
      await (c.kind === "dir" ? fsCreateDir(p) : fsCreateFile(p));
      await refresh(name);
    } catch (e) {
      toast(String(e), "err");
    }
  };

  const startRename = () => {
    setMenu(null);
    const n = nameAt(cursor());
    if (n) setRenaming(n);
  };
  const commitRename = async (oldName: string, value: string) => {
    setRenaming(null);
    const name = value.trim();
    if (!name || name === oldName) return;
    if (invalidName(name)) return toast("Invalid name", "err");
    try {
      await fsRename(joinPath(cwd(), oldName), joinPath(cwd(), name));
      await refresh(name);
    } catch (e) {
      toast(String(e), "err");
    }
  };

  const copySel = () => {
    const paths = selectedPaths();
    if (paths.length) { setClipboard({ mode: "copy", paths }); toast(`Copied ${paths.length} item${plural(paths.length)}`); }
    setMenu(null);
  };
  const cutSel = () => {
    const paths = selectedPaths();
    if (paths.length) { setClipboard({ mode: "cut", paths }); toast(`Cut ${paths.length} item${plural(paths.length)}`); }
    setMenu(null);
  };
  const paste = async () => {
    const cb = clipboard();
    setMenu(null);
    if (!cb) return;
    try {
      if (cb.mode === "copy") await fsCopy(cb.paths, cwd());
      else { await fsMove(cb.paths, cwd()); setClipboard(null); }
      await refresh();
    } catch (e) {
      toast(String(e), "err");
    }
  };

  const doMove = async (paths: string[], dest: string) => {
    // Skip no-op / self-into-descendant moves; let the backend reject the rest.
    const real = paths.filter((p) => dest !== parentOf(p) && dest !== p && !dest.startsWith(p + sepOf(p)));
    if (!real.length) return;
    try {
      await fsMove(real, dest);
      await refresh();
    } catch (e) {
      toast(String(e), "err");
    }
  };

  const askDelete = (permanent: boolean) => {
    setMenu(null);
    const paths = selectedPaths();
    if (!paths.length) return;
    const n = paths.length;
    const what = n === 1 ? `“${baseName(paths[0]!)}”` : `${n} items`;
    setConfirm({
      title: permanent ? "Delete permanently?" : "Move to Trash?",
      body: permanent
        ? `Permanently delete ${what}. This cannot be undone.`
        : `Move ${what} to the Trash.`,
      danger: permanent,
      onYes: async () => {
        setConfirm(null);
        try {
          await (permanent ? fsDelete(paths) : fsTrash(paths));
          await refresh();
          toast(permanent ? `Deleted ${n} item${plural(n)}` : `Moved ${n} item${plural(n)} to Trash`);
        } catch (e) {
          toast(String(e), "err");
        }
      },
    });
  };

  // ── Virtualization ──
  let scroller!: HTMLDivElement;
  let filesRoot!: HTMLDivElement;
  const [scrollTop, setScrollTop] = createSignal(0);
  const [vh, setVh] = createSignal(480);
  const start = () => Math.max(0, Math.floor(scrollTop() / ROW_H) - 6);
  const end = () => Math.min(view().length, Math.ceil((scrollTop() + vh()) / ROW_H) + 6);
  const slice = () => view().slice(start(), end());

  onMount(() => {
    const ro = new ResizeObserver(() => setVh(scroller.clientHeight));
    ro.observe(scroller);
    setVh(scroller.clientHeight);
    onCleanup(() => { ro.disconnect(); clearTimeout(noticeTimer); });
  });

  // ── Marquee (rubber-band) selection (#90) ──
  // Drag on empty space to draw a rectangle; rows whose band it covers select.
  // Coordinates are in *content* space (scroll-independent) so it stays aligned
  // while the list auto-scrolls at the edges.
  const [marquee, setMarquee] = createSignal<{ x1: number; y1: number; x2: number; y2: number } | null>(null);
  let marqueeBase = new Set<string>(); // selection to union with (additive drags)
  let marqueeRaf = 0;
  let marqueePtr: { x: number; y: number } | null = null;

  const marqueeTick = () => {
    if (!marqueePtr || !scroller) return;
    const r = scroller.getBoundingClientRect();
    const edge = 26; // auto-scroll when the pointer nears an edge
    if (marqueePtr.y < r.top + edge) scroller.scrollTop -= 14;
    else if (marqueePtr.y > r.bottom - edge) scroller.scrollTop += 14;
    const x2 = marqueePtr.x - r.left;
    const y2 = marqueePtr.y - r.top + scroller.scrollTop;
    const m = setMarquee((p) => (p ? { ...p, x2, y2 } : p));
    if (!m) return;
    const lo = Math.max(0, Math.floor(Math.min(m.y1, m.y2) / ROW_H));
    const hi = Math.min(view().length - 1, Math.floor(Math.max(m.y1, m.y2) / ROW_H));
    const next = new Set(marqueeBase);
    for (let i = lo; i <= hi; i++) { const name = nameAt(i); if (name) next.add(name); }
    setSelected(next);
    if (hi >= lo) setCursor(hi);
    marqueeRaf = requestAnimationFrame(marqueeTick);
  };

  const onListMouseDown = (e: MouseEvent) => {
    if (e.button !== 0 || creating() || renaming()) return;
    const tgt = e.target as HTMLElement;
    if (tgt !== scroller && !tgt.classList.contains("files-spacer")) return; // empty area only
    const r = scroller.getBoundingClientRect();
    const additive = e.shiftKey || e.ctrlKey || e.metaKey;
    marqueeBase = additive ? new Set(selected()) : new Set<string>();
    if (!additive) clearSel();
    const x = e.clientX - r.left;
    const y = e.clientY - r.top + scroller.scrollTop;
    setMarquee({ x1: x, y1: y, x2: x, y2: y });
    marqueePtr = { x: e.clientX, y: e.clientY };
    filesRoot?.focus(); // keep keyboard nav after the drag
    const onMove = (ev: MouseEvent) => { marqueePtr = { x: ev.clientX, y: ev.clientY }; };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      cancelAnimationFrame(marqueeRaf);
      marqueeRaf = 0;
      marqueePtr = null;
      setMarquee(null);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    marqueeRaf = requestAnimationFrame(marqueeTick);
    e.preventDefault();
  };
  onCleanup(() => cancelAnimationFrame(marqueeRaf));

  // Keyboard: nav + the operation shortcuts. Inputs and open dialogs opt out.
  const onKey = (e: KeyboardEvent) => {
    if ((e.target as HTMLElement)?.tagName === "INPUT") return;
    if (creating() || renaming()) return;
    if (confirm()) { if (e.key === "Escape") setConfirm(null); return; }
    if (menu()) { if (e.key === "Escape") setMenu(null); return; }

    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === "z") { e.preventDefault(); void undo(); return; }
    if (mod && e.key.toLowerCase() === "a") { e.preventDefault(); selectAll(); return; }
    if (mod && e.key.toLowerCase() === "c") { copySel(); return; }
    if (mod && e.key.toLowerCase() === "x") { cutSel(); return; }
    if (mod && e.key.toLowerCase() === "v") { void paste(); return; }

    const n = view().length;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      const i = Math.min(n - 1, cursor() + 1);
      e.shiftKey ? selectRange(i) : selectOnly(i);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      const i = Math.max(0, cursor() < 0 ? 0 : cursor() - 1);
      e.shiftKey ? selectRange(i) : selectOnly(i);
    } else if (e.key === "Enter") {
      const item = view()[cursor()];
      if (item) openEntry(item);
    } else if (e.key === "F2") {
      e.preventDefault();
      startRename();
    } else if (e.key === "Delete" || (e.key === "Backspace" && (e.metaKey || e.ctrlKey))) {
      e.preventDefault();
      askDelete(e.shiftKey);
    } else if (e.key === "Backspace") {
      e.preventDefault();
      goUp();
    } else if (e.key === "Escape") {
      clearSel();
    }
  };
  // Keep the keyboard cursor row in view.
  createEffect(() => {
    const i = cursor();
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

  // Context menu, built from what's under the cursor + current state.
  const openMenu = (e: MouseEvent, entry: FileEntry | null) => {
    e.preventDefault();
    e.stopPropagation();
    setMenu({ x: e.clientX, y: e.clientY, entry });
  };
  const menuItems = (): (MenuItem | "sep")[] => {
    const m = menu();
    if (!m) return [];
    const selCount = selected().size;
    const hasClip = !!clipboard();
    if (m.entry) {
      const items: (MenuItem | "sep")[] = [
        { label: "Open", run: () => { setMenu(null); openEntry(m.entry!); } },
      ];
      if (!m.entry.is_dir)
        items.push({ label: "Open in default app", run: () => { setMenu(null); void fsOpen(joinPath(cwd(), m.entry!.name)).catch((e) => toast(String(e), "err")); } });
      items.push("sep");
      if (selCount <= 1) items.push({ label: "Rename", key: "F2", run: startRename });
      items.push(
        { label: "Copy", key: mod("C"), run: copySel },
        { label: "Cut", key: mod("X"), run: cutSel },
      );
      if (hasClip) items.push({ label: "Paste", key: mod("V"), run: () => void paste() });
      items.push(
        "sep",
        { label: "Move to Trash", key: "⌫", run: () => askDelete(false) },
        { label: "Delete permanently", danger: true, run: () => askDelete(true) },
      );
      return items;
    }
    // Empty-area menu.
    const items: (MenuItem | "sep")[] = [
      { label: "New Folder", run: () => startCreate("dir") },
      { label: "New File", run: () => startCreate("file") },
    ];
    if (hasClip) items.push({ label: "Paste", key: mod("V"), run: () => void paste() });
    items.push(
      "sep",
      { label: "Undo", key: mod("Z"), run: () => { setMenu(null); void undo(); } },
      { label: "Select All", key: mod("A"), run: () => { setMenu(null); selectAll(); } },
      { label: "Refresh", run: () => { setMenu(null); void refresh(); } },
    );
    return items;
  };

  const isCut = (name: string) =>
    clipboard()?.mode === "cut" && clipboard()!.paths.includes(joinPath(cwd(), name));

  return (
    <div class="files" tabindex={0} ref={filesRoot} onKeyDown={onKey}>
      {/* Toolbar: nav + breadcrumb + actions + search */}
      <div class="files-toolbar">
        <button class="files-nav" disabled={!canBack()} title="Back" onClick={goBack}>‹</button>
        <button class="files-nav" disabled={!canFwd()} title="Forward" onClick={goFwd}>›</button>
        <button class="files-nav" disabled={!listing()?.parent} title="Up" onClick={goUp}>↑</button>
        <div class="files-crumbs">
          <For each={crumbs(cwd())}>
            {(c, i) => (
              <>
                <Show when={i() > 0}><span class="files-crumb-sep">›</span></Show>
                <button
                  classList={{ "files-crumb": true, drop: dropTarget() === c.path }}
                  onClick={() => navigate(c.path)}
                  onDragOver={(e) => { if (dragPaths.length) { e.preventDefault(); setDropTarget(c.path); } }}
                  onDragLeave={() => setDropTarget((d) => (d === c.path ? null : d))}
                  onDrop={(e) => { e.preventDefault(); setDropTarget(null); void doMove(dragPaths, c.path); }}
                >{c.name}</button>
              </>
            )}
          </For>
        </div>
        <button class="files-act" title="New folder" onClick={() => startCreate("dir")}><NewFolderIcon /></button>
        <button class="files-act" title="Refresh" onClick={() => void refresh()}><RefreshIcon /></button>
        <input
          class="files-search"
          value={filter()}
          onInput={(e) => setFilter(e.currentTarget.value)}
          placeholder="Filter"
          spellcheck={false}
        />
      </div>

      <div class="files-body">
        {/* Quick-access rail (also drop targets for move) */}
        <nav class="files-rail">
          <div class="files-rail-section">Quick access</div>
          <For each={places().filter((p) => p.kind === "home" || p.kind === "folder")}>
            {(p) => <RailItem p={p} cwd={cwd()} dropTarget={dropTarget()} dragging={() => dragPaths.length > 0}
              onNav={navigate} onOver={setDropTarget} onDrop={(dest) => void doMove(dragPaths, dest)} />}
          </For>
          <Show when={places().some((p) => p.kind === "linux")}>
            <div class="files-rail-section">Linux</div>
            <For each={places().filter((p) => p.kind === "linux")}>
              {(p) => <RailItem p={p} cwd={cwd()} dropTarget={dropTarget()} dragging={() => dragPaths.length > 0}
                onNav={navigate} onOver={setDropTarget} onDrop={(dest) => void doMove(dragPaths, dest)} />}
            </For>
          </Show>
          <Show when={places().some((p) => p.kind === "drive")}>
            <div class="files-rail-section">Drives</div>
            <For each={places().filter((p) => p.kind === "drive")}>
              {(p) => <RailItem p={p} cwd={cwd()} dropTarget={dropTarget()} dragging={() => dragPaths.length > 0}
                onNav={navigate} onOver={setDropTarget} onDrop={(dest) => void doMove(dragPaths, dest)} />}
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

          {/* Inline create row */}
          <Show when={creating()}>
            {(c) => (
              <div class="files-create">
                <span class="file-icon" style={{ color: c().kind === "dir" ? "var(--flux-violet)" : "var(--flux-teal)" }}>
                  {c().kind === "dir" ? <FolderIcon /> : <FileIcon />}
                </span>
                <input
                  class="files-rename-input"
                  autofocus
                  placeholder={c().kind === "dir" ? "New folder name" : "New file name"}
                  value={c().value}
                  onInput={(e) => setCreating({ kind: c().kind, value: e.currentTarget.value })}
                  onBlur={() => void commitCreate()}
                  onKeyDown={(e) => {
                    e.stopPropagation();
                    if (e.key === "Enter") void commitCreate();
                    else if (e.key === "Escape") setCreating(null);
                  }}
                />
              </div>
            )}
          </Show>

          <div
            class="files-list"
            ref={scroller}
            onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
            onMouseDown={onListMouseDown}
            onClick={(e) => { if (e.target === e.currentTarget || (e.target as HTMLElement).classList.contains("files-spacer")) clearSel(); }}
            onContextMenu={(e) => { if (e.target === scroller || (e.target as HTMLElement).classList.contains("files-spacer")) openMenu(e, null); }}
            onDragOver={(e) => { if (dragPaths.length) { e.preventDefault(); setDropTarget(cwd()); } }}
            onDrop={(e) => { if (dragPaths.length) { e.preventDefault(); setDropTarget(null); void doMove(dragPaths, cwd()); } }}
          >
            <Show when={!loading()} fallback={<div class="files-empty">Loading…</div>}>
              <Show when={!error()} fallback={<div class="files-empty files-err">{error()}</div>}>
                <Show when={view().length > 0} fallback={<div class="files-empty">This folder is empty.</div>}>
                  <div class="files-spacer" style={{ height: `${view().length * ROW_H}px` }}>
                    <For each={slice()}>
                      {(entry, i) => {
                        const idx = () => start() + i();
                        return (
                          <div
                            classList={{
                              "files-row": true,
                              selected: selected().has(entry.name),
                              cut: isCut(entry.name),
                              drop: entry.is_dir && dropTarget() === joinPath(cwd(), entry.name),
                            }}
                            style={{ top: `${idx() * ROW_H}px` }}
                            draggable={!renaming()}
                            onClick={(e) => onRowClick(idx(), e)}
                            onDblClick={() => openEntry(entry)}
                            onContextMenu={(e) => {
                              if (!selected().has(entry.name)) selectOnly(idx());
                              openMenu(e, entry);
                            }}
                            onDragStart={(e) => {
                              if (!selected().has(entry.name)) selectOnly(idx());
                              dragPaths = selectedPaths();
                              if (e.dataTransfer) {
                                e.dataTransfer.effectAllowed = "move";
                                e.dataTransfer.setData("text/plain", dragPaths.join("\n"));
                              }
                            }}
                            onDragEnd={() => { dragPaths = []; setDropTarget(null); }}
                            onDragOver={(e) => {
                              if (entry.is_dir && dragPaths.length) {
                                e.preventDefault();
                                e.stopPropagation();
                                setDropTarget(joinPath(cwd(), entry.name));
                              }
                            }}
                            onDrop={(e) => {
                              if (entry.is_dir && dragPaths.length) {
                                e.preventDefault();
                                e.stopPropagation();
                                const dest = joinPath(cwd(), entry.name);
                                setDropTarget(null);
                                void doMove(dragPaths, dest);
                              }
                            }}
                            title={entry.name}
                          >
                            <span class="files-cell name">
                              <span class="file-icon" style={{ color: entry.is_dir ? "var(--flux-violet)" : iconColor(entry.name) }}>
                                {entry.is_dir ? <FolderIcon /> : <FileIcon />}
                              </span>
                              <Show
                                when={renaming() === entry.name}
                                fallback={<span class="files-name">{entry.name}</span>}
                              >
                                <input
                                  class="files-rename-input"
                                  autofocus
                                  value={entry.name}
                                  ref={(el) => queueMicrotask(() => { el.focus(); el.select(); })}
                                  onClick={(e) => e.stopPropagation()}
                                  onBlur={(e) => void commitRename(entry.name, e.currentTarget.value)}
                                  onKeyDown={(e) => {
                                    e.stopPropagation();
                                    if (e.key === "Enter") void commitRename(entry.name, e.currentTarget.value);
                                    else if (e.key === "Escape") setRenaming(null);
                                  }}
                                />
                              </Show>
                              <Show when={entry.symlink}><span class="files-link">↗</span></Show>
                            </span>
                            <span class="files-cell size">{fmtSize(entry.size, entry.is_dir)}</span>
                            <span class="files-cell modified">{fmtDate(entry.modified)}</span>
                          </div>
                        );
                      }}
                    </For>
                    <Show when={marquee()}>
                      {(m) => (
                        <div
                          class="files-marquee"
                          style={{
                            left: `${Math.min(m().x1, m().x2)}px`,
                            top: `${Math.min(m().y1, m().y2)}px`,
                            width: `${Math.abs(m().x2 - m().x1)}px`,
                            height: `${Math.abs(m().y2 - m().y1)}px`,
                          }}
                        />
                      )}
                    </Show>
                  </div>
                </Show>
              </Show>
            </Show>
          </div>
        </main>
      </div>

      {/* Status bar */}
      <div class="files-statusbar">
        <Show when={selected().size > 0} fallback={
          <span>{counts().total} items · {counts().dirs} folders · {counts().files} files</span>
        }>
          <span>{selected().size} selected</span>
        </Show>
        <span style={{ flex: 1 }} />
        <Show when={clipboard()}>
          {(cb) => <span class="files-clip">{cb().mode === "cut" ? "Cut" : "Copied"} {cb().paths.length}</span>}
        </Show>
        <label class="files-toggle">
          <input type="checkbox" checked={showHidden()} onChange={(e) => setShowHidden(e.currentTarget.checked)} />
          Hidden
        </label>
      </div>

      {/* Context menu */}
      <Show when={menu()}>
        {(m) => (
          <>
            <div class="files-menu-backdrop" onClick={() => setMenu(null)} onContextMenu={(e) => { e.preventDefault(); setMenu(null); }} />
            <div class="files-menu" style={menuStyle(m())}>
              <For each={menuItems()}>
                {(it) =>
                  it === "sep" ? (
                    <div class="files-menu-sep" />
                  ) : (
                    <button classList={{ "files-menu-item": true, danger: !!it.danger }} onClick={it.run}>
                      <span>{it.label}</span>
                      <Show when={it.key}><span class="files-menu-key">{it.key}</span></Show>
                    </button>
                  )
                }
              </For>
            </div>
          </>
        )}
      </Show>

      {/* Confirm dialog (destructive ops) */}
      <Show when={confirm()}>
        {(c) => (
          <div class="files-confirm-backdrop" onClick={() => setConfirm(null)}>
            <div class="files-confirm" onClick={(e) => e.stopPropagation()}>
              <div class="files-confirm-title">{c().title}</div>
              <div class="files-confirm-body">{c().body}</div>
              <div class="files-confirm-actions">
                <button class="files-btn" onClick={() => setConfirm(null)}>Cancel</button>
                <button classList={{ "files-btn": true, primary: !c().danger, danger: c().danger }} onClick={c().onYes}>
                  {c().danger ? "Delete" : "Move to Trash"}
                </button>
              </div>
            </div>
          </div>
        )}
      </Show>

      {/* Transient toast */}
      <Show when={notice()}>
        {(n) => <div classList={{ "files-toast": true, err: n().kind === "err" }}>{n().text}</div>}
      </Show>
    </div>
  );
};

// ─── subcomponents ────────────────────────────────────────────────────────────

type MenuItem = { label: string; key?: string; danger?: boolean; run: (e: MouseEvent) => void };

const RailItem: Component<{
  p: QuickLocation;
  cwd: string;
  dropTarget: string | null;
  dragging: () => boolean;
  onNav: (p: string) => void;
  onOver: (p: string | null) => void;
  onDrop: (p: string) => void;
}> = (props) => (
  <button
    classList={{ "files-loc": true, active: props.cwd === props.p.path, drop: props.dropTarget === props.p.path }}
    onClick={() => props.onNav(props.p.path)}
    onDragOver={(e) => { if (props.dragging()) { e.preventDefault(); props.onOver(props.p.path); } }}
    onDragLeave={() => props.onOver(null)}
    onDrop={(e) => { e.preventDefault(); props.onOver(null); props.onDrop(props.p.path); }}
  >
    <span class="files-loc-icon">
      {props.p.kind === "home" ? <HomeIcon />
        : props.p.kind === "drive" ? <DriveIcon />
        : props.p.kind === "linux" ? <LinuxIcon />
        : <FolderIcon />}
    </span>
    {props.p.name}
  </button>
);

// ─── helpers ────────────────────────────────────────────────────────────────

const mod = (k: string): string => (navigator.platform.startsWith("Mac") ? "⌘" : "Ctrl+") + k;

function plural(n: number): string { return n === 1 ? "" : "s"; }

function sepOf(p: string): string { return p.includes("\\") ? "\\" : "/"; }

function joinPath(dir: string, name: string): string {
  const sep = sepOf(dir);
  return dir.endsWith(sep) ? dir + name : dir + sep + name;
}

function baseName(p: string): string {
  const parts = p.split(/[\\/]/);
  return parts[parts.length - 1] || p;
}

function parentOf(p: string): string {
  const sep = sepOf(p);
  const i = p.replace(/[\\/]+$/, "").lastIndexOf(sep);
  return i <= 0 ? p.slice(0, i + 1) || sep : p.slice(0, i);
}

/** Reject names that would escape the current directory or are degenerate. */
function invalidName(n: string): boolean {
  return !n.trim() || /[\\/]/.test(n) || n === "." || n === "..";
}

function menuStyle(m: { x: number; y: number }): JSX.CSSProperties {
  const W = 210, H = 320;
  const x = typeof window !== "undefined" ? Math.min(m.x, window.innerWidth - W - 8) : m.x;
  const y = typeof window !== "undefined" ? Math.min(m.y, window.innerHeight - H - 8) : m.y;
  return { left: `${Math.max(8, x)}px`, top: `${Math.max(8, y)}px` };
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
// WSL distro — a terminal-in-a-box mark (>_), signalling a Linux shell/distro.
const LinuxIcon = () => (
  <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <rect x="3" y="4" width="18" height="16" rx="2" /><path d="M7 9l3 3-3 3M13 15h4" />
  </svg>
);
const NewFolderIcon = () => (
  <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M10 4H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-7" />
    <path d="M18 3v6M15 6h6" />
  </svg>
);
const RefreshIcon = () => (
  <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M21 12a9 9 0 1 1-2.64-6.36M21 4v5h-5" />
  </svg>
);

export default FilesView;
