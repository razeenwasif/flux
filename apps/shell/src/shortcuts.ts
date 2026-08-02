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
  | "reopen-tab"
  | "close-tab"
  | "next-tab"
  | "prev-tab"
  | "toggle-terminal"
  | "toggle-agent"
  | "toggle-sidebar"
  | "focus-address"
  | "palette"
  | "spotlight"
  | "find"
  | "reload"
  | "back"
  | "forward"
  | "save-to-omni"
  | "shell-history"
  | "zoom-in"
  | "zoom-out"
  | "zoom-reset"
  | "focus-mode"
  | "bookmark-page"
  | "devtools"
  | `tab-${number}`;

export function keyToAction(e: KeyboardEvent): ShortcutAction | null {
  const mod = e.ctrlKey || e.metaKey;
  const k = (e.key || "").toLowerCase();

  if (mod && !e.altKey && !e.shiftKey) {
    switch (k) {
      case "t":
        return "new-tab";
      case "w":
        return "close-tab";
      case "b":
        return "toggle-sidebar";
      case "l":
        return "focus-address";
      case "k":
        return "palette";
      case "f":
        return "find";
      case "r":
        return "reload";
      case "`":
        return "toggle-terminal";
      case "=":
      case "+":
        return "zoom-in"; // Ctrl+= / numpad +
      case "-":
        return "zoom-out";
      case "0":
        return "zoom-reset";
      case "d":
        return "bookmark-page"; // Ctrl/Cmd+D → bookmark this page
    }
    if (e.key === "Tab") return "next-tab";
    if (k >= "1" && k <= "9") return `tab-${Number(k)}`;
  }
  if (mod && e.shiftKey && !e.altKey) {
    if (k === "t") return "reopen-tab"; // Ctrl/Cmd+Shift+T → reopen last closed tab
    // (terminal: Ctrl+` toggles the column; sidebar has a Terminal-tab button)
    if (k === "a") return "toggle-agent";
    if (k === "o") return "save-to-omni"; // Ctrl/Cmd+Shift+O → save page to Omni
    if (k === "r") return "shell-history"; // Ctrl/Cmd+Shift+R → semantic shell-history search
    // Ctrl/Cmd+Shift+K → search spotlight. Deliberately next to the palette's
    // Ctrl+K: same gesture, outward instead of inward (web vs. what you have).
    if (k === "k") return "spotlight";
    if (k === "+") return "zoom-in"; // Ctrl+Shift+= (a.k.a. Ctrl++)
    if (k === "f") return "focus-mode"; // Ctrl+Shift+F → focus/compact mode
    if (e.key === "Tab") return "prev-tab";
  }
  if (e.altKey && !mod) {
    if (e.key === "ArrowLeft") return "back";
    if (e.key === "ArrowRight") return "forward";
  }
  if (e.key === "F5") return "reload";
  if (e.key === "F12") return "devtools";
  return null;
}
