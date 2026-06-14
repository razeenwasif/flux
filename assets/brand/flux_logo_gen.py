import math

# ── Flux logo — DeepMind-inspired spiral vortex ──────────────────────────────
# Three logarithmic-spiral "flux" arms swirling into a glowing core, on the
# velvet squircle. Palette: teal (outer) → royal violet → magenta (core).

CX = CY = 512.0
R0 = 16.0          # core radius
TURNS = 2.15
T_MAX = TURNS * 2 * math.pi
B = math.log(26.0) / T_MAX   # growth so outer radius ≈ R0*26 ≈ 416
ARMS = 3
SEGMENTS = 9       # per-arm chunks, for ribbon taper
W_INNER, W_OUTER = 7.0, 58.0


def spiral_points(phase, n=150):
    pts = []
    for i in range(n + 1):
        t = T_MAX * i / n
        r = R0 * math.exp(B * t)
        # negative angle → counter-clockwise inward swirl
        a = -t + phase
        pts.append((CX + r * math.cos(a), CY + r * math.sin(a)))
    return pts


def path_d(pts):
    d = f"M {pts[0][0]:.2f} {pts[0][1]:.2f}"
    for x, y in pts[1:]:
        d += f" L {x:.2f} {y:.2f}"
    return d


def arm_segments(phase):
    """Split an arm into chunks with increasing stroke width → tapered ribbon."""
    pts = spiral_points(phase)
    n = len(pts)
    out = []
    for s in range(SEGMENTS):
        lo = int(s * (n - 1) / SEGMENTS)
        hi = int((s + 1) * (n - 1) / SEGMENTS) + 1
        frac = s / (SEGMENTS - 1)
        w = W_INNER + (W_OUTER - W_INNER) * frac
        out.append((path_d(pts[lo:hi]), w))
    return out


arms = []
for k in range(ARMS):
    phase = 2 * math.pi * k / ARMS
    for d, w in arm_segments(phase):
        arms.append(
            f'<path d="{d}" stroke="url(#flow)" stroke-width="{w:.1f}" '
            f'fill="none" stroke-linecap="round" stroke-linejoin="round"/>'
        )
arms_svg = "\n    ".join(arms)

svg = f'''<?xml version="1.0" encoding="UTF-8"?>
<!--
  Flux logo — DeepMind-inspired spiral vortex (master artwork, 1024 grid).
  Three logarithmic-spiral arms swirl into a glowing core. "Flux" = flow.
  Rasterize with headless Chromium (renders gradients/blur, unlike the local
  ImageMagick SVG delegate):
    chrome --headless --screenshot=icon-1024.png --window-size=1024,1024 \\
           --default-background-color=00000000 flux-icon.html
  then:  npx tauri icon assets/brand/icon-1024.png -o crates/flux-core/icons
-->
<svg width="1024" height="1024" viewBox="0 0 1024 1024" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="flow" x1="120" y1="120" x2="904" y2="904" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#2ff3ff"/>
      <stop offset="0.45" stop-color="#7b61ff"/>
      <stop offset="0.8" stop-color="#c44bff"/>
      <stop offset="1" stop-color="#ec4be0"/>
    </linearGradient>
    <radialGradient id="tile" cx="32%" cy="26%" r="90%">
      <stop offset="0" stop-color="#1a1640"/>
      <stop offset="0.55" stop-color="#0b0a1d"/>
      <stop offset="1" stop-color="#07050f"/>
    </radialGradient>
    <radialGradient id="core" cx="50%" cy="50%" r="50%">
      <stop offset="0" stop-color="#ffffff"/>
      <stop offset="0.35" stop-color="#9ff7ff"/>
      <stop offset="1" stop-color="#2ff3ff"/>
    </radialGradient>
    <filter id="glow" x="-30%" y="-30%" width="160%" height="160%">
      <feGaussianBlur stdDeviation="14" result="b"/>
      <feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
    </filter>
  </defs>

  <!-- Velvet squircle tile -->
  <rect x="0" y="0" width="1024" height="1024" rx="224" fill="url(#tile)"/>
  <rect x="20" y="20" width="984" height="984" rx="206" fill="none"
        stroke="#2ff3ff" stroke-opacity="0.14" stroke-width="3"/>

  <!-- Spiral vortex (glow applied to the whole arm group) -->
  <g filter="url(#glow)">
    {arms_svg}
  </g>

  <!-- Glowing core -->
  <circle cx="512" cy="512" r="34" fill="url(#core)" filter="url(#glow)"/>
</svg>
'''

with open("/home/amaterasu/Flux/assets/brand/flux-icon.svg", "w") as f:
    f.write(svg)

# HTML wrapper so Chromium rasterizes the SVG at an exact 1024² with transparency
html = (
    '<!doctype html><meta charset="utf-8">'
    '<style>html,body{margin:0;padding:0;background:transparent}'
    'svg{display:block}</style>'
    + svg[svg.index("<svg"):]
)
with open("/tmp/flux-icon.html", "w") as f:
    f.write(html)

print("wrote SVG + HTML")
