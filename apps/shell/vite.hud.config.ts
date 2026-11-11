// The floating answer card (IndexerHud.tsx, hud.rs) is a page of its own: a
// webview over a tab that shouldn't load the whole chrome to do it. A separate
// build, into the same dist, so it doesn't change how the chrome's bundle is
// split, which the startup budgets measure (scripts/perf-budget.mjs).
import { defineConfig } from "vite";
import solid from "vite-plugin-solid";
import { katexWoff2Only } from "./vite.katex";

export default defineConfig({
  // The same woff2-only KaTeX fonts as the chrome (audit P16): the woff and
  // ttf copies were 817 KB this build shipped and never read.
  plugins: [solid(), katexWoff2Only()],
  build: {
    target: "esnext",
    minify: "esbuild",
    sourcemap: false,
    emptyOutDir: false,
    rollupOptions: { input: "hud.html" },
    // KaTeX's fonts come with it (AnswerText), and only when an answer has maths.
    chunkSizeWarningLimit: 4000,
  },
  clearScreen: false,
});
