import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

if (process.platform !== "darwin") throw new Error("This native smoke bundle targets macOS.");
const root = fileURLToPath(new URL("../", import.meta.url));
const result = spawnSync(
  "npx",
  [
    "tauri",
    "build",
    "--debug",
    "--bundles",
    "app",
    "--features",
    "native-smoke",
    "--config",
    "scripts/native-smoke.config.json",
    "--",
    "--locked",
    "--offline",
  ],
  {
    cwd: root,
    stdio: "inherit",
    env: { ...process.env, VITE_FLUX_NATIVE_SMOKE: "1" },
  },
);
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
