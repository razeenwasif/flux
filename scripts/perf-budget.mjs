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
// Chrome JS: re-baselined 50 → 65 KB on 2026-07-16 (code audit). The original
// 50 KB was set before ~30 chrome features landed (workspaces, split view,
// groups/folders, containers, omnibox suggestions, palette, voice wiring, …).
// The audit first CUT what was genuinely cold — FindBar, ReaderView, semantic
// find/history, watch panel, tracker graph, app panes are now lazy+gated
// (70.1 → 64.4 KB) — and the remainder is load-bearing boot chrome, so the
// budget moved to just above the real floor to keep pressure on regressions.
// Re-baselined 65 → 66 KB on 2026-07-21: the Sentinel phishing warning (ADR 0013,
// Pillar 1) wires an always-on nav-check + per-tab verdict store into the boot
// path (~0.2 KB); the banner itself is lazy. A security control is load-bearing.
// Re-baselined 66 → 70 KB on 2026-07-21 (owner-approved): Sentinel Pillars 1–3
// each add a small always-on hook to the boot path (nav checks + per-tab stores)
// even though every banner is lazy, and M4 landed at 65.7 with ~0.3 KB left —
// too tight to land M5 honestly. This is deliberate headroom, NOT a licence to
// stop trimming: the eager floor is still ~66 KB, so a jump toward 70 means
// something eager crept in and should be justified or made lazy.
// Re-baselined 70 → 72 KB on 2026-08-11 (owner-approved): Flux's own icon set
// (#183) replaces the system emoji across the pages rail and the sidebar footer
// — 30 icons, ~1.8 KB gzipped of path data plus the component. Eager by
// necessity: both rails paint on first frame, so lazy-loading them would flash
// blank chips. The eager floor above still stands — this bought icons, not
// slack, and the next jump toward 72 wants the same justification.
// Ratcheted 72 → 56 KB on 2026-08-14 (a tightening, so no approval needed): the
// mobile pass split the desktop-only chrome — Sidebar, AppDock, WebPanelPane,
// TerminalColumn — out of the eager path, taking it from 71.3 to 51.9 KB. Those
// still render on first paint on desktop; they're preloaded at module-eval time
// rather than left to load when their <Show> flips. The phone renders none of
// them and now never fetches them at all. Budget set just above the new number
// so the win can't quietly erode; the eager floor is ~52 KB.
const CHROME_JS_GZIP_BUDGET = 56 * 1024; // bytes
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
