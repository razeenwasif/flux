/**
 * The notch island (iOS, notch iPhones): a black shape grown out of the notch
 * that makes the browser faster to drive with one thumb.
 *
 * - Idle: nothing but the notch. Pull down from it to open the island; hold
 *   it to ask Fairy.
 * - Compact: a lip under the notch with whatever is running (island.ts picks
 *   it): a confirmation, Fairy working, a meeting about to start, something
 *   playing in a tab, new mail. Tap it to open the island on that page; hold
 *   it for the activity's own action (play/pause, join, open the inbox).
 * - Open: a card of six pages (Quick, Tabs, Calendar, Mail, Playing, Fairy),
 *   swiped sideways like a carousel. The status bar fades out so the title and
 *   the page dots can sit in the notch's ears. Swipe up or tap outside to close.
 *
 * Pages are native WebViews under the shell (ADR 0021), so the plugin is told
 * where the island is (`set_island`): touches there reach it instead of the
 * page, and while it's open every touch does. iOS has no API for the notch, so
 * its size comes from a table by model (`notch_geometry`); on any other phone
 * the island isn't drawn at all.
 */
import { invoke } from "@tauri-apps/api/core";
import {
  For,
  Match,
  Show,
  Switch,
  createEffect,
  createMemo,
  createSignal,
  on,
  onCleanup,
  onMount,
  type Component,
  type JSX,
} from "solid-js";

import READER_JS from "../../../crates/flux-core/assets/reader.js?raw";
import {
  PAGE,
  PAGES,
  dayKey,
  firstName,
  islandLip,
  islandMedia,
  islandMore,
  islandNextEvent,
  islandToast,
  minutesUntil,
  watchMedia,
  type IslandKind,
} from "./island";
import { START_URL, webviewBack, webviewReload, type ReaderBlock } from "./ipc";
import {
  askFairy,
  glance,
  linkProblem,
  linkState,
  macName,
  markMailSeen,
  pairFromClipboard,
  refreshGlance,
  startLink,
  type FairyAnswer,
} from "./macLink";
import { Icon, type IconName } from "./mobileicons";
import {
  activeId,
  activeTab,
  ensureFavicon,
  faviconFor,
  focusTab,
  openReader,
  openTab,
  reopenClosedTab,
  tabs,
} from "./store";
import "./NotchIsland.css";

type Geometry = { w: number; h: number };

/** Island sizes, in points. */
const LIP_H = 32;
const LIP_EXTRA_W = 26;
const OPEN_H = 352;
const OPEN_INSET = 6;
const HOLD_MS = 480;
/** The bare notch isn't touch-sensitive (there's no screen there), so idle,
 *  a strip under and beside it takes the touches: this far either side of it,
 *  and this far below the status bar. */
const GRAB_PAD = 30;
const GRAB_BELOW = 14;

const LIP_ICON: Record<IslandKind, IconName> = {
  toast: "tick",
  fairy: "sparkle",
  calendar: "calendar",
  media: "wave",
  mail: "mail",
};

const hostOf = (url: string): string => {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
};

