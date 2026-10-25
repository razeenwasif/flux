/**
 * flux://bookmarks — full-page bookmark manager (BACKLOG #22). DOM-rendered in
 * the content card (no webview), like flux://history. Search at the top; bookmarks
 * are grouped by folder. Each folder can be **opened as a Flux tab group** — the
 * practical bridge for "import my Chrome tab groups". Import pulls every bookmark
 * from a Zen or Firefox profile (under "Zen" / "Firefox") or a Chrome profile
 * (under "Imported"), via flux-import.
 */
import { For, Show, createMemo, createSignal, onCleanup, onMount, type Component } from "solid-js";
import {
  BOOKMARKS_URL,
  bookmarkRemove,
  bookmarkRename,
  bookmarksClear,
  bookmarksImportChrome,
  bookmarksImportGecko,
  bookmarksList,
  chromeImportPreview,
  geckoImportPreview,
  type Bookmark,
  type ChromeProfilePreview,
  type GeckoProfile,
} from "./ipc";
import { ensureFavicon, faviconFor, openUrlsAsGroup, titleInternalTab } from "./store";
import { askConfirm } from "./ask";
import { openLinkMenu } from "./linkMenu";

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/^www\./, "") || null;
  } catch {
    return null;
  }
}

const RowIcon: Component<{ url: string }> = (props) => {
  const host = () => hostOf(props.url);
  ensureFavicon(host());
  const data = () => faviconFor(host());
  return (
    <Show
      when={typeof data() === "string"}
      fallback={<span class="hist-letter">{(host() ?? "?").charAt(0).toUpperCase()}</span>}
    >
      <img class="fav-img" src={data() as string} alt="" />
    </Show>
  );
};

