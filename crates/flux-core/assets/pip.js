// pip.js — Picture-in-picture for videos (BACKLOG #37).
//
// requestPictureInPicture() requires transient user activation *in the page*, so
// the chrome can't trigger it via eval (that has no activation → NotAllowedError).
// This injected script provides the trigger from real in-page gestures: a hover
// button on videos and an Alt+P hotkey. It also best-effort auto-PiPs a playing
// video when the tab is backgrounded (works when the engine reports the
// visibility change and recent activation is still live). Document-start.
//
// WebView2 (Chromium) supports the PiP API; older WebKitGTK may not — there it
// no-ops gracefully.
(function () {
  if (!("pictureInPictureEnabled" in document) || !document.pictureInPictureEnabled) return;

  var currentVid = null;
  var hideTimer = 0;
  var btn = null;

  // Is this a real, watchable video (vs. a muted autoplay-loop *thumbnail* like
  // the hover previews on YouTube/social grids)? Offering PiP on those popped a
  // preview clip the site then tore down. Require a sane size, and either real
  // audio or a non-trivial duration; reject the muted-loop thumbnail signature.
  function eligible(v) {
    if (!v || v.disablePictureInPicture || v.videoWidth < 180) return false;
    var r = v.getBoundingClientRect();
    if (r.width < 200 || r.height < 140) return false;
    if (v.loop && v.muted) return false; // classic hover-thumbnail
    var hasAudio = !!v.webkitAudioDecodedByteCount || v.mozHasAudio || (v.audioTracks && v.audioTracks.length > 0);
    if (hasAudio) return true;
    return isFinite(v.duration) && v.duration >= 20;
  }

  // The best video to PiP: the largest eligible one that's playing, else the
  // largest eligible one.
  function pickVideo() {
    var vids = Array.prototype.slice.call(document.querySelectorAll("video")).filter(eligible);
    if (!vids.length) return null;
    var playing = vids.filter(function (v) { return !v.paused && !v.ended; });
    var pool = playing.length ? playing : vids;
    pool.sort(function (a, b) { return b.videoWidth * b.videoHeight - a.videoWidth * a.videoHeight; });
    return pool[0];
  }

  function toggle(v) {
    try {
      if (document.pictureInPictureElement) {
        document.exitPictureInPicture();
      } else if (v && v.requestPictureInPicture && !v.disablePictureInPicture) {
        v.requestPictureInPicture().catch(function () {});
      }
    } catch (e) {
      /* NotAllowedError when there's no user activation — ignore. */
    }
  }

  // Alt+P → toggle PiP for the best video. This keydown IS a user activation.
  window.addEventListener(
    "keydown",
    function (e) {
      if (e.altKey && !e.ctrlKey && !e.metaKey && (e.key === "p" || e.key === "P")) {
        var v = document.pictureInPictureElement || pickVideo();
        if (v) { e.preventDefault(); toggle(v); }
      }
    },
    true,
  );

  // A small "PiP" button shown while hovering a sizable video.
  function ensureBtn() {
    if (btn) return btn;
    btn = document.createElement("button");
    btn.textContent = "⧉ PiP";
    btn.setAttribute("aria-label", "Picture-in-picture");
    var s = btn.style;
    s.position = "fixed";
    s.zIndex = "2147483646";
    s.padding = "5px 9px";
    s.borderRadius = "7px";
    s.border = "none";
    s.background = "rgba(18,18,26,0.8)";
    s.color = "#fff";
    s.font = "600 12px system-ui, sans-serif";
    s.cursor = "pointer";
    s.display = "none";
    s.boxShadow = "0 2px 10px rgba(0,0,0,0.5)";
    btn.addEventListener("mouseover", function () { clearTimeout(hideTimer); });
    btn.addEventListener("click", function (e) {
      e.preventDefault();
      e.stopPropagation();
      toggle(currentVid || pickVideo());
      hide();
    });
    document.documentElement.appendChild(btn);
    return btn;
  }
  function hide() { if (btn) btn.style.display = "none"; }
  function showFor(v) {
    if (!eligible(v)) return; // no PiP button on thumbnails / hover previews
    var r = v.getBoundingClientRect();
    currentVid = v;
    var b = ensureBtn();
    b.style.display = "block";
    b.style.top = r.top + 10 + "px";
    b.style.left = Math.max(8, r.right - 72) + "px";
    clearTimeout(hideTimer);
  }
  document.addEventListener(
    "mouseover",
    function (e) { if (e.target && e.target.tagName === "VIDEO") showFor(e.target); },
    true,
  );
  document.addEventListener(
    "mouseout",
    function (e) {
      if (e.target && e.target.tagName === "VIDEO") {
        clearTimeout(hideTimer);
        hideTimer = setTimeout(hide, 1200);
      }
    },
    true,
  );

  // Best-effort auto-PiP when the tab is backgrounded.
  document.addEventListener("visibilitychange", function () {
    if (document.hidden && !document.pictureInPictureElement) {
      var v = pickVideo();
      if (v && !v.paused) toggle(v);
    }
  });
})();
