/**
 * Particle-flow start-page backdrop (BACKLOG #77) — a dense field of fine
 * monochrome particles advected by a curl-noise flow field, leaving fading trails
 * that bunch into flowing fingerprint/topographic ridges, with soft luminous
 * blobs glowing underneath. Replaces the SMIL wave.
 *
 * Pipeline (WebGL2, ping-pong framebuffers — the trails are the whole effect):
 *   1. FADE   — copy last frame's accumulation × ~0.95 into the current target
 *               (so particle paths decay into streaks → the contour look);
 *   2. DRAW   — additively splat ~8k tiny soft white points (curl-flow advected);
 *   3. COMP   — to screen: a velvet base + drifting glow blobs + the accumulation.
 *
 * Performance (Flux's low-RAM wedge): a handful of draw calls, no library; the
 * start page only mounts while it's the active tab (leaving it tears the GL
 * context down → GPU 0); pauses on blur / hidden / `body.resizing`; the field
 * renders at ~0.8× resolution (it's soft); ~40 fps; `prefers-reduced-motion` →
 * a static frame; any WebGL2 failure → `onFallback` so the page shows the wave.
 */
import { createEffect, onCleanup, onMount, type Component } from "solid-js";

const N = 5000;        // fine particles
const POINT_PX = 3.6;  // splat size in field pixels
const SPEED = 0.06;    // flow speed
const FADE = 0.95;     // trail persistence (higher = longer contour streaks)
const INTENSITY = 0.32;
const FIELD_SCALE = 0.8;

const QUAD_VS = `#version 300 es
layout(location = 0) in vec2 p;
out vec2 v_uv;
void main(){ v_uv = p * 0.5 + 0.5; gl_Position = vec4(p, 0.0, 1.0); }`;

const FADE_FS = `#version 300 es
precision highp float;
in vec2 v_uv; out vec4 o;
uniform sampler2D u_prev; uniform float u_fade;
void main(){ o = texture(u_prev, v_uv) * u_fade; }`;

const PART_VS = `#version 300 es
layout(location = 0) in vec2 a_pos;
uniform float u_size;
void main(){ gl_Position = vec4(a_pos * 2.0 - 1.0, 0.0, 1.0); gl_PointSize = u_size; }`;

const PART_FS = `#version 300 es
precision highp float;
out vec4 o; uniform float u_intensity;
void main(){
  vec2 pc = gl_PointCoord * 2.0 - 1.0;
  float r2 = dot(pc, pc);
  if(r2 > 1.0) discard;
  float a = (1.0 - r2); a *= a;       // soft round splat
  o = vec4(vec3(a * u_intensity), a * u_intensity);
}`;

const COMP_FS = `#version 300 es
precision highp float;
in vec2 v_uv; out vec4 o;
uniform sampler2D u_field; uniform float u_time; uniform float u_aspect;
void main(){
  vec2 uv = v_uv;
  vec2 p = vec2(uv.x * u_aspect, uv.y);
  vec3 base = vec3(0.028, 0.022, 0.055)                 // velvet
            + vec3(0.05, 0.04, 0.10) * smoothstep(0.85, -0.1, uv.y); // a hair brighter low
  float g = 0.0;
  for(int i = 0; i < 3; i++){
    float fi = float(i);
    vec2 c = vec2((0.5 + 0.30 * sin(u_time * 0.13 + fi * 2.1)) * u_aspect,
                  0.45 + 0.28 * cos(u_time * 0.11 + fi * 1.7));
    g += smoothstep(0.46, 0.0, distance(p, c)) * 0.13;
  }
  vec3 glow = vec3(0.55, 0.60, 0.78) * g;
  vec3 field = texture(u_field, uv).rgb;                // accumulated white particles + trails
  o = vec4(base + glow + field, 1.0);
}`;

