/**
 * Particle-liquid start-page backdrop (BACKLOG #77) — a flowing metaball "liquid"
 * with fake-3D shading + grain, replacing the SMIL wave.
 *
 * Performance is the whole point (Flux's low-RAM wedge): it's a SINGLE WebGL2
 * fragment shader — one fullscreen triangle, one draw call, no Three.js, ~3 KB —
 * and it's gated hard:
 *   • the start page only mounts while it's the active tab, so leaving it tears
 *     the GL context down entirely (GPU → 0);
 *   • while mounted it pauses on window blur, tab/document hidden, and window/pane
 *     resize (`body.resizing`), painting one static frame instead of looping;
 *   • render DPR is capped to 1× and the loop is throttled to ~40 fps (liquid is
 *     soft — extra resolution/frames aren't visible);
 *   • `prefers-reduced-motion` → one static frame, no animation;
 *   • any WebGL2 / shader-compile failure calls `onFallback` so the page shows the
 *     cheap SVG wave instead — it can never leave the page blank.
 */
import { createEffect, onCleanup, onMount, type Component } from "solid-js";

const VERT = `#version 300 es
in vec2 p;
void main(){ gl_Position = vec4(p, 0.0, 1.0); }`;

const FRAG = `#version 300 es
precision highp float;
out vec4 outColor;
uniform vec2 u_res;
uniform float u_t;

float hash(vec2 x){ return fract(sin(dot(x, vec2(127.1, 311.7))) * 43758.5453); }

// Flux palette: velvet base → violet → teal → magenta.
vec3 palette(float t){
  vec3 velvet  = vec3(0.07, 0.05, 0.16);
  vec3 violet  = vec3(0.48, 0.38, 1.00);
  vec3 teal    = vec3(0.18, 0.95, 1.00);
  vec3 magenta = vec3(1.00, 0.42, 0.82);
  t = clamp(t, 0.0, 1.0);
  vec3 c = mix(velvet, violet, smoothstep(0.0, 0.45, t));
  c = mix(c, teal, smoothstep(0.40, 0.72, t));
  c = mix(c, magenta, smoothstep(0.72, 1.0, t));
  return c;
}

// Sum of metaball fields + its gradient (for fake-3D shading), aspect-corrected.
float field(vec2 uv, float aspect, out vec2 grad){
  float f = 0.0; grad = vec2(0.0);
  for(int i = 0; i < 7; i++){
    float fi = float(i);
    float sp = 0.18 + 0.10 * fract(fi * 0.41);
    vec2 c = vec2(
      0.5  + 0.40 * sin(u_t * sp + fi * 1.7),
      0.42 + 0.44 * cos(u_t * sp * 0.85 + fi * 2.1)
    );
    float r = 0.15 + 0.05 * sin(u_t * 0.4 + fi);
    vec2 d = uv - c; d.x *= aspect;
    float dd = dot(d, d) + 1e-4;
    f += r * r / dd;
    grad += (-2.0 * r * r / (dd * dd)) * vec2(d.x * aspect, d.y);
  }
  return f;
}

void main(){
  vec2 uv = gl_FragCoord.xy / u_res;       // 0..1, origin bottom-left
  float aspect = u_res.x / u_res.y;
  vec2 grad;
  float f = field(uv, aspect, grad);

  float m = smoothstep(0.85, 1.40, f);     // liquid surface + soft edge

  // Fake 3D: shade by the field gradient.
  vec3 n = normalize(vec3(grad * 0.4, 1.0));
  vec3 L = normalize(vec3(0.35, 0.65, 0.80));
  float diff = clamp(dot(n, L), 0.0, 1.0);
  float spec = pow(clamp(dot(reflect(-L, n), vec3(0.0, 0.0, 1.0)), 0.0, 1.0), 28.0);

  float t = clamp(f * 0.32 + uv.y * 0.22, 0.0, 1.0);
  vec3 col = palette(t) * (0.55 + 0.6 * diff) + spec * 0.55;

  // Pool toward the bottom (where the wave was); fade out going up.
  float bottom = 1.0 - smoothstep(0.0, 0.95, uv.y);
  float alpha = m * mix(0.22, 0.95, bottom);

  col += (hash(gl_FragCoord.xy + u_t) - 0.5) * 0.03; // particle grain
  alpha = clamp(alpha, 0.0, 1.0) * 0.9;
  outColor = vec4(col * alpha, alpha);     // premultiplied
}`;

