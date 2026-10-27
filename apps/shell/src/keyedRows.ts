import { unwrap, type SetStoreFunction } from "solid-js/store";

/**
 * Replace a store's rows with `next`, keyed by `pid`: what `reconcile(next,
 * { key: "pid" })` does, by hand, because importing reconcile puts it in the
 * boot bundle that solid-js/store lives in (+0.6 KB gzip). A row whose pid is
 * still there keeps its object — so a `<For>` keeps its DOM row and moves it —
 * and only its changed fields update; new pids come in as given.
 */
export function mergeByPid<T extends { pid: number }>(
  rows: T[],
  set: SetStoreFunction<T[]>,
  next: T[],
): void {
  const raw = unwrap(rows);
  const at = new Map(raw.map((r, i) => [r.pid, i]));
  const merged = next.map((n) => {
    const i = at.get(n.pid);
    if (i === undefined) return n;
    const old = raw[i]!;
    for (const k of Object.keys(n) as (keyof T & string)[]) {
      if (old[k] !== n[k]) (set as (i: number, k: string, v: unknown) => void)(i, k, n[k]);
    }
    return old;
  });
  set(merged);
}
