#!/usr/bin/env node
/**
 * Performance-budget gate (ADR 0001 — "enforced in CI; regressions block merge").
 *
 * Checks the budgets that can be measured from build artifacts (no display /
 * webview needed, so this runs on any CI runner):
 *
 *   • Entry JS, gzip   ≤ 46 KiB   — the eagerly-loaded shell bundle only. Lazy
 *                                  route chunks (PdfViewer, ArchivePage, …) are
 *                                  excluded from this entry metric; explicit
 *                                  desktop preloads are counted separately.
 *   • Desktop entry + explicit preloads ≤ 72 KiB (shared static dependencies included).
 *   • Default desktop boot JS — everything a fresh desktop window loads at
 *                                  startup with the default layout: the above plus
 *                                  the lazy columns and panes it shows.
 *   • Entry stylesheet, gzip — the render-blocking CSS index.html links.
 *   • Installer / binary ≤ 25 MB — the release `flux` binary, when present.
 *
 * The eager set is computed from Vite's build manifest: start at the entry and
 * follow static `imports` transitively; `dynamicImports` (lazy) are not counted,
 * except the ones named as default-desktop-boot roots below.
 *
 * Budgets that need a running window (idle RAM, cold start, terminal/agent
 * latency) are NOT checked here — see docs/perf/memory-benchmark.md. They need a
 * display + the platform webview, i.e. a self-hosted runner, and are measured
 * with the methodology documented there.
 *
 * Usage:  node scripts/perf-budget.mjs [--dist <dir>] [--binary <path>] [--json]
 * Exit code 1 if any checked budget is exceeded.
 */
import { execFileSync } from "node:child_process";
import { gzipSync } from "node:zlib";
import { readFileSync, existsSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { desktopPreloadRoots, manifestKey, startupCss, startupFiles } from "./startup-graph.mjs";

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
// Ratcheted 56 → 46 KB on 2026-10-13 (a tightening): the performance audit's
// entry diet took the app registry and app guides, @tauri-apps/api/window, the
// palette's action list, the three prompt bars and the clocks out of the boot
// bundle (55.5 → 43.5 KB). The eager floor is ~43.5 KB.
const CHROME_JS_GZIP_BUDGET = 46 * 1024; // bytes
// New independent gate: entry + desktopChrome registry, baselined in batch 3.
// This is a lower bound, excluding other conditionally rendered lazy features.
// Ratcheted 84 → 72 KB on 2026-10-13 with the entry diet above (81.5 → 70.1 KB).
const DESKTOP_PRELOAD_BUDGET = 72 * 1024;
// Default desktop boot, added 2026-10-13 (performance audit): the entry chunk is
// only the start of what a desktop window parses before it settles. Baselined at
// 240.0 KB after the entry diet that day; the bulk is xterm and its WebGL addon
// (the terminal column is on by default) and the agent panel.
const DEFAULT_BOOT_BUDGET = 242 * 1024;
// The lazy chunks the default layout loads at startup on a window wide enough to
// show all of it (sidebar, editor column, bookmark bar, agent + terminal stack,
// launcher and connections columns, the Indexer orb), beyond the entry and the
// preloads. Taken from the mocked preview (`npm run preview:ui`) at 2560×1440
// with empty localStorage and a web page active, listing
// performance.getEntriesByType("resource"); re-take it when the default layout
// changes. The active tab's own page (start page, PDF viewer, …) isn't counted.
// Each root is a manifest key, or the name of a dependency's dynamic chunk.
const DEFAULT_BOOT_ROOTS = [
  "src/EditorColumn.tsx",
  "src/BookmarkBar.tsx",
  "src/FindBar.tsx",
  "src/AgentPanel.tsx",
  "src/TerminalView.tsx",
  "xterm",
  "addon-fit",
  "addon-web-links",
  "addon-webgl",
  "src/BarsColumn.tsx",
  "src/PagesBar.tsx",
  "src/ConnectionsRail.tsx",
  "src/TrailMini.tsx",
  "src/SysMonitor.tsx",
  "src/IndexerBubble.tsx",
  // Loaded once the window is idle (App), still within the first second or two.
  "src/clocks.ts",
  "src/ClockAlarm.tsx",
];
// Entry stylesheet, added 2026-10-13 (performance audit): theme.css is linked
// from index.html, so all of it blocks first paint, including the rules for
// screens that aren't on it. Baselined at 42.9 KB gzip. Ratcheted 43.5 → 31 KB
// the same day, once twelve screens' rules moved into sheets of their own that
// load with those screens (29.0 KB).
const ENTRY_CSS_BUDGET = 31 * 1024;
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
  for (const dir of new Set([cargoTargetDir(), join(ROOT, "target")])) {
    for (const p of [join(dir, "release/flux"), join(dir, "release/flux.exe")]) {
      if (existsSync(p)) return p;
    }
  }
  return null;
}