const LiquidBackground: Component<{ active: () => boolean; onFallback?: () => void }> = (props) => {
  let canvas: HTMLCanvasElement | undefined;

  onMount(() => {
    const c = canvas;
    if (!c) return;
    const gl = c.getContext("webgl2", {
      alpha: true,
      premultipliedAlpha: true,
      antialias: false,
      depth: false,
      powerPreference: "low-power",
    });
    if (!gl) { props.onFallback?.(); return; }

    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

    const compile = (type: number, src: string): WebGLShader | null => {
      const s = gl.createShader(type);
      if (!s) return null;
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
        console.warn("[liquid] shader:", gl.getShaderInfoLog(s));
        return null;
      }
      return s;
    };
    const vs = compile(gl.VERTEX_SHADER, VERT);
    const fs = compile(gl.FRAGMENT_SHADER, FRAG);
    const prog = gl.createProgram();
    if (!vs || !fs || !prog) { props.onFallback?.(); return; }
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      console.warn("[liquid] link:", gl.getProgramInfoLog(prog));
      props.onFallback?.();
      return;
    }
    gl.useProgram(prog);

    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, "p");
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    const uRes = gl.getUniformLocation(prog, "u_res");
    const uT = gl.getUniformLocation(prog, "u_t");
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.clearColor(0, 0, 0, 0);

    const DPR_CAP = 1.0;
    let w = 0, h = 0;
    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, DPR_CAP);
      const nw = Math.max(1, Math.round(c.clientWidth * dpr));
      const nh = Math.max(1, Math.round(c.clientHeight * dpr));
      if (nw !== w || nh !== h) {
        w = nw; h = nh; c.width = nw; c.height = nh;
        gl.viewport(0, 0, nw, nh);
      }
    };
    const ro = new ResizeObserver(resize);
    ro.observe(c);
    resize();

    let time = 0;
    const draw = () => {
      gl.uniform2f(uRes, w, h);
      gl.uniform1f(uT, time);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    };

    const FPS = 40;
    const MIN_DT = 1 / FPS;
    let raf = 0, running = false, last = 0, acc = 0;
    const frame = (now: number) => {
      raf = requestAnimationFrame(frame);
      const dt = last ? (now - last) / 1000 : 0;
      last = now;
      acc += dt;
      if (acc < MIN_DT) return; // throttle to ~40 fps
      time += acc;
      acc = 0;
      draw();
    };
    const start = () => { if (running) return; running = true; last = 0; raf = requestAnimationFrame(frame); };
    const stop = () => { running = false; cancelAnimationFrame(raf); };

    const shouldRun = () =>
      props.active() && !reduce && !document.hidden && document.hasFocus() &&
      !document.body.classList.contains("resizing");

    const sync = () => {
      if (shouldRun()) start();
      else { stop(); draw(); } // one static frame while paused — never blank
    };

    // React to active() changes + browser/window state.
    createEffect(() => { props.active(); sync(); });
    const onState = () => sync();
    document.addEventListener("visibilitychange", onState);
    window.addEventListener("focus", onState);
    window.addEventListener("blur", onState);
    // body.resizing toggles aren't events — watch the class.
    const bodyMo = new MutationObserver(onState);
    bodyMo.observe(document.body, { attributes: true, attributeFilter: ["class"] });
    sync();

    onCleanup(() => {
      stop();
      ro.disconnect();
      bodyMo.disconnect();
      document.removeEventListener("visibilitychange", onState);
      window.removeEventListener("focus", onState);
      window.removeEventListener("blur", onState);
      gl.deleteBuffer(buf);
      gl.deleteProgram(prog);
      gl.deleteShader(vs);
      gl.deleteShader(fs);
      gl.getExtension("WEBGL_lose_context")?.loseContext(); // free the GPU context now
    });
  });

  return <canvas ref={canvas} class="start-liquid" aria-hidden="true" />;
};

export default LiquidBackground;
