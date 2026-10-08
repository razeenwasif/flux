/**
 * Behaviour of the scripts flux-core injects into web pages
 * (`crates/flux-core/assets/*.js`). They run in a real engine with no test
 * harness of their own, and their failures are silent: a snapshot that never
 * arrives, a key the page never sees. Each one is an IIFE over a handful of
 * browser globals, so it runs here against small stubs of exactly those.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import captureJs from "../../../crates/flux-core/assets/capture.js?raw";

/** Run an injected script with `globals` standing in for the browser's. Timers
 *  are not stubbed here: they resolve to the (fakeable) real ones. */
const runPageScript = (src: string, globals: Record<string, unknown>) =>
  new Function(...Object.keys(globals), src)(...Object.values(globals));

afterEach(() => vi.useRealTimers());

describe("capture.js", () => {
  const loadCapture = () => {
    const sent: string[] = [];
    const listeners = new Map<string, () => void>();
    let observed: (() => void) | undefined;
    runPageScript(captureJs, {
      window: {
        __TAURI_INTERNALS__: {
          invoke: (cmd: string) => {
            sent.push(cmd);
            return Promise.resolve();
          },
        },
      },
      document: {
        readyState: "complete",
        documentElement: { outerHTML: "<html></html>" },
        body: { innerText: "text" },
        title: "title",
      },
      location: { href: "https://example.com/" },
      addEventListener: (type: string, cb: () => void) => listeners.set(type, cb),
      MutationObserver: class {
        constructor(cb: () => void) {
          observed = cb;
        }
        observe() {}
      },
    });
    return { sent, load: () => listeners.get("load")!(), mutate: () => observed!() };
  };

  it("still publishes a page that never stops mutating", () => {
    // A JS animation or ticker writing `style` every 100 ms kept restarting a
    // pure trailing debounce, so not even the load snapshot was ever sent.
    vi.useFakeTimers();
    const page = loadCapture();
    page.load();
    for (let t = 0; t < 5000; t += 100) {
      page.mutate();
      vi.advanceTimersByTime(100);
    }
    expect(page.sent.length).toBeGreaterThanOrEqual(2);
    expect(page.sent.length).toBeLessThanOrEqual(3);
    expect(page.sent.every((c) => c === "plugin:fluxtab|dom_publish")).toBe(true);
  });

  it("coalesces a burst into one snapshot", () => {
    vi.useFakeTimers();
    const page = loadCapture();
    page.load();
    for (let i = 0; i < 10; i++) {
      page.mutate();
      vi.advanceTimersByTime(50);
    }
    vi.advanceTimersByTime(5000);
    expect(page.sent).toEqual(["plugin:fluxtab|dom_publish"]);
  });
});
