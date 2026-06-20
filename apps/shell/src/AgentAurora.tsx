import { createEffect, onCleanup, onMount, type Component } from "solid-js";

const QUAD_VS = `#version 300 es
layout(location = 0) in vec2 p;
out vec2 v_uv;
void main(){ 
  v_uv = p * 0.5 + 0.5; 
  gl_Position = vec4(p, 0.0, 1.0); 
}`;

const POLAR_AURORA_FS = `#version 300 es
precision highp float;
in vec2 v_uv; out vec4 o;
uniform float u_time;
uniform float u_aspect;
uniform float u_busy;

// Simplex 3D Noise from Ashima Arts
vec4 permute(vec4 x){return mod(((x*34.0)+1.0)*x, 289.0);}
vec4 taylorInvSqrt(vec4 r){return 1.79284291400159 - 0.85373472095314 * r;}

float snoise(vec3 v){ 
  const vec2  C = vec2(1.0/6.0, 1.0/3.0);
  const vec4  D = vec4(0.0, 0.5, 1.0, 2.0);
  vec3 i  = floor(v + dot(v, C.yyy));
  vec3 x0 = v - i + dot(i, C.xxx);
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
  p0 *= norm.x; p1 *= norm.y; p2 *= norm.z; p3 *= norm.w;
  vec4 m = max(0.5 - vec4(dot(x0,x0), dot(x1,x1), dot(x2,x2), dot(x3,x3)), 0.0);
  m = m * m;
  return 105.0 * dot( m*m, vec4( dot(p0,x0), dot(p1,x1), dot(p2,x2), dot(p3,x3) ) );
}

void main() {
  vec2 uv = v_uv;
  vec2 d = uv - vec2(0.5);

  // Squircle distance keeps the effect panel-shaped instead of circular.
  float radius = pow(pow(abs(d.x), 4.5) + pow(abs(d.y), 4.5), 1.0 / 4.5);
  float angle = atan(d.y, d.x);

  // Keep the noise sampling proportional on wide/narrow panels.
  vec2 noiseD = d;
  noiseD.x *= u_aspect;

  float busy = smoothstep(0.0, 1.0, u_busy);
  float t = u_time * mix(0.09, 0.16, busy);

  vec3 auroraCol = vec3(0.0);

  // A broad mask: faint central ribbons, stronger light near the glass edge.
  float centerWash = smoothstep(0.72, 0.10, radius);
  float edgeBand = smoothstep(0.22, 0.55, radius) * smoothstep(0.68, 0.48, radius);

  for(float i = 0.0; i < 5.0; i++) {
    float fi = i * 0.73;

    float rotT = t * (0.35 + i * 0.08) + fi;
    float s = sin(rotT);
    float c = cos(rotT);
    mat2 rot = mat2(c, -s, s, c);

    vec2 q = rot * noiseD * mix(1.9, 2.45, busy);
    q.y += sin(q.x * 2.2 + t * 2.6 + fi) * 0.18;
    q.x += cos(q.y * 1.6 - t * 1.9 + fi) * 0.14;

    float n1 = snoise(vec3(q, t + fi));
    float n2 = snoise(vec3(q * 2.15 + n1 * 0.35, t * 1.5 - fi));

    float ribbon = sin((q.x * 3.6 + q.y * 1.15) + n2 * 2.8 + t * (2.0 + busy * 2.4) + fi * 3.4);
    ribbon = 1.0 - smoothstep(0.02, mix(0.46, 0.28, busy), abs(ribbon));

    float grain = 0.72 + 0.28 * snoise(vec3(q * 4.0, t * 0.55 + fi));
    float sweep = 0.5 + 0.5 * sin(angle * 3.0 + t * (1.0 + busy * 3.0) + fi);
    float focus = mix(centerWash * 0.22 + edgeBand * 0.85, centerWash * 0.58 + edgeBand, busy);

    vec3 teal = vec3(0.10, 0.95, 0.86);
    vec3 blue = vec3(0.22, 0.40, 1.00);
    vec3 violet = vec3(0.58, 0.32, 1.00);
    vec3 rose = vec3(1.00, 0.30, 0.72);
    vec3 col = mix(teal, blue, smoothstep(-0.8, 0.8, n1));
    col = mix(col, violet, smoothstep(-0.4, 1.0, n2 + radius));
    col = mix(col, rose, pow(sweep, 2.4) * (0.18 + busy * 0.22));

    auroraCol += col * ribbon * grain * focus * (0.38 + busy * 0.75);
  }

  // A restrained inner rim makes the glass feel alive without washing out text.
  float innerRim = smoothstep(0.44, 0.58, radius) * smoothstep(0.66, 0.50, radius);
  float pulse = 0.55 + 0.45 * sin(t * (2.2 + busy * 3.2) + angle * 2.0);
  auroraCol += vec3(0.18, 0.72, 1.0) * innerRim * pulse * (0.08 + busy * 0.22);

  float alpha = clamp(length(auroraCol) * mix(0.34, 0.52, busy), 0.0, 0.72);
  o = vec4(auroraCol, alpha);
}
`;

