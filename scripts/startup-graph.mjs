import ts from "typescript";

/** Read the same preload registry executed by App; reject unanalyzable imports. */
export function desktopPreloadRoots(source) {
  const file = ts.createSourceFile("desktopChrome.ts", source, ts.ScriptTarget.Latest, true);
  const roots = [];
  const visit = (node) => {
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const arg = node.arguments[0];
      if (!arg || !ts.isStringLiteral(arg) || !/^\.\/[\w-]+$/.test(arg.text)) {
        throw new Error("Desktop preload imports must be literal sibling module paths");
      }
      roots.push(`src/${arg.text.slice(2)}.tsx`);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  if (!roots.length) throw new Error("No desktop preloads found; check the startup registry");
  return roots;
}

/**
 * A root's manifest key: the key itself (`src/Sidebar.tsx`), or the one chunk
 * whose `name` it is — a dependency's dynamic chunk is keyed by a hashed file
 * name (`_xterm-CXm7zg2o.js`), so `xterm` is the only stable way to name it.
 */
export function manifestKey(manifest, root) {
  if (manifest[root]) return root;
  const named = Object.keys(manifest).filter((k) => manifest[k].name === root);
  if (named.length !== 1) {
    throw new Error(`Startup chunk ${named.length ? "ambiguous" : "missing from manifest"}: ${root}`);
  }
  return named[0];
}

/** Stylesheets the given roots load, following the same static imports. */
export function startupCss(manifest, roots) {
  const visited = new Set();
  const files = new Set();
  const visit = (key) => {
    if (visited.has(key)) return;
    const node = manifest[key];
    if (!node) throw new Error(`Startup chunk missing from manifest: ${key}`);
    visited.add(key);
    for (const css of node.css ?? []) files.add(css);
    for (const dependency of node.imports ?? []) visit(dependency);
  };
  roots.forEach(visit);
  return [...files];
}

export function startupFiles(manifest, roots) {
  const visited = new Set();
  const files = new Set();
  const visit = (key) => {
    if (visited.has(key)) return;
    const node = manifest[key];
    if (!node) throw new Error(`Startup chunk missing from manifest: ${key}`);
    visited.add(key);
    if (node.file?.endsWith(".js")) files.add(node.file);
    for (const dependency of node.imports ?? []) visit(dependency);
  };
  roots.forEach(visit);
  return [...files];
}
