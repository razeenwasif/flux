/**
 * Waking an unloaded tab (tabsleep.rs): the snapshot it left is painted in its
 * page card while the page reloads hidden, until WebKit reports the page's
 * first real paint, so there's no blank frame between the two.
 */
import { createSignal } from "solid-js";

import { onTabPainted } from "./ipc";

const [shots, setShots] = createSignal<ReadonlyMap<number, string>>(new Map());

/** The snapshot to paint for tab `id` while it wakes, if any. */
export const wakeShot = (id: number | null | undefined): string | undefined =>
  id == null ? undefined : shots().get(id);

export function setWakeShot(id: number, url: string | null): void {
  if (url) listen();
  setShots((m) => {
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
