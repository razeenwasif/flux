/**
 * The agent panel's backdrop in Liquid Silk (AgentMotion): Paper's grain
 * gradient, soft colour glows from the corners, with its dither pattern laid
 * over it in a soft-light blend, so the glows break into stepped bands of dots.
 * Two shaders, stacked, in the wallpaper's accents.
 *
 * Paper Shaders (Apache-2.0) is the framework-free core; this is its only use,
 * and it loads with this module, when the agent panel first shows under Silk.
 */
import {
  ShaderMount,
  ShaderFitOptions,
  defaultObjectSizing,
  defaultPatternSizing,
  ditheringFragmentShader,
  DitheringShapes,
  DitheringTypes,
  getShaderColorFromString,
  getShaderNoiseTexture,
  grainGradientFragmentShader,
  GrainGradientShapes,
} from "@paper-design/shaders";

export type SilkBackdrop = {
  /** How fast it moves (1 = its resting pace × `pace`) and how strongly it shows. */
  set: (pace: number, show: number) => void;
  dispose: () => void;
};

const sizing = (s: typeof defaultObjectSizing) => ({
  u_fit: ShaderFitOptions[s.fit],
  u_scale: s.scale,
  u_rotation: s.rotation,
  u_offsetX: s.offsetX,
  u_offsetY: s.offsetY,
  u_originX: s.originX,
  u_originY: s.originY,
  u_worldWidth: s.worldWidth,
  u_worldHeight: s.worldHeight,
});

const rgbHex = (rgb: string, fallback: string): string => {
  const n = rgb.split(",").map((v) => Number(v.trim()));
  if (n.length < 3 || n.some((v) => !Number.isFinite(v))) return fallback;
  return `#${n
    .slice(0, 3)
    .map((v) =>
      Math.max(0, Math.min(255, Math.round(v)))
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;
};

/** Mount the backdrop in `host` (which it fills). Resolves once it's drawing. */
export async function mountSilkBackdrop(host: HTMLElement): Promise<SilkBackdrop> {
  const css = getComputedStyle(document.documentElement);
  const accent = rgbHex(css.getPropertyValue("--accent-rgb"), "#93e8d8");
  const ai = rgbHex(css.getPropertyValue("--accent-ai-rgb"), "#d29cf6");
  const clear = getShaderColorFromString("#00000000");

  // The grain gradient reads a noise image, which has to be loaded first.
  const noise = getShaderNoiseTexture();
  if (noise && !noise.complete)
    await new Promise<void>((done) => {
      noise.addEventListener("load", () => done(), { once: true });
      noise.addEventListener("error", () => done(), { once: true });
    });

  const layer = (opacity: number, blend: string) => {
    const el = document.createElement("div");
    Object.assign(el.style, {
      position: "absolute",
      inset: "0",
      opacity: String(opacity),
      mixBlendMode: blend,
    });
    host.append(el);
    return el;
  };
  const grainColors = ["#3d6fd6", ai, accent].map(getShaderColorFromString);
  const GRAIN_PACE = 0.3,
    DITHER_PACE = 0.2;
  const grain = new ShaderMount(
    layer(1, "normal"),
    grainGradientFragmentShader,
    {
      u_colorBack: clear,
      u_colors: grainColors,
      u_colorsCount: grainColors.length,
      u_softness: 0.7,
      u_intensity: 0.45,
      u_noise: 0.3,
      u_shape: GrainGradientShapes.corners,
      ...(noise ? { u_noiseTexture: noise } : {}),
      ...sizing({ ...defaultObjectSizing, fit: "cover" }),
    },
    undefined,
    GRAIN_PACE,
    0,
    1,
    640 * 900,
  );
  const dither = new ShaderMount(
    layer(0.3, "soft-light"),
    ditheringFragmentShader,
    {
      u_colorBack: clear,
      u_colorFront: getShaderColorFromString("#eafcf8"),
      u_shape: DitheringShapes.simplex,
      u_type: DitheringTypes["4x4"],
      u_pxSize: 2,
      ...sizing({ ...defaultPatternSizing, scale: 0.6 }),
    },
    undefined,
    DITHER_PACE,
    0,
    1,
    640 * 900,
  );
  return {
    set(pace, show) {
      grain.setSpeed(GRAIN_PACE * pace);
      dither.setSpeed(DITHER_PACE * pace);
      host.style.opacity = String(show);
    },
    dispose() {
      grain.dispose();
      dither.dispose();
      host.textContent = "";
    },
  };
}
