/**
 * The launcher (Flux Next): one place for what the ⌘K palette, the search
 * spotlight and the old pages-and-apps launcher each did. Search the web or go
 * to an address, switch to a tab, reopen something from history, open a note,
 * or run any command, from one field. The rules (section order, caps, scopes,
 * the calculator) live in launcherModel.ts.
 *
 * ↵ opens, ⌘↵ opens in a background tab, ⇧↵ beside the current page, ⌘K
 * shows the selected row's actions, ⌥↵ files what you typed as a task. With
 * nothing typed it lists your recent tabs on ⌘1–⌘4.
 *
 * App paints a still of the page behind it (tabsleep.rs), so the page stays
 * in view while the launcher is up.
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

import Icon, { IconOrGlyph, type IconName } from "./Icon";
import {
  fsOpen,
  historyRecent,
  historySearch,
  kbQuery,
  omniSearch,
  searchResolve,
  searchSuggest,
  START_URL,
  type HistoryEntry,
  type KbHit,
  type OmniHit,
} from "./ipc";
import {
  ago,
  calculate,
  formatNumber,
  highlight,
  keepSelection,
  layout,
  looksLikeAddress,
  matchScore,
  parseQuery,
  type SectionKind,
} from "./launcherModel";
import { PAGES } from "./launcherCatalog";
import { favorites, loadTerminalApps, setTerminalApps, terminalApps, toggleFavorite } from "./launcherData";
import { latestQuery } from "./latestQuery";
import Modal from "./Modal";
import { paletteActions, type PaletteContext } from "./paletteActions";
import { isMobile } from "./platform";
import {
  activeId,
  closeTab,
  focusTab,
  isHibernated,
  lastAccessForUrl,
  openTab,
  openTerminalApp,
  openTuiPane,
  searchSuggestOn,
  setTile,
  tabs,
} from "./store";
import TerminalAppsEditor from "./TerminalAppsEditor";
import { MAX_PANES, layoutsFor } from "./tiles";
import "./Launcher.css";

/** How a row is opened: here, in a background tab, or beside this page. */
type How = "open" | "background" | "split";

interface Action {
  label: string;
  icon: IconName;
  keys?: string;
  run: () => void | Promise<void>;
}

interface Row {
  key: string;
  icon: IconName | string;
  label: string;
  meta?: string;
  /** Highlight the query in the label. */
  marks?: boolean;
  url?: string;
  run: (how: How) => void | Promise<void>;
  /** Shown by ⌘K, besides the opening ones every link row gets. */
  more?: Action[];
}

const SECTION_TITLE: Record<SectionKind, string> = {
  search: "Search",
  tabs: "Tabs",
  history: "History",
  notes: "Notes",
  commands: "Commands",
};

const hostOf = (url: string): string => {
  try {
    const u = new URL(url);
    return u.host.replace(/^www\./, "") || url;
  } catch {
    return url;
  }
};

/** "Onyx · ML": the note's source, then the folder it's in. */
const noteWhere = (h: KbHit): string => {
  const source = h.source ? h.source[0]!.toUpperCase() + h.source.slice(1) : "";
  const folder = h.path.split(/[\\/]/).slice(-2, -1)[0] ?? "";
  return [source, folder].filter(Boolean).join(" · ");
};

