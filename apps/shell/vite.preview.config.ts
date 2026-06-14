// Preview-only config: renders the shell with mocked Tauri IPC so the UI can
// be inspected/screenshotted without a Rust runtime. Never used for shipping.
import { defineConfig } from "vite";
import solid from "vite-plugin-solid";
import { resolve } from "node:path";

export default defineConfig({
  plugins: [solid()],
  base: "./",
  resolve: {
    alias: {
      "@tauri-apps/api/core": resolve(__dirname, "src/mock/tauri-core.ts"),
      "@tauri-apps/api/event": resolve(__dirname, "src/mock/tauri-event.ts"),
    },
  },
  build: { outDir: "dist-preview", target: "esnext" },
});
