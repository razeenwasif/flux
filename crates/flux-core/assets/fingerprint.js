/*flux-fp*/
// Fingerprint defences (BACKLOG #60, fingerprint.rs): what a page reads back
// from a canvas, WebGL or Web Audio carries a little noise, the way Brave
// "farbles" it. The noise comes from a key for this session and this site: one
// site sees the same values all session, so it keeps working, but two sites
// can't match them up, and the next session is a stranger. Nothing changes on
// screen; only what's read back.
//
// Runs in every frame before the page's own scripts, and leaves no trace a page
// could look for. CONFIG below is filled in by Rust: this session's secret,
// whether it's on, and the hosts where Shields is off (no noise there). The site
// is the top page's, from ancestorOrigins in a frame.
(function () {
  "use strict";
  const CONFIG = __FP_CONFIG__;
  const SECRET = CONFIG.secret;

  const topHost = () => {
    try {
      const anc = location.ancestorOrigins;
      const top = anc && anc.length ? anc[anc.length - 1] : location.origin;
      return new URL(top).hostname;
    } catch (_) {
      return location.hostname;
    }
  };
  // The site, roughly its registrable domain: a.b.example.com and example.com
  // share a key. Not the public suffix list; a two-label suffix (co.uk) gives a
  // site per subdomain, which only makes the noise vary more.
  const site = (h) => h.split(".").slice(-2).join(".");

  // FNV-1a, then mulberry32 for a stream of noise.
  const hash = (s) => {
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
    return h >>> 0;
  };
  if (!CONFIG.on || CONFIG.off.indexOf(topHost()) !== -1) return;
  const KEY = hash(SECRET + "|" + site(topHost()));
  const stream = (salt) => {
    let a = (KEY ^ salt) >>> 0;
    return () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  };

  // Patched functions read as native ones.
  const ours = new WeakMap();
  const nativeToString = Function.prototype.toString;
  const patch = (proto, name, make) => {
    const orig = proto && proto[name];
    if (typeof orig !== "function") return;
    const fn = make(orig);
    ours.set(fn, orig);
    Object.defineProperty(proto, name, { value: fn, writable: true, configurable: true, enumerable: false });
  };
  patch(Function.prototype, "toString", (orig) =>
    function toString() {
      return orig.call(ours.has(this) ? ours.get(this) : this);
    },
  );
  void nativeToString;

  // ── Canvas: flip the low bit of one channel in about one pixel in 50, at
  // places fixed by the key and the image's size, so the same drawing reads
  // back the same all session.
  const farble = (data, width, height) => {
    if (!data || !width || !height) return;
    const next = stream(hash(width + "x" + height));
    const pixels = width * height;
    const count = Math.max(1, Math.floor(pixels / 50));
    for (let i = 0; i < count; i++) {
      const p = Math.floor(next() * pixels) * 4;
      const c = Math.floor(next() * 3);
      if (data[p + 3] !== 0) data[p + c] ^= 1; // leave transparent pixels transparent
    }
  };
  const C2D = window.CanvasRenderingContext2D && CanvasRenderingContext2D.prototype;
  const origGetImageData = C2D && C2D.getImageData;
  patch(C2D, "getImageData", (orig) =>
    function getImageData(sx, sy, sw, sh) {
      const img = orig.apply(this, arguments);
      try {
        farble(img.data, img.width, img.height);
      } catch (_) {}
      return img;
    },
  );
  // toDataURL/toBlob read the canvas as a whole: farble a copy, never the
  // canvas on screen.
  const noisyCopy = (canvas) => {
    const w = canvas.width;
    const h = canvas.height;
    if (!w || !h || !origGetImageData) return null;
    const copy = document.createElement("canvas");
    copy.width = w;
    copy.height = h;
    const ctx = copy.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(canvas, 0, 0);
    const img = origGetImageData.call(ctx, 0, 0, w, h);
    farble(img.data, w, h);
    ctx.putImageData(img, 0, 0);
    return copy;
  };
  const HC = window.HTMLCanvasElement && HTMLCanvasElement.prototype;
  patch(HC, "toDataURL", (orig) =>
    function toDataURL() {
      let copy = null;
      try {
        copy = noisyCopy(this);
      } catch (_) {}
      return orig.apply(copy || this, arguments);
    },
  );
  patch(HC, "toBlob", (orig) =>
    function toBlob() {
      let copy = null;
      try {
        copy = noisyCopy(this);
      } catch (_) {}
      return orig.apply(copy || this, arguments);
    },
  );
  const OC2D = window.OffscreenCanvasRenderingContext2D && OffscreenCanvasRenderingContext2D.prototype;
  patch(OC2D, "getImageData", (orig) =>
    function getImageData() {
      const img = orig.apply(this, arguments);
      try {
        farble(img.data, img.width, img.height);
      } catch (_) {}
      return img;
    },
  );

  // ── WebGL: what readPixels hands back, the same way.
  for (const Ctx of [window.WebGLRenderingContext, window.WebGL2RenderingContext]) {
    patch(Ctx && Ctx.prototype, "readPixels", (orig) =>
      function readPixels(x, y, width, height, format, type, pixels) {
        const out = orig.apply(this, arguments);
        try {
          if (pixels && pixels.BYTES_PER_ELEMENT === 1) farble(pixels, width, height);
        } catch (_) {}
        return out;
      },
    );
  }

  // ── Web Audio: a rendered buffer, and an analyser's output, nudged by a few
  // parts in ten million. Once per buffer and channel, so reading twice agrees.
  const noised = new WeakMap();
  const nudge = (arr, salt) => {
    const next = stream(salt);
    for (let i = 0; i < arr.length; i += 1 + Math.floor(next() * 7)) arr[i] += (next() - 0.5) * 2e-7;
  };
  const AB = window.AudioBuffer && AudioBuffer.prototype;
  patch(AB, "getChannelData", (orig) =>
    function getChannelData(channel) {
      const data = orig.apply(this, arguments);
      try {
        let done = noised.get(this);
        if (!done) noised.set(this, (done = new Set()));
        if (!done.has(channel)) {
          done.add(channel);
          nudge(data, hash("audio" + channel + "|" + this.length));
        }
      } catch (_) {}
      return data;
    },
  );
  patch(AB, "copyFromChannel", (orig) =>
    function copyFromChannel(destination, channel) {
      // Through getChannelData, so both agree.
      try {
        this.getChannelData(channel);
      } catch (_) {}
      return orig.apply(this, arguments);
    },
  );
  const AN = window.AnalyserNode && AnalyserNode.prototype;
  patch(AN, "getFloatFrequencyData", (orig) =>
    function getFloatFrequencyData(array) {
      const out = orig.apply(this, arguments);
      try {
        nudge(array, hash("analyser" + array.length));
      } catch (_) {}
      return out;
    },
  );
})();