const AgentAurora: Component<{ active: () => boolean; busy?: () => boolean }> = (props) => {
  let canvas: HTMLCanvasElement | undefined;

  onMount(() => {
    const c = canvas;
    if (!c) return;
    const gl = c.getContext("webgl2", { alpha: true, antialias: false, depth: false, powerPreference: "low-power" });
    if (!gl) return;
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

    const sh = (type: number, src: string): WebGLShader | null => {
      const s = gl.createShader(type); if (!s) return null;
      gl.shaderSource(s, src); gl.compileShader(s);
      return s;
    };
    const program = (vsSrc: string, fsSrc: string): WebGLProgram | null => {
      const vs = sh(gl.VERTEX_SHADER, vsSrc), fs = sh(gl.FRAGMENT_SHADER, fsSrc);
      const pr = gl.createProgram();
      if (!vs || !fs || !pr) return null;
      gl.attachShader(pr, vs); gl.attachShader(pr, fs); gl.linkProgram(pr);
      return pr;
    };
    
    const prog = program(QUAD_VS, POLAR_AURORA_FS);
    if (!prog) return;

    const quad = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, quad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);

    let cw = 0, ch = 0, aspect = 1;
    const resize = () => {
      cw = Math.max(1, c.clientWidth); ch = Math.max(1, c.clientHeight);
      c.width = Math.max(1, Math.round(cw * 0.8));
      c.height = Math.max(1, Math.round(ch * 0.8));
      aspect = c.width / c.height;
    };
    const ro = new ResizeObserver(resize); ro.observe(c); resize();

    const uTime = gl.getUniformLocation(prog, "u_time");
    const uAspect = gl.getUniformLocation(prog, "u_aspect");
    const uBusy = gl.getUniformLocation(prog, "u_busy");

    let time = 0;
    let busyVal = 0;
    const render = () => {
      gl.viewport(0, 0, c.width, c.height);
      gl.useProgram(prog);
      gl.bindBuffer(gl.ARRAY_BUFFER, quad);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
      gl.uniform1f(uTime, time);
      gl.uniform1f(uAspect, aspect);
      gl.uniform1f(uBusy, busyVal);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    };

    const FPS = 30, MIN_DT = 1 / FPS;
    let raf = 0, running = false, last = 0, acc = 0;
    const frame = (now: number) => {
      raf = requestAnimationFrame(frame);
      const d = last ? (now - last) / 1000 : 0; last = now;
      acc += d;
      if (acc < MIN_DT) return;
      
      const targetBusy = props.busy?.() ? 1.0 : 0.0;
      busyVal += (targetBusy - busyVal) * 5.0 * acc;
      
      time += acc * (1.0 + busyVal * 1.5);
      acc = 0;
      render();
    };
    const start = () => { if (running) return; running = true; last = 0; raf = requestAnimationFrame(frame); };
    const stop = () => { running = false; cancelAnimationFrame(raf); };
    const shouldRun = () =>
      props.active() && !reduce && !document.hidden && document.hasFocus();
    const sync = () => { if (shouldRun()) start(); else { stop(); render(); } };

    createEffect(() => { props.active(); sync(); });
    const onState = () => sync();
    document.addEventListener("visibilitychange", onState);
    window.addEventListener("focus", onState);
    window.addEventListener("blur", onState);
    render();
    sync();

    onCleanup(() => {
      stop(); ro.disconnect();
      document.removeEventListener("visibilitychange", onState);
      window.removeEventListener("focus", onState);
      window.removeEventListener("blur", onState);
      gl.deleteBuffer(quad); gl.deleteProgram(prog);
    });
  });

  return <canvas ref={canvas} style={{ position: "absolute", inset: 0, width: "100%", height: "100%", "pointer-events": "none", "border-radius": "inherit" }} aria-hidden="true" />;
};

export default AgentAurora;
