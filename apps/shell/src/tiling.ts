// Webview tiling — the geometry engine that keeps the native OS webviews glued
// to the DOM chrome. A native webview is a separate OS layer ABOVE all HTML, so
// the chrome can't draw over it; instead this module measures the DOM slots
// (content card, web-panel boxes), computes each webview's rect, and issues
// show/hide/bounds IPC. Extracted from App.tsx so layout algebra and IPC
// reconciliation live in one place; App composes it with its local overlay
// flags via createWebviewTiling(deps).
import { createEffect, createSignal, onCleanup, onMount } from "solid-js";
import {
  activePanel,
  activePanelB,
  activePanelId,
  activePanelIdB,
  activeTab,
  panelDragging,
  panelSplitRatio,
  panelWidth,
  readerOpen,
  setHibernated,
  tileGroup,
  tilePanes,
} from "./store";
import { tileRects } from "./tiles";
import {
  isStartUrl,
  panelClose,
  panelHide,
  panelOpen,
  panelSetBounds,
  panelShow,
  webviewHibernate,
  webviewHide,
  webviewOpen,
  webviewSetBounds,
  webviewShow,
  type Rect,
  type TabMeta,
  type WebPanel,
} from "./ipc";

/** One tiled pane: a browser tab's webview and the rect it must occupy. */
export type Pane = { tab: TabMeta; rect: Rect };

/** App-local reactive inputs the tiling engine can't own itself. */
export type TilingDeps = {
  /** Any full-card HTML overlay is open (pageOverlayActive + App-local flags). */
  overlayActive: () => boolean;
  /** A splitter/divider drag is in flight — hide everything so the DOM tracks the pointer. */
  uiDragging: () => boolean;
  /** Focus/compact mode (#55) — hides the web-panel column (not a page overlay). */
  focusMode: () => boolean;
};

/** What App (hibernation, navigation, workspace switching) needs back. */
export type WebviewTiling = {
  /** Tab ids whose native webview exists. */
  openedWebviews: Set<number>;
  /** Tab ids whose webview open IPC is in flight. */
  openingWebviews: Set<number>;
  /** Last time each tab was the active one (ms) — drives hibernation (#45). */
  lastActive: Map<number, number>;
  /** Fire-and-forget a webview command, surfacing failures to the console. */
  wv: (p: Promise<unknown>) => void;
  /** Drop all liveness bookkeeping for a tab (closed / hibernated). */
  forgetWebview: (id: number) => void;
  /** Coalesced bounds re-apply (one IPC per animation frame). */
  scheduleRelayout: () => void;
  /** Force a full re-tile even when the card rect is unchanged (fullscreen exit). */
  forceRelayout: () => void;
  /** The current pane layout: which webviews should be visible, and where. */
  paneLayout: () => Pane[];
};

// ── Layout constants ─────────────────────────────────────────────────────────
/** Gap between split panes; the DOM seam lives in it (no webview covers it). */
export const SPLIT_GAP = 8;
/** DOM toolbar height atop each web-panel box; its webview tiles below it. */
export const PANEL_TOOLBAR = 34;
/** Grab gutter on the panel's left edge so the resize handle sits in a strip
 *  no native webview covers (same idea as the split seam's SPLIT_GAP). */
export const PANEL_GUTTER = 14;

