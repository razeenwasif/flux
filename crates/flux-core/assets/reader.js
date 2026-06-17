// Reader-mode extractor (BACKLOG #41). Injected on demand (not at init). Finds
// the article root by a text-density heuristic, walks it into a flat list of
// STRUCTURED blocks (heading / paragraph / list-item / quote / pre / image), and
// posts them to the chrome via the `reader_publish` fluxtab command. The chrome
// renders blocks as text + <img src> (never raw HTML), so there's no XSS surface.
(function () {
  var inv = window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.invoke;
  if (!inv) return;

  function density(el) {
    var t = (el.innerText || "").trim().length;
    var tags = el.getElementsByTagName("*").length + 1;
    return t / tags;
  }

  // Prefer semantic roots; otherwise the densest big text block.
  var root = document.querySelector("article") || document.querySelector("main") || document.querySelector("[role=main]");
  if (!root) {
    var best = null, bestScore = 0;
    var cands = document.querySelectorAll("article, main, section, div");
    for (var i = 0; i < cands.length; i++) {
      var el = cands[i];
      var len = (el.innerText || "").trim().length;
      if (len < 200) continue;
      var s = len * density(el);
      if (s > bestScore) { bestScore = s; best = el; }
    }
    root = best || document.body;
  }

  var blocks = [];
  var nodes = root.querySelectorAll("h1, h2, h3, h4, p, li, blockquote, pre, figcaption, img");
  for (var i = 0; i < nodes.length && blocks.length < 600; i++) {
    var n = nodes[i];
    if (n.closest("nav, footer, aside, form")) continue; // chrome/boilerplate
    var tag = n.tagName.toLowerCase();
    if (tag === "img") {
      var src = n.currentSrc || n.src;
      if (src && n.naturalWidth > 150) blocks.push({ kind: "img", src: src, text: n.alt || "" });
      continue;
    }
    var txt = (n.innerText || "").replace(/\s+/g, " ").trim();
    if (txt.length < 2) continue;
    var kind = tag.charAt(0) === "h" ? "h"
      : tag === "li" ? "li"
      : tag === "blockquote" ? "quote"
      : tag === "pre" ? "pre"
      : tag === "figcaption" ? "cap"
      : "p";
    var level = tag.charAt(0) === "h" ? parseInt(tag.charAt(1), 10) || 2 : 0;
    blocks.push({ kind: kind, text: txt, level: level });
  }

  var h1 = document.querySelector("h1");
  var title = document.title || (h1 && h1.innerText) || "Reader";
  try {
    inv("plugin:fluxtab|reader_publish", { tabId: window.__FLUX_TAB_ID__, title: title, blocks: blocks });
  } catch (e) {}
})();
