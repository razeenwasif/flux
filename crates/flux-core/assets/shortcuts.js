// Flux app keyboard shortcuts, forwarded from a focused tab webview (BACKLOG
// #18). A native child webview captures the keyboard when focused, so the
// chrome's own keydown listener never sees these chords — this script detects
// Flux's chord set, swallows the event so the page can't act on it, and hands
// the action to the chrome via the `chrome_key` fluxtab command. The chord set
// MUST mirror apps/shell/src/shortcuts.ts (keyToAction). Primary modifier is
// Ctrl (Windows/Linux); Cmd (meta) is accepted too for macOS.
(function () {
  var inv = window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.invoke;
  if (!inv) return;

  function actionFor(e) {
    var mod = e.ctrlKey || e.metaKey;
    var k = (e.key || "").toLowerCase();
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
      if (k >= "1" && k <= "9") return "tab-" + k;
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

  window.addEventListener(
    "keydown",
    function (e) {
      var a = actionFor(e);
      if (!a) return;
      e.preventDefault();
      e.stopPropagation();
      try {
        inv("plugin:fluxtab|chrome_key", { action: a });
      } catch (_) {}
    },
    true,
  );
})();
