/**
 * Particle-liquid start-page backdrop (BACKLOG #77) — many small metallic balls
 * flowing + colliding like liquid, replacing the SMIL wave.
 *
 * A lightweight CPU sim moves N particles (gravity + pairwise soft repulsion so
 * they collide/space out + a gentle sideways flow so it keeps sloshing); their
 * positions feed a SINGLE WebGL2 fragment shader that renders them as merging
 * metaballs with a metallic, near-colourless shade that picks up the velvet page
 * background (no pink/cyan — just chrome tinted by the bg + a sharp highlight).
 *
 * Performance is the whole point (Flux's low-RAM wedge):
 *   • one fullscreen triangle, one draw call, no library;
 *   • the start page only mounts while it's the active tab, so leaving it tears
 *     the GL context down (GPU → 0);
 *   • pauses on window blur / tab hidden / `body.resizing`;
 *   • renders at ~0.7× resolution (metaballs are soft, upscaling is invisible)
 *     and throttles to ~40 fps;
 *   • `prefers-reduced-motion` → one static frame;
 *   • any WebGL2 / shader failure → `onFallback` so the page shows the cheap wave.
 */
import { createEffect, onCleanup, onMount, type Component } from "solid-js";

const N = 80;          // particle count — "a lot of small balls"
const RADIUS = 0.052;  // metaball influence radius (uv units)

const VERT = `#version 300 es
in vec2 p;
void main(){ gl_Position = vec4(p, 0.0, 1.0); }`;

