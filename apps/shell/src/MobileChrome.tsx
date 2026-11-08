/**
 * The phone chrome (ADR 0012), built for iOS first: a bottom bar in the
 * thumb's reach, a search view, and a grid of tabs.
 *
 * Every tab's page is a native WebView laid over the shell, so nothing here
 * can float over a page: the bar has its own grid row under the content card,
 * and the status-bar strip has one above it. Whatever has to cover the page
 * (the search view, the tab grid) is an overlay that App hides the page for
 * while it's up (`sheet`).
 *
 * - The bar: back, the address pill (tap to search, swipe sideways to change
 *   tabs), the tab count, and ⋯ for the menu sheet. It shrinks to a slim strip
 *   showing just the site while the page scrolls down, and comes back when it
 *   scrolls up or the strip is tapped.
 * - The search view: the field sits on the keyboard, suggestions stack up
 *   from it, nearest first: open tabs, history, and the search itself.
 * - The tab grid: page covers in two columns; tap to open, × or swipe a card
 *   away to close it.
 */
import { addPluginListener } from "@tauri-apps/api/core";
import {
  For,
  Show,
  createEffect,
  createMemo,
  createSignal,
  on,
  onCleanup,
  onMount,
  type Component,
} from "solid-js";

import {
  historyRecent,
  historySearch,
  isStartUrl,
  searchResolve,
  webviewBack,
  webviewReload,
  webviewStop,
  webviewThumbnail,
  type HistoryEntry,
} from "./ipc";
import { Icon } from "./mobileicons";
import {
  activeId,
  activeTab,
  closeTab,
  ensureFavicon,
  faviconFor,
  focusTab,
  isLoading,
  openTab,
  setTabThumb,
  tabs,
  tabThumb,
} from "./store";
import "./MobileChrome.css";

export type MobileSheet = "search" | "tabs" | null;

const hostOf = (url: string): string => {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
};

/** A page's theme colour is only used if it's dark enough for white status-bar
 *  text, the only kind the shell asks for; a light one falls back to velvet. */
const darkEnough = (hex: string): boolean => {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!m) return false;
  const [r = 0, g = 0, b = 0] = m.slice(1, 4).map((x) => parseInt(x, 16) / 255);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b < 0.45;
};

type Nav = { id: number; theme?: string; progress?: number; loading?: boolean };
type Scroll = { id: number; down: boolean };

