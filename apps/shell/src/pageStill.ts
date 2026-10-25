/**
 * A still of a page, painted in its card while the page itself is out of
 * sight, so the card never shows empty. Two cases: a tab waking from an
 * unload (tabsleep.rs), whose snapshot shows while the page reloads hidden
 * until WebKit reports its first real paint; and the launcher, which goes up
 * over a still of the page on screen.
 */
import { createSignal } from "solid-js";

import { onTabPainted } from "./ipc";

const [stills, setStills] = createSignal<ReadonlyMap<number, string>>(new Map());

/** The still to paint for tab `id`, if any. */
export const pageStill = (id: number | null | undefined): string | undefined =>
  id == null ? undefined : stills().get(id);

export function setPageStill(id: number, url: string | null): void {
  if (url) listen();
  setStills((m) => {
    if (!url && !m.has(id)) return m;
    const next = new Map(m);
    if (url) next.set(id, url);
    else next.delete(id);
    return next;
  });
}

const waiting = new Map<number, () => void>();
/** Painted before anyone waited (the page can beat the open's own follow-up). */
const early = new Set<number>();
let listening = false;
function listen(): void {
  if (listening) return;
  listening = true;
  void onTabPainted((id) => {
    const done = waiting.get(id);
    if (done) done();
    else early.add(id);
  });
}

/** Resolves when tab `id` has drawn, or after `ms` whatever happened. */
export function untilPainted(id: number, ms: number): Promise<void> {
  if (early.delete(id)) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      waiting.delete(id);
      resolve();
    };
    const timer = setTimeout(done, ms);
    waiting.set(id, done);
  });
}
