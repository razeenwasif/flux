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
  
  // Tighter squircle distance (power 5.0) to hug the rectangular bounds more closely
  float radius = pow(pow(abs(d.x), 5.0) + pow(abs(d.y), 5.0), 0.2);
  float angle = atan(d.y, d.x);
  
  // Keep the actual noise sampling uniform (circular) so it doesn't stretch
  vec2 noiseD = d;
  noiseD.x *= u_aspect;
  
  float t = u_time * 0.15;
  
  // Transparent background so the agent panel's glass effect works
  vec3 auroraCol = vec3(0.0);
  
  for(float i = 0.0; i < 4.0; i++) {
    float fi = i * 0.8;
    
    // Sample 3D noise using rotating Cartesian coordinates for seamlessness
    float rotT = t * 0.3 + fi;
    float s = sin(rotT);
    float c = cos(rotT);
    mat2 rot = mat2(c, -s, s, c);
    
    vec2 q = rot * noiseD * 2.5; 
    
    float n1 = snoise(vec3(q, t * 0.5));
    float n2 = snoise(vec3(q * 2.0 + n1 * 0.5, t * 0.8));
    
    // Curtains spinning around the center
    // Multiply angle by an integer (4.0) so it wraps perfectly seamlessly at PI
    float curtain = smoothstep(0.0, 1.0, sin(angle * 4.0 + n2 * 4.0 + t * 3.0 + fi * 2.0));
    
    // Density ridge
    float ridge = abs(n1 + n2 * 0.5);
    ridge = 1.0 - smoothstep(0.0, 0.4, ridge);
    
    // Hug the outer bounds of the panel tightly (peak closer to 0.5)
    // Displace the inner fade radius with noise so it organically fades out instead of leaving a hard geometric cutout
    float organicRadius = radius + n2 * 0.15;
    float innerFade = mix(0.15, -0.1, u_busy);
    float ringFade = smoothstep(innerFade, 0.50, organicRadius) * smoothstep(0.60, 0.49, radius);
    
    vec3 c1 = vec3(0.1, 1.0, 0.5); // Neon green
    vec3 c2 = vec3(0.2, 0.5, 0.9); // Blue
    vec3 c3 = vec3(0.8, 0.2, 0.9); // Purple
    
    vec3 col = mix(c1, c2, radius * 2.0 + i * 0.1);
    col = mix(col, c3, n2 * 0.5 + 0.5);
    
    auroraCol += col * ridge * curtain * ringFade * (0.6 + u_busy * 0.8);
  }
  
  float alpha = length(auroraCol);
  o = vec4(auroraCol, alpha * 0.8);
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