const MobileChrome: Component<{
  go: (url: string) => void;
  onMenu: () => void;
  sheet: () => MobileSheet;
  setSheet: (s: MobileSheet) => void;
}> = (props) => {
  const cur = () => activeTab();
  const curUrl = () => {
    const t = cur();
    return t && t.kind === "browser" && !isStartUrl(t.url) ? t.url : "";
  };
  const browserTabs = () => tabs().filter((t) => t.kind === "browser");

  // ── What the native views report: theme colour, progress, scroll direction.
  const [themes, setThemes] = createSignal<Record<number, string>>({});
  const [progress, setProgress] = createSignal<Record<number, number>>({});
  const [compact, setCompact] = createSignal(false);
  onMount(() => {
    const subs: Promise<{ unregister: () => Promise<void> }>[] = [
      addPluginListener<Nav>("flux-webview", "nav", (e) => {
        if (e.theme !== undefined) setThemes((m) => ({ ...m, [e.id]: e.theme! }));
        if (e.progress !== undefined)
          setProgress((m) => ({ ...m, [e.id]: e.loading === false ? 1 : e.progress! }));
      }),
      addPluginListener<Scroll>("flux-webview", "scroll", (e) => {
        if (e.id === activeId()) setCompact(e.down);
      }),
    ];
    onCleanup(() => subs.forEach((p) => void p.then((s) => s.unregister()).catch(() => {})));
  });
  // A different tab, or a sheet, starts from the full bar.
  createEffect(on([activeId, props.sheet], () => setCompact(false), { defer: true }));

  const tint = () => {
    const id = activeId();
    const c = id != null && curUrl() ? themes()[id] : "";
    return c && darkEnough(c) ? c : "";
  };
  const pct = () => {
    const id = activeId();
    return id == null ? 1 : (progress()[id] ?? (isLoading() ? 0.1 : 1));
  };

  const navActive = (fn: (id: number) => Promise<unknown>) => {
    const t = cur();
    if (t?.kind === "browser") void fn(t.id).catch(() => {});
  };

  // ── Swipe the pill sideways to step through tabs, the way Safari does.
  let swipeX = 0;
  let swipeY = 0;
  let swiped = false;
  const [drag, setDrag] = createSignal(0);
  const step = (dir: 1 | -1) => {
    const list = browserTabs();
    const i = list.findIndex((t) => t.id === activeId());
    const next = list[i + dir];
    if (next) void focusTab(next.id);
  };
  const onTouchStart = (e: TouchEvent) => {
    swipeX = e.touches[0]!.clientX;
    swipeY = e.touches[0]!.clientY;
    swiped = false;
  };
  const onTouchMove = (e: TouchEvent) => {
    const dx = e.touches[0]!.clientX - swipeX;
    const dy = e.touches[0]!.clientY - swipeY;
    if (Math.abs(dx) > 12 && Math.abs(dx) > Math.abs(dy) * 1.5) {
      swiped = true;
      setDrag(Math.max(-90, Math.min(90, dx * 0.6)));
    } else if (dy < -40 && Math.abs(dy) > Math.abs(dx) * 1.5 && !swiped) {
      // Swipe up from the bar: the tab grid.
      swiped = true;
      props.setSheet("tabs");
    }
  };
  const onTouchEnd = () => {
    const d = drag();
    setDrag(0);
    if (d > 45) step(-1);
    else if (d < -45) step(1);
  };

  // ── Search ──────────────────────────────────────────────────────────────
  const [draft, setDraft] = createSignal("");
  const [history, setHistory] = createSignal<HistoryEntry[]>([]);
  const [kb, setKb] = createSignal(0);
  let input: HTMLInputElement | undefined;

  /** Opened from the tap itself: iOS only raises the keyboard for a focus()
   *  inside the touch's own handler, and Solid renders the field synchronously
   *  when the signal flips, so it's there to focus. */
  const openSearch = () => {
    if (swiped) return;
    setDraft(curUrl());
    props.setSheet("search");
    input?.focus();
    input?.select();
  };
  const closeSearch = () => {
    input?.blur();
    if (props.sheet() === "search") props.setSheet(null);
  };

  // The field rides on top of the keyboard: the visual viewport shrinks by the
  // keyboard's height while the layout viewport doesn't.
  onMount(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const fit = () => setKb(Math.max(0, window.innerHeight - vv.height - vv.offsetTop));
    vv.addEventListener("resize", fit);
    vv.addEventListener("scroll", fit);
    onCleanup(() => {
      vv.removeEventListener("resize", fit);
      vv.removeEventListener("scroll", fit);
    });
  });

  let seq = 0;
  createEffect(() => {
    if (props.sheet() !== "search") return;
    const q = draft().trim();
    const mine = ++seq;
    const t = setTimeout(
      () => {
        void (q ? historySearch(q, 8) : historyRecent(8))
          .then((h) => {
            if (mine === seq) setHistory(h);
          })
          .catch(() => {});
      },
      q ? 90 : 0,
    );
    onCleanup(() => clearTimeout(t));
  });

  const matchingTabs = createMemo(() => {
    const q = draft().trim().toLowerCase();
    if (!q || q === curUrl().toLowerCase()) return [];
    return browserTabs()
      .filter(
        (t) =>
          t.id !== activeId() &&
          ((t.title || "").toLowerCase().includes(q) || t.url.toLowerCase().includes(q)),
      )
      .slice(0, 3);
  });

  const run = async () => {
    const v = draft().trim();
    closeSearch();
    if (!v) return;
    if (v.startsWith("flux://")) return props.go(v);
    const r = await searchResolve(v);
    props.go(r.url);
  };
  const submit = (e: SubmitEvent) => {
    e.preventDefault();
    void run();
  };
  const openUrl = (url: string) => {
    closeSearch();
    props.go(url);
  };

  // ── Tab grid: covers are cached natively and pulled when the grid opens
  // (the plugin event channel drops payloads this large).
  createEffect(() => {
    if (props.sheet() !== "tabs") return;
    for (const t of browserTabs()) {
      void webviewThumbnail(t.id)
        .then((d) => {
          if (d) setTabThumb(t.id, d);
        })
        .catch(() => {});
    }
  });
  const closeGrid = () => props.setSheet(null);

  const Favicon: Component<{ host: string; size: number }> = (p) => {
    createEffect(() => ensureFavicon(p.host));
    return (
      <Show
        when={faviconFor(p.host)}
        fallback={
          <span class="mc-glyph" style={{ width: `${p.size}px`, height: `${p.size}px` }}>
            {(p.host[0] || "•").toUpperCase()}
          </span>
        }
      >
        <img class="mc-fav" src={faviconFor(p.host)!} alt="" width={p.size} height={p.size} />
      </Show>
    );
  };

  return (
    <>
      <div class="mc-status" style={tint() ? { background: tint() } : undefined} />

      <footer
        class="mc-bar"
        classList={{ compact: compact() }}
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={onTouchEnd}
      >
        <Show when={pct() < 1}>
          <div class="mc-progress" style={{ transform: `scaleX(${Math.max(0.06, pct())})` }} />
        </Show>
        <Show
          when={!compact()}
          fallback={
            <button class="mc-mini" onClick={() => setCompact(false)} aria-label="Show the toolbar">
              <Show when={curUrl().startsWith("https:")}>
                <Icon name="lock" size={11} />
              </Show>
              <span>{hostOf(curUrl()) || "Flux"}</span>
            </button>
          }
        >
          <button
            class="mc-btn"
            disabled={!curUrl()}
            onClick={() => navActive(webviewBack)}
            aria-label="Back"
          >
            <Icon name="back" />
          </button>
          <div
            class="mc-pill"
            classList={{ act: !!curUrl() }}
            style={drag() ? { transform: `translateX(${drag()}px)` } : undefined}
            onClick={openSearch}
            role="button"
            aria-label="Search or enter website"
          >
            <span class="mc-pill-ico">
              <Icon
                name={curUrl() ? (curUrl().startsWith("https:") ? "lock" : "globe") : "search"}
                size={15}
              />
            </span>
            <span class="mc-pill-text" classList={{ hint: !curUrl() }}>
              {curUrl() ? hostOf(curUrl()) || curUrl() : "Search or enter website"}
            </span>
            <Show when={curUrl()}>
              <button
                class="mc-pill-act"
                onClick={(e) => {
                  e.stopPropagation();
                  navActive(isLoading() ? webviewStop : webviewReload);
                }}
                aria-label={isLoading() ? "Stop" : "Reload"}
              >
                <Icon name={isLoading() ? "stop" : "reload"} size={17} />
              </button>
            </Show>
          </div>
          <button class="mc-btn" onClick={() => props.setSheet("tabs")} aria-label="Tabs">
            <span class="mc-count">{browserTabs().length}</span>
          </button>
          <button class="mc-btn" onClick={() => props.onMenu()} aria-label="Menu">
            <Icon name="more" />
          </button>
        </Show>
      </footer>

      <Show when={props.sheet() === "search"}>
        <div class="mc-search">
          <div class="mc-search-list" style={{ "padding-bottom": `${kb() + 84}px` }}>
            <Show when={draft().trim()}>
              <button class="mc-row go" onClick={() => void run()}>
                <span class="mc-row-ico">
                  <Icon name="search" size={18} />
                </span>
                <span class="mc-row-main">
                  <span class="mc-row-title">{draft().trim()}</span>
                  <span class="mc-row-sub">Search or go</span>
                </span>
              </button>
            </Show>
            <For each={matchingTabs()}>
              {(t) => (
                <button
                  class="mc-row"
                  onClick={() => {
                    closeSearch();
                    void focusTab(t.id);
                  }}
                >
                  <span class="mc-row-ico">
                    <Favicon host={hostOf(t.url)} size={20} />
                  </span>
                  <span class="mc-row-main">
                    <span class="mc-row-title">{t.title || hostOf(t.url)}</span>
                    <span class="mc-row-sub">Switch to tab</span>
                  </span>
                </button>
              )}
            </For>
            <For each={history().filter((h) => h.url !== curUrl())}>
              {(h) => (
                <button class="mc-row" onClick={() => openUrl(h.url)}>
                  <span class="mc-row-ico">
                    <Favicon host={hostOf(h.url)} size={20} />
                  </span>
                  <span class="mc-row-main">
                    <span class="mc-row-title">{h.title || hostOf(h.url)}</span>
                    <span class="mc-row-sub">{hostOf(h.url)}</span>
                  </span>
                </button>
              )}
            </For>
            <Show when={!draft().trim()}>
              <div class="mc-search-head">Recently visited</div>
            </Show>
          </div>
          <form
            class="mc-field"
            classList={{ kb: kb() > 0 }}
            style={{ bottom: `${kb()}px` }}
            onSubmit={submit}
          >
            <div class="mc-field-box">
              <Icon name="search" size={16} />
              <input
                ref={input}
                value={draft()}
                onInput={(e) => setDraft(e.currentTarget.value)}
                enterkeyhint="go"
                inputmode="url"
                type="text"
                autocapitalize="off"
                autocomplete="off"
                spellcheck={false}
                placeholder="Search or enter website"
              />
              <Show when={draft()}>
                <button
                  type="button"
                  class="mc-field-clear"
                  onClick={() => {
                    setDraft("");
                    input?.focus();
                  }}
                  aria-label="Clear"
                >
                  <Icon name="close" size={13} />
                </button>
              </Show>
            </div>
            <button type="button" class="mc-field-cancel" onClick={closeSearch}>
              Cancel
            </button>
          </form>
        </div>
      </Show>

      <Show when={props.sheet() === "tabs"}>
        <div class="mc-tabs">
          <div class="mc-grid">
            <For each={browserTabs()}>
              {(t) => {
                const host = () => hostOf(t.url);
                let x0 = 0;
                const [dx, setDx] = createSignal(0);
                return (
                  <div
                    class="mc-card"
                    classList={{ active: t.id === activeId() }}
                    style={
                      dx()
                        ? { transform: `translateX(${dx()}px)`, opacity: 1 - Math.abs(dx()) / 220 }
                        : undefined
                    }
                    onTouchStart={(e) => (x0 = e.touches[0]!.clientX)}
                    onTouchMove={(e) => {
                      const d = e.touches[0]!.clientX - x0;
                      if (Math.abs(d) > 10) setDx(d);
                    }}
                    onTouchEnd={() => {
                      if (Math.abs(dx()) > 120) void closeTab(t.id);
                      else setDx(0);
                    }}
                    onClick={() => {
                      void focusTab(t.id);
                      closeGrid();
                    }}
                  >
                    <div
                      class="mc-cover"
                      style={tabThumb(t.id) ? { "background-image": `url("${tabThumb(t.id)}")` } : undefined}
                    >
                      <Show when={!tabThumb(t.id)}>
                        <div class="mc-cover-empty">
                          <Favicon host={host()} size={36} />
                        </div>
                      </Show>
                      <button
                        class="mc-card-x"
                        onClick={(e) => {
                          e.stopPropagation();
                          void closeTab(t.id);
                        }}
                        aria-label="Close tab"
                      >
                        <Icon name="close" size={12} />
                      </button>
                    </div>
                    <div class="mc-card-foot">
                      <Favicon host={host()} size={14} />
                      <span>{t.custom_title || t.title || host() || "New tab"}</span>
                    </div>
                  </div>
                );
              }}
            </For>
          </div>
          <div class="mc-tabs-bar">
            <button
              class="mc-btn"
              onClick={() => {
                void openTab("browser");
                closeGrid();
              }}
              aria-label="New tab"
            >
              <Icon name="plus" />
            </button>
            <span class="mc-tabs-count">
              {browserTabs().length} {browserTabs().length === 1 ? "Tab" : "Tabs"}
            </span>
            <button class="mc-done" onClick={closeGrid}>
              Done
            </button>
          </div>
        </div>
      </Show>
    </>
  );
};

export default MobileChrome;
