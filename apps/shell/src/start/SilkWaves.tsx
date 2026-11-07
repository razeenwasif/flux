/**
 * Opal in motion: Liquid Silk's home wallpaper bent by slow waves, drawn with
 * one WebGL fragment shader over the wallpaper image.
 *
 * The still wallpaper is `body::before` (liquid-silk.css). This puts a canvas
 * under it and, once the canvas has drawn, sets `data-silk-waves` on <html>, so
 * `body::before` keeps only its scrim and the moving silk shows through. The
 * canvas lives on <body>, not in the page, so nothing above it can trap a fixed
 * layer, and the glass cards blur it like they blur the still image.
 *
 * Two layers of sine waves move the image's coordinates, the second warped by
 * the first so it reads as cloth rather than ripples, and the slope of the folds
 * lightens or shades the silk a little. The image is cropped as `body::before`
 * crops it, and the waves ease in from nothing, so the hand-over from the still
 * wallpaper is seamless.
 *
 * Cost: one draw a frame, held to 60 fps, at up to 1.5× the window's size (the
 * silk is soft). It only runs while the home page shows, Flux is focused and
 * visible, no web page is open beside it (`data-reading`), the window isn't being
 * resized, and Reduce Motion is off; otherwise it holds its last frame or, while
 * reading, hands back to the still wallpaper. Leaving home tears the context down.
 */
import { onCleanup, onMount, type Component } from "solid-js";

const VS = `attribute vec2 a; varying vec2 v;
void main(){ v = a * 0.5 + 0.5; gl_Position = vec4(a, 0.0, 1.0); }`;

const FS = `precision highp float;
uniform sampler2D img; uniform vec2 res; uniform vec2 isz;
uniform float t; uniform float amp; uniform float light;
varying vec2 v;
vec2 cover(vec2 uv){
  float ra = res.x / res.y, ri = isz.x / isz.y;
  vec2 s = ra > ri ? vec2(1.0, ri / ra) : vec2(ra / ri, 1.0);
  return 0.5 + (uv - 0.5) * s;
}
void main(){
  vec2 p = v * vec2(res.x / res.y, 1.0);
  vec2 w = vec2(
    sin(p.y * 2.1 + t * 0.31) + 0.6 * sin((p.x + p.y) * 3.0 - t * 0.23),
    cos(p.x * 1.8 - t * 0.27) + 0.6 * cos((p.x - p.y) * 2.5 + t * 0.19));
  vec2 q = p + 0.22 * w;
  vec2 w2 = vec2(sin(q.y * 3.2 - t * 0.21 + 1.3), cos(q.x * 2.8 + t * 0.17 + 0.4));
  vec2 d = (w * 0.6 + w2 * 0.4) * amp;
  vec2 uv = cover(0.5 + (v - 0.5) * ${(1 / 1.06).toFixed(4)} + d);
  vec3 c = texture2D(img, vec2(uv.x, 1.0 - uv.y)).rgb;
  c *= 1.0 + 0.045 * (w2.x * 0.55 + w.y * 0.45) * light;
  gl_FragColor = vec4(c, 1.0);
}`;

/** Tuned with the user on a live render: 3× the base pace, 125% depth. */
const SPEED = 3;
const AMP = 0.016 * 1.25;
/** Seconds the waves take to grow from the still image. */
const EASE_IN = 2;
const MIN_FRAME_MS = 1000 / 60 - 2;
const ATTR = "data-silk-waves";

