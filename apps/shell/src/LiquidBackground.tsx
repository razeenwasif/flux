/**
 * Particle-liquid start-page backdrop (BACKLOG #77) — a fine spray of tiny
 * metallic droplets endlessly swirling/splashing, replacing the SMIL wave.
 *
 * Rendered as GL points (one small shaded sprite per particle), so cost scales
 * with particle *count*, not screen pixels — that's what lets there be thousands
 * of tiny balls cheaply (the per-pixel metaball approach can't). A curl-noise
 * flow field advects them (divergence-free → fluid-like swirls) so they're always
 * moving; each sprite is shaded as a little metallic bead that picks up the
 * velvet page background (no fixed hue).
 *
 * Performance (Flux's low-RAM wedge): one buffer upload + one draw call per frame,
 * no library; the start page only mounts while it's the active tab (leaving it
 * tears the GL context down → GPU 0); pauses on blur / hidden / `body.resizing`;
 * ~40 fps; `prefers-reduced-motion` → static; any WebGL2 failure → `onFallback`
 * so the page shows the cheap SVG wave.
 */
import { createEffect, onCleanup, onMount, type Component } from "solid-js";

const N = 5000;        // lots of small droplets
const POINT_PX = 16.0;  // sprite size (device px) — small balls, not pinprick dots
const SPEED = 0.07;    // flow speed
const GRAVITY = 0.015; // gentle downward bias

const VERT = `#version 300 es
in vec2 a_pos;            // 0..1 (x across width, y up)
uniform float u_size;
out float v_y;
void main(){
  gl_Position = vec4(a_pos * 2.0 - 1.0, 0.0, 1.0);
  gl_PointSize = u_size;
  v_y = a_pos.y;
}`;

const FRAG = `#version 300 es
precision highp float;
in float v_y;
out vec4 outColor;
void main(){
  vec2 pc = gl_PointCoord * 2.0 - 1.0;   // -1..1 within the sprite
  float r2 = dot(pc, pc);
  if(r2 > 1.0) discard;
  // Fake sphere normal → a little 3D metallic bead.
  vec3 n = vec3(pc, sqrt(max(0.0, 1.0 - r2)));
  vec3 L = normalize(vec3(0.4, 0.6, 0.7));
  float diff = clamp(dot(n, L), 0.0, 1.0);
  float spec = pow(clamp(n.z, 0.0, 1.0), 36.0);          // top-lit chrome highlight
  // Metallic "environment" = the velvet page bg, lighter toward the top.
  vec3 env = mix(vec3(0.10, 0.09, 0.20), vec3(0.34, 0.32, 0.56), n.y * 0.5 + 0.5);
  vec3 col = env * (0.5 + 0.6 * diff) + spec * vec3(0.95);
  float edge = smoothstep(1.0, 0.55, r2);                 // soft round edge
  float fade = mix(0.30, 0.95, 1.0 - smoothstep(0.0, 0.98, v_y)); // lighter near the top
  float a = edge * fade;
  outColor = vec4(col * a, a);                            // premultiplied
}`;