/** Where cargo builds to: target/ unless CARGO_TARGET_DIR or a cargo config's
 *  build.target-dir points elsewhere. A fixed target/ then measured whatever
 *  stale build was last left there. */
function cargoTargetDir() {
  try {
    const out = execFileSync("cargo", ["metadata", "--format-version", "1", "--no-deps"], {
      cwd: ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return JSON.parse(out).target_directory || join(ROOT, "target");
  } catch {
    return join(ROOT, "target");
  }
}

function gzipLen(file) {
  return gzipSync(readFileSync(file), { level: 9 }).length;
}
function kb(n) {
  return `${(n / 1024).toFixed(1)} KB`;
}
function mb(n) {
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

// ── startup bundles from the manifest ────────────────────────────────────────
// "entry": the eager JS; "desktop": plus the desktop preloads; "boot": plus the
// default desktop layout's lazy chunks; "css": the entry's stylesheet.
const CHECKS = {
  entry: { name: "chrome-js-gzip", budget: CHROME_JS_GZIP_BUDGET },
  desktop: { name: "desktop-preloads-gzip", budget: DESKTOP_PRELOAD_BUDGET },
  boot: { name: "default-desktop-boot-gzip", budget: DEFAULT_BOOT_BUDGET },
  css: { name: "entry-css-gzip", budget: ENTRY_CSS_BUDGET },
};
function bundleCheck(kind) {
  const { name, budget } = CHECKS[kind];
  const manifestPath = [join(distDir, ".vite/manifest.json"), join(distDir, "manifest.json")].find(
    existsSync,
  );
  if (!manifestPath) {
    return { name, ok: false, error: `no Vite manifest under ${distDir} (run \`npm run build\`)` };
  }
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));

  // Walk static imports from the entry; collect eager JS chunk files.
  const entryKey = Object.keys(manifest).find((k) => manifest[k].isEntry);
  if (!entryKey) return { name, ok: false, error: "no entry in manifest" };

  let files;
  try {
    const preloadRoots =
      kind === "desktop" || kind === "boot"
        ? desktopPreloadRoots(readFileSync(join(ROOT, "apps/shell/src/desktopChrome.ts"), "utf8"))
        : [];
    const bootRoots = kind === "boot" ? DEFAULT_BOOT_ROOTS.map((r) => manifestKey(manifest, r)) : [];
    const roots = [entryKey, ...preloadRoots, ...bootRoots];
    files = kind === "css" ? startupCss(manifest, [entryKey]) : startupFiles(manifest, roots);
  } catch (error) {
    return { name, ok: false, error: String(error) };
  }
  let total = 0;
  const parts = [];
  for (const file of files) {
    const g = gzipLen(join(distDir, file));
    total += g;
    parts.push({ file, gzip: g });
  }
  parts.sort((a, b) => b.gzip - a.gzip);
  return {
    name,
    ok: total <= budget,
    value: total,
    budget,
    detail: parts,
  };
}

// ── binary / installer size ──────────────────────────────────────────────────
function binaryCheck() {
  if (!binaryArg || !existsSync(binaryArg)) {
    return { name: "binary-size", skipped: true, reason: "no release binary built (skipped)" };
  }
  const size = statSync(binaryArg).size;
  return {
    name: "binary-size",
    ok: size <= BINARY_BUDGET,
    value: size,
    budget: BINARY_BUDGET,
    path: binaryArg,
  };
}

// ── run ──────────────────────────────────────────────────────────────────────
const results = [
  bundleCheck("entry"),
  bundleCheck("desktop"),
  bundleCheck("boot"),
  bundleCheck("css"),
  binaryCheck(),
];

if (asJson) {
  console.log(JSON.stringify(results, null, 2));
} else {
  console.log("Flux performance budgets (ADR 0001)\n");
  for (const r of results) {
    if (r.skipped) {
      console.log(`  ⊘ ${r.name}: ${r.reason}`);
      continue;
    }
    if (r.error) {
      console.log(`  ✗ ${r.name}: ${r.error}`);
      continue;
    }
    const fmt = r.name === "binary-size" ? mb : kb;
    const mark = r.ok ? "✓" : "✗";
    console.log(`  ${mark} ${r.name}: ${fmt(r.value)} / ${fmt(r.budget)} budget`);
    if (r.detail) {
      for (const p of r.detail) console.log(`       ${p.file}  ${kb(p.gzip)}`);
    }
  }
  console.log("\n  Desktop preloads are a lower bound, not the complete first-paint cost;");
  console.log("  default-desktop-boot adds what the default layout loads (not the active page).");
  console.log("  (idle RAM, cold start, terminal/agent latency need a display —");
  console.log("   see docs/perf/memory-benchmark.md for the measured wedge.)");
}

const failed = results.filter((r) => r.ok === false);
if (failed.length) {
  console.error(`\nBudget exceeded: ${failed.map((r) => r.name).join(", ")}`);
  process.exit(1);
}
