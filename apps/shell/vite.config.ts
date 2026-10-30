import { defineConfig, type Plugin } from "vite";
import solid from "vite-plugin-solid";

/** KaTeX's stylesheet offers each face as woff2, woff and ttf, and the bundler
 *  copies all three into the app binary. WebKit and WebView2 take the woff2
 *  every time, so the other two were 876 KB never read. */
const katexWoff2Only = (): Plugin => ({
  name: "flux-katex-woff2-only",
  enforce: "pre",
  transform(code, id) {
    if (!/[\\/]katex[\\/]dist[\\/]katex(\.min)?\.css$/.test(id)) return null;
    return code.replace(/,\s*url\([^)]+\.woff\)\s*format\("woff"\)\s*,\s*url\([^)]+\.ttf\)\s*format\("truetype"\)/g, "");
  },
});

export default defineConfig({
  plugins: [solid(), katexWoff2Only()],
  // Tauri expects a fixed dev port (tauri.conf.json devUrl).
  server: { port: 1420, strictPort: true },
  // Chrome JS budget is 50 KB gzip (ADR 0001) — keep the output inspectable.
  build: {
    target: "esnext",
    minify: "esbuild",
    sourcemap: false,
    reportCompressedSize: true,
    // Emit a build manifest so the perf-budget gate (ADR 0001: chrome JS ≤ 50 KB
    // gzip) can separate eagerly-loaded chrome JS from lazy route chunks.
    manifest: true,
    // The Porcupine wake-word SDK is a ~3.3 MB lazy chunk (its WASM is base64-
    // embedded) that only loads if a user enables Porcupine — so don't warn on it.
    // The eager-chrome budget is enforced separately by the manifest gate above.
    chunkSizeWarningLimit: 4000,
  },
  clearScreen: false,
  // Pure-logic unit tests (geometry, group algebra, strip layout). Node, not
  // jsdom: nothing here touches the DOM, and pulling jsdom in for tests that
  // don't need it costs install weight for no coverage.
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    // Vitest stubs CSS imports to an empty string by default, which silently
    // turns the stylesheet-invariant tests (theme.test.ts) into assertions
    // about "". `?raw` alone doesn't escape that, so opt the raw imports back
    // in — theme.css and the component sheets split out of it. The pattern
    // matches the `?raw` query, so the plain `import "./X.css"` side effects in
    // components imported by other tests stay stubbed.
    css: { include: [/\.css\?raw\b/] },
  },
});