const Launcher: Component<{
  ctx: PaletteContext;
  /** What the field starts with (">" lists the commands). */
  initial?: string;
  onClose: () => void;
  onNavigate: (url: string) => void;
  onAiSearch: (q: string) => void;
  onOpenFiles: () => void;
}> = (props) => {
  const [text, setText] = createSignal(props.initial ?? "");
  const parsed = createMemo(() => parseQuery(text()));
  const q = () => parsed().q;
  const scope = () => parsed().scope;
  const [editing, setEditing] = createSignal(false);
  const [status, setStatus] = createSignal("");
  const [actionsOpen, setActionsOpen] = createSignal(false);
  const [actionSel, setActionSel] = createSignal(0);
  const [cmdHeld, setCmdHeld] = createSignal(false);
  let input!: HTMLInputElement;

  onMount(() => {
    if (!isMobile) void loadTerminalApps();
    const down = (e: KeyboardEvent) => setCmdHeld(e.metaKey || e.key === "Meta");
    const up = (e: KeyboardEvent) => setCmdHeld(e.metaKey && e.key !== "Meta");
    const blur = () => setCmdHeld(false);
    window.addEventListener("keydown", down, true);
    window.addEventListener("keyup", up, true);
    window.addEventListener("blur", blur);
    onCleanup(() => {
      window.removeEventListener("keydown", down, true);
      window.removeEventListener("keyup", up, true);
      window.removeEventListener("blur", blur);
    });
  });

  // ─── Sources that answer later ─────────────────────────────────────────────
  const [history, setHistory] = createSignal<HistoryEntry[]>([]);
  const [omni, setOmni] = createSignal<OmniHit[]>([]);
  const [notes, setNotes] = createSignal<KbHit[]>([]);
  const [related, setRelated] = createSignal<string[]>([]);
  const [recent, setRecent] = createSignal<HistoryEntry[]>([]);
  // Lists only: a source that answers with anything else (an older backend,
  // the preview's mock) counts as having found nothing, rather than throwing
  // inside the update and leaving the list stuck.
  const list = <T,>(r: T[] | null | undefined): T[] => (Array.isArray(r) ? r : []);
  const historyQ = latestQuery(
    (s) => historySearch(s, 25),
    (r) => setHistory(list(r)),
    () => setHistory([]),
    60,
  );
  const omniQ = latestQuery(
    (s) => omniSearch(s, 12),
    (r) => setOmni(list(r)),
    () => setOmni([]),
    180,
  );
  const notesQ = latestQuery(
    (s) => kbQuery(s, 6),
    (r) => setNotes(list(r)),
    () => setNotes([]),
    200,
  );
  const suggestQ = latestQuery(
    (s) => searchSuggest(s, { enabled: searchSuggestOn(), tabId: activeId() }),
    (r) => setRelated(list(r).slice(0, 2)),
    () => setRelated([]),
    140,
  );
  onCleanup(() => [historyQ, omniQ, notesQ, suggestQ].forEach((x) => x.cancel()));
  void historyRecent(8)
    .then((r) => setRecent(list(r)))
    .catch(() => {});

  createEffect(() => {
    const s = q();
    const sc = scope();
    setHistory([]);
    setOmni([]);
    setNotes([]);
    setRelated([]);
    const wants = (k: SectionKind) => sc === "all" || sc === k;
    if (s && (wants("history") || wants("tabs"))) {
      if (wants("history")) historyQ.search(s);
      if (s.length > 1) omniQ.search(s);
    } else {
      historyQ.cancel();
      omniQ.cancel();
    }
    if (s.length > 1 && wants("notes")) notesQ.search(s);
    else notesQ.cancel();
    if (s && sc === "all" && searchSuggestOn() && !looksLikeAddress(s)) suggestQ.search(s);
    else suggestQ.cancel();
  });

  // ─── Opening things ────────────────────────────────────────────────────────
  const done = () => props.onClose();
  const openUrl = async (url: string, how: How) => {
    if (how === "open") {
      done();
      props.onNavigate(url);
    } else if (how === "background") {
      await openTab("browser", url, false, true);
      setStatus("Opened in a background tab");
    } else {
      const cur = activeId();
      const tab = await openTab("browser", url, false, true);
      done();
      if (cur == null) return;
      const panes = [cur, tab.id].slice(0, MAX_PANES);
      setTile(panes, layoutsFor(panes.length)[0]!);
    }
  };
  /** Through the search backend (#68), so !bangs, keywords and address-vs-search
   *  go exactly as they do in the address field. */
  const searchFor = async (s: string, how: How) => {
    const r = await searchResolve(s).catch(() => null);
    if (!r) {
      setStatus("Couldn't open that search. Try again.");
      return;
    }
    await openUrl(r.url, how);
    if (how === "open" && r.kind === "search") props.onAiSearch(s);
  };
  const copy = (s: string, what = "Link") =>
    void navigator.clipboard
      .writeText(s)
      .then(() => setStatus(`${what} copied`))
      .catch(() => setStatus("Couldn't copy"));
  const addTask = (title: string) => {
    const t = title.trim();
    if (!t) return;
    void import("./taskAdd")
      .then((m) => m.addTaskLine(t))
      .then(() => {
        props.ctx.toast(`Added to Tasks: ${t}`, "ok");
        done();
      })
      .catch(() => setStatus("Couldn't add the task"));
  };
  const openNote = (h: KbHit) => {
    done();
    if (/^https?:\/\//i.test(h.path)) void openTab("browser", h.path);
    else if (h.path) void fsOpen(h.path).catch(() => {});
  };

  // ─── Rows ──────────────────────────────────────────────────────────────────
  const searchRows = createMemo<Row[]>(() => {
    const s = q();
    if (!s || scope() !== "all") return [];
    const out: Row[] = [];
    const sum = calculate(s);
    if (sum != null) {
      const shown = formatNumber(sum);
      out.push({
        key: "calc",
        icon: "find",
        label: `= ${shown}`,
        meta: "↵ copies",
        run: () => copy(String(sum), "Answer"),
      });
    }
    if (looksLikeAddress(s)) {
      out.push({
        key: "go",
        icon: "find",
        label: `Go to ${s}`,
        meta: "address",
        run: (how) => searchFor(s, how),
      });
    }
    out.push({
      key: "web",
      icon: "find",
      label: `Search the web for ${s}`,
      meta: "default engine",
      marks: true,
      run: (how) => searchFor(s, how),
    });
    for (const r of related()) {
      if (r.toLocaleLowerCase() === s.toLocaleLowerCase()) continue;
      out.push({
        key: `sugg:${r}`,
        icon: "find",
        label: r,
        meta: "search",
        marks: true,
        run: (how) => searchFor(r, how),
      });
    }
    return out;
  });

  const tabRows = createMemo<Row[]>(() => {
    const s = q();
    if (!s && scope() !== "tabs") return [];
    const act = activeId();
    const scored = tabs()
      .map((t) => ({ t, score: matchScore(s, t.title || t.url, t.url) }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score || lastAccessForUrl(b.t.url) - lastAccessForUrl(a.t.url));
    const seen = new Set(scored.map((x) => x.t.id));
    // Matches in a page's text (#66), after the title matches, in their order.
    for (const h of omni()) {
      if (h.kind !== "tab" || h.tab_id == null || seen.has(h.tab_id)) continue;
      const t = tabs().find((x) => x.id === h.tab_id);
      if (t) {
        seen.add(t.id);
        scored.push({ t, score: 0 });
      }
    }
    return scored.map(({ t }): Row => {
      const host = t.kind === "terminal" ? "Terminal" : t.kind === "files" ? "Files" : hostOf(t.url);
      return {
        key: `tab:${t.id}`,
        icon: "tabs",
        label: t.title || t.url,
        meta: t.id === act ? `${host} · this tab` : isHibernated(t.id) ? `asleep · ${host}` : host,
        marks: true,
        url: t.kind === "browser" ? t.url : undefined,
        run: (how) => {
          if (how === "split" && act != null && act !== t.id) {
            done();
            const panes = [act, t.id].slice(0, MAX_PANES);
            setTile(panes, layoutsFor(panes.length)[0]!);
            return;
          }
          done();
          void focusTab(t.id);
        },
        more: [{ label: "Close tab", icon: "trash", run: () => void closeTab(t.id) }],
      };
    });
  });

  const historyRows = createMemo<Row[]>(() => {
    const open = new Set(tabs().map((t) => t.url));
    const rows: Row[] = history()
      .filter((h) => !open.has(h.url))
      .map((h) => ({
        key: `hist:${h.url}`,
        icon: "history",
        label: h.title || h.url,
        meta: `${hostOf(h.url)} · ${ago(h.last_visit_ms)}`,
        marks: true,
        url: h.url,
        run: (how) => openUrl(h.url, how),
      }));
    const seen = new Set(rows.map((r) => r.url));
    // Bookmarks, and pages that match by meaning (#66), after the word matches.
    for (const b of omni()) {
      if (b.kind === "tab" || seen.has(b.url) || open.has(b.url)) continue;
      seen.add(b.url);
      const mark = b.kind === "bookmark";
      rows.push({
        key: `${mark ? "bm" : "hist"}:${b.url}`,
        icon: mark ? "bookmarks" : "history",
        label: b.title || b.url,
        meta: mark ? `bookmark · ${hostOf(b.url)}` : hostOf(b.url),
        marks: true,
        url: b.url,
        run: (how) => openUrl(b.url, how),
      });
    }
    return rows;
  });

  const noteRows = createMemo<Row[]>(() =>
    notes().map((h) => ({
      key: `note:${h.source}:${h.doc_id}`,
      icon: "note",
      label: h.title || h.path,
      meta: noteWhere(h),
      marks: true,
      run: () => openNote(h),
      more: [{ label: "Copy path", icon: "files", run: () => copy(h.path, "Path") }],
    })),
  );

  /** Pages and terminal apps can sit in the pages bar (PagesBar.tsx). */
  const pin = (id: string): Action => ({
    label: favorites().includes(id) ? "Unpin from the pages bar" : "Pin to the pages bar",
    icon: "panels",
    run: () => {
      try {
        toggleFavorite(id);
        setStatus(favorites().includes(id) ? "Pinned to the pages bar" : "Unpinned");
      } catch {
        setStatus("Couldn't save that. Try again.");
      }
    },
  });

  const commandRows = createMemo<Row[]>(() => {
    const s = q();
    if (!s && scope() !== "commands") return [];
    const all: Row[] = [];
    const actions = paletteActions(props.ctx);
    for (const a of actions) {
      all.push({
        key: `cmd:${a.id}`,
        icon: a.icon,
        label: a.label,
        marks: true,
        run: () => (done(), a.run()),
      });
    }
    all.push({
      key: "cmd:home",
      icon: "⌂",
      label: "Go to the start page",
      marks: true,
      run: () => (done(), props.onNavigate(START_URL)),
    });
    all.push({
      key: "cmd:files-panel",
      icon: "files",
      label: "Open the file explorer",
      marks: true,
      run: () => (done(), props.onOpenFiles()),
    });
    // Flux's own pages, unless a command already opens them.
    const labels = actions.map((a) => a.label.toLocaleLowerCase());
    for (const p of PAGES) {
      if (labels.some((l) => l.includes(p.label.toLocaleLowerCase()))) continue;
      all.push({
        key: `page:${p.url}`,
        icon: p.icon,
        label: p.label,
        meta: "Flux page",
        marks: true,
        url: p.url,
        run: (how) => (how === "open" ? (done(), void openTab("browser", p.url)) : openUrl(p.url, how)),
        more: [pin(`page:${p.url}`)],
      });
    }
    if (!isMobile) {
      for (const app of terminalApps()) {
        all.push({
          key: `app:${app.id}`,
          icon: app.icon,
          label: app.name,
          meta: `terminal app · ${app.cmd}`,
          marks: true,
          // ⌘↵ gives it a whole tab rather than a pane.
          run: (how) => {
            done();
            if (how === "background") void openTerminalApp(app.cmd, app.cwd ?? "");
            else openTuiPane({ name: app.name, icon: app.icon, cmd: app.cmd, cwd: app.cwd ?? "" });
          },
          more: [pin(`terminal:${app.id}`)],
        });
      }
      all.push({
        key: "cmd:edit-apps",
        icon: "terminal",
        label: "Edit terminal apps…",
        marks: true,
        run: () => void setEditing(true),
      });
    }
    if (!s) return all;
    return all
      .map((r, i) => ({ r, i, score: matchScore(s, r.label, r.meta ?? "") }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score || a.i - b.i)
      .map((x) => x.r);
  });

  const sections = createMemo(() =>
    layout(
      {
        search: searchRows(),
        tabs: tabRows(),
        history: historyRows(),
        notes: noteRows(),
        commands: commandRows(),
      },
      scope(),
    ),
  );

  // The empty launcher: your recent tabs, then recent pages, on ⌘1–⌘4.
  const recents = createMemo<Row[]>(() => {
    const act = activeId();
    const rows: Row[] = tabs()
      .filter((t) => t.id !== act && lastAccessForUrl(t.url) > 0)
      .sort((a, b) => lastAccessForUrl(b.url) - lastAccessForUrl(a.url))
      .slice(0, 4)
      .map((t) => ({
        key: `tab:${t.id}`,
        icon: "tabs",
        label: t.title || t.url,
        meta: t.kind === "browser" ? hostOf(t.url) : t.kind,
        url: t.kind === "browser" ? t.url : undefined,
        run: (how: How) => (how === "open" ? (done(), void focusTab(t.id)) : openUrl(t.url, how)),
      }));
    const open = new Set(tabs().map((t) => t.url));
    for (const h of recent()) {
      if (rows.length >= 4) break;
      if (open.has(h.url)) continue;
      rows.push({
        key: `hist:${h.url}`,
        icon: "history",
        label: h.title || h.url,
        meta: `${hostOf(h.url)} · ${ago(h.last_visit_ms)}`,
        url: h.url,
        run: (how) => openUrl(h.url, how),
      });
    }
    return rows;
  });
  const empty = () => !text().trim();

  const flat = createMemo(() => (empty() ? recents() : sections().flatMap((s) => s.rows)));
  const [sel, setSel] = createSignal(0);
  let selKey: string | null = null;
  createEffect(() => {
    const rows = flat();
    const at = keepSelection(
      selKey,
      rows.map((r) => r.key),
      sel(),
    );
    setSel(at);
    selKey = rows[at]?.key ?? null;
  });
  const select = (i: number) => {
    setSel(i);
    selKey = flat()[i]?.key ?? null;
    setActionsOpen(false);
  };
  const current = () => flat()[sel()];
  createEffect(() => {
    document.getElementById(`lx-row-${sel()}`)?.scrollIntoView({ block: "nearest" });
  });

  const actionsFor = (r: Row): Action[] => {
    const list: Action[] = [];
    if (r.url || r.key === "web" || r.key === "go" || r.key.startsWith("sugg:")) {
      list.push({ label: "Open in background", icon: "tabs", keys: "⌘↵", run: () => r.run("background") });
      if (r.url) list.push({ label: "Copy link", icon: "files", keys: "⌘C", run: () => copy(r.url!) });
      list.push({ label: "Split with current", icon: "split", keys: "⇧↵", run: () => r.run("split") });
    } else if (r.key.startsWith("tab:")) {
      list.push({ label: "Split with current", icon: "split", keys: "⇧↵", run: () => r.run("split") });
    }
    list.push(...(r.more ?? []));
    list.push({
      label: "Add to Tasks",
      icon: "tasks",
      keys: "⌥↵",
      run: () => addTask(empty() ? r.label : text()),
    });
    return list;
  };

  const run = (how: How) => {
    const r = current();
    if (!r) return;
    setStatus("");
    void Promise.resolve(r.run(how)).catch(() => setStatus("That didn't work. Try again."));
  };

  const onKey = (e: KeyboardEvent) => {
    const rows = flat();
    if (actionsOpen()) {
      const acts = current() ? actionsFor(current()!) : [];
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const n = acts.length || 1;
        setActionSel((i) => (i + (e.key === "ArrowDown" ? 1 : n - 1)) % n);
        return;
      }
      if (e.key === "Enter") {
        e.preventDefault();
        const a = acts[actionSel()];
        setActionsOpen(false);
        if (a) void Promise.resolve(a.run()).catch(() => setStatus("That didn't work. Try again."));
        return;
      }
      if (e.key === "Escape" || (e.metaKey && e.key.toLowerCase() === "k")) {
        e.preventDefault();
        e.stopPropagation();
        setActionsOpen(false);
        return;
      }
    }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const n = rows.length;
      if (n) select((sel() + (e.key === "ArrowDown" ? 1 : n - 1)) % n);
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (e.altKey) addTask(text());
      else run(e.metaKey ? "background" : e.shiftKey ? "split" : "open");
    } else if (e.metaKey && e.key.toLowerCase() === "k") {
      e.preventDefault();
      e.stopPropagation();
      if (current()) {
        setActionSel(0);
        setActionsOpen((v) => !v);
      }
    } else if (e.metaKey && e.key.toLowerCase() === "c" && input.selectionStart === input.selectionEnd) {
      const url = current()?.url;
      if (url) {
        e.preventDefault();
        copy(url);
      }
    } else if (e.metaKey && empty() && /^[1-4]$/.test(e.key)) {
      e.preventDefault();
      e.stopPropagation();
      const r = recents()[Number(e.key) - 1];
      if (r) void Promise.resolve(r.run("open"));
    }
  };

  const Label = (p: { row: Row }) => (
    <Show when={p.row.marks && q()} fallback={p.row.label}>
      <For each={highlight(p.row.label, q())}>{(run) => (run.hit ? <mark>{run.text}</mark> : run.text)}</For>
    </Show>
  );

  const RowView = (p: { row: Row; index: number; badge?: string }) => (
    <div
      id={`lx-row-${p.index}`}
      role="option"
      aria-selected={sel() === p.index}
      classList={{ "lx-row": true, sel: sel() === p.index }}
      onMouseMove={() => sel() !== p.index && select(p.index)}
      onMouseDown={(e) => e.preventDefault()}
      onClick={(e) => {
        select(p.index);
        run(e.metaKey ? "background" : e.shiftKey ? "split" : "open");
      }}
    >
      <Show when={p.badge}>
        <kbd classList={{ "lx-num": true, shown: cmdHeld() }}>{p.badge}</kbd>
      </Show>
      <span class="lx-ico">
        <IconOrGlyph icon={p.row.icon} size={16} />
      </span>
      <span class="lx-label">
        <Label row={p.row} />
      </span>
      <Show when={p.row.meta}>
        <span class="lx-meta">{p.row.meta}</span>
      </Show>
      <Show when={sel() === p.index && !empty()}>
        <span class="lx-keys" aria-hidden="true">
          <kbd>↵</kbd> open
          <Show when={p.row.url || p.row.key === "web" || p.row.key === "go"}>
            <kbd>⌘↵</kbd> background tab
          </Show>
          <kbd>⌘K</kbd> actions
        </span>
      </Show>
    </div>
  );

  const offsets = createMemo(() => {
    let n = 0;
    return sections().map((s) => {
      const at = n;
      n += s.rows.length;
      return at;
    });
  });

  return (
    <Modal label="Launcher" backdropClass="lx-backdrop" class="lx" onClose={props.onClose}>
      <Show
        when={!editing()}
        fallback={
          <div class="lx-editor">
            <TerminalAppsEditor
              apps={terminalApps()}
              onBusy={() => {}}
              onCancel={() => setEditing(false)}
              onSaved={(apps) => {
                setTerminalApps(apps);
                setEditing(false);
              }}
            />
          </div>
        }
      >
        <div class="lx-field">
          <Icon name="find" size={18} />
          <input
            ref={input}
            data-autofocus
            class="lx-input"
            value={text()}
            placeholder={empty() ? "Search or type a URL" : ""}
            onInput={(e) => {
              setText(e.currentTarget.value);
              setStatus("");
              setActionsOpen(false);
            }}
            onKeyDown={onKey}
            spellcheck={false}
            autocomplete="off"
            role="combobox"
            aria-label="Search tabs, history, notes and commands"
            aria-expanded="true"
            aria-controls="lx-list"
            aria-autocomplete="list"
            aria-activedescendant={flat().length ? `lx-row-${sel()}` : undefined}
          />
          <kbd class="lx-esc">esc</kbd>
        </div>

        <div class="lx-list" id="lx-list" role="listbox" aria-label="Results">
          <Show
            when={!empty()}
            fallback={
              <>
                <Show when={recents().length}>
                  <div class="lx-hint">
                    <kbd>⌘</kbd>{" "}
                    {cmdHeld() ? "held, so recents show their numbers" : "and a number opens a recent one"}
                  </div>
                </Show>
                <For each={recents()}>{(r, i) => <RowView row={r} index={i()} badge={`⌘${i() + 1}`} />}</For>
              </>
            }
          >
            <For each={sections()}>
              {(section, si) => (
                <section class="lx-section" aria-label={SECTION_TITLE[section.kind]}>
                  <h3 class="lx-head">
                    {SECTION_TITLE[section.kind]}
                    <Show when={section.kind === "tabs"}>
                      <span>{section.total} open</span>
                    </Show>
                    <Show
                      when={
                        (section.kind === "history" || section.kind === "notes") &&
                        section.total > section.rows.length
                      }
                    >
                      <span>
                        {section.rows.length} of {section.total}
                      </span>
                    </Show>
                  </h3>
                  <For each={section.rows}>
                    {(r, i) => <RowView row={r} index={offsets()[si()]! + i()} />}
                  </For>
                </section>
              )}
            </For>
            <Show when={!sections().length}>
              <div class="lx-none" role="status">
                Nothing matches. ↵ searches the web.
              </div>
            </Show>
          </Show>
        </div>

        <Show when={actionsOpen() && current()}>
          <div class="lx-actions" role="menu" aria-label="Actions">
            <div class="lx-actions-head">
              Actions <kbd>⌘K</kbd>
            </div>
            <div class="lx-actions-of">{current()!.label}</div>
            <For each={actionsFor(current()!)}>
              {(a, i) => (
                <button
                  role="menuitem"
                  classList={{ "lx-action": true, sel: actionSel() === i() }}
                  onMouseMove={() => setActionSel(i())}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => {
                    setActionsOpen(false);
                    void Promise.resolve(a.run()).catch(() => setStatus("That didn't work. Try again."));
                  }}
                >
                  <Icon name={a.icon} size={15} />
                  <span>{a.label}</span>
                  <Show when={a.keys}>
                    <kbd>{a.keys}</kbd>
                  </Show>
                </button>
              )}
            </For>
          </div>
        </Show>

        <footer class="lx-foot">
          <Show
            when={status()}
            fallback={
              <span>
                Narrow with <code>@tabs</code> <code>@history</code> <code>@notes</code> · <code>&gt;</code>{" "}
                commands
              </span>
            }
          >
            <span role="status">{status()}</span>
          </Show>
          <span class="lx-move">
            <kbd>↑</kbd>
            <kbd>↓</kbd> move · <kbd>⌥↵</kbd> task
          </span>
        </footer>
      </Show>
    </Modal>
  );
};

export default Launcher;
