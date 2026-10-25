/**
 * The bookmark bar's folders: bookmarks into a tree by their "a/b/c" folder
 * paths (BookmarkBar.tsx draws the top level, BookmarkFolderMenu the rest).
 */
import type { Bookmark } from "./ipc";

export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}
/** Letter stand-in favicon (matches the start page / tab strip convention). */
export function letter(b: Bookmark): string {
  return (hostOf(b.url)[0] ?? "?").toUpperCase();
}

/** A folder of the bar: its own bookmarks and subfolders, in the order they
 *  were added, and how many bookmarks it holds all told. */
export type Folder = {
  name: string;
  path: string;
  folders: Folder[];
  items: Bookmark[];
  count: number;
  first: number;
};

/** Bookmarks into a tree by their "a/b/c" folder paths. */
export function buildTree(list: Bookmark[]): { root: Folder; byPath: Map<string, Folder> } {
  const root: Folder = { name: "", path: "", folders: [], items: [], count: 0, first: -1 };
  const byPath = new Map<string, Folder>([["", root]]);
  const folderAt = (path: string, at: number): Folder => {
    const known = byPath.get(path);
    if (known) return known;
    const cut = path.lastIndexOf("/");
    const parent = folderAt(cut < 0 ? "" : path.slice(0, cut), at);
    const f: Folder = { name: path.slice(cut + 1), path, folders: [], items: [], count: 0, first: at };
    parent.folders.push(f);
    byPath.set(path, f);
    return f;
  };
  list.forEach((b, i) => {
    const path = b.folder.split("/").filter(Boolean).join("/");
    folderAt(path, i).items.push(b);
  });
  const count = (f: Folder): number =>
    (f.count = f.items.length + f.folders.reduce((n, c) => n + count(c), 0));
  count(root);
  return { root, byPath };
}
