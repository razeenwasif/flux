import { defineConfig } from "vite";
import solid from "vite-plugin-solid";

export default defineConfig({
  plugins: [solid()],
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
  },
});
