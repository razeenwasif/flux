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
