/**
 * Behaviour of the scripts flux-core injects into web pages
 * (`crates/flux-core/assets/*.js`). They run in a real engine with no test
 * harness of their own, and their failures are silent: a snapshot that never
 * arrives, a key the page never sees. Each one is an IIFE over a handful of
 * browser globals, so it runs here against small stubs of exactly those.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import captureJs from "../../../crates/flux-core/assets/capture.js?raw";
import consentJs from "../../../crates/flux-core/assets/consent.js?raw";
import navJs from "../../../crates/flux-core/assets/nav.js?raw";
import explainRs from "../../../crates/flux-core/src/sentinel/explain.rs?raw";

/** Run an injected script with `globals` standing in for the browser's. Timers
 *  are not stubbed here: they resolve to the (fakeable) real ones. */
const runPageScript = (src: string, globals: Record<string, unknown>) =>
  new Function(...Object.keys(globals), src)(...Object.values(globals));

afterEach(() => vi.useRealTimers());

describe("capture.js", () => {
  const loadCapture = () => {
    const sent: string[] = [];
    const args: unknown[] = [];
    const listeners = new Map<string, () => void>();
    let observed: (() => void) | undefined;
    const window: Record<string, unknown> = {
      __TAURI_INTERNALS__: {
        invoke: (cmd: string, a: unknown) => {
          sent.push(cmd);
          args.push(a);
          return Promise.resolve();
        },
      },
    };
    runPageScript(captureJs, {
      window,
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
    return {
      sent,
      args,
      flux: window.__FLUX__ as Record<string, (...a: unknown[]) => void>,
      load: () => listeners.get("load")!(),
      mutate: () => observed!(),
    };
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

  it("sends agent action outcomes through the fluxtab bridge", () => {
    // A raw postMessage with a made-up `cmd` matched no command, so a blocked
    // click or an extracted table never reached the chrome.
    const page = loadCapture();
    page.flux.report!("blocked_destructive", "delete");
    page.flux.deliver!("extract", "csv", "a,b");
    expect(page.sent).toEqual(["plugin:fluxtab|agent_report", "plugin:fluxtab|agent_report"]);
    expect(page.args).toEqual([
      { kind: "blocked_destructive", detail: "delete", format: "", payload: "" },
      { kind: "extract", detail: "", format: "csv", payload: "a,b" },
    ]);
  });
});

describe("consent.js", () => {
  // The click vocabulary exactly as Rust bakes it in (REJECT_TERMS).
  const start = explainRs.indexOf("pub const REJECT_TERMS");
  const terms = [...explainRs.slice(start, explainRs.indexOf("];", start)).matchAll(/"([^"]+)"/g)].map(
    (m) => m[1],
  );

  /** `banner`: inside a consent container; `dialog`: inside a dialog with this text. */
  type Control = { id: string; label: string; banner?: boolean; dialog?: string };
  const clickedOn = (controls: Control[]) => {
    const clicked: string[] = [];
    const els = controls.map((c) => ({
      getAttribute: (n: string) => (n === "aria-label" ? c.label : null),
      getBoundingClientRect: () => ({ width: 10, height: 10 }),
      closest: (sel: string) =>
        sel.includes("dialog") ? (c.dialog == null ? null : { innerText: c.dialog }) : c.banner ? {} : null,
      click: () => clicked.push(c.id),
    }));
    runPageScript(consentJs.replace("__FLUX_REJECT_TERMS__", JSON.stringify(terms)), {
      document: { querySelectorAll: () => els },
    });
    return clicked;
  };

  it("never clicks an unrelated control when the banner's wording is unknown", () => {
    expect(terms).toContain("decline");
    const page = [
      { id: "banner", label: "Manage options", banner: true },
      { id: "invite", label: "Decline" },
      { id: "headline", label: "Stocks decline as rates rise" },
      { id: "invite-dialog", label: "Decline", dialog: "Team sync, Thursday 10:00" },
    ];
    expect(clickedOn(page)).toEqual([]);
  });

  it("clicks the reject control the banner itself offers", () => {
    expect(clickedOn([{ id: "invite", label: "Decline" }, { id: "cmp", label: "Decline", banner: true }])).toEqual([
      "cmp",
    ]);
    expect(
      clickedOn([
        { id: "invite", label: "Decline" },
        { id: "cmp", label: "Decline", dialog: "We and our partners use cookies" },
      ]),
    ).toEqual(["cmp"]);
    expect(
      clickedOn([
        { id: "article", label: "Why you should reject all cookies today" },
        { id: "cmp", label: "Reject all and close", banner: true },
      ]),
    ).toEqual(["cmp"]);
  });

  it("still matches an exact multi-word phrase anywhere on the page", () => {
    expect(clickedOn([{ id: "unmarked-banner", label: "Reject all" }])).toEqual(["unmarked-banner"]);
  });
});

describe("nav.js", () => {
  const loadNav = (activeElement: unknown) => {
    const handlers = new Map<string, (e: unknown) => void>();
    const scrolled: number[] = [];
    runPageScript(navJs, {
      window: { __FLUX_NAV__: { hints: true, gestures: false } },
      document: { activeElement, querySelectorAll: () => [], body: { scrollHeight: 1000 } },
      addEventListener: (type: string, cb: (e: unknown) => void) => handlers.set(type, cb),
      innerHeight: 800,
      innerWidth: 1200,
      scrollBy: (_x: number, y: number) => scrolled.push(y),
      scrollTo: () => {},
    });
    /** Press `key` on the element `path[0]`; returns whether the page lost it. */
    const press = (key: string, path: unknown[]) => {
      let prevented = false;
      handlers.get("keydown")!({
        key,
        ctrlKey: false,
        metaKey: false,
        altKey: false,
        target: path[path.length - 1],
        composedPath: () => path,
        preventDefault: () => {
          prevented = true;
        },
      });
      return prevented;
    };
    return { press, scrolled };
  };

  it("leaves keys alone while typing in a shadow-DOM input", () => {
    // document.activeElement is the shadow *host*, not the focused <input>.
    const input = { tagName: "INPUT" };
    const host = { tagName: "SL-INPUT", shadowRoot: { activeElement: input } };
    const page = loadNav(host);
    expect(page.press("f", [input, host])).toBe(false);
    expect(page.press("j", [input, host])).toBe(false);
    expect(page.scrolled).toEqual([]);
  });

  it("still acts on keys when nothing editable has focus", () => {
    const body = { tagName: "BODY" };
    const page = loadNav(body);
    expect(page.press("f", [body])).toBe(true);
    page.press("j", [body]);
    expect(page.scrolled).toEqual([64]);
  });
});