/** Wire the tiling effects. Call once, inside App's setup (owns the effects). */
export function createWebviewTiling(deps: TilingDeps): WebviewTiling {
  const { overlayActive, uiDragging, focusMode } = deps;

  // Live rect of the content card, in CSS (logical) px relative to the window.
  // Native tab webviews are positioned to match it (BACKLOG #2).
  const [contentRect, setContentRect] = createSignal<Rect | null>(null);
  // Bumped to force the tiling effects to re-apply bounds even when the card
  // rect hasn't changed. Needed because exiting an HTML5 video fullscreen
  // leaves the native webview oversized (covering the bookmark bar / footer)
  // and fires no window resize, so nothing would otherwise re-tile it down.
  const [relayoutTick, setRelayoutTick] = createSignal(0);
  const forceRelayout = () => setRelayoutTick((n) => n + 1);

  const openedWebviews = new Set<number>();
  const openingWebviews = new Set<number>();
  // Webview ids currently shown (visible panes). Lets the layout effect issue
  // show/hide IPC only on transitions, not once per tab on every resize frame.
  const shown = new Set<number>();
  // Last time each tab was the active one (ms) — drives tab hibernation (#45).
  const lastActive = new Map<number, number>();

  // Fire-and-forget a webview command, surfacing failures (the search/position
  // bug is hard to see otherwise — check the devtools console).
  const wv = (p: Promise<unknown>) => void p.catch((e) => console.error("[flux webview]", e));
  const forgetWebview = (id: number) => {
    openedWebviews.delete(id);
    openingWebviews.delete(id);
    shown.delete(id);
  };

  // ── Rect math ──────────────────────────────────────────────────────────────
  // Read the content-card rect fresh from the DOM (never a stale signal).
  const readRect = (): Rect | null => {
    const el = document.getElementById("flux-web-area");
    if (!el) return null;
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return null;
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  };
  // Each web-panel slot is a DOM element (toolbar + native-webview region); the
  // webview is tiled below the toolbar of its slot's box, so a vertical split is
  // just two boxes the native layer follows.
  const slotViewRect = (elId: string, active: boolean): Rect | null => {
    const el = document.getElementById(elId);
    if (!el || !active) return null;
    const r = el.getBoundingClientRect();
    if (!r || r.width < 1 || r.height < PANEL_TOOLBAR + 1) return null;
    return { x: r.x, y: r.y + PANEL_TOOLBAR, width: r.width, height: Math.max(0, r.height - PANEL_TOOLBAR) };
  };
  const insetLeft = (r: Rect | null, px: number): Rect | null =>
    r ? { ...r, x: r.x + px, width: Math.max(0, r.width - px) } : null;
  const panelViewRect = (): Rect | null =>
    insetLeft(slotViewRect("flux-panel-area", activePanelId() != null), PANEL_GUTTER);
  const panelViewRectB = (): Rect | null =>
    insetLeft(slotViewRect("flux-panel-area-b", activePanelIdB() != null), PANEL_GUTTER);

  // The pane layout (#43): normally the active browser tab fills the card; when
  // a split is active the two pair tabs tile left | right at `splitRatio` with a
  // small gap the DOM splitter sits in.
  const paneLayout = (): Pane[] => {
    if (readerOpen()) return []; // reader view covers the card; hide the page
    const rect = readRect();
    if (!rect) return [];
    const panes = tilePanes();
    const g = tileGroup();
    if (panes && g) {
      // Same geometry the DOM panes use — see tiles.ts on why it's one function.
      const rects = tileRects({
        layout: g.layout,
        n: panes.length,
        main: g.main,
        sec: g.sec,
        rect,
        gap: SPLIT_GAP,
      });
      // Only real web pages get a tiled webview; Flux's internal pages (any
      // flux:// url) render as DOM into their slot — feeding them here would
      // open a black native webview over the page.
      return panes
        .map((tab, i) => ({ tab, rect: rects[i]! }))
        .filter((p) => p.rect && !isStartUrl(p.tab.url));
    }
    const act = activeTab();
    if (act?.kind === "browser" && !isStartUrl(act.url)) return [{ tab: act, rect }];
    return [];
  };

  // Coalesce webview bounds updates to one IPC call per animation frame — a
  // resize fires dozens of layout changes/sec, and one IPC each was the lag.
  // Pane-aware: repositions every tiled pane, not just the active tab.
  let boundsRaf = 0;
  const scheduleRelayout = () => {
    if (boundsRaf) return;
    boundsRaf = requestAnimationFrame(() => {
      boundsRaf = 0;
      if (uiDragging() || overlayActive()) return;
      for (const p of paneLayout()) wv(webviewSetBounds(p.tab.id, p.rect));
    });
  };

  // ── Measurement ────────────────────────────────────────────────────────────
  // Track the content-card rect: ResizeObserver catches every layout change
  // (window resize, sidebar collapse, panel toggles, pane resize) in one place.
  onMount(() => {
    const el = document.getElementById("flux-web-area");
    if (!el) return;
    const measure = () => setContentRect(readRect());
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    window.addEventListener("resize", measure);
    // Recover the layout after a video leaves fullscreen: the host window
    // regains focus / fires a fullscreenchange, but no resize, so we re-measure
    // AND force a bounds re-apply to shrink the page webview back down.
    const recover = () => {
      measure();
      forceRelayout();
    };
    window.addEventListener("focus", recover);
    document.addEventListener("visibilitychange", recover);
    document.addEventListener("fullscreenchange", recover);
    document.addEventListener("webkitfullscreenchange", recover);
    measure();
    onCleanup(() => {
      ro.disconnect();
      window.removeEventListener("resize", measure);
      window.removeEventListener("focus", recover);
      document.removeEventListener("visibilitychange", recover);
      document.removeEventListener("fullscreenchange", recover);
      document.removeEventListener("webkitfullscreenchange", recover);
    });
  });

  // ── Tab webviews ───────────────────────────────────────────────────────────
  // Sync native webviews to the pane layout (#2/#43): show the tiled pane(s) at
  // their rects, hide every other browser tab's webview. flux:// tabs get no
  // webview — their page renders in the card. While a seam/divider is dragged,
  // hide all panes so the DOM splitter can track the pointer (a native webview
  // is a separate OS layer that would otherwise eat the mouse).
  createEffect(() => {
    contentRect(); // subscribe: re-run on any layout change
    relayoutTick(); // subscribe: forced re-tile (e.g. after fullscreen-video exit)
    tileGroup(); // subscribe: re-tile when a seam moves or the layout changes
    panelWidth(); // subscribe: re-tile when the panel divider moves
    const dragging = uiDragging();
    const overlay = overlayActive();
    const panes = overlay ? [] : paneLayout();
    const liveIds = new Set(panes.map((p) => p.tab.id));
    // Hide only what's currently shown but shouldn't be (or everything mid-drag).
    // Crucially this issues NO hide IPC on a pure resize — `shown` already
    // matches `liveIds`, so the loop is a no-op and only the throttled bounds
    // update runs.
    for (const id of [...shown]) {
      if (dragging || !liveIds.has(id)) {
        wv(webviewHide(id));
        shown.delete(id);
      }
    }
    if (dragging || overlay) return; // panes re-show when the drag/overlay ends
    let needRelayout = false;
    for (const p of panes) {
      const id = p.tab.id;
      if (openedWebviews.has(id)) {
        if (!shown.has(id)) {
          wv(webviewShow(id)); // only on transition into view
          shown.add(id);
        }
        needRelayout = true; // throttled bounds for resize/seam follow
      } else if (!openingWebviews.has(id)) {
        openingWebviews.add(id);
        setHibernated(id, false); // (re)opening = waking from sleep (#45)
        lastActive.set(id, Date.now());
        const r = p.rect;
        webviewOpen(id, p.tab.url, r)
          .then(async () => {
            if (!openingWebviews.has(id)) {
              shown.delete(id);
              await webviewHibernate(id);
              return;
            }
            await webviewSetBounds(id, r);
            openingWebviews.delete(id);
            openedWebviews.add(id);
            if (overlayActive() || uiDragging()) {
              shown.delete(id);
              await webviewHide(id);
              return;
            }
            shown.add(id);
            await webviewShow(id);
          })
          .catch((e) => {
            openingWebviews.delete(id);
            openedWebviews.delete(id);
            shown.delete(id);
            console.error("[flux webview] open failed:", e);
          });
      }
    }
    if (needRelayout) scheduleRelayout();
  });

  // ── Web-panel webviews (#48) ───────────────────────────────────────────────
  // Manage the open panel webview(s) — positioned in their own grid pane beside
  // the content card. Switching panels closes the old one; hidden mid-drag.
  const opened: { top: number | null; bottom: number | null } = { top: null, bottom: null };
  // Reconcile one split slot's native webview against the panel it should show
  // and the rect it should occupy (null rect = keep alive but hidden).
  const syncSlot = (slot: "top" | "bottom", p: WebPanel | null, rect: Rect | null) => {
    const prev = opened[slot];
    if (prev != null && prev !== (p?.id ?? null)) {
      wv(panelClose(prev));
      opened[slot] = null;
    }
    if (!p) return;
    if (!rect) {
      wv(panelHide(p.id));
      return;
    }
    if (opened[slot] === p.id) {
      wv(panelSetBounds(p.id, rect));
      wv(panelShow(p.id));
    } else {
      opened[slot] = p.id;
      wv(panelOpen(p.id, p.url, rect).then(() => panelSetBounds(p.id, rect)));
    }
  };
  createEffect(() => {
    contentRect();
    relayoutTick(); // subscribe: forced re-tile (e.g. after fullscreen-video exit)
    panelWidth(); // subscribe: re-position on resize / divider drag
    panelSplitRatio(); // subscribe: re-tile both slots when the split moves
    const top = activePanel();
    const bottom = activePanelB();
    // Full-card overlays must sit above everything — including the web panel's
    // own native webview layer. focusMode hides the panel *column* (not a page
    // overlay); panel drags hide only the panel webviews (split-seam drags
    // don't touch this pane).
    const hidden = panelDragging() || focusMode() || overlayActive();
    syncSlot("top", top, hidden ? null : panelViewRect());
    syncSlot("bottom", bottom, hidden ? null : panelViewRectB());
  });

  return {
    openedWebviews,
    openingWebviews,
    lastActive,
    wv,
    forgetWebview,
    scheduleRelayout,
    forceRelayout,
    paneLayout,
  };
}