const SilkWaves: Component = () => {
  onMount(() => {
    const root = document.documentElement;
    const canvas = document.createElement("canvas");
    canvas.setAttribute("aria-hidden", "true");
    Object.assign(canvas.style, {
      position: "fixed",
      inset: "0",
      width: "100%",
      height: "100%",
      zIndex: "-2",
      pointerEvents: "none",
    });
    const gl = canvas.getContext("webgl", { alpha: false, antialias: false, powerPreference: "low-power" });
    if (!gl) return;

    const shader = (type: number, src: string) => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, src);
      gl.compileShader(s);
      return s;
    };
    const prog = gl.createProgram()!;
    gl.attachShader(prog, shader(gl.VERTEX_SHADER, VS));
    gl.attachShader(prog, shader(gl.FRAGMENT_SHADER, FS));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      console.warn("[silk-waves]", gl.getProgramInfoLog(prog));
      return;
    }
    gl.useProgram(prog);
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const aLoc = gl.getAttribLocation(prog, "a");
    gl.enableVertexAttribArray(aLoc);
    gl.vertexAttribPointer(aLoc, 2, gl.FLOAT, false, 0, 0);
    const u = (n: string) => gl.getUniformLocation(prog, n);
    const uRes = u("res"),
      uIsz = u("isz"),
      uT = u("t"),
      uAmp = u("amp"),
      uLight = u("light");

    let ready = false,
      shown = false,
      running = false,
      raf = 0,
      last = 0,
      drawn = 0,
      t = 0,
      grown = 0;

    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
      canvas.width = Math.max(1, Math.round(innerWidth * dpr));
      canvas.height = Math.max(1, Math.round(innerHeight * dpr));
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.uniform2f(uRes, canvas.width, canvas.height);
      if (ready && !running) render();
    };
    const render = () => {
      // Ease in (smoothstep) so the first frame matches the still wallpaper.
      const k = Math.min(grown / EASE_IN, 1);
      const ease = k * k * (3 - 2 * k);
      gl.uniform1f(uT, t);
      gl.uniform1f(uAmp, AMP * ease);
      gl.uniform1f(uLight, ease);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    };

    const reduce = matchMedia("(prefers-reduced-motion: reduce)");
    const reading = () => root.hasAttribute("data-reading");
    const shouldRun = () =>
      ready &&
      !reduce.matches &&
      !reading() &&
      !document.hidden &&
      document.hasFocus() &&
      !document.body.classList.contains("resizing");

    const frame = (now: number) => {
      raf = requestAnimationFrame(frame);
      // Held to 60 fps: a 120 Hz display draws every other refresh.
      if (drawn && now - drawn < MIN_FRAME_MS) return;
      const dt = last ? Math.min((now - last) / 1000, 0.1) : 0;
      last = now;
      drawn = now;
      t += dt * SPEED;
      grown += dt;
      render();
    };
    const sync = () => {
      // The silk shows unless a web page is open beside home or Reduce Motion
      // is on; then the still wallpaper (and its reading dim) takes over.
      const show = ready && !reading() && !reduce.matches;
      if (show !== shown) {
        shown = show;
        if (show) {
          grown = 0;
          render();
          root.setAttribute(ATTR, "");
        } else root.removeAttribute(ATTR);
      }
      if (shouldRun() && !running) {
        running = true;
        last = drawn = 0;
        raf = requestAnimationFrame(frame);
      } else if (!shouldRun() && running) {
        running = false;
        cancelAnimationFrame(raf);
      }
    };

    const img = new Image();
    img.onload = () => {
      const tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, img);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.uniform2f(uIsz, img.naturalWidth, img.naturalHeight);
      ready = true;
      sync();
    };
    img.src = "/wallpapers/opal.webp";

    document.body.prepend(canvas);
    resize();
    addEventListener("resize", resize);
    document.addEventListener("visibilitychange", sync);
    addEventListener("focus", sync);
    addEventListener("blur", sync);
    reduce.addEventListener("change", sync);
    const mo = new MutationObserver(sync);
    mo.observe(root, { attributes: true, attributeFilter: ["data-reading"] });
    mo.observe(document.body, { attributes: true, attributeFilter: ["class"] });
    // A lost context (GPU reset, too many contexts) hands back to the still image.
    canvas.addEventListener("webglcontextlost", () => {
      ready = false;
      sync();
    });

    onCleanup(() => {
      cancelAnimationFrame(raf);
      root.removeAttribute(ATTR);
      removeEventListener("resize", resize);
      document.removeEventListener("visibilitychange", sync);
      removeEventListener("focus", sync);
      removeEventListener("blur", sync);
      reduce.removeEventListener("change", sync);
      mo.disconnect();
      img.onload = null;
      gl.getExtension("WEBGL_lose_context")?.loseContext();
      canvas.remove();
    });
  });
  return null;
};

export default SilkWaves;