const BookmarksPage: Component<{ onNavigate: (url: string) => void }> = (props) => {
  const [query, setQuery] = createSignal("");
  const [items, setItems] = createSignal<Bookmark[]>([]);
  const [importing, setImporting] = createSignal(false);
  const [note, setNote] = createSignal("");

  const load = () =>
    void bookmarksList()
      .then(setItems)
      .catch(() => setItems([]));
  onMount(() => {
    titleInternalTab(BOOKMARKS_URL, "Bookmarks");
    load();
  });

  // Chrome profiles for the import menu (lazy — fetched each time the menu opens).
  // A plain signal: the one-argument createResource ran its fetcher once, untracked,
  // at creation (menu closed → []), so chromeImportPreview() never actually ran.
  const [profiles, setProfiles] = createSignal<ChromeProfilePreview[]>([]);
  // Zen and Firefox too, listed first: the one each browser opens is marked.
  const [gecko, setGecko] = createSignal<GeckoProfile[] | null>(null);
  const loadProfiles = () => {
    void chromeImportPreview()
      .then(setProfiles)
      .catch(() => setProfiles([]));
    setGecko(null);
    void geckoImportPreview()
      .then(setGecko)
      .catch(() => setGecko([]));
  };

  // Filter by query (flat), then group the result by folder.
  const groups = createMemo<[string, Bookmark[]][]>(() => {
    const q = query().trim().toLowerCase();
    const list = q
      ? items().filter((b) => b.title.toLowerCase().includes(q) || b.url.toLowerCase().includes(q))
      : items();
    const byFolder = new Map<string, Bookmark[]>();
    for (const b of list) {
      const key = b.folder || "Bookmarks";
      (byFolder.get(key) ?? byFolder.set(key, []).get(key)!).push(b);
    }
    return [...byFolder.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  });

  const open = (b: Bookmark) => props.onNavigate(b.url);
  const remove = (b: Bookmark) => void bookmarkRemove(b.id).then(load);

  // Inline rename (#22): a ✎ per row turns the name into an input.
  const [editId, setEditId] = createSignal<number | null>(null);
  const [draft, setDraft] = createSignal("");
  const startEdit = (b: Bookmark, ev: MouseEvent) => {
    ev.stopPropagation();
    setDraft(b.title || b.url);
    setEditId(b.id);
  };
  const commitEdit = (id: number) => {
    if (editId() !== id) return;
    const title = draft();
    setEditId(null);
    void bookmarkRename(id, title).then(() => {
      load();
      window.dispatchEvent(new Event("flux:bookmarks-changed"));
    });
  };
  const clearAll = async () => {
    if (await askConfirm({ title: "Remove all bookmarks?", confirm: "Remove all" })) {
      void bookmarksClear().then(load);
    }
  };
  const openFolderAsGroup = async (folder: string, rows: Bookmark[]) => {
    const name = folder.split("/").pop() || folder;
    const n = await openUrlsAsGroup(
      name,
      rows.map((r) => r.url),
    );
    setNote(
      `Opened ${n} tab${n === 1 ? "" : "s"} as group “${name}”${rows.length > n ? ` (capped from ${rows.length})` : ""}`,
    );
  };
  const doImport = async (dir: string) => {
    const n = await bookmarksImportChrome(dir).catch(() => 0);
    setImporting(false);
    setNote(`Imported ${n} new bookmark${n === 1 ? "" : "s"} from Chrome.`);
    load();
  };
  const doImportGecko = async (p: GeckoProfile) => {
    setNote(`Importing from ${p.browser}…`);
    try {
      const n = await bookmarksImportGecko(p.dir, p.browser);
      setImporting(false);
      setNote(
        n
          ? `Imported ${n} new bookmark${n === 1 ? "" : "s"} from ${p.browser}, under “${p.browser}”.`
          : `Nothing new: your ${p.browser} bookmarks are already here.`,
      );
      load();
      window.dispatchEvent(new Event("flux:bookmarks-changed"));
    } catch (e) {
      setNote(`Couldn't import from ${p.browser}: ${String(e).replace(/^Error:\s*/, "")}`);
    }
  };

  let noteTimer: number | undefined;
  const flashNote = () => {
    clearTimeout(noteTimer);
    if (note()) noteTimer = window.setTimeout(() => setNote(""), 4000);
  };
  onCleanup(() => clearTimeout(noteTimer));

  return (
    <div class="hist-page">
      <header class="hist-head">
        <div class="hist-title">🔖 Bookmarks</div>
        <input
          class="hist-search"
          placeholder="Search bookmarks…"
          value={query()}
          autofocus
          onInput={(e) => setQuery(e.currentTarget.value)}
        />
        <button
          class="hist-clear"
          onClick={() => {
            const opening = !importing();
            setImporting(opening);
            if (opening) loadProfiles();
          }}
        >
          Import…
        </button>
        <button class="hist-clear" onClick={clearAll}>
          Clear all
        </button>
      </header>

      <Show when={importing()}>
        <div class="bm-import">
          <Show when={gecko()} fallback={<span class="bm-note">Looking for Zen and Firefox…</span>}>
            {(list) => (
              <Show when={list().length > 0}>
                <span class="bm-note">Zen and Firefox: everything, folders kept.</span>
                <For each={list()}>
                  {(p) => (
                    <button class="bm-profile" onClick={() => void doImportGecko(p)}>
                      {p.browser} · {p.name}
                      {p.in_use ? " (in use)" : ""} · {p.bookmark_count} bookmarks
                    </button>
                  )}
                </For>
              </Show>
            )}
          </Show>
          <Show
            when={(profiles() ?? []).length > 0}
            fallback={
              <span class="bm-note">No Chrome profile found (looked in the default user-data dir).</span>
            }
          >
            <span class="bm-note">Chrome (under “Imported”):</span>
            <For each={profiles()}>
              {(p) => (
                <button class="bm-profile" onClick={() => void doImport(p.dir)}>
                  Chrome · {p.name} · {p.bookmark_count} bookmarks
                </button>
              )}
            </For>
          </Show>
        </div>
      </Show>

      <Show when={note()}>
        {(n) => {
          flashNote();
          return <div class="bm-flash">{n()}</div>;
        }}
      </Show>

      <div class="hist-body">
        <Show
          when={groups().length > 0}
          fallback={
            <div class="hist-empty">
              {query()
                ? "No matching bookmarks."
                : "No bookmarks yet — bookmark a page (🔖), or Import… from Zen, Firefox or Chrome."}
            </div>
          }
        >
          <For each={groups()}>
            {([folder, rows]) => (
              <div class="hist-group">
                <div class="bm-folder">
                  <span class="bm-folder-name">📁 {folder}</span>
                  <span class="hist-day" style={{ "margin-left": "auto" }}>
                    {rows.length}
                  </span>
                  <button
                    class="bm-open-group"
                    title="Open this folder's bookmarks as a tab group"
                    onClick={() => void openFolderAsGroup(folder, rows)}
                  >
                    ⊞ Open as group
                  </button>
                </div>
                <For each={rows}>
                  {(b) => (
                    <div
                      class="hist-row"
                      onClick={() => (editId() === b.id ? undefined : open(b))}
                      onContextMenu={(ev) => openLinkMenu(ev, b.url)}
                    >
                      <RowIcon url={b.url} />
                      <span class="hist-text">
                        <Show
                          when={editId() === b.id}
                          fallback={<span class="hist-name">{b.title || b.url}</span>}
                        >
                          <input
                            class="bm-rename"
                            autofocus
                            value={draft()}
                            onClick={(ev) => ev.stopPropagation()}
                            onInput={(ev) => setDraft(ev.currentTarget.value)}
                            onBlur={() => commitEdit(b.id)}
                            onKeyDown={(ev) => {
                              if (ev.key === "Enter") ev.currentTarget.blur();
                              else if (ev.key === "Escape") setEditId(null);
                            }}
                          />
                        </Show>
                        <span class="hist-url">{b.url}</span>
                      </span>
                      <button class="hist-forget" title="Rename" onClick={(ev) => startEdit(b, ev)}>
                        ✎
                      </button>
                      <button
                        class="hist-forget"
                        title="Remove"
                        onClick={(ev) => {
                          ev.stopPropagation();
                          remove(b);
                        }}
                      >
                        ✕
                      </button>
                    </div>
                  )}
                </For>
              </div>
            )}
          </For>
        </Show>
      </div>
    </div>
  );
};

export default BookmarksPage;
