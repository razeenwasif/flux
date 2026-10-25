/**
 * The focus session as the shell sees it (focus.rs): what covers which tab.
 * App.tsx loads it just after the first paint and it answers through
 * focusGate.ts, which the page layout (tiling.ts) reads to keep a covered
 * tab's webview off the screen; the cover itself (FocusCover.tsx) loads on use.
 *
 * A tab is covered while a session runs and either its page is on a blocked
 * site, or a navigation to one was stopped there (Rust says which).
 */
import { createEffect, createRoot, createSignal } from "solid-js";

import { focusStatus, onFocusBlocked, onFocusChanged } from "./focusIpc";
import { installFocusGate, type Cover } from "./focusGate";
import { webviewSuspend, type FocusStatus, type TabMeta } from "./ipc";

const [status, setStatus] = createSignal<FocusStatus | null>(null);
const [fetchedAt, setFetchedAt] = createSignal(0);
const [now, setNow] = createSignal(Date.now());
/** Navigations the session stopped, by tab: where each tab was going. */
const [stopped, setStopped] = createSignal<Record<number, { url: string; site: string }>>({});

export const focus = status;

/** "18:02", "1:05:00". */
export const clockOf = (ms: number): string => {
  const s = Math.ceil(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
};

export const refreshFocus = async (): Promise<void> => {
  try {
    setStatus(await focusStatus());
    setFetchedAt(Date.now());
    setNow(Date.now());
  } catch {
    /* no session to show */
  }
};

/** Milliseconds left in the session, counting down between fetches. */
export const focusLeft = (): number => {
  const s = status();
  if (!s?.running) return 0;
  return s.paused ? s.remaining_ms : Math.max(0, s.remaining_ms - (now() - fetchedAt()));
};

const siteOf = (url: string): string => {
  try {
    return new URL(url).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return "";
  }
};

/** The blocked site `url` is on, while the session stops it. */
const blockedSite = (url: string): string => {
  const s = status();
  if (!s?.running || s.paused || focusLeft() === 0) return "";
  const host = siteOf(url);
  const site = host ? s.blocks.find((b) => host === b || host.endsWith(`.${b}`)) : undefined;
  if (!site) return "";
  const pass = s.allowed.find((a) => a.site === site);
  return pass && pass.until_ms > now() ? "" : site;
};

export type { Cover };

/** What covers `tab`, if anything. */
export const focusCover = (tab: TabMeta | null | undefined): Cover | null => {
  if (!tab || tab.kind !== "browser") return null;
  const st = stopped()[tab.id];
  if (st && blockedSite(st.url)) return { ...st, stopped: true };
  const site = blockedSite(tab.url);
  return site ? { site, url: tab.url, stopped: false } : null;
};

export const forgetStopped = (tab: number): void => {
  setStopped((s) => {
    const next = { ...s };
    delete next[tab];
    return next;
  });
};

/** Start following the session. `tabs` and `live` (which tabs have a
 *  webview) come from App: a page on a blocked site goes quiet under its cover
 *  (suspended, as tab sleep does) and wakes when it's shown again. */
export function startFocusWatch(tabs: () => TabMeta[], live: (id: number) => boolean): void {
  const quieted = new Set<number>();
  createRoot(() =>
    createEffect(() => {
      for (const t of tabs()) {
        const c = focusCover(t);
        if (c && !c.stopped && live(t.id)) {
          if (!quieted.has(t.id)) {
            quieted.add(t.id);
            void webviewSuspend(t.id).catch(() => {});
          }
        } else quieted.delete(t.id);
      }
    }),
  );
  installFocusGate({
    cover: focusCover,
    line: () => {
      const s = status();
      return !s?.running ? "" : s.paused ? "Focus · paused" : `Focus · ${clockOf(focusLeft())} left`;
    },
  });
  void refreshFocus();
  void onFocusChanged(() => void refreshFocus());
  void onFocusBlocked((tab, url, site) => {
    setStopped((s) => ({ ...s, [tab]: { url, site } }));
    void refreshFocus();
  });
  // The countdown and "Allow 5 minutes" run out on their own: tick while a
  // session runs, and ask again now and then.
  let n = 0;
  setInterval(() => {
    if (!status()?.running) return;
    setNow(Date.now());
    if (++n % 30 === 0 || focusLeft() === 0) void refreshFocus();
  }, 1000);
}