const LiquidBackground: Component<{ active: () => boolean; onFallback?: () => void }> = (props) => {
  let canvas: HTMLCanvasElement | undefined;

  onMount(() => {
    const c = canvas;
    if (!c) return;
    const gl = c.getContext("webgl2", {
      alpha: true, premultipliedAlpha: true, antialias: false, depth: false, powerPreference: "low-power",
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
    gl.attachShader(prog, vs); gl.attachShader(prog, fs); gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) { props.onFallback?.(); return; }
    gl.useProgram(prog);

    // Particle positions (uv space) — uploaded each frame.
    const pos = new Float32Array(N * 2);
    for (let i = 0; i < N; i++) { pos[i * 2] = Math.random(); pos[i * 2 + 1] = Math.random(); }
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, pos, gl.DYNAMIC_DRAW);
    const loc = gl.getAttribLocation(prog, "a_pos");
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    const uSize = gl.getUniformLocation(prog, "u_size");
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.clearColor(0, 0, 0, 0);

    let dpr = 1, aspect = 1;
    const resize = () => {
      dpr = Math.min(window.devicePixelRatio || 1, 1.5);
      const nw = Math.max(1, Math.round(c.clientWidth * dpr));
      const nh = Math.max(1, Math.round(c.clientHeight * dpr));
      if (nw !== c.width || nh !== c.height) {
        c.width = nw; c.height = nh; aspect = nw / nh;
        gl.viewport(0, 0, nw, nh);
        gl.uniform1f(uSize, POINT_PX * dpr);
      }
    };
    const ro = new ResizeObserver(resize);
    ro.observe(c);
    resize();

    // Divergence-free curl-noise flow (incompressible → fluid swirls). x is
    // aspect-scaled so the swirls stay round on wide screens.
    const sim = (dt: number, t: number) => {
      dt = Math.min(dt, 0.05);
      for (let i = 0; i < N; i++) {
        const x = pos[i * 2]! * aspect;
        const y = pos[i * 2 + 1]!;
        // psi = sin(3x+.5t)cos(3y-.4t) + .5 sin(5y+.3t)cos(5x-.6t)
        // v = (dpsi/dy, -dpsi/dx)
        const vx = Math.sin(3 * x + 0.5 * t) * (-3 * Math.sin(3 * y - 0.4 * t))
                 + 0.5 * (5 * Math.cos(5 * y + 0.3 * t)) * Math.cos(5 * x - 0.6 * t);
        const vy = -(3 * Math.cos(3 * x + 0.5 * t) * Math.cos(3 * y - 0.4 * t)
                 + 0.5 * Math.sin(5 * y + 0.3 * t) * (-5 * Math.sin(5 * x - 0.6 * t)));
        let nx = pos[i * 2]! + (vx * SPEED / aspect) * dt;
        let ny = pos[i * 2 + 1]! + (vy * SPEED - GRAVITY) * dt;
        // wrap so the spray recirculates forever
        nx = nx < 0 ? nx + 1 : nx > 1 ? nx - 1 : nx;
        ny = ny < 0 ? ny + 1 : ny > 1 ? ny - 1 : ny;
        pos[i * 2] = nx; pos[i * 2 + 1] = ny;
      }
    };

    const draw = () => {
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, pos);
      gl.drawArrays(gl.POINTS, 0, N);
    };

    const FPS = 40, MIN_DT = 1 / FPS;
    let raf = 0, running = false, last = 0, acc = 0, t = 0;
    const frame = (now: number) => {
      raf = requestAnimationFrame(frame);
      const d = last ? (now - last) / 1000 : 0;
      last = now;
      acc += d;
      if (acc < MIN_DT) return;
      t += acc;
      sim(acc, t);
      acc = 0;
      draw();
    };
    const start = () => { if (running) return; running = true; last = 0; raf = requestAnimationFrame(frame); };
    const stop = () => { running = false; cancelAnimationFrame(raf); };

    const shouldRun = () =>
      props.active() && !reduce && !document.hidden && document.hasFocus() &&
      !document.body.classList.contains("resizing");
    const sync = () => { if (shouldRun()) start(); else { stop(); draw(); } };

    createEffect(() => { props.active(); sync(); });
    const onState = () => sync();
    document.addEventListener("visibilitychange", onState);
    window.addEventListener("focus", onState);
    window.addEventListener("blur", onState);
    const bodyMo = new MutationObserver(onState);
    bodyMo.observe(document.body, { attributes: true, attributeFilter: ["class"] });
    draw();
    sync();

    onCleanup(() => {
      stop();
      ro.disconnect();
      bodyMo.disconnect();
      document.removeEventListener("visibilitychange", onState);
      window.removeEventListener("focus", onState);
      window.removeEventListener("blur", onState);
      gl.deleteBuffer(buf); gl.deleteProgram(prog); gl.deleteShader(vs); gl.deleteShader(fs);
      gl.getExtension("WEBGL_lose_context")?.loseContext();
    });
  });

  return <canvas ref={canvas} class="start-liquid" aria-hidden="true" />;
};

export default LiquidBackground;
