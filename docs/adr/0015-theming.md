# 0015 — Theming: role-named palette channels, one definition

Status: **accepted — shipped 2026-08-03**
Date: 2026-08-03
Relates to: [0001](0001-architecture-and-performance-budgets.md) (chrome-JS budget),
[0002](0002-ui-architecture-arc-style-shell.md) (the Velvet × Liquid Glass shell).

## Context

Flux shipped with one palette — Royal Velvet — and no way to add another. The
obstacle wasn't design, it was structure: roughly **300 accent literals** were
hardcoded across `theme.css` (`rgba(47, 243, 255, 0.14)`, `#7b61ff`, and so on),
plus a handful more in TypeScript for the WebGL shaders and canvas surfaces. A
second palette meant a 15,000-line search-and-replace, and keeping two in sync
after that meant doing it again on every tweak.

Two further constraints shaped the answer:

- **Canvas and WebGL can't read CSS.** The Liquid background, the agent Aurora,
  the Trail graph, the Omni graph and the terminal all need numbers, not
  `var(--accent-rgb)`.
- **Flux ships on exactly two engines** — WebView2 (Chromium) and WebKitGTK.
  Portability beyond them is portability to browsers Flux never runs in.

## Decision

**A theme is five base tones plus six RGB channels. Nothing else.**

```css
--accent-rgb        /* primary interactive: focus, active, links */
--accent-ai-rgb     /* the agent / "Liquid AI" surfaces */
--accent-ai2-rgb    /* its softer companion */
--accent-hot-rgb    /* attention, highlights, the aurora */
--neutral-rgb       /* borders, scrollbar thumbs */
--rim-rgb           /* glass specular edge */
```

Four decisions inside that:

**1. Channels are named by role, not hue.** `--accent-rgb` is "the primary
interactive colour". It is teal in Velvet and a warm rose in Ember. A channel
called `--teal` would be a lie in every theme but the first, and the lie would
propagate into every call site that reads it.

**2. Bare `R, G, B` triplets, not colours.** Alpha varies per use — that is
precisely why the literals were scattered in the first place — so the channel
holds the triplet and each site composes `rgba(var(--accent-rgb), 0.14)`.

**3. `theme.css` is the single definition; everything else asks.** `palette.ts`
reads the *computed* custom properties off `<html>` and hands numbers to the
shaders and canvases. Duplicating each theme's values in TypeScript would have
been simpler to write and would have drifted on the first tweak.

**4. Status colours are separate channels.** `--flux-ok` and `--flux-warn` are
not derived from the accents. A theme may need to move them to stay legible —
Ember's warnings are amber, because a pink-red warning is invisible beside a
rose accent — but no theme may make "succeeded" and "failed" look alike. The
same reasoning holds the terminal's ANSI `red`/`green`/`yellow` fixed: those are
what *programs* mean by them, and repainting a compiler error rose because the
theme is rose would make `cargo` output unreadable.

**Applied before first paint**, by an inline script in `index.html`. From a
Solid effect the app renders one frame in the default palette and then snaps,
which reads as a bug on every launch. The default theme carries **no**
`data-theme` attribute, so a fresh install, an install that never opened
Settings, and a broken `localStorage` all render identically.

## Consequences

- A new theme is ~20 lines of CSS and one entry in `themes.ts`.
- **Every new accent must go through a channel.** A hardcoded literal will look
  right in the theme it was authored against and wrong in every other, and
  nothing will fail — which is why the two shipped themes should be checked
  whenever chrome is added.
- `palette.ts` caches; draw loops compare a generation counter rather than
  calling `getComputedStyle` per frame, which would force a style resolution
  inside the frame.
- The picker uses swatches, not names: a colour theme is the one setting you
  cannot evaluate from its label. Those swatches are hardcoded per theme *on
  purpose* — they must show each theme's own colours, not the active one's.
- Light mode is **not** addressed here. Every theme so far is dark, and the
  glass/shadow treatment assumes a dark floor; a light theme is a bigger change
  than a new channel set.
