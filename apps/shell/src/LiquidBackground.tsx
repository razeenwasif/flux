/**
 * Aurora start-page backdrop — a seamless, pure WebGL fragment shader
 * simulating the Northern Lights using layered 3D simplex noise.
 *
 * Performance (Flux's low-RAM wedge): a single draw call, no library; the
 * start page only mounts while it's the active tab (leaving it tears the GL
 * context down → GPU 0); pauses on blur / hidden / `body.resizing`; the field
 * renders at ~0.8× resolution (it's soft); ~40 fps; `prefers-reduced-motion` →
 * a static frame; any WebGL2 failure → `onFallback` so the page shows the wave.
 */
import { createEffect, onCleanup, onMount, type Component } from "solid-js";
import { palette as pal, paletteGeneration, unit } from "./palette";

const QUAD_VS = `#version 300 es
layout(location = 0) in vec2 p;
out vec2 v_uv;
void main(){ 
  v_uv = p * 0.5 + 0.5; 
  gl_Position = vec4(p, 0.0, 1.0); 
}`;

const AURORA_FS = `#version 300 es
precision highp float;
in vec2 v_uv; out vec4 o;
uniform float u_time;
uniform float u_aspect;
// The theme's palette, fed in from palette.ts so a theme change repaints the
// shader. Baking these in is how the WebGL surfaces stayed teal under Ember.
uniform vec3 u_c1;
uniform vec3 u_c2;
uniform vec3 u_c3;
uniform vec3 u_bg;

// Simplex 3D Noise from Ashima Arts
vec4 permute(vec4 x){return mod(((x*34.0)+1.0)*x, 289.0);}
vec4 taylorInvSqrt(vec4 r){return 1.79284291400159 - 0.85373472095314 * r;}

float snoise(vec3 v){ 
  const vec2  C = vec2(1.0/6.0, 1.0/3.0) ;
  const vec4  D = vec4(0.0, 0.5, 1.0, 2.0);

  vec3 i  = floor(v + dot(v, C.yyy) );
  vec3 x0 = v - i + dot(i, C.xxx) ;

  vec3 g = step(x0.yzx, x0.xyz);
  vec3 l = 1.0 - g;
  vec3 i1 = min( g.xyz, l.zxy );
  vec3 i2 = max( g.xyz, l.zxy );

  vec3 x1 = x0 - i1 + 1.0 * C.xxx;
  vec3 x2 = x0 - i2 + 2.0 * C.xxx;
  vec3 x3 = x0 - 1.0 + 3.0 * C.xxx;

  i = mod(i, 289.0 ); 
  vec4 p = permute( permute( permute( 
             i.z + vec4(0.0, i1.z, i2.z, 1.0 ))
           + i.y + vec4(0.0, i1.y, i2.y, 1.0 )) 
           + i.x + vec4(0.0, i1.x, i2.x, 1.0 ));

  float n_ = 1.0/7.0;
  vec3  ns = n_ * D.wyz - D.xzx;

  vec4 j = p - 49.0 * floor(p * ns.z *ns.z);

  vec4 x_ = floor(j * ns.z);
  vec4 y_ = floor(j - 7.0 * x_ );

  vec4 x = x_ *ns.x + ns.yyyy;
  vec4 y = y_ *ns.x + ns.yyyy;
  vec4 h = 1.0 - abs(x) - abs(y);

  vec4 b0 = vec4( x.xy, y.xy );
  vec4 b1 = vec4( x.zw, y.zw );

  vec4 s0 = floor(b0)*2.0 + 1.0;
  vec4 s1 = floor(b1)*2.0 + 1.0;
  vec4 sh = -step(h, vec4(0.0));

  vec4 a0 = b0.xzyw + s0.xzyw*sh.xxyy ;
  vec4 a1 = b1.xzyw + s1.xzyw*sh.zzww ;

  vec3 p0 = vec3(a0.xy,h.x);
  vec3 p1 = vec3(a0.zw,h.y);
  vec3 p2 = vec3(a1.xy,h.z);
  vec3 p3 = vec3(a1.zw,h.w);

  vec4 norm = taylorInvSqrt(vec4(dot(p0,p0), dot(p1,p1), dot(p2, p2), dot(p3,p3)));
  p0 *= norm.x;
  p1 *= norm.y;
  p2 *= norm.z;
  p3 *= norm.w;

  vec4 m = max(0.5 - vec4(dot(x0,x0), dot(x1,x1), dot(x2,x2), dot(x3,x3)), 0.0);
  m = m * m;
  return 105.0 * dot( m*m, vec4( dot(p0,x0), dot(p1,x1), 
                                dot(p2,x2), dot(p3,x3) ) );
}

void main() {
  vec2 uv = v_uv;
  vec2 p = uv;
  p.x *= u_aspect;
  
  float t = u_time * 0.15;
  
  // Subtle rippling in the dark areas using low-freq noise
  float bgRipple = snoise(vec3(p * 1.5, t * 0.3));
  float bgRipple2 = snoise(vec3(p * 3.0 - bgRipple, t * 0.4));
  float bgMix = smoothstep(-0.6, 0.6, bgRipple * 0.7 + bgRipple2 * 0.3);
  
  // Base dark purple night sky
  vec3 bg = u_bg * 1.6 - uv.y * u_bg * 0.8;
  // Add the deep velvet ripples to the background
  bg += u_bg * 1.2 * bgMix * (1.0 - uv.y * 0.5);

  vec3 auroraCol = vec3(0.0);
  
  // Aurora layers
  for(float i = 0.0; i < 4.0; i++) {
    float fi = i * 0.8;
    
    // Domain warp for swirling velvety curtains (broader, softer)
    vec2 q = p * vec2(0.4, 0.8) + vec2(t * 0.15 + fi, t * 0.1);
    float n1 = snoise(vec3(q, t * 0.3));
    float n2 = snoise(vec3(q * 1.5 + n1 * 0.5, t * 0.5));
    
    // Velvet folds: broader and softer to avoid looking like individual strings
    float wave = p.x * 1.2 + n1 * 1.0 + n2 * 1.5 + t + fi * 1.5;
    
    // Very broad, blurred wave for a soft plush shape
    float curtain = smoothstep(-0.8, 1.0, sin(wave));
    
    // Soft sheen on the edges
    float sheen = smoothstep(0.6, 1.0, cos(wave));
    curtain = curtain * 0.8 + sheen * 0.3;
    
    // Density ridge - heavily smoothed for a blurred, non-stringy velvety texture
    float ridge = 1.0 - abs(n1 + n2 * 0.4);
    ridge = smoothstep(0.0, 1.0, ridge);
    
    // Fade at top and bottom (make the curtains a bit taller and more encompassing)
    float heightFade = smoothstep(0.05, 0.5, uv.y) * smoothstep(0.95, 0.2, uv.y);
    
    // Colors based on layer and height (matching user's request to keep color scheme perfect)
    vec3 c1 = u_c1;
    vec3 c2 = u_c2;
    vec3 c3 = u_c3;
    
    vec3 col = mix(c1, c2, uv.y + i * 0.1);
    col = mix(col, c3, n2 * 0.5 + 0.5);
    
    // Accumulate with velvety weighting
    auroraCol += col * ridge * curtain * heightFade * 0.5;
  }
  
  o = vec4(bg + auroraCol, 1.0);
}
`;

