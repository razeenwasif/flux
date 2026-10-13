import { test } from "node:test";
import assert from "node:assert/strict";
import { desktopPreloadRoots, manifestKey, startupCss, startupFiles } from "./startup-graph.mjs";

test("preloads include shared static dependencies once and exclude cold imports", () => {
  const manifest = {
    entry: { file: "entry.js", imports: ["shared"], dynamicImports: ["cold"] },
    sidebar: { file: "side.js", imports: ["shared", "alias"] },
    shared: { file: "shared.js", imports: ["entry"] },
    alias: { file: "shared.js" },
    cold: { file: "cold.js" },
  };
  assert.deepEqual(startupFiles(manifest, ["entry", "sidebar"]).sort(), ["entry.js", "shared.js", "side.js"]);
  assert.throws(() => startupFiles(manifest, ["missing"]), /missing/);
});

test("registry parsing follows formatted literal imports and fails closed", () => {
  assert.deepEqual(desktopPreloadRoots('const A = lazy(() => import(\n"./Sidebar"\n));'), [
    "src/Sidebar.tsx",
  ]);
  assert.throws(() => desktopPreloadRoots("import(name)"), /literal/);
  assert.throws(() => desktopPreloadRoots("const empty = {};"), /No desktop/);
});

test("stylesheets follow static imports only", () => {
  const manifest = {
    entry: { file: "entry.js", css: ["entry.css"], imports: ["shared"], dynamicImports: ["cold"] },
    shared: { file: "shared.js", css: ["shared.css", "entry.css"] },
    cold: { file: "cold.js", css: ["cold.css"] },
  };
  assert.deepEqual(startupCss(manifest, ["entry"]).sort(), ["entry.css", "shared.css"]);
  assert.throws(() => startupCss(manifest, ["missing"]), /missing/);
});

test("roots resolve by manifest key or by a unique chunk name", () => {
  const manifest = {
    "src/Sidebar.tsx": { file: "Sidebar-a1.js", name: "Sidebar" },
    "_xterm-b2.js": { file: "xterm-b2.js", name: "xterm" },
    "index.html": { file: "index-c3.js", name: "index" },
    "node_modules/pdf-lib/index.js": { file: "index-d4.js", name: "index" },
  };
  assert.equal(manifestKey(manifest, "src/Sidebar.tsx"), "src/Sidebar.tsx");
  assert.equal(manifestKey(manifest, "xterm"), "_xterm-b2.js");
  assert.throws(() => manifestKey(manifest, "index"), /ambiguous/);
  assert.throws(() => manifestKey(manifest, "src/Gone.tsx"), /missing/);
});
