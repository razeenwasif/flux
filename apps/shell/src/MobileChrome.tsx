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
 * - The bar: a frosted-glass island floating over the page with the address
 *   pill (tap to search, swipe sideways to change tabs), the tab count, and ⋯
 *   for the menu sheet. No back button: the edge swipe goes back (iOS) and so
 *   does the system back (Android). It shrinks to a small pill showing just the
 *   site while the page scrolls down, and comes back when it scrolls up or the
 *   pill is tapped.
 * - The search view: the field sits on the keyboard, suggestions stack up
 *   from it, nearest first: open tabs, history, and the search itself.
 * - The tab grid: page covers in two columns; tap to open, × or swipe a card
 *   away to close it.
 */
import { addPluginListener, invoke } from "@tauri-apps/api/core";
import { emit } from "@tauri-apps/api/event";
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
  START_URL,
  isStartUrl,
  searchResolve,
  webviewReload,
  webviewStop,
  webviewThumbnail,
  type HistoryEntry,
} from "./ipc";
import { Icon } from "./mobileicons";
import NotchIsland from "./NotchIsland";
import { isIOS } from "./platform";
import {
  activeId,
  activeTab,
  closeTab,
  ensureFavicon,
  faviconFor,
  focusTab,
  isLoading,
  openTab,
  setFilesPanelOpen,
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

/** The pill's host, cut from the LEFT when long (audit S17): the end of a
 *  hostname is the site you're on, so `bank.com.evil.example` must not show
 *  as `bank.com.ev…`. */
const pillHost = (host: string, max = 28): string => (host.length > max ? `…${host.slice(1 - max)}` : host);

type Nav = { id: number; progress?: number; loading?: boolean };

const hex = (r: number, g: number, b: number) =>
  "#" + [r, g, b].map((v) => Math.round(v).toString(16).padStart(2, "0")).join("");

/** The colour along the top of Flux's own background: the wallpaper's top edge
 *  (Liquid Silk paints it on body::before), else the body's colour. */
async function topColor(): Promise<string> {
  const before = getComputedStyle(document.body, "::before").backgroundImage;
  const url = /url\("?([^")]+)"?\)/.exec(before)?.[1];
  if (url) {
    const img = new Image();
    img.src = url;
    await img.decode();
    const c = document.createElement("canvas");
    c.width = 24;
    c.height = 2;
    const ctx = c.getContext("2d");
    if (ctx) {
      ctx.drawImage(img, 0, 0, img.naturalWidth, Math.max(1, img.naturalHeight * 0.05), 0, 0, 24, 2);
      const d = ctx.getImageData(0, 0, 24, 2).data;
      let r = 0,
        g = 0,
        b = 0;
      for (let i = 0; i < d.length; i += 4) {
        r += d[i]!;
        g += d[i + 1]!;
        b += d[i + 2]!;
      }
      const n = d.length / 4;
      return hex(r / n, g / n, b / n);
    }
  }
  const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(getComputedStyle(document.body).backgroundColor);
  return m ? hex(+m[1]!, +m[2]!, +m[3]!) : "";
}
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
  /** On one of Flux's own pages (Settings, Notebook, Trail…), not home: its
   *  name, from its address, for the pill. Such a page has no web history to swipe back through,
   *  so the island shows Home beside it. */
  const fluxPage = () => {
    const t = cur();
    if (!t || t.kind !== "browser" || !t.url.startsWith("flux://") || t.url === START_URL) return "";
    // From the address, not the tab's title: moving between Flux's pages in
    // one tab leaves the title of the first.
    const name = t.url.slice(7).split(/[/?#]/)[0] ?? "";
    return name.charAt(0).toUpperCase() + name.slice(1);
  };

  // ── What the native views report: theme colour, progress, scroll direction.
  const [progress, setProgress] = createSignal<Record<number, number>>({});
  const [compact, setCompact] = createSignal(false);
  /** Tabs whose native cover may be newer than the one the grid has. */
  const staleThumbs = new Set<number>();
  onMount(() => {
    const subs: Promise<{ unregister: () => Promise<void> }>[] = [
      addPluginListener<Nav>("flux-webview", "nav", (e) => {
        // A page that finished loading has a new cover natively.
        if (e.loading === false) staleThumbs.add(e.id);
        if (e.progress !== undefined)
          setProgress((m) => ({ ...m, [e.id]: e.loading === false ? 1 : e.progress! }));
      }),
      addPluginListener<Scroll>("flux-webview", "scroll", (e) => {
        if (e.id === activeId()) setCompact(e.down);
      }),
      // iOS's memory warning, passed on as the desktop's pressure event so the
      // shell's tab sleep unloads idle background tabs. iOS sends no all-clear,
      // so it's followed by one a few seconds later.
      addPluginListener("flux-webview", "memory", () => {
        void emit("flux://memory-pressure", "critical");
        setTimeout(() => void emit("flux://memory-pressure", "normal"), 5000);
      }),
    ];
    onCleanup(() => subs.forEach((p) => void p.then((s) => s.unregister()).catch(() => {})));
  });
  // The bar's height, for anything laid out above it (the Files page).
  // The bars' heights: for anything laid out above the bar (the Files page),
  // and for the native pages under them, which get them as insets. With them
  // goes the colour for the strip behind the notch over Flux's own pages:
  // WebKit draws nothing there, so the native layer shows, and it takes the
  // top edge of the wallpaper (iOS, ADR 0021).
  let bar: HTMLElement | undefined;
  let strip: HTMLDivElement | undefined;
  let fill = "";
  const send = () => {
    if (!bar || !strip) return;
    const top = strip.offsetHeight;
    // From the island's top to the screen's foot: the page is inset by all of
    // it, the margin under the island included.
    const bottom = Math.round(innerHeight - bar.getBoundingClientRect().top);
    document.documentElement.style.setProperty("--mc-bar-h", `${bottom}px`);
    void invoke("plugin:flux-webview|set_chrome", { top, bottom, fill: fill || null }).catch(() => {});
  };
  const sampleFill = async () => {
    fill = await topColor().catch(() => "");
    send();
  };
  onMount(() => {
    if (!bar || !strip) return;
    const ro = new ResizeObserver(send);
    ro.observe(bar);
    ro.observe(strip);
    // A new wallpaper or design changes the colour.
    const mo = new MutationObserver(() => void sampleFill());
    mo.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-wallpaper", "data-design"],
    });
    void sampleFill();
    onCleanup(() => {
      ro.disconnect();
      mo.disconnect();
    });
  });

  // iOS lays each page under the shell (ADR 0021): while one is on screen the
  // shell goes transparent, so the bars are glass over the page.
  onMount(() => {
    const sub = addPluginListener<{ visible: boolean }>("flux-webview", "page", (e) =>
      document.documentElement.classList.toggle("native-page", e.visible),
    );
    onCleanup(() => void sub.then((s) => s.unregister()).catch(() => {}));
  });
  // Links sent with Share → Flux from another app (iOS share extension, ADR
  // 0021) each open in a new tab. Flux takes them at start (a share can launch
  // it), when told one arrived, and on coming back to the front.
  const takeOpened = () =>
    void invoke<string[]>("plugin:flux-webview|take_opened")
      .then((links) => {
        for (const url of links) void openTab("browser", url);
      })
      .catch(() => {});
  onMount(() => {
    takeOpened();
    const sub = addPluginListener("flux-webview", "opened", takeOpened);
    const onVisible = () => {
      if (document.visibilityState === "visible") takeOpened();
    };
    document.addEventListener("visibilitychange", onVisible);
    onCleanup(() => {
      document.removeEventListener("visibilitychange", onVisible);
      void sub.then((s) => s.unregister()).catch(() => {});
    });
  });

  // Files is a full page over the tab on a phone, so going somewhere else (a
  // new address, another tab) closes it.
  createEffect(on([activeId, () => activeTab()?.url], () => setFilesPanelOpen(false), { defer: true }));

  // A different tab, or a sheet, starts from the full bar.
  createEffect(on([activeId, props.sheet], () => setCompact(false), { defer: true }));

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
  // (the plugin event channel drops payloads this large). Only the ones that
  // can have changed: the tab just left (its cover is retaken on the way
  // out), pages that finished loading since, and tabs without one yet.
  // Pulling every cover on every open cost an IPC and a JPEG decode per tab.
  createEffect(() => {
    if (props.sheet() !== "tabs") return;
    const act = activeId();
    for (const t of browserTabs()) {
      if (t.id !== act && !staleThumbs.has(t.id) && tabThumb(t.id)) continue;
      staleThumbs.delete(t.id);
      void webviewThumbnail(t.id)
        .then((d) => {
          if (d) setTabThumb(t.id, d);
        })
        .catch(() => {});
    }
  });
  const closeGrid = () => props.setSheet(null);
  const [gridMounted, setGridMounted] = createSignal(false);
  createEffect(() => {
    if (props.sheet() === "tabs") setGridMounted(true);
  });

  /** `off` for a private or Tor tab: the favicon fetcher asks for the icon
   *  outside that session and caches it on disk (audit S23), so those show the
   *  letter. */
  const Favicon: Component<{ host: string; size: number; off?: boolean }> = (p) => {
    createEffect(() => {
      if (!p.off) ensureFavicon(p.host);
    });
    return (
      <Show
        when={!p.off && faviconFor(p.host)}
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
      <div class="mc-status" ref={strip} />
      <Show when={isIOS}>
        <NotchIsland
          go={props.go}
          openSearch={openSearch}
          openTabs={() => props.setSheet("tabs")}
          hidden={() => props.sheet() !== null}
        />
      </Show>

      <footer
        ref={bar}
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
          <Show when={fluxPage()}>
            <button class="mc-btn" onClick={() => props.go(START_URL)} aria-label="Home">
              <Icon name="home" />
            </button>
          </Show>
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
            <span class="mc-pill-text" classList={{ hint: !curUrl() && !fluxPage() }}>
              {curUrl() ? pillHost(hostOf(curUrl())) || curUrl() : fluxPage() || "Search or enter website"}
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
                    <Favicon host={hostOf(t.url)} size={20} off={t.private || t.tor} />
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

      {/* Mounted on first open and then kept, shown and hidden: rebuilding the
          cards on every open re-decoded every cover. */}
      <Show when={gridMounted()}>
        <div class="mc-tabs" classList={{ open: props.sheet() === "tabs" }}>
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
                          <Favicon host={host()} size={36} off={t.private || t.tor} />
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
                      <Favicon host={host()} size={14} off={t.private || t.tor} />
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