/** A Flux page's name ("Home", "Settings"), or "" for a web page. */
const fluxName = (url: string): string => {
  if (!url.startsWith("flux://")) return "";
  if (url === START_URL) return "Home";
  const n = url.slice(7).split(/[/?#]/)[0] ?? "";
  return n.charAt(0).toUpperCase() + n.slice(1);
};

const haptic = (style: "light" | "medium" | "soft" = "light") =>
  void invoke("plugin:flux-webview|haptic", { style }).catch(() => {});

/** Runs `js` (an async function body) in a tab and returns its result. */
async function inTab<T>(id: number, js: string): Promise<T | null> {
  const r = await invoke<{ json: string }>("plugin:flux-webview|eval_tab", { id, js });
  return JSON.parse(r.json) as T | null;
}

/** The media element a page is playing, or its first one. */
const PICK =
  "const els=[...document.querySelectorAll('video,audio')];" +
  "const e=els.find(x=>!x.paused&&!x.ended)||els.find(x=>x.currentTime>0&&!x.ended)||els[0];" +
  "if(!e) return null;";
const MEDIA = {
  toggle: PICK + "if(e.paused){await e.play().catch(()=>{});}else{e.pause();} return !e.paused;",
  seek: (s: number) => PICK + `e.currentTime=Math.max(0,e.currentTime+(${s}));return e.currentTime;`,
  rate: PICK + "const r=[1,1.25,1.5,2];e.playbackRate=r[(r.indexOf(e.playbackRate)+1)%r.length]||1;return e.playbackRate;",
  where: PICK + "return {t:e.currentTime,d:isFinite(e.duration)?e.duration:0,p:!e.paused,r:e.playbackRate};",
};

/** reader.js posts its blocks through Tauri's IPC, which an iOS tab doesn't
 *  have: it's given a stand-in that keeps them, in Flux's own script world. */
const READER_IOS =
  "let out=null;window.__TAURI_INTERNALS__={invoke:(_c,a)=>{out=a;}};window.__FLUX_TAB_ID__=0;" +
  READER_JS +
  "\ndelete window.__TAURI_INTERNALS__;return out?{title:out.title,blocks:out.blocks}:null;";

const PAGE_TEXT =
  "const root=document.querySelector('article,main,[role=main]')||document.body;" +
  "const sel=String(getSelection()||'').trim();" +
  "return {url:location.href,title:document.title,text:(root.innerText||'').replace(/\\s+\\n/g,'\\n').slice(0,24000),selection:sel.slice(0,4000)};";

const clockTime = (s: number) => {
  const t = Math.max(0, Math.floor(s));
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const sec = String(t % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
};

const mailTime = (ms: number) => {
  if (!ms) return "";
  const d = new Date(ms);
  const now = new Date();
  if (dayKey(d) === dayKey(now)) return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  return d.toLocaleDateString([], { weekday: "short" });
};

const NotchIsland: Component<{
  go: (url: string) => void;
  openSearch: () => void;
  openTabs: () => void;
  hidden: () => boolean;
}> = (props) => {
  const [notch, setNotch] = createSignal<Geometry | null>(null);
  const [open, setOpen] = createSignal(false);
  const [page, setPage] = createSignal<number>(PAGE.quick);
  const [width, setWidth] = createSignal(window.innerWidth);
  const [safeTop, setSafeTop] = createSignal(44);

  onMount(() => {
    void invoke<{ w?: number; h?: number }>("plugin:flux-webview|notch_geometry")
      .then((g) => {
        if (g.w && g.h) setNotch({ w: g.w, h: g.h });
      })
      .catch(() => {});
    const probe = document.createElement("div");
    probe.style.cssText = "position:fixed;top:0;height:env(safe-area-inset-top,0px);visibility:hidden";
    document.body.appendChild(probe);
    const measure = () => {
      setWidth(window.innerWidth);
      setSafeTop(probe.offsetHeight || 44);
    };
    measure();
    window.addEventListener("resize", measure);
    onCleanup(() => {
      window.removeEventListener("resize", measure);
      probe.remove();
    });
    watchMedia();
    void startLink();
    // For driving it from the Mac (scripts/ios-drive.sh) while testing.
    (window as unknown as { __fluxIsland?: unknown }).__fluxIsland = {
      open: (p = 0) => openAt(p),
      close: () => close(),
      toast: islandToast,
    };
  });

  const mode = createMemo<"idle" | "compact" | "open">(() =>
    open() ? "open" : islandLip() ? "compact" : "idle",
  );

  const size = createMemo(() => {
    const n = notch() ?? { w: 210, h: 32 };
    switch (mode()) {
      case "open":
        return { w: width() - OPEN_INSET * 2, h: OPEN_H, r: 46 };
      case "compact":
        return { w: n.w + LIP_EXTRA_W, h: n.h + LIP_H, r: 26 };
      default:
        return { w: n.w, h: n.h, r: 20 };
    }
  });

  // Where touches go: the plugin passes everything outside the island down
  // to the page; open, the shell takes all of them.
  createEffect(() => {
    if (!notch()) return;
    const s = size();
    const hide = props.hidden();
    const m = mode();
    const n = notch()!;
    const rect = hide
      ? { x: 0, y: 0, w: 0, h: 0 }
      : m === "idle"
        ? { x: (width() - n.w) / 2 - GRAB_PAD, y: 0, w: n.w + GRAB_PAD * 2, h: safeTop() + GRAB_BELOW }
        : { x: (width() - s.w) / 2, y: 0, w: s.w, h: s.h };
    void invoke("plugin:flux-webview|set_island", { ...rect, open: m === "open" && !hide }).catch(() => {});
  });

  // A sheet (search, the tab grid) closes it.
  createEffect(on(props.hidden, (h) => h && setOpen(false), { defer: true }));

  const openAt = (p: number) => {
    setPage(p);
    setOpen(true);
    haptic("light");
  };
  const close = () => {
    if (!open()) return;
    setOpen(false);
    haptic("soft");
  };

  // The Mail page, looked at, makes what's there no longer new.
  createEffect(() => {
    if (open() && page() === PAGE.mail) markMailSeen();
  });
  // Fresh calendar and mail whenever it opens on them.
  createEffect(
    on(open, (o) => {
      if (o) void refreshGlance();
    }),
  );

  // ── Touches on the island: tap, hold, swipe up to close ───────────────────
  let t0 = { x: 0, y: 0, at: 0 };
  let held = false;
  let holdTimer: ReturnType<typeof setTimeout> | undefined;
  let moved = false;

  const lipAction = (kind: IslandKind) => {
    const m = islandMedia();
    if (kind === "media" && m) void inTab(m.id, MEDIA.toggle).catch(() => {});
    else if (kind === "calendar") {
      const j = islandNextEvent()?.event.join;
      if (j) props.go(j);
      else openAt(PAGE.calendar);
    } else if (kind === "mail") props.go("https://mail.google.com/mail/u/0/#inbox");
    else openAt(islandLip()?.page ?? PAGE.quick);
  };

  const onStart = (e: TouchEvent) => {
    const p = e.touches[0]!;
    t0 = { x: p.clientX, y: p.clientY, at: Date.now() };
    held = false;
    moved = false;
    clearTimeout(holdTimer);
    if (mode() === "open") return;
    holdTimer = setTimeout(() => {
      held = true;
      haptic("medium");
      const lip = islandLip();
      if (lip) lipAction(lip.kind);
      else openAt(PAGE.fairy);
    }, HOLD_MS);
  };
  const onMove = (e: TouchEvent) => {
    const p = e.touches[0]!;
    const dx = p.clientX - t0.x;
    const dy = p.clientY - t0.y;
    if (Math.abs(dx) > 8 || Math.abs(dy) > 8) {
      moved = true;
      clearTimeout(holdTimer);
    }
    // Closed: pulling down opens it.
    if (mode() !== "open" && dy > 28 && Math.abs(dy) > Math.abs(dx)) {
      clearTimeout(holdTimer);
      held = true;
      openAt(islandLip()?.page ?? PAGE.quick);
    }
  };
  const onEnd = (e: TouchEvent) => {
    clearTimeout(holdTimer);
    const p = e.changedTouches[0]!;
    const dx = p.clientX - t0.x;
    const dy = p.clientY - t0.y;
    if (mode() === "open") {
      // Swipe up anywhere on the card closes it.
      if (dy < -40 && Math.abs(dy) > Math.abs(dx) * 1.2) close();
      return;
    }
    if (held || moved) return;
    // A tap on the lip opens its page; on the bare notch, Quick.
    openAt(islandLip()?.page ?? PAGE.quick);
  };

  // ── The carousel ────────────────────────────────────────────────────────
  const [drag, setDrag] = createSignal(0);
  const [dragging, setDragging] = createSignal(false);
  let c0 = { x: 0, y: 0 };
  let axis: "x" | "y" | null = null;
  const cardW = () => width() - OPEN_INSET * 2;
  const cStart = (e: TouchEvent) => {
    c0 = { x: e.touches[0]!.clientX, y: e.touches[0]!.clientY };
    axis = null;
  };
  const cMove = (e: TouchEvent) => {
    const dx = e.touches[0]!.clientX - c0.x;
    const dy = e.touches[0]!.clientY - c0.y;
    if (!axis && (Math.abs(dx) > 8 || Math.abs(dy) > 8)) axis = Math.abs(dx) > Math.abs(dy) ? "x" : "y";
    if (axis !== "x") return;
    e.preventDefault();
    setDragging(true);
    const atEnd = (page() === 0 && dx > 0) || (page() === PAGES.length - 1 && dx < 0);
    setDrag(atEnd ? dx * 0.3 : dx);
  };
  const cEnd = () => {
    if (axis === "x") {
      const d = drag();
      if (d < -50 && page() < PAGES.length - 1) {
        setPage(page() + 1);
        haptic("light");
      } else if (d > 50 && page() > 0) {
        setPage(page() - 1);
        haptic("light");
      }
    }
    setDrag(0);
    setDragging(false);
    axis = null;
  };
  const trackX = () => -page() * cardW() + drag();
  const pageStyle = (i: number): JSX.CSSProperties => {
    const d = Math.min(1, Math.abs(i * cardW() + trackX()) / cardW());
    return { opacity: String(1 - d * 0.7), transform: `scale(${1 - d * 0.1})` };
  };

  // ── Actions ─────────────────────────────────────────────────────────────
  const cur = () => {
    const t = activeTab();
    return t && t.kind === "browser" && !t.url.startsWith("flux://") ? t : null;
  };
  const after = (fn: () => void) => () => {
    close();
    fn();
  };
  const copyLink = () => {
    const t = cur();
    if (!t) return;
    void navigator.clipboard
      .writeText(t.url)
      .then(() => {
        close();
        islandToast("Link copied");
      })
      .catch(() => {});
  };
  const share = () => {
    const t = cur();
    if (!t) return;
    close();
    void invoke("plugin:flux-webview|share", { url: t.url, title: t.title || null }).catch(() => {});
  };
  const reader = () => {
    const t = cur();
    if (!t) return;
    close();
    void inTab<{ title: string; blocks: ReaderBlock[] }>(t.id, READER_IOS)
      .then((r) => {
        if (r && r.blocks.length) openReader(t.id, r.title, r.blocks);
        else islandToast("No article on this page");
      })
      .catch(() => islandToast("No article on this page"));
  };
  const find = () => {
    close();
    void invoke("plugin:flux-webview|find_in_page").catch(() => {});
  };

  const Fav: Component<{ url: string; size: number; off?: boolean }> = (p) => {
    const host = () => hostOf(p.url);
    createEffect(() => {
      if (!p.off) ensureFavicon(host());
    });
    return (
      <Show
        when={!p.off && faviconFor(host())}
        fallback={
          <span class="ni-fav glyph" style={{ width: `${p.size}px`, height: `${p.size}px` }}>
            {(host()[0] || "•").toUpperCase()}
          </span>
        }
      >
        <img class="ni-fav" src={faviconFor(host())!} alt="" width={p.size} height={p.size} />
      </Show>
    );
  };

  // ── Pages ───────────────────────────────────────────────────────────────
  const Tile: Component<{ icon: IconName; label: string; run: () => void; ai?: boolean; off?: boolean }> = (p) => (
    <button class="ni-tile" classList={{ ai: p.ai }} disabled={p.off} onClick={p.run}>
      <Icon name={p.icon} size={20} />
      <span>{p.label}</span>
    </button>
  );

  const Quick = () => (
    <div class="ni-page">
      <div class="ni-cur">
        <Show when={cur()} fallback={<span class="ni-fav glyph big">F</span>}>
          {(t) => <Fav url={t().url} size={36} off={t().private || t().tor} />}
        </Show>
        <div class="ni-cur-main">
          <div class="ni-cur-title">{cur()?.title || (cur() ? hostOf(cur()!.url) : "Flux")}</div>
          <div class="ni-sub">{cur() ? hostOf(cur()!.url) : "Home"}</div>
        </div>
        <button class="ni-round" aria-label="Back" disabled={!cur()} onClick={() => cur() && void webviewBack(cur()!.id).catch(() => {})}>
          <Icon name="back" size={18} />
        </button>
        <button class="ni-round" aria-label="Reload" disabled={!cur()} onClick={() => cur() && void webviewReload(cur()!.id).catch(() => {})}>
          <Icon name="reload" size={18} />
        </button>
      </div>
      <div class="ni-tiles">
        <Tile icon="plus" label="New tab" run={after(() => void openTab("browser", START_URL))} />
        <Tile icon="lock" label="Private" run={after(() => void openTab("browser", START_URL, true))} />
        <Tile icon="search" label="Search" run={after(props.openSearch)} />
        <Tile icon="sparkle" label="Ask Fairy" ai run={() => setPage(PAGE.fairy)} />
        <Tile icon="book" label="Reader" off={!cur()} run={reader} />
        <Tile icon="find" label="Find" off={!cur()} run={find} />
        <Tile icon="share" label="Share" off={!cur()} run={share} />
        <Tile icon="link" label="Copy link" off={!cur()} run={copyLink} />
      </div>
    </div>
  );

  const Tabs = () => {
    const list = createMemo(() => {
      const browser = tabs().filter((t) => t.kind === "browser");
      const act = browser.find((t) => t.id === activeId());
      const rest = browser.filter((t) => t.id !== activeId()).reverse();
      return (act ? [act, ...rest] : rest).slice(0, 4);
    });
    const playingId = () => (islandMedia()?.playing ? islandMedia()!.id : -1);
    return (
      <div class="ni-page">
        <For each={list()} fallback={<div class="ni-empty">No tabs open</div>}>
          {(t) => (
            <button class="ni-row" onClick={after(() => void focusTab(t.id))}>
              <Fav url={t.url} size={30} off={t.private || t.tor} />
              <span class="ni-row-main">
                <span class="ni-row-title">{fluxName(t.url) || t.title || hostOf(t.url) || "New tab"}</span>
                <span class="ni-sub">
                  {fluxName(t.url) ? "Flux" : hostOf(t.url) || "Flux"}
                  {t.id === activeId() ? " · this tab" : t.id === playingId() ? " · playing" : ""}
                </span>
              </span>
              <Show when={t.id === activeId()}>
                <span class="ni-dot-live" />
              </Show>
            </button>
          )}
        </For>
        <div class="ni-pills">
          <button class="ni-pill" onClick={after(() => void openTab("browser", START_URL))}>
            <Icon name="plus" size={14} />
            New tab
          </button>
          <button class="ni-pill" onClick={after(props.openTabs)}>
            All {tabs().filter((t) => t.kind === "browser").length} tabs
          </button>
          <button class="ni-pill" onClick={after(() => void reopenClosedTab())}>
            Reopen closed
          </button>
        </div>
      </div>
    );
  };

  /** Shown on the Mac's pages until this phone is paired, or while it can't
   *  reach the Mac. */
  const Linked: Component<{ what: string; children: JSX.Element }> = (p) => (
    <Switch>
      <Match when={linkState() === "linked" || (linkState() === "offline" && glance())}>{p.children}</Match>
      <Match when={linkState() === "unpaired"}>
        <div class="ni-page ni-pair">
          <div class="ni-pair-title">{p.what} comes from Flux on your Mac</div>
          <p class="ni-pair-text">
            On the Mac, open Settings › Phone link and copy a pairing link. It arrives here through Universal Clipboard.
          </p>
          <button class="ni-pill strong" onClick={() => void pairFromClipboard().catch(() => {})}>
            Paste pairing link
          </button>
          <Show when={linkProblem()}>
            <p class="ni-pair-err">{linkProblem()}</p>
          </Show>
        </div>
      </Match>
      <Match when={true}>
        <div class="ni-page ni-pair">
          <div class="ni-pair-title">
            {linkState() === "connecting" ? `Reaching ${macName() || "your Mac"}…` : `Can't reach ${macName() || "your Mac"}`}
          </div>
          <p class="ni-pair-text">Both need Tailscale on, and Flux open on the Mac.</p>
          <Show when={linkState() === "offline"}>
            <button class="ni-pill" onClick={() => void refreshGlance()}>
              Try again
            </button>
          </Show>
        </div>
      </Match>
    </Switch>
  );

  const Calendar = () => {
    const week = createMemo(() => {
      const now = new Date();
      const monday = new Date(now);
      monday.setDate(now.getDate() - ((now.getDay() + 6) % 7));
      const busy = new Set((glance()?.events ?? []).map((e) => e.date));
      return Array.from({ length: 7 }, (_, i) => {
        const d = new Date(monday);
        d.setDate(monday.getDate() + i);
        const key = dayKey(d);
        return { key, letter: "MTWTFSS"[i]!, day: d.getDate(), today: key === dayKey(now), busy: busy.has(key) };
      });
    });
    const later = createMemo(() => {
      const today = dayKey(new Date());
      const next = islandNextEvent()?.event;
      return (glance()?.events ?? [])
        .filter((e) => e.date === today && e !== next && (!e.time || minutesUntil(e.end || e.time) > 0))
        .filter((e) => !next || !e.time || e.time >= next.time)
        .slice(0, 3);
    });
    const when = () => {
      const n = islandNextEvent();
      if (!n) return "";
      return n.until > 60 ? `At ${n.event.time}` : n.until > 0 ? `In ${n.until} min` : "Now";
    };
    return (
      <Linked what="Your calendar">
        <div class="ni-page">
          <Show
            when={glance()?.calendar.connected}
            fallback={<div class="ni-empty">Add your Google Calendar to Flux on your Mac (Settings › Calendar).</div>}
          >
            <div class="ni-week">
              <For each={week()}>
                {(d) => (
                  <div class="ni-day" classList={{ today: d.today }}>
                    <span>{d.letter}</span>
                    <b>{d.day}</b>
                    <i classList={{ on: d.busy && !d.today }} />
                  </div>
                )}
              </For>
            </div>
            <Show when={islandNextEvent()} fallback={<div class="ni-empty">Nothing else today</div>}>
              {(n) => (
                <div class="ni-next">
                  <div class="ni-next-main">
                    <div class="ni-next-when">{when()}</div>
                    <div class="ni-next-title">{n().event.summary}</div>
                    <div class="ni-sub">
                      {n().event.time}
                      {n().event.end ? ` to ${n().event.end}` : ""}
                      {n().event.location && !n().event.join ? ` · ${n().event.location}` : n().event.join ? " · Video call" : ""}
                    </div>
                  </div>
                  <Show when={n().event.join}>
                    <button class="ni-pill join" onClick={after(() => props.go(n().event.join))}>
                      <Icon name="video" size={15} />
                      Join
                    </button>
                  </Show>
                </div>
              )}
            </Show>
            <For each={later()}>
              {(e) => (
                <div class="ni-ev">
                  <span class="ni-ev-time">{e.time || "All day"}</span>
                  <i />
                  <span class="ni-ev-title">{e.summary}</span>
                  <span class="ni-sub">{e.calendar}</span>
                </div>
              )}
            </For>
          </Show>
        </div>
      </Linked>
    );
  };

  const Mail = () => (
    <Linked what="Your inbox">
      <div class="ni-page">
        <Show
          when={glance()?.mail.connected}
          fallback={<div class="ni-empty">Connect Gmail to Flux on your Mac (the mail pane, with an app password).</div>}
        >
          <div class="ni-mail-head">
            <span class="ni-mail-title">Inbox</span>
            <Show when={glance()!.mail.unread > 0}>
              <span class="ni-badge">{glance()!.mail.unread} unread</span>
            </Show>
            <span style={{ flex: 1 }} />
            <button
              class="ni-round"
              aria-label="Compose"
              onClick={after(() => props.go("https://mail.google.com/mail/u/0/#inbox?compose=new"))}
            >
              <Icon name="compose" size={16} />
            </button>
          </div>
          <For each={glance()!.mail.messages.slice(0, 4)} fallback={<div class="ni-empty">Inbox zero</div>}>
            {(m) => (
              <button class="ni-mail" onClick={after(() => props.go(m.link))}>
                <span class="ni-avatar">{(firstName(m.from)[0] || "?").toUpperCase()}</span>
                <span class="ni-row-main">
                  <span class="ni-mail-top">
                    <Show when={m.unread}>
                      <i class="ni-unread" />
                    </Show>
                    <span class="ni-mail-from" classList={{ read: !m.unread }}>
                      {m.from.replace(/<[^>]*>/g, "").replace(/"/g, "").trim() || m.from}
                    </span>
                    <span class="ni-sub">{mailTime(m.date_ms)}</span>
                  </span>
                  <span class="ni-mail-subject" classList={{ read: !m.unread }}>
                    {m.subject || "(no subject)"}
                  </span>
                </span>
              </button>
            )}
          </For>
        </Show>
      </div>
    </Linked>
  );

  const Playing = () => {
    const [pos, setPos] = createSignal<{ t: number; d: number; p: boolean; r: number } | null>(null);
    // Where it's up to, once a second, while this page is on screen.
    createEffect(() => {
      const m = islandMedia();
      if (!open() || page() !== PAGE.playing || !m) return;
      const tick = () => void inTab<{ t: number; d: number; p: boolean; r: number }>(m.id, MEDIA.where).then(setPos).catch(() => {});
      tick();
      const iv = setInterval(tick, 1000);
      onCleanup(() => clearInterval(iv));
    });
    const tab = () => tabs().find((t) => t.id === islandMedia()?.id);
    const run = (js: string) => {
      const m = islandMedia();
      if (!m) return;
      haptic("light");
      void inTab<{ t: number; d: number; p: boolean; r: number }>(m.id, js)
        .then(() => inTab<{ t: number; d: number; p: boolean; r: number }>(m.id, MEDIA.where))
        .then(setPos)
        .catch(() => {});
    };
    const playing = () => pos()?.p ?? islandMedia()?.playing ?? false;
    return (
      <Show when={islandMedia()} fallback={<div class="ni-page"><div class="ni-empty">Nothing is playing</div></div>}>
        {(m) => (
          <div class="ni-page">
            <div class="ni-play-head">
              <Show when={m().art} fallback={<span class="ni-art"><Icon name="wave" size={40} /></span>}>
                <img class="ni-art" src={m().art} alt="" />
              </Show>
              <div class="ni-row-main">
                <div class="ni-play-title">{m().title || "Playing"}</div>
                <div class="ni-sub">{m().artist || hostOf(tab()?.url ?? "")}</div>
                <button class="ni-pill small" onClick={after(() => void focusTab(m().id))}>
                  {hostOf(tab()?.url ?? "")} · go to tab
                </button>
              </div>
            </div>
            <div class="ni-scrub">
              <div style={{ width: `${pos()?.d ? Math.min(100, (pos()!.t / pos()!.d) * 100) : 0}%` }} />
            </div>
            <div class="ni-times">
              <span>{clockTime(pos()?.t ?? 0)}</span>
              <span>{pos()?.d ? `-${clockTime(pos()!.d - pos()!.t)}` : ""}</span>
            </div>
            <div class="ni-controls">
              <button class="ni-round big" aria-label="Playback speed" onClick={() => run(MEDIA.rate)}>
                {(pos()?.r ?? 1) === 1 ? "1×" : `${pos()!.r}×`}
              </button>
              <button class="ni-round big" aria-label="Back 15 seconds" onClick={() => run(MEDIA.seek(-15))}>
                <Icon name="back15" size={22} />
              </button>
              <button class="ni-play" aria-label={playing() ? "Pause" : "Play"} onClick={() => run(MEDIA.toggle)}>
                <Icon name={playing() ? "pause" : "play"} size={24} />
              </button>
              <button class="ni-round big" aria-label="Forward 30 seconds" onClick={() => run(MEDIA.seek(30))}>
                <Icon name="fwd30" size={22} />
              </button>
            </div>
          </div>
        )}
      </Show>
    );
  };

  const [answer, setAnswer] = createSignal<(FairyAnswer & { about: string }) | null>(null);
  const [asking, setAsking] = createSignal(false);
  const [askErr, setAskErr] = createSignal("");
  let askField: HTMLInputElement | undefined;
  const ask = async (question: string) => {
    // A private or Tor tab's page never leaves the phone (as on the Mac).
    const t = cur() && !cur()!.private && !cur()!.tor ? cur() : null;
    if (!question.trim() || asking()) return;
    setAsking(true);
    setAskErr("");
    try {
      const page = t
        ? ((await inTab<{ url: string; title: string; text: string; selection: string }>(t.id, PAGE_TEXT).catch(() => null)) ?? {
            url: t.url,
            title: t.title,
            text: "",
            selection: "",
          })
        : { url: "", title: "", text: "", selection: "" };
      const q = question === "Explain selection" ? `Explain this: "${page.selection || "(nothing selected)"}"` : question;
      const a = await askFairy(q, { url: page.url, title: page.title, text: page.text });
      setAnswer({ ...a, about: page.title || hostOf(page.url) });
      if (!open()) islandToast("Fairy answered");
    } catch (e) {
      setAskErr(e instanceof Error ? e.message : String(e));
    } finally {
      setAsking(false);
    }
  };

  const Fairy = () => (
    <Linked what="Fairy">
      <div class="ni-page">
        <Show
          when={glance()?.fairy.installed !== false}
          fallback={<div class="ni-empty">Fairy isn't installed on {macName() || "your Mac"}.</div>}
        >
          <div class="ni-answer">
            <div class="ni-answer-head">
              <Icon name="sparkle" size={15} />
              {glance()?.fairy.name || "Fairy"}
              {answer() ? ` · ${answer()!.about}` : cur() ? " · on this page" : ""}
            </div>
            <p class="ni-answer-text" classList={{ dim: !answer() && !asking() }}>
              {asking()
                ? "Reading the page…"
                : askErr() || answer()?.answer || "Ask anything about the page you're on. She reads it on your Mac."}
            </p>
          </div>
          <div class="ni-pills wrap">
            <For each={["Summarise", "Key points", "Translate", "Explain selection"]}>
              {(q) => (
                <button class="ni-pill" disabled={asking()} onClick={() => void ask(q === "Summarise" ? "Summarise this page" : q === "Key points" ? "What are the key points?" : q === "Translate" ? "Translate this page into English" : q)}>
                  {q}
                </button>
              )}
            </For>
          </div>
          <form
            class="ni-ask"
            onSubmit={(e) => {
              e.preventDefault();
              const q = askField?.value ?? "";
              if (askField) askField.value = "";
              askField?.blur();
              void ask(q);
            }}
          >
            <label class="ni-sr" for="ni-ask-field">
              Ask Fairy about this page
            </label>
            <input id="ni-ask-field" ref={askField} type="text" enterkeyhint="send" placeholder="Ask about this page" autocomplete="off" />
            <button class="ni-round send" type="submit" aria-label="Ask">
              <Icon name="up" size={16} />
            </button>
          </form>
        </Show>
      </div>
    </Linked>
  );

  return (
    <Show when={notch()}>
      <div class="ni-scrim" classList={{ on: open() }} onClick={close} />
      <Show when={mode() === "idle" && !props.hidden()}>
        <div
          class="ni-grab"
          style={{ width: `${notch()!.w + GRAB_PAD * 2}px`, height: `${safeTop() + GRAB_BELOW}px` }}
          onTouchStart={onStart}
          onTouchMove={onMove}
          onTouchEnd={onEnd}
          role="button"
          aria-label="Open the island"
        />
      </Show>
      <div
        class="ni"
        classList={{ open: open(), compact: mode() === "compact", hidden: props.hidden() }}
        style={{
          width: `${size().w}px`,
          height: `${size().h}px`,
          "border-radius": `0 0 ${size().r}px ${size().r}px`,
        }}
        onTouchStart={onStart}
        onTouchMove={onMove}
        onTouchEnd={onEnd}
        role={open() ? "dialog" : undefined}
        aria-label={open() ? "Island" : undefined}
      >
        <div class="ni-lip" style={{ top: `${notch()!.h}px` }} aria-live="polite">
          <Show when={islandLip()}>
            {(lip) => (
              <>
                <span class={`ni-lip-ico ${lip().kind}`}>
                  <Icon name={LIP_ICON[lip().kind]} size={15} />
                </span>
                <span class="ni-lip-text">{lip().text}</span>
                <Show when={lip().kind === "fairy"}>
                  <span class="ni-dots">
                    <i />
                    <i />
                    <i />
                  </span>
                </Show>
                <Show when={lip().kind === "media"}>
                  <span class="ni-eq">
                    <i />
                    <i />
                    <i />
                    <i />
                  </span>
                </Show>
                <Show when={lip().detail}>
                  <span class={`ni-lip-detail ${lip().kind}`}>{lip().detail}</span>
                </Show>
                <Show when={islandMore()}>
                  <span class="ni-more" />
                </Show>
              </>
            )}
          </Show>
        </div>

        <Show when={open()}>
          <div class="ni-body">
            <div class="ni-ear left">{PAGES[page()]}</div>
            <div class="ni-ear right">
              <For each={[...PAGES]}>
                {(label, i) => (
                  <button
                    class="ni-pdot"
                    classList={{ on: i() === page() }}
                    aria-label={`Show ${label}`}
                    onClick={() => setPage(i())}
                  />
                )}
              </For>
            </div>
            <div class="ni-view" onTouchStart={cStart} onTouchMove={cMove} onTouchEnd={cEnd}>
              <div
                class="ni-track"
                classList={{ dragging: dragging() }}
                style={{ width: `${cardW() * PAGES.length}px`, transform: `translateX(${trackX()}px)` }}
              >
                <For each={[Quick, Tabs, Calendar, Mail, Playing, Fairy]}>
                  {(P, i) => (
                    <div class="ni-slot" classList={{ dragging: dragging() }} style={{ width: `${cardW()}px`, ...pageStyle(i()) }} aria-hidden={i() !== page()}>
                      <P />
                    </div>
                  )}
                </For>
              </div>
            </div>
            <button class="ni-handle" aria-label="Close" onClick={close}>
              <i />
            </button>
          </div>
        </Show>
      </div>
    </Show>
  );
};

export default NotchIsland;