const FRAG = `#version 300 es
precision highp float;
out vec4 outColor;
#define N ${N}
uniform vec2 u_res;
uniform vec2 u_balls[N];
uniform float u_r2;     // metaball radius squared
uniform float u_aspect; // res.x / res.y

float field(vec2 uv, out vec2 grad){
  float f = 0.0; grad = vec2(0.0);
  for(int i = 0; i < N; i++){
    vec2 d = uv - u_balls[i]; d.x *= u_aspect;
    float dd = dot(d, d) + 1e-4;
    f += u_r2 / dd;
    grad += (-2.0 * u_r2 / (dd * dd)) * vec2(d.x * u_aspect, d.y);
  }
  return f;
}

void main(){
  vec2 uv = gl_FragCoord.xy / u_res;     // 0..1, origin bottom-left
  vec2 grad;
  float f = field(uv, grad);
  float m = smoothstep(0.95, 1.5, f);    // liquid surface
  if(m <= 0.001){ outColor = vec4(0.0); return; }

  // Metallic shade: an "environment" that's just the velvet page background,
  // lighter toward the top of each blob, + fresnel rim + a tight specular. No
  // hue of its own — it reads as liquid chrome tinted by the page.
  vec3 n = normalize(vec3(grad * 0.5, 1.0));
  vec3 L = normalize(vec3(0.35, 0.6, 0.75));
  vec3 V = vec3(0.0, 0.0, 1.0);
  vec3 envLo = vec3(0.06, 0.05, 0.14);   // velvet base
  vec3 envHi = vec3(0.28, 0.26, 0.48);   // raised velvet/violet
  vec3 env = mix(envLo, envHi, clamp(n.y * 0.5 + 0.5, 0.0, 1.0));
  float fres = pow(1.0 - clamp(n.z, 0.0, 1.0), 3.0);
  float spec = pow(clamp(dot(reflect(-L, n), V), 0.0, 1.0), 60.0);
  vec3 col = env + fres * vec3(0.5, 0.55, 0.72) * 0.5 + spec * vec3(0.95);

  float bottom = 1.0 - smoothstep(0.0, 0.98, uv.y);
  float alpha = clamp(m * mix(0.35, 1.0, bottom), 0.0, 1.0);
  outColor = vec4(col * alpha, alpha);   // premultiplied
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

    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, "p");
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    const uRes = gl.getUniformLocation(prog, "u_res");
    const uBalls = gl.getUniformLocation(prog, "u_balls");
    const uR2 = gl.getUniformLocation(prog, "u_r2");
    const uAspect = gl.getUniformLocation(prog, "u_aspect");
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.clearColor(0, 0, 0, 0);
    gl.uniform1f(uR2, RADIUS * RADIUS);

    const RENDER_SCALE = 0.7; // metaballs are soft → render below CSS resolution
    let w = 0, h = 0, aspect = 1;
    const resize = () => {
      const nw = Math.max(1, Math.round(c.clientWidth * RENDER_SCALE));
      const nh = Math.max(1, Math.round(c.clientHeight * RENDER_SCALE));
      if (nw !== w || nh !== h) {
        w = nw; h = nh; aspect = nw / nh;
        c.width = nw; c.height = nh;
        gl.viewport(0, 0, nw, nh);
      }
    };
    const ro = new ResizeObserver(resize);
    ro.observe(c);
    resize();

    // ── Particle sim ── physical space: x in [0, aspect], y in [0, 1] (isotropic).
    const qx = new Float32Array(N), qy = new Float32Array(N);
    const vx = new Float32Array(N), vy = new Float32Array(N);
    const balls = new Float32Array(N * 2);
    // Deterministic-ish spread (no Math.random dependency on exact look).
    for (let i = 0; i < N; i++) {
      qx[i] = ((i * 0.6180339887) % 1) * aspect;
      qy[i] = 0.08 + ((i * 0.7548776662) % 1) * 0.55;
      vx[i] = 0; vy[i] = 0;
    }
    const MIND = RADIUS * 1.7;      // collision spacing
    const G = 0.07;                  // gravity
    const DAMP = 0.985;
    const sim = (dt: number, t: number) => {
      dt = Math.min(dt, 0.05);
      // forces: gravity + a gentle sideways sloshing flow
      for (let i = 0; i < N; i++) {
        vy[i] = vy[i]! - G * dt;
        vx[i] = vx[i]! + Math.sin(t * 0.5 + qy[i]! * 6.0) * 0.05 * dt;
      }
      // pairwise soft repulsion → collision / spacing
      for (let i = 0; i < N; i++) {
        const xi = qx[i]!, yi = qy[i]!;
        for (let j = i + 1; j < N; j++) {
          let dx = xi - qx[j]!, dy = yi - qy[j]!;
          const d2 = dx * dx + dy * dy;
          if (d2 < MIND * MIND && d2 > 1e-7) {
            const d = Math.sqrt(d2);
            const push = ((MIND - d) / MIND) * 0.9 * dt;
            dx /= d; dy /= d;
            vx[i] = vx[i]! + dx * push; vy[i] = vy[i]! + dy * push;
            vx[j] = vx[j]! - dx * push; vy[j] = vy[j]! - dy * push;
          }
        }
      }
      // integrate + damp + bounce
      for (let i = 0; i < N; i++) {
        let pvx = vx[i]! * DAMP, pvy = vy[i]! * DAMP;
        let x = qx[i]! + pvx * dt, y = qy[i]! + pvy * dt;
        if (x < 0) { x = 0; pvx *= -0.6; } else if (x > aspect) { x = aspect; pvx *= -0.6; }
        if (y < 0) { y = 0; pvy *= -0.5; } else if (y > 1) { y = 1; pvy *= -0.5; }
        qx[i] = x; qy[i] = y; vx[i] = pvx; vy[i] = pvy;
        balls[i * 2] = x / aspect;
        balls[i * 2 + 1] = y;
      }
    };

    const draw = () => {
      gl.uniform2f(uRes, w, h);
      gl.uniform1f(uAspect, aspect);
      gl.uniform2fv(uBalls, balls);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    };

    const FPS = 40, MIN_DT = 1 / FPS;
    let raf = 0, running = false, last = 0, acc = 0, t = 0;
    const frame = (now: number) => {
      raf = requestAnimationFrame(frame);
      const dt = last ? (now - last) / 1000 : 0;
      last = now;
      acc += dt;
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
