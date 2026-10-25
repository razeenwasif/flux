// Flux's keyboard shortcuts, forwarded from a focused page (#18). A native
// child webview captures the keyboard when focused, so the chrome's own keydown
// listener never sees these chords — this script looks each keydown up in the
// chord map (keys.rs: stamped as __FLUX_KEYS__, kept current through
// __fluxKeysSet), swallows a match so the page can't act on it, and hands the
// command to the chrome via the `chrome_key` fluxtab command. chordOf MUST
// read keys the way apps/shell/src/keys.ts does.
(function () {
  var inv = window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.invoke;
  if (!inv) return;
  var map = window.__FLUX_KEYS__ || {};
  window.__fluxKeysSet = function (m) {
    map = m || {};
  };

  // Punctuation by key position: Shift and Option change what e.key says.
  var CODES = {
    Backquote: "`",
    Minus: "-",
    Equal: "=",
    BracketLeft: "[",
    BracketRight: "]",
    Backslash: "\\",
    Semicolon: ";",
    Quote: "'",
    Comma: ",",
    Period: ".",
    Slash: "/",
    Space: "Space",
    NumpadAdd: "=",
    NumpadSubtract: "-",
  };

  function chordOf(e) {
    var c = e.code || "";
    var k = e.key || "";
    if (/^Key[A-Z]$/.test(c) && !/^[a-z]$/i.test(k)) k = c.slice(3);
    else if (/^Digit[0-9]$/.test(c)) k = c.slice(5);
    else if (CODES[c]) k = CODES[c];
    else if (k.length === 1) k = k.toUpperCase();
    if (!k || k === "Shift" || k === "Control" || k === "Alt" || k === "Meta" || k === "Dead") return null;
    return (
      (e.ctrlKey ? "Ctrl+" : "") +
      (e.altKey ? "Alt+" : "") +
      (e.shiftKey ? "Shift+" : "") +
      (e.metaKey ? "Cmd+" : "") +
      k
    );
  }

  // A key that types or moves the caret is the text field's, unless ⌘ or Ctrl
  // is down; Back and Forward leave text fields alone too (⌘[ is outdent there).
  function typing(e, action) {
    var t = (e.composedPath && e.composedPath()[0]) || e.target;
    var field = t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName || ""));
    if (!field) return false;
    if (action === "back" || action === "forward") return true;
    return !e.ctrlKey && !e.metaKey && !/^F\d+$/.test(e.key || "");
  }

  window.addEventListener(
    "keydown",
    function (e) {
      if (e.isComposing) return;
      var chord = chordOf(e);
      var a = chord && map[chord];
      if (!a || typing(e, a)) return;
      e.preventDefault();
      e.stopPropagation();
      try {
        inv("plugin:fluxtab|chrome_key", { action: a });
      } catch (_) {}
    },
    true,
  );
})();