const LiquidBackground: Component<{ active: () => boolean; onFallback?: () => void }> = (props) => {
  let canvas: HTMLCanvasElement | undefined;

  onMount(() => {
    const c = canvas;
    if (!c) return;
    const gl = c.getContext("webgl2", { alpha: false, antialias: false, depth: false, powerPreference: "low-power" });
    if (!gl) { props.onFallback?.(); return; }
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

    const sh = (type: number, src: string): WebGLShader | null => {
      const s = gl.createShader(type); if (!s) return null;
      gl.shaderSource(s, src); gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) { console.warn("[liquid]", gl.getShaderInfoLog(s)); return null; }
      return s;
    };
    const program = (vsSrc: string, fsSrc: string): WebGLProgram | null => {
      const vs = sh(gl.VERTEX_SHADER, vsSrc), fs = sh(gl.FRAGMENT_SHADER, fsSrc);
      const pr = gl.createProgram();
      if (!vs || !fs || !pr) return null;
      gl.attachShader(pr, vs); gl.attachShader(pr, fs); gl.linkProgram(pr);
      if (!gl.getProgramParameter(pr, gl.LINK_STATUS)) { console.warn("[liquid]", gl.getProgramInfoLog(pr)); return null; }
      return pr;
    };
    const fadeP = program(QUAD_VS, FADE_FS);
    const partP = program(PART_VS, PART_FS);
    const compP = program(QUAD_VS, COMP_FS);
    if (!fadeP || !partP || !compP) { props.onFallback?.(); return; }

    const quad = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, quad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);

    const pos = new Float32Array(N * 2);
    const age = new Float32Array(N), life = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      pos[i * 2] = Math.random(); pos[i * 2 + 1] = Math.random();
      life[i] = 3 + Math.random() * 5; age[i] = Math.random() * life[i]!;
    }
    const posBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, posBuf);
    gl.bufferData(gl.ARRAY_BUFFER, pos, gl.DYNAMIC_DRAW);

    // Ping-pong accumulation targets.
    type Target = { tex: WebGLTexture; fbo: WebGLFramebuffer };
    let a: Target | null = null, b: Target | null = null;
    let fw = 0, fh = 0, cw = 0, ch = 0, aspect = 1;
    const makeTarget = (w: number, h: number): Target => {
      const tex = gl.createTexture()!;
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      const fbo = gl.createFramebuffer()!;
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      return { tex, fbo };
    };
    const resize = () => {
      cw = Math.max(1, c.clientWidth); ch = Math.max(1, c.clientHeight);
      fw = Math.max(1, Math.round(cw * FIELD_SCALE)); fh = Math.max(1, Math.round(ch * FIELD_SCALE));
      aspect = fw / fh;
      c.width = cw; c.height = ch;
      if (a) { gl.deleteTexture(a.tex); gl.deleteFramebuffer(a.fbo); }
      if (b) { gl.deleteTexture(b.tex); gl.deleteFramebuffer(b.fbo); }
      gl.clearColor(0, 0, 0, 1);
      a = makeTarget(fw, fh); b = makeTarget(fw, fh);
    };
    const ro = new ResizeObserver(resize); ro.observe(c); resize();

    const bindQuad = (prog: WebGLProgram) => {
      gl.useProgram(prog);
      gl.bindBuffer(gl.ARRAY_BUFFER, quad);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    };

    const fadeU = { prev: gl.getUniformLocation(fadeP, "u_prev"), fade: gl.getUniformLocation(fadeP, "u_fade") };
    const partU = { size: gl.getUniformLocation(partP, "u_size"), intensity: gl.getUniformLocation(partP, "u_intensity") };
    const compU = { field: gl.getUniformLocation(compP, "u_field"), time: gl.getUniformLocation(compP, "u_time"), aspect: gl.getUniformLocation(compP, "u_aspect") };

    const curl = (x: number, y: number, t: number): [number, number] => {
      const vx = Math.sin(3 * x + 0.5 * t) * (-3 * Math.sin(3 * y - 0.4 * t))
               + 0.5 * (5 * Math.cos(5 * y + 0.3 * t)) * Math.cos(5 * x - 0.6 * t);
      const vy = -(3 * Math.cos(3 * x + 0.5 * t) * Math.cos(3 * y - 0.4 * t)
               + 0.5 * Math.sin(5 * y + 0.3 * t) * (-5 * Math.sin(5 * x - 0.6 * t)));
      return [vx, vy];
    };
    const sim = (dt: number, t: number) => {
      dt = Math.min(dt, 0.05);
      for (let i = 0; i < N; i++) {
        age[i] = age[i]! + dt;
        if (age[i]! > life[i]!) {                 // respawn → keeps density even + flowing
          pos[i * 2] = Math.random(); pos[i * 2 + 1] = Math.random();
          age[i] = 0; life[i] = 3 + Math.random() * 5;
          continue;
        }
        const [vx, vy] = curl(pos[i * 2]! * aspect, pos[i * 2 + 1]!, t);
        let nx = pos[i * 2]! + (vx * SPEED / aspect) * dt;
        let ny = pos[i * 2 + 1]! + (vy * SPEED) * dt;
        nx = nx < 0 ? nx + 1 : nx > 1 ? nx - 1 : nx;
        ny = ny < 0 ? ny + 1 : ny > 1 ? ny - 1 : ny;
        pos[i * 2] = nx; pos[i * 2 + 1] = ny;
      }
    };

    let time = 0;
    const render = () => {
      if (!a || !b) return;
      // 1) fade prev (a) → cur (b)
      gl.bindFramebuffer(gl.FRAMEBUFFER, b.fbo);
      gl.viewport(0, 0, fw, fh);
      gl.disable(gl.BLEND);
      bindQuad(fadeP);
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, a.tex);
      gl.uniform1i(fadeU.prev, 0); gl.uniform1f(fadeU.fade, FADE);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      // 2) additive particles onto cur
      gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE);
      gl.useProgram(partP);
      gl.bindBuffer(gl.ARRAY_BUFFER, posBuf);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, pos);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
      gl.uniform1f(partU.size, POINT_PX); gl.uniform1f(partU.intensity, INTENSITY);
      gl.drawArrays(gl.POINTS, 0, N);
      // 3) composite cur → screen
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, cw, ch);
      gl.disable(gl.BLEND);
      bindQuad(compP);
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, b.tex);
      gl.uniform1i(compU.field, 0); gl.uniform1f(compU.time, time); gl.uniform1f(compU.aspect, aspect);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      const tmp = a; a = b; b = tmp; // swap
    };

    const FPS = 40, MIN_DT = 1 / FPS;
    let raf = 0, running = false, last = 0, acc = 0;
    const frame = (now: number) => {
      raf = requestAnimationFrame(frame);
      const d = last ? (now - last) / 1000 : 0; last = now;
      acc += d;
      if (acc < MIN_DT) return;
      time += acc; sim(acc, time); acc = 0;
      render();
    };
    const start = () => { if (running) return; running = true; last = 0; raf = requestAnimationFrame(frame); };
    const stop = () => { running = false; cancelAnimationFrame(raf); };
    const shouldRun = () =>
      props.active() && !reduce && !document.hidden && document.hasFocus() &&
      !document.body.classList.contains("resizing");
    const sync = () => { if (shouldRun()) start(); else { stop(); render(); } };

    createEffect(() => { props.active(); sync(); });
    const onState = () => sync();
    document.addEventListener("visibilitychange", onState);
    window.addEventListener("focus", onState);
    window.addEventListener("blur", onState);
    const bodyMo = new MutationObserver(onState);
    bodyMo.observe(document.body, { attributes: true, attributeFilter: ["class"] });
    render();
    sync();

    onCleanup(() => {
      stop(); ro.disconnect(); bodyMo.disconnect();
      document.removeEventListener("visibilitychange", onState);
      window.removeEventListener("focus", onState);
      window.removeEventListener("blur", onState);
      if (a) { gl.deleteTexture(a.tex); gl.deleteFramebuffer(a.fbo); }
      if (b) { gl.deleteTexture(b.tex); gl.deleteFramebuffer(b.fbo); }
      gl.deleteBuffer(quad); gl.deleteBuffer(posBuf);
      gl.deleteProgram(fadeP); gl.deleteProgram(partP); gl.deleteProgram(compP);
      gl.getExtension("WEBGL_lose_context")?.loseContext();
    });
  });

  return <canvas ref={canvas} class="start-liquid" aria-hidden="true" />;
};

export default LiquidBackground;
