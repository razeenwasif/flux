// Force-dark for all sites (BACKLOG #40). A CSS "smart invert": invert the whole
// page to flip light→dark, then RE-invert media (images, video, iframes, canvas,
// background-image elements) so photos look normal. It's pure CSS injected into
// the page, so it's engine-agnostic — works on WebView2 (Windows) and WebKitGTK
// (Linux) alike, and on every site whether or not it supports prefers-color-scheme.
//
// Toggled live by `__fluxDark(on)` (the chrome evals this on every open tab when
// you flip the Settings switch) and applied at document_start for new tabs via
// the `window.__FLUX_DARK__` flag the init script stamps.
(function () {
  var STYLE_ID = "flux-darkmode";
  var CSS =
    "html{background-color:#0e0e10!important}" +
    "html{filter:invert(1) hue-rotate(180deg)!important}" +
    // Re-invert media so it isn't color-flipped.
    "img,video,picture,canvas,iframe,embed,object,svg image," +
    'twitter-widget,[style*="background-image"]{' +
    "filter:invert(1) hue-rotate(180deg)!important}";

  window.__fluxDark = function (on) {
    try {
      var d = document;
      var s = d.getElementById(STYLE_ID);
      if (on) {
        if (!s) {
          s = d.createElement("style");
          s.id = STYLE_ID;
        }
        s.textContent = CSS;
        var host = d.head || d.documentElement;
        if (host && !s.parentNode) host.appendChild(s);
      } else if (s && s.parentNode) {
        s.parentNode.removeChild(s);
      }
    } catch (e) {}
  };

  // Apply the boot-time state stamped by the webview init script.
  if (window.__FLUX_DARK__) window.__fluxDark(true);
})();
