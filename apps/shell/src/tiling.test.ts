/**
 * Tiling's webview_open, as the restored tab's page now goes through it.
 *
 * Rust opens that page during setup (boot.rs), before the shell exists, so the
 * shell's open of it is a no-op that resolves at once, and the bounds and show
 * after it are what place the page. Those must never show a page that stopped
 * being a pane while the open was in flight: a launch URL taking focus at boot
 * is the usual case.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TabMeta, WebPanel } from "./ipc";

const CARD = { x: 260, y: 44, width: 900, height: 800 };
// The web panel's box; its webview sits below the toolbar, right of the gutter.
let panelBox = { x: 1180, y: 44, width: 380, height: 800 };

const ipc = vi.hoisted(() => {
  const ok = () => vi.fn((..._args: unknown[]) => Promise.resolve());
  return {
    isStartUrl: (url: string) => url.startsWith("flux://"),
    panelClose: ok(),
    panelHide: ok(),
    panelOpen: ok(),
    panelSetBounds: ok(),
    panelShow: ok(),
    webviewHibernate: ok(),
    webviewHide: ok(),
    webviewOpen: ok(),
    webviewSetBounds: ok(),
    webviewShow: ok(),
    tabSnapshot: vi.fn((_id: number) => Promise.resolve<string | null>(null)),
    painted: (_id: number) => {},
    onTabPainted: vi.fn((cb: (id: number) => void) => {
      ipc.painted = cb;
      return Promise.resolve(() => {});
    }),
  };
});
vi.mock("./ipc", () => ipc);
const asleep = vi.hoisted(() => new Set<number>());

// The store's tab, panel and panel-width signals, settable from the tests.
const live = vi.hoisted(() => ({
  setActiveTab: (_t: TabMeta | null) => {},
  setPanel: (_p: WebPanel | null) => {},
  setPanelWidth: (_w: number) => {},
}));
vi.mock("./store", async () => {
  const { createSignal } = await import("solid-js");
  const [activeTab, setActiveTab] = createSignal<TabMeta | null>(null);
  const [panel, setPanel] = createSignal<WebPanel | null>(null);
  const [panelWidth, setPanelWidth] = createSignal(380);
  live.setActiveTab = (t) => void setActiveTab(t);
  live.setPanel = (p) => void setPanel(p);
  live.setPanelWidth = (w) => void setPanelWidth(w);
  const none = () => null;
  return {
    activePanel: panel,
    activePanelB: none,
    activePanelId: () => panel()?.id ?? null,
    activePanelIdB: none,
    activeTab,
    panelDragging: () => false,
    panelSplitRatio: () => 0.5,
    panelWidth,
    readerOpen: () => false,
    isHibernated: (id: number) => asleep.has(id),
    setHibernated: (id: number, on: boolean) => void (on ? asleep.add(id) : asleep.delete(id)),
    tileGroup: none,
    tilePanes: none,
  };
});

import { createRoot, createSignal } from "solid-js";
import { createWebviewTiling, type WebviewTiling } from "./tiling";

const tab = (id: number, url: string): TabMeta => ({
  id,
  kind: "browser",
  url,
  title: "",
  pinned: false,
  cluster: null,
  group: null,
  folder: null,
  custom_title: null,
  workspace: 1,
  private: false,
  container: 0,
});

let frames: FrameRequestCallback[] = [];
const settle = async () => {
  for (let i = 0; i < 5; i++) {
    await new Promise((r) => setTimeout(r, 0));
    const due = frames;
    frames = [];
    for (const f of due) f(0);
  }
};

let dispose: (() => void) | undefined;
const boot = (overlay: () => boolean): WebviewTiling => {
  let tiling!: WebviewTiling;
  createRoot((d) => {
    dispose = d;
    tiling = createWebviewTiling({ overlayActive: overlay, uiDragging: () => false, focusMode: () => false });
  });
  return tiling;
};

beforeEach(() => {
  vi.clearAllMocks();
  frames = [];
  const listeners = { addEventListener: () => {}, removeEventListener: () => {} };
  vi.stubGlobal("document", {
    ...listeners,
    getElementById: (id: string) =>
      id === "flux-web-area"
        ? { getBoundingClientRect: () => ({ ...CARD }) }
        : id === "flux-panel-area"
          ? { getBoundingClientRect: () => ({ ...panelBox }) }
          : null,
  });
  vi.stubGlobal("window", listeners);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  vi.stubGlobal("requestAnimationFrame", (f: FrameRequestCallback) => frames.push(f));
});

afterEach(() => {
  dispose?.();
  live.setActiveTab(null);
  live.setPanel(null);
  live.setPanelWidth(380);
  panelBox = { x: 1180, y: 44, width: 380, height: 800 };
  asleep.clear();
  vi.unstubAllGlobals();
});

describe("waking an unloaded tab", () => {
  it("keeps the page hidden behind its snapshot until it has drawn", async () => {
    asleep.add(9);
    ipc.tabSnapshot.mockResolvedValueOnce("data:image/jpeg;base64,AAAA");
    boot(() => false);
    live.setActiveTab(tab(9, "https://example.com/"));
    await settle();
    expect(ipc.tabSnapshot).toHaveBeenCalledWith(9);
    expect(ipc.webviewOpen).toHaveBeenCalledWith(9, "https://example.com/", CARD);
    expect(ipc.webviewShow).not.toHaveBeenCalled();
    ipc.painted(9);
    await settle();
    expect(ipc.webviewShow).toHaveBeenCalledWith(9);
    expect(asleep.has(9)).toBe(false);
  });

  it("opens and shows at once when there's no snapshot", async () => {
    asleep.add(9);
    boot(() => false);
    live.setActiveTab(tab(9, "https://example.com/"));
    await settle();
    expect(ipc.webviewShow).toHaveBeenCalledWith(9);
  });
});

describe("the restored tab's open", () => {
  it("places the page with the usual bounds and show", async () => {
    boot(() => false);
    live.setActiveTab(tab(7, "https://example.com/"));
    await settle();
    // For a page Rust already opened, this webview_open is a no-op in Rust:
    // the bounds and show after it are what place the page.
    expect(ipc.webviewOpen).toHaveBeenCalledTimes(1);
    expect(ipc.webviewOpen).toHaveBeenCalledWith(7, "https://example.com/", CARD);
    expect(ipc.webviewSetBounds).toHaveBeenCalledWith(7, CARD);
    expect(ipc.webviewShow).toHaveBeenCalledWith(7);
    expect(ipc.webviewHide).not.toHaveBeenCalled();
  });

  it("leaves the page hidden under an overlay that opened meanwhile", async () => {
    const [overlay, setOverlay] = createSignal(false);
    let release!: () => void;
    ipc.webviewOpen.mockImplementationOnce(() => new Promise<void>((r) => (release = r)));
    boot(overlay);
    live.setActiveTab(tab(7, "https://example.com/"));
    setOverlay(true);
    release();
    await settle();
    expect(ipc.webviewShow).not.toHaveBeenCalled();
    expect(ipc.webviewHide).toHaveBeenCalledWith(7);
    // It comes back as a pane once the overlay closes.
    setOverlay(false);
    await settle();
    expect(ipc.webviewShow).toHaveBeenCalledWith(7);
  });

  it("does not show a page that stopped being a pane meanwhile", async () => {
    let release!: () => void;
    ipc.webviewOpen.mockImplementationOnce(() => new Promise<void>((r) => (release = r)));
    boot(() => false);
    live.setActiveTab(tab(7, "https://example.com/"));
    expect(ipc.webviewOpen).toHaveBeenCalledTimes(1);
    live.setActiveTab(tab(8, "flux://start"));
    release();
    await settle();
    expect(ipc.webviewShow).not.toHaveBeenCalled();
    expect(ipc.webviewHide).toHaveBeenCalledWith(7);
  });
});

describe("a web panel's webview", () => {
  const panel: WebPanel = { id: 3, url: "https://example.org/", title: "" };
  const view = (box: typeof panelBox) => ({
    x: box.x + 14,
    y: box.y + 34,
    width: box.width - 14,
    height: box.height - 34,
  });

  it("is opened once and then left alone while nothing about it changes", async () => {
    boot(() => false);
    live.setPanel(panel);
    await settle();
    expect(ipc.panelOpen).toHaveBeenCalledWith(3, "https://example.org/", view(panelBox));
    // A column sliding open re-runs the effect every frame (here: the width
    // signal), with the panel's own box where it was.
    for (const w of [381, 382, 383]) live.setPanelWidth(w);
    await settle();
    expect(ipc.panelSetBounds).toHaveBeenCalledTimes(1); // the one after the open
    expect(ipc.panelShow).not.toHaveBeenCalled();
  });

  it("is moved only when its box moves, and shown and hidden only on a change", async () => {
    const [overlay, setOverlay] = createSignal(false);
    boot(overlay);
    live.setPanel(panel);
    await settle();
    vi.clearAllMocks();

    panelBox = { ...panelBox, x: 1100, width: 460 };
    live.setPanelWidth(460);
    await settle();
    expect(ipc.panelSetBounds).toHaveBeenCalledTimes(1);
    expect(ipc.panelSetBounds).toHaveBeenCalledWith(3, view(panelBox));
    expect(ipc.panelShow).not.toHaveBeenCalled();

    setOverlay(true);
    live.setPanelWidth(461);
    await settle();
    expect(ipc.panelHide).toHaveBeenCalledTimes(1);

    setOverlay(false);
    await settle();
    expect(ipc.panelShow).toHaveBeenCalledTimes(1);
    expect(ipc.panelSetBounds).toHaveBeenCalledTimes(1); // same box as before it hid
  });

  it("gets its bounds again after a forced relayout", async () => {
    const tiling = boot(() => false);
    live.setPanel(panel);
    await settle();
    vi.clearAllMocks();
    tiling.forceRelayout();
    await settle();
    expect(ipc.panelSetBounds).toHaveBeenCalledWith(3, view(panelBox));
    expect(ipc.panelShow).not.toHaveBeenCalled();
  });
});