const LiquidBackground: Component<{ active: () => boolean; onFallback?: () => void }> = (props) => {
  let canvas: HTMLCanvasElement | undefined;

  onMount(() => {
    const c = canvas;
    if (!c) return;
    const gl = c.getContext("webgl2", {
      alpha: false,
      antialias: false,
      depth: false,
      powerPreference: "low-power",
    });
    if (!gl) {
      props.onFallback?.();
      return;
    }
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

    const sh = (type: number, src: string): WebGLShader | null => {
      const s = gl.createShader(type);
      if (!s) return null;
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
        console.warn("[aurora]", gl.getShaderInfoLog(s));
        return null;
      }
      return s;
    };
    const program = (vsSrc: string, fsSrc: string): WebGLProgram | null => {
      const vs = sh(gl.VERTEX_SHADER, vsSrc),
        fs = sh(gl.FRAGMENT_SHADER, fsSrc);
      const pr = gl.createProgram();
      if (!vs || !fs || !pr) return null;
      gl.attachShader(pr, vs);
      gl.attachShader(pr, fs);
      gl.linkProgram(pr);
      if (!gl.getProgramParameter(pr, gl.LINK_STATUS)) {
        console.warn("[aurora]", gl.getProgramInfoLog(pr));
        return null;
      }
      return pr;
    };

    const prog = program(QUAD_VS, AURORA_FS);
    if (!prog) {
      props.onFallback?.();
      return;
    }

    const quad = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, quad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);

    let cw = 0,
      ch = 0,
      aspect = 1;
    const resize = () => {
      cw = Math.max(1, c.clientWidth);
      ch = Math.max(1, c.clientHeight);
      c.width = Math.max(1, Math.round(cw * 0.8));
      c.height = Math.max(1, Math.round(ch * 0.8));
      aspect = c.width / c.height;
    };
    const ro = new ResizeObserver(resize);
    ro.observe(c);
    resize();

    const uTime = gl.getUniformLocation(prog, "u_time");
    const uAspect = gl.getUniformLocation(prog, "u_aspect");
    const uC1 = gl.getUniformLocation(prog, "u_c1");
    const uC2 = gl.getUniformLocation(prog, "u_c2");
    const uC3 = gl.getUniformLocation(prog, "u_c3");
    const uBg = gl.getUniformLocation(prog, "u_bg");
    // Re-read only when the theme actually changes; getComputedStyle in a 40fps
    // draw loop would force a style resolution every frame.
    let paintGen = -1;

    let time = 0;
    const render = () => {
      gl.viewport(0, 0, c.width, c.height);
      gl.useProgram(prog);
      gl.bindBuffer(gl.ARRAY_BUFFER, quad);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
      gl.uniform1f(uTime, time);
      gl.uniform1f(uAspect, aspect);
      if (paintGen !== paletteGeneration()) {
        paintGen = paletteGeneration();
        const p = pal();
        gl.uniform3fv(uC1, unit(p.accent));
        gl.uniform3fv(uC2, unit(p.ai));
        gl.uniform3fv(uC3, unit(p.hot));
        // Scaled right down: this is the ambient wash the curtains sit in, not
        // the base colour itself.
        gl.uniform3fv(uBg, unit(p.bg).map((v) => v * 0.9) as [number, number, number]);
      }
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    };

    const FPS = 40,
      MIN_DT = 1 / FPS;
    let raf = 0,
      running = false,
      last = 0,
      acc = 0;
    const frame = (now: number) => {
      raf = requestAnimationFrame(frame);
      const d = last ? (now - last) / 1000 : 0;
      last = now;
      acc += d;
      if (acc < MIN_DT) return;
      time += acc;
      acc = 0;
      render();
    };
    const start = () => {
      if (running) return;
      running = true;
      last = 0;
      raf = requestAnimationFrame(frame);
    };
    const stop = () => {
      running = false;
      cancelAnimationFrame(raf);
    };
    const shouldRun = () =>
      props.active() &&
      !reduce &&
      !document.hidden &&
      document.hasFocus() &&
      !document.body.classList.contains("resizing");
    const sync = () => {
      if (shouldRun()) start();
      else {
        stop();
        render();
      }
    };

    createEffect(() => {
      props.active();
      sync();
    });
    const onState = () => sync();
    document.addEventListener("visibilitychange", onState);
    window.addEventListener("focus", onState);
    window.addEventListener("blur", onState);
    const bodyMo = new MutationObserver(onState);
    bodyMo.observe(document.body, { attributes: true, attributeFilter: ["class"] });
    render();
    sync();

    onCleanup(() => {
      stop();
      ro.disconnect();
      bodyMo.disconnect();
      document.removeEventListener("visibilitychange", onState);
      window.removeEventListener("focus", onState);
      window.removeEventListener("blur", onState);
      gl.deleteBuffer(quad);
      gl.deleteProgram(prog);
      gl.getExtension("WEBGL_lose_context")?.loseContext();
    });
  });

  return <canvas ref={canvas} class="start-liquid" aria-hidden="true" />;
};

export default LiquidBackground;
