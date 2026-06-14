# ADR 0002 — UI Architecture: Arc-style Vertical Shell

| | |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-06-13 |
| **Deciders** | Flux Core Team |
| **Supersedes** | The horizontal tab-strip + bottom-terminal layout in the 0.1 scaffold |

## Context

The 0.1 scaffold used a conventional layout: a horizontal tab strip across the
top, a bottom horizontal terminal pane, and a right agent sidebar. Two problems:

1. **It looks like 2010.** The reference set the team aligned on (Arc, Dia,
   and modern productivity apps — see `assets/`) has converged on a very
   different shape, and Flux read as dated next to them.
2. **The terminal wanted to be vertical.** A bottom horizontal strip wastes
   the most valuable axis (vertical lines of scrollback) and fights the wide
   aspect ratio of modern displays.

## Decision

Adopt an **Arc-style vertical shell**. Concretely:

- **Left sidebar owns navigation.** No top tab strip. The sidebar holds, top
  to bottom: window-drag/controls, nav buttons (back/forward/reload), an
  address+search field, a **pinned-tab grid** (square favicon tiles, the
  Arc "Favorites" pattern), the **vertical tab list** (unpinned, with cluster
  color as a left accent), a new-tab control, and a footer of tool toggles.
  The sidebar **collapses** to a narrow icon rail.
- **Content is a floating card.** The active tab renders into a rounded card
  inset from the window edges, sitting on a subtle gradient frame. This is
  the single biggest "modern browser" tell and it's pure CSS — zero runtime
  cost.
- **The terminal is a vertical right-side column**, not a bottom pane.
  Toggleable, collapses to 0 width.
- **The agent is the far-right column.** Toggleable, independent of the
  terminal. With both open the order is `sidebar | content | terminal | agent`.
- **Chrome melts away.** No persistent status bar; status and tool toggles
  live in the sidebar footer.

### What we keep

- **The dark Deep Space Blue identity** (ADR 0001 / the brand icon). The
  references are light-themed; we take their *structure and polish*, not their
  palette. Flux stays `#0B132B` / `#00E5FF` / `#D100D1`.
- **The CSS-Grid geometry contract.** Panes still never measure each other;
  toggling a column is a single `grid-template-columns` change → one style
  recalc, no JS layout. Collapsing the sidebar or a dock animates the template.
- **Tab kinds and pinning** (ADR-era `TabKind`, `pinned`) — the sidebar is
  just a better surface for the model that already existed.

## Consequences

- **Positive:** matches the reference aesthetic; vertical terminal reclaims
  the useful axis; collapsible chrome maximizes content; all geometry stays in
  one grid template.
- **Negative:** up to four vertical columns can crowd a narrow window —
  mitigated by independent collapse and sensible defaults (agent open,
  terminal closed, sidebar open). A future responsive breakpoint that
  auto-collapses docks under a min width is BACKLOG.
- **Neutral:** the address bar lives in the sidebar (Arc model); a centered
  ⌘L command bar is the eventual primary entry point (palette, BACKLOG #6).
