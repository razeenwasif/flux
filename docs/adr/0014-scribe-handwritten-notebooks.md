# 0014 — Scribe: handwritten per-course notebooks with one-way Onyx publish

Status: **accepted — v1 (foundation) shipped**
Date: 2026-07-23
Relates to: [0010](0010-knowledge-base-second-brain.md) (the KB / Onyx corpus),
[0012](0012-mobile-termux.md) (pointer/stylus input, rung B),
the whiteboard (`flux://whiteboard`).

## Context

Math-heavy coursework wants handwriting, not typing: derivations, diagrams, and
worked solutions. The user asked for a GoodNotes-style surface **inside Flux**,
organized per course, that can also feed their TUI Markdown notes app **Onyx**
(the KB's primary corpus, ADR 0010).

Flux already had the hard part: `flux://whiteboard` is a complete vector-ink
engine — pen/highlighter/shapes/text, an object-based eraser, undo/redo, camera
pan/zoom, PNG export — driven by pointer events, so a stylus already draws. The
gap was **structure, durable storage, and Onyx sync**, not ink.

## Decision

**Reuse the ink engine.** Extract the whiteboard's engine into a shared
`InkCanvas` component parameterized by `bounds` (`null` = infinite canvas →
whiteboard; `{w,h}` = a fixed paper page → Scribe) and a paper `template`
(plain/grid/lined/squared). Both surfaces consume it; the whiteboard's
infinite-canvas behavior is unchanged (the `bounds=null` path). One engine, two
shells: whiteboard = freeform scratch; Scribe = structured course notes.

**Paged, per-course notebooks.** Chosen over the whiteboard's infinite canvas
because it matches GoodNotes and exports cleanly page-by-page. A notebook has a
`course` (its Onyx folder) and an ordered list of fixed-size (A4-portrait) pages.

**Disk-backed from day one, strokes opaque.** localStorage is wrong for a
semester of notes (size-capped, per-machine, clearable). `scribe.rs` persists
one JSON file per notebook under `<app_data>/scribe/<id>.json` (best-effort
atomic writes via `persist.rs`; a 500 ms autosave rewrites only the edited
notebook). Each page stores its ink as an **opaque JSON string** the Rust side
never parses — so the ink format can grow new stroke kinds with zero Rust or
`bindings.gen.ts` churn.

**Onyx sync is one-way publish.** Onyx is a Markdown TUI; it cannot render
strokes. So a page publishes to `<vault>/<course>/<title>.md` — YAML frontmatter
(`source: flux-scribe`, course, page, date) + an embedded PNG of the ink (in
`assets/`) + a text body. Scribe stays the source of truth for the ink; Onyx (and
therefore the KB) gets a searchable, indexable mirror. The publish reuses the KB
module's vault-root resolution (`kb::onyx_vault`) and note-name sanitization, and
**fails loud** when the vault path is unset (never a silent no-op — a recurring
Flux failure mode). True two-way ink sync is rejected: ink can't round-trip from
Markdown.

**"Let Rust own anything that must be exact."** Vault-path resolution, filename
sanitization/disambiguation, and frontmatter escaping live in Rust, not the
frontend.

## Consequences

- The whiteboard was refactored onto the shared engine — the one real regression
  risk; its `bounds=null` path is preserved byte-for-byte and keyed-on-board
  remounts still reset camera + undo.
- Publishing is deliberately manual and per-page (a button), so nothing leaves
  the machine implicitly. The PNG is rendered in the shell and passed as base64.
- Stylus **pressure/tilt** only materialize on the native Windows build; the
  WSL2/WebKitGTK build draws but without nib fidelity (ADR 0012).
- **Touch/Pencil handling is engine-level and portable** (added after v1): the
  ink engine treats a pencil/mouse as the pen and a finger as a pan gesture
  (toggleable), and replays coalesced pointer samples for smooth high-rate
  strokes. This works in any webview — Safari/WKWebView included — which matters
  for an eventual iPad target (though the iOS build itself needs a Mac + Xcode;
  Flux has no `gen/apple/` yet).

## Deferred (fast-follows)

- **Gemma page → LaTeX/Markdown transcription** — the headline follow-up. The
  publish `body` field is designed as its drop-in target, so an OCR'd page
  becomes real searchable math in Onyx and answerable by the KB. Chosen to ship
  after the foundation.
- Native stylus fidelity; more templates (Cornell, staff paper); lasso
  select/move; page reorder.
- Two-way Onyx — not planned (infeasible for ink).
