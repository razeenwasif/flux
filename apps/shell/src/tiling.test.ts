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
import type { TabMeta } from "./ipc";

const CARD = { x: 260, y: 44, width: 900, height: 800 };

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

// The store's tab signal, settable from the tests.
const live = vi.hoisted(() => ({ setActiveTab: (_t: TabMeta | null) => {} }));
vi.mock("./store", async () => {
  const { createSignal } = await import("solid-js");
  const [activeTab, setActiveTab] = createSignal<TabMeta | null>(null);
  live.setActiveTab = (t) => void setActiveTab(t);
  const none = () => null;
  return {
    activePanel: none,
    activePanelB: none,
    activePanelId: none,
    activePanelIdB: none,
    activeTab,
    panelDragging: () => false,
    panelSplitRatio: () => 0.5,
    panelWidth: () => 380,
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
      id === "flux-web-area" ? { getBoundingClientRect: () => ({ ...CARD }) } : null,
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
