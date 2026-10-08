/**
 * Reconcile a freshly fetched list with the one already shown: every row whose
 * content didn't change keeps its previous object.
 *
 * The footer popovers (Boosts, Macros) poll, and every IPC call hands back brand
 * new objects. `<For>` keys rows by identity, so each poll disposed and recreated
 * every row — including the one being edited, whose input lost focus and caret
 * (or its typed text) mid-edit. Changed, added and removed rows still update.
 */
export function keepSame<T extends { id: number }>(prev: T[], next: T[]): T[] {
  const old = new Map(prev.map((p) => [p.id, p]));
  return next.map((n) => {
    const p = old.get(n.id);
    // Both sides are serde output for the same type, so their key order matches.
    return p && JSON.stringify(p) === JSON.stringify(n) ? p : n;
  });
}
