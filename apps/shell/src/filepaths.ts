/**
 * Path helpers for the Files view, kept out of the component so they can be
 * tested: quiet string logic whose mistakes only show on unusual names.
 */

/** Turn a local OS path into a file:// URL (handles Windows drive paths + backslashes). */
export function toFileUrl(p: string): string {
  let s = p.replace(/\\/g, "/");
  if (!s.startsWith("/")) s = "/" + s; // C:/Users/… → /C:/Users/…
  // encodeURI leaves `#` and `?` alone (they're URL delimiters), so "C# notes.md"
  // opened …/C and "#1 report.pdf" opened its folder instead of the PDF viewer.
  return "file://" + encodeURI(s).replace(/[#?]/g, (c) => encodeURIComponent(c));
}

/** Breadcrumb segments with their absolute paths (Windows `C:\…`, UNC `\\server\share\…`, Unix `/…`). */
export function crumbs(path: string): { name: string; path: string }[] {
  // UNC: every WSL "Linux" place and network share. The generic split below made
  // `\`, `\wsl.localhost`, `\wsl.localhost\Ubuntu`… of these: drive-relative paths
  // that resolve to C:\wsl.localhost\… (or C:\ itself), as clicks and drop targets.
  if (path.startsWith("\\\\")) {
    const [server = "", share = "", ...rest] = path.slice(2).split("\\");
    let acc = share ? `\\\\${server}\\${share}` : `\\\\${server}\\`;
    const out = [{ name: share || server, path: acc }];
    for (const part of rest) {
      if (!part) continue;
      acc = `${acc.replace(/\\$/, "")}\\${part}`;
      out.push({ name: part, path: acc });
    }
    return out;
  }
  const win = path.includes("\\");
  const sep = win ? "\\" : "/";
  const out: { name: string; path: string }[] = [];
  let acc = "";
  path.split(sep).forEach((part, i) => {
    if (i === 0) {
      if (win) {
        acc = part + sep;
        out.push({ name: part, path: acc });
      } else {
        acc = "/";
        out.push({ name: "/", path: "/" });
      }
    } else if (part) {
      acc = acc.endsWith(sep) ? acc + part : acc + sep + part;
      out.push({ name: part, path: acc });
    }
  });
  return out;
}
