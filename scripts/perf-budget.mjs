#!/usr/bin/env node
/**
 * Performance-budget gate (ADR 0001 — "enforced in CI; regressions block merge").
 *
 * Checks the budgets that can be measured from build artifacts (no display /
 * webview needed, so this runs on any CI runner):
 *
 *   • Chrome JS, gzip  ≤ 50 KB   — the eagerly-loaded shell bundle only. Lazy
 *                                  route chunks (PdfViewer, ArchivePage, …) are
 *                                  excluded: they don't count against the chrome
 *                                  budget because they aren't loaded at boot.
 *   • Installer / binary ≤ 25 MB — the release `flux` binary, when present.
 *
 * The eager set is computed from Vite's build manifest: start at the entry and
 * follow static `imports` transitively; `dynamicImports` (lazy) are not counted.
 *
 * Budgets that need a running window (idle RAM, cold start, terminal/agent
 * latency) are NOT checked here — see docs/perf/memory-benchmark.md. They need a
 * display + the platform webview, i.e. a self-hosted runner, and are measured
 * with the methodology documented there.
 *
 * Usage:  node scripts/perf-budget.mjs [--dist <dir>] [--binary <path>] [--json]
 * Exit code 1 if any checked budget is exceeded.
 */
import { gzipSync } from "node:zlib";
import { readFileSync, existsSync, statSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// ── budgets (ADR 0001) ───────────────────────────────────────────────────────
const CHROME_JS_GZIP_BUDGET = 50 * 1024; // bytes
const BINARY_BUDGET = 25 * 1024 * 1024; // bytes

// ── args ─────────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const flag = (name, def) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
};
const asJson = args.includes("--json");
const distDir = flag("--dist", join(ROOT, "apps/shell/dist"));
const binaryArg = flag("--binary", findBinary());

function findBinary() {
  for (const p of [
    join(ROOT, "target/release/flux"),
    join(ROOT, "target/release/flux.exe"),
  ]) {
    if (existsSync(p)) return p;
  }
  return null;
}

function gzipLen(file) {
  return gzipSync(readFileSync(file), { level: 9 }).length;
}
function kb(n) { return `${(n / 1024).toFixed(1)} KB`; }
function mb(n) { return `${(n / 1024 / 1024).toFixed(2)} MB`; }

// ── chrome JS: eager bundle from the manifest ────────────────────────────────
function chromeJsCheck() {
  const manifestPath = [
    join(distDir, ".vite/manifest.json"),
    join(distDir, "manifest.json"),
  ].find(existsSync);
  if (!manifestPath) {
    return { name: "chrome-js-gzip", ok: false, error: `no Vite manifest under ${distDir} (run \`npm run build\`)` };
  }
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));

  // Walk static imports from the entry; collect eager JS chunk files.
  const entryKey = Object.keys(manifest).find((k) => manifest[k].isEntry);
  if (!entryKey) return { name: "chrome-js-gzip", ok: false, error: "no entry in manifest" };

  const eager = new Set();
  const visit = (key) => {
    const node = manifest[key];
    if (!node || eager.has(key)) return;
    eager.add(key);
    for (const imp of node.imports ?? []) visit(imp); // static only — skip dynamicImports
  };
  visit(entryKey);

  let total = 0;
  const parts = [];
  for (const key of eager) {
    const file = manifest[key].file;
    if (!file?.endsWith(".js")) continue;
    const g = gzipLen(join(distDir, file));
    total += g;
    parts.push({ file, gzip: g });
  }
  parts.sort((a, b) => b.gzip - a.gzip);
  return {
    name: "chrome-js-gzip",
    ok: total <= CHROME_JS_GZIP_BUDGET,
    value: total,
    budget: CHROME_JS_GZIP_BUDGET,
    detail: parts,
  };
}

// ── binary / installer size ──────────────────────────────────────────────────
function binaryCheck() {
  if (!binaryArg || !existsSync(binaryArg)) {
    return { name: "binary-size", skipped: true, reason: "no release binary built (skipped)" };
  }
  const size = statSync(binaryArg).size;
  return { name: "binary-size", ok: size <= BINARY_BUDGET, value: size, budget: BINARY_BUDGET, path: binaryArg };
}

// ── run ──────────────────────────────────────────────────────────────────────
const results = [chromeJsCheck(), binaryCheck()];

if (asJson) {
  console.log(JSON.stringify(results, null, 2));
} else {
  console.log("Flux performance budgets (ADR 0001)\n");
  for (const r of results) {
    if (r.skipped) { console.log(`  ⊘ ${r.name}: ${r.reason}`); continue; }
    if (r.error) { console.log(`  ✗ ${r.name}: ${r.error}`); continue; }
    const fmt = r.name === "binary-size" ? mb : kb;
    const mark = r.ok ? "✓" : "✗";
    console.log(`  ${mark} ${r.name}: ${fmt(r.value)} / ${fmt(r.budget)} budget`);
    if (r.name === "chrome-js-gzip" && r.detail) {
      for (const p of r.detail) console.log(`       ${p.file}  ${kb(p.gzip)}`);
    }
  }
  console.log("\n  (idle RAM, cold start, terminal/agent latency need a display —");
  console.log("   see docs/perf/memory-benchmark.md for the measured wedge.)");
}

const failed = results.filter((r) => r.ok === false);
if (failed.length) {
  console.error(`\nBudget exceeded: ${failed.map((r) => r.name).join(", ")}`);
  process.exit(1);
}
