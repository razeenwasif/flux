// panel-badge.js — unread/notification badge for a web panel (BACKLOG #48).
//
// Pinned panels (Discord, Proton Mail, LinkedIn, Gmail, WhatsApp…) put their
// unread count in the page TITLE — "(3) Discord", "Inbox (5) — Proton Mail",
// "(2) Messaging | LinkedIn". We watch the title, parse the count, and report it
// to the chrome over the fluxtab bridge; the chrome paints a red bubble on the
// panel's rail icon. Title-only — no content capture, so panels stay history-
// clean. Heuristic by design: catches the (N) convention, not in-DOM-only badges.
(function () {
  var inv = window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.invoke;
  if (!inv) return;

  var last = -1;
  function parseCount() {
    // First (N) or [N] in the title. Capped so a stray year/long number can't
    // produce an absurd badge.
    var m = /[(\[](\d{1,4})[)\]]/.exec(document.title || "");
    return m ? (parseInt(m[1], 10) || 0) : 0;
  }
  function report() {
    var n = parseCount();
    if (n === last) return;
    last = n;
    try { inv("plugin:fluxtab|panel_badge", { count: n }); } catch (e) {}
  }
  function watch() {
    report();
    if (!window.MutationObserver) return;
    // The title's text, and <head> itself: SPAs sometimes swap the whole
    // <title> node, which the head sees go by. No timer, so a quiet panel
    // costs nothing.
    var titleObs = new MutationObserver(report);
    var titleEl = null;
    function follow() {
      var el = document.querySelector("title");
      if (el === titleEl) return;
      titleEl = el;
      titleObs.disconnect();
      if (el) titleObs.observe(el, { childList: true, characterData: true, subtree: true });
      report();
    }
    follow();
    var head = document.head || document.documentElement;
    if (head) new MutationObserver(follow).observe(head, { childList: true });
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", watch);
  } else {
    watch();
  }
})();
