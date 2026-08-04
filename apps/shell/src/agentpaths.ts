/**
 * Path handling for the agent's file tools (#163).
 *
 * The loop's steps are written by a model reading the previous step's output,
 * so the *shape* of what a tool returns decides what the next command looks
 * like. `list` returned bare filenames, so the next step came back as
 * `read 01-lecture.pdf` — a relative path, resolved against whatever directory
 * Flux was launched from, which is never where the file is. The read failed,
 * and from the model's side a relative-path failure is indistinguishable from
 * a file that isn't there, so it had nothing useful to react to.
 *
 * Two halves of the fix: `list` now hands back full paths (see `joinPath`), and
 * a bare name is resolved against the last directory listed anyway, because a
 * small model will shorten a long path back to its basename however it was
 * given them.
 *
 * Extracted here rather than left inline in the panel because this is exactly
 * the kind of quiet string logic that earns a test.
 */

/** Does this path stand on its own, or does it need a directory? */
export function isAbsolutePath(p: string): boolean {
  return /^[~/]/.test(p) || /^[A-Za-z]:[\\/]/.test(p) || p.startsWith("\\\\");
}

/**
 * Join a directory and an entry name, keeping the separator already in use.
 *
 * Windows accepts `/` in most APIs, but a path echoed back to the user should
 * look like the one they gave. A `\` directory with no `/` in it is a Windows
 * path; everything else is treated as POSIX — including WSL paths, which are
 * POSIX even on Windows.
 */
export function joinPath(dir: string, name: string): string {
  const sep = dir.includes("\\") && !dir.includes("/") ? "\\" : "/";
  // Trailing separators on either side would double up: `find` and `fs_list`
  // both return directory entries that may carry one.
  return `${dir.replace(/[/\\]+$/, "")}${sep}${name.replace(/[/\\]+$/, "")}`;
}

/**
 * Turn whatever the model wrote into a path a file tool can open. Strips the
 * quotes it likes to add, and resolves a bare name against `lastDir`.
 *
 * With no `lastDir` the input is returned unchanged: guessing a directory would
 * turn "file not found" into "read the wrong file", which is far worse.
 */
export function resolveAgentPath(raw: string, lastDir: string): string {
  const p = raw.trim().replace(/^["']|["']$/g, "");
  if (!p || isAbsolutePath(p) || !lastDir) return p;
  return joinPath(lastDir, p);
}
