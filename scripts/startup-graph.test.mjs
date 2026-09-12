import { test } from "node:test";
import assert from "node:assert/strict";
import { desktopPreloadRoots, startupFiles } from "./startup-graph.mjs";

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
