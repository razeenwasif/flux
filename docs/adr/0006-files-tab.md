# ADR 0006 — Files Tab: an in-browser filesystem explorer

| | |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-06-14 |
| **Deciders** | Flux Core Team |
| **Relates to** | ADR 0002 (tab kinds), ADR 0003 (terminal-as-tab pattern) |

## Context

Flux already renders non-web content as first-class tabs (the terminal). A file
explorer is a natural companion for a developer browser — and it follows the
exact same pattern, so the marginal architecture cost is low.

## Decision

Add **`TabKind::Files`**: a read-only filesystem explorer rendered in the
content card (no webview), backed by `std::fs`.

- **Backend (`flux-core::files`)** — `fs_list` (the heavy one) runs on a
  blocking thread; entries are **compact** (name, is_dir, symlink, size,
  modified) so even a 10k-file listing is a small JSON payload. `fs_home`,
  `fs_quick_locations` (home subfolders + drive roots), `fs_open` (open a file
  with the OS default app via the `open` crate — launches, never mutates).
- **Frontend (`FilesView.tsx`)** — toolbar (back/forward/up, breadcrumb,
  filter), a quick-access rail, and a **virtualized** columned list (only the
  visible row slice is in the DOM). Sorting, folders-first, hidden-file toggle,
  and keyboard nav are all client-side over the one payload. The cwd lives in
  the tab's `url` (so it survives tab switches and shows in the title).

### Why read-only first

Ship the performance + feel (virtualized scroll, native `std::fs` speed,
minimal premium UI) before the surface area of mutations. File operations
(new/rename/delete/move/copy) are the next increment — see BACKLOG.

### Why this shape

- **Same proven pattern as the terminal** — a tab kind in the content card,
  Rust-backed. No webview, no new window machinery.
- **Native speed** — `std::fs::read_dir` + batched metadata is microseconds;
  the blocking call is off the main thread (the lesson from the webview
  deadlock), so a huge directory never freezes the UI.
- **Virtualized rendering** — tens of thousands of entries scroll smoothly
  because the DOM only ever holds the visible window of rows.

## Consequences

- **Positive:** a fast, native file explorer that matches the velvet/glass UI;
  groundwork for Flux-native cross-links ("open in terminal here", agent file
  actions).
- **Negative:** pathological directories (100k+ entries) make a large one-shot
  JSON payload; acceptable for v1 (virtualized rendering keeps the UI smooth),
  paginate/stream later if needed.
- **Neutral:** read-only for now; write operations are a deliberate next step.

## Update (2026-06-14) — file operations shipped

The planned write increment landed (BACKLOG #83/#84): new folder/file, rename,
copy/cut/paste, drag-to-move, and delete. Design choices worth recording:

- **Delete defaults to the OS trash** (the `trash` crate), not `unlink` —
  recoverable by default; permanent delete is behind an explicit ⇧ gesture.
  Both confirm first.
- **Every mutation runs on the blocking pool**, same as `fs_list` — a slow op
  on a network drive must never wedge the UI.
- **`fs_move` tries `rename`, then falls back to copy+delete** across
  filesystems; **`fs_copy` recurses** directories and **auto-uniquifies**
  ("name copy") so a paste into the source folder duplicates rather than fails.
- **The frontend owns interaction** (multi-select, context menu, inline
  create/rename, drag targets, confirm dialog); the backend stays mechanical
  and path-based, with name validation on the UI side.

## Update (2026-06-15) — marquee selection + OS-native drag-out (#90)

- **Marquee (rubber-band) selection:** drag on empty space to sweep rows.
  Coordinates are kept in *content* space (scroll-independent), so it stays
  aligned with the virtualized rows and survives the edge auto-scroll (a rAF
  loop while the pointer sits near a viewport edge). It only starts on the empty
  background, so it never competes with a row's own drag.
- **OS-native drag-out:** HTML5 drag-and-drop can't hand files to *other* apps,
  so dragging a file into Explorer/mail/an editor needs a native drag
  (`tauri-plugin-drag`, which also handles the main-thread dispatch + raw window
  handle). That conflicts with the in-app drag-to-move (both want the drag
  gesture), so the resolution is a **modifier**: plain drag = in-app move
  (unchanged), **Alt+drag** = native drag-out (copy). The drag preview image
  must be a real path, so `fs_drag_icon` writes the app's 32px icon to the temp
  dir and the frontend caches it. Security: the plugin's `drag:default`
  permission is granted only to the `main` chrome window — never to tab
  webviews, consistent with the rest of the ACL.

## Update (2026-06-14) — live watch + undo

- **Live directory watch (#85):** one `notify` watcher per Files tab (keyed by
  tab id, stored behind a `Mutex` — `RecommendedWatcher` is `Send` but not
  `Sync`), emitting `flux://fs-changed` *scoped to the shell window* (`emit_to`,
  so it never reaches remote tab pages). The UI debounces (~180ms) and does a
  **soft re-list** that preserves scroll and selection, so external changes —
  and the app's own ops — appear without a flicker or a manual refresh.
- **Undo (#89):** a **backend-owned** stack of *reversible* ops only — undo
  never deletes user data, it only puts files back: rename→rename, move→move,
  trash→restore (the `trash` crate's `os_limited` restore, gated to
  Windows/freedesktop; a no-op stub elsewhere). Keeping the stack in Rust means
  the platform-specific `TrashItem` restore handle never has to cross IPC.
  ⌘/Ctrl-Z (or the context menu) triggers `fs_undo`, which returns a description
  for a toast. Create/copy/permanent-delete are deliberately **not** undoable —
  reversing them would mean deleting, which `undo` must never do.
