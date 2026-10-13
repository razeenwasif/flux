/**
 * Reconcile a freshly fetched list with the one already shown: every row whose
 * content didn't change keeps its previous object.
 *
 * The footer popovers (Boosts, Macros) poll, and every IPC call hands back brand
 * new objects. `<For>` keys rows by identity, so each poll disposed and recreated
 * every row — including the one being edited, whose input lost focus and caret
 * (or its typed text) mid-edit. Changed, added and removed rows still update.
 *
 * When nothing changed at all, the previous list itself comes back, so a signal
 * set to the result doesn't notify: the store's tab, group and panel lists are
 * refetched after every structural change, and an unchanged refetch then costs
 * no re-render and re-runs no effect.
 */
export function keepSame<T extends { id: number }>(prev: T[], next: T[]): T[] {
  const old = new Map(prev.map((p) => [p.id, p]));
  const out = next.map((n) => {
    const p = old.get(n.id);
    // Both sides are serde output for the same type, so their key order matches.
    return p && JSON.stringify(p) === JSON.stringify(n) ? p : n;
  });
  return out.length === prev.length && out.every((row, i) => row === prev[i]) ? prev : out;
}
