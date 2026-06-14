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
  },
  clearScreen: false,
});
