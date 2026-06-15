/**
 * App keyboard chord → action mapping (BACKLOG #18). Used by the chrome's own
 * keydown listener (App.tsx). The SAME chord set is mirrored, in plain JS, in
 * crates/flux-core/assets/shortcuts.js — which is injected into tab webviews so
 * a focused page forwards these chords back to the chrome. Keep the two in sync.
 *
 * Primary modifier is Ctrl (Windows/Linux focus); Cmd (meta) is accepted too so
 * the bindings also work on macOS. We deliberately avoid Ctrl+A (select-all) and
 * Ctrl+S (save-page): agent toggle is Ctrl+Shift+A and sidebar toggle is Ctrl+B.
 */
export type ShortcutAction =
  | "new-tab"
  | "new-terminal"
  | "close-tab"
  | "next-tab"
  | "prev-tab"
  | "toggle-terminal"
  | "toggle-agent"
  | "toggle-sidebar"
  | "focus-address"
  | "reload"
  | "back"
  | "forward"
  | `tab-${number}`;

export function keyToAction(e: KeyboardEvent): ShortcutAction | null {
  const mod = e.ctrlKey || e.metaKey;
  const k = (e.key || "").toLowerCase();

  if (mod && !e.altKey && !e.shiftKey) {
    switch (k) {
      case "t": return "new-tab";
      case "w": return "close-tab";
      case "b": return "toggle-sidebar";
      case "l": return "focus-address";
      case "r": return "reload";
      case "`": return "toggle-terminal";
    }
    if (e.key === "Tab") return "next-tab";
    if (k >= "1" && k <= "9") return `tab-${Number(k)}`;
  }
  if (mod && e.shiftKey && !e.altKey) {
    if (k === "t") return "new-terminal";
    if (k === "a") return "toggle-agent";
    if (e.key === "Tab") return "prev-tab";
  }
  if (e.altKey && !mod) {
    if (e.key === "ArrowLeft") return "back";
    if (e.key === "ArrowRight") return "forward";
  }
  if (e.key === "F5") return "reload";
  return null;
}
