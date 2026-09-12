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
