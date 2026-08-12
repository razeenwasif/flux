# Changelog

All notable changes to Flux. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
versions follow [SemVer](https://semver.org). Unreleased work lands here in the
same commit as the code (docs-before-commit policy). Pair file: `BACKLOG.md`
(what's NOT done yet).

## [Unreleased]

### Changed
- **Drawn icons for the TUI launcher, the arcade, and the page tools (#183, batch 2).** Fifty-two
  more icons: the twelve seeded terminal apps, all twenty-three Playground games, and the sidebar
  tools (reader, screenshot, translate, save-for-offline, watch, split, files, playground).

  The TUI icons are **user data** — that field is a free-text box — so the bar resolves a known
  icon name to the drawing and renders anything else verbatim. Type `lazygit` and you get the
  drawing; type an emoji and you keep the emoji. A one-time migration upgrades a seeded app that
  still carries its original emoji and leaves a chosen one alone, because a migration that
  overwrites a preference is a bug wearing an upgrade's clothes.

  The game icons live in the Playground's own chunk rather than the shared set. That set is eager
  chrome, paid for at boot by every session; twenty-three cabinet icons only matter to someone who
  opened the arcade, so they ride along with it and cost every other launch nothing. Eager chrome
  lands at 71.3 KB against the 72 KB budget.

### Changed
- **Flux draws its own icons (#183).** The launcher rail and the sidebar footer used emoji, which
  were never really icons: they render in the *system's* font, so they arrived multicoloured, at
  inconsistent optical weights, sized differently per glyph, and looking like a different product
  on Windows than on Linux. A rail of seventeen read as a row of stickers rather than a set of
  controls.

  Thirty line icons now cover both surfaces, drawn on one 24×24 grid at one stroke weight. They're
  painted in `currentColor`, which is the part emoji could never do — the button already encodes
  its state in `color`, so the icons finally dim, brighten on hover and turn teal when active
  along with everything else. Resting tone moved to white: the old dim value was tuned for emoji,
  which carry their own colour and needed holding back, and a line icon at that tone just looks
  switched off.

  The eager chrome budget moves 70 → 72 KB to pay for it (~1.8 KB). Both rails paint on the first
  frame, so lazy-loading them would flash blank chips.

### Fixed
- **You can now change a source's location without breaking it first.** The Notebook's vault-path /
  server-URL field only rendered for sources reporting an **error**, so a path that worked but
  pointed at the *wrong* vault couldn't be changed at all — the only way to repoint Onyx was to make
  it fail. There's a **Source locations** disclosure now, listing every configurable source with its
  current value. It still opens by itself when something is broken, and only the broken row keeps
  the alarm colouring — three hot-bordered boxes for a healthy vault would read as three problems.
  The Onyx hint also names both path dialects, since either now resolves.

### Fixed
- **A Windows vault path now resolves on the WSL build too.** `C:\Users\you\OnyxVault` is a real
  path on the Windows build and meaningless on the Linux one, where the same directory is
  `/mnt/c/Users/you/OnyxVault`. Typing the Windows form used to fail the directory check, and
  `onyx_vault` would then fall through to **autodetect** — which happily finds a different vault in
  `$HOME` and indexes that instead. Flux kept working, pointed at the wrong notes, with nothing to
  indicate it. Both dialects now resolve to the same directory, so one setting is correct on either
  build. Reads, writes, named places and Scribe publish all funnel through the same resolver, so
  they move together.

### Fixed
- **The agent could get stuck describing a page as "loading…" (#182).** Two causes, both fixed.

  The capture script watched the DOM for `childList` and `characterData` changes but **not
  attributes** — so a page that renders a placeholder and then *reveals* its content by flipping a
  class produced no mutation it was looking for. `innerText` deliberately respects CSS visibility
  (the agent should read what you see), which means the text genuinely changed while nothing the
  observer watched had. Measured in a real engine: content-replacement and text-rewrite both fire,
  a class flip fires nothing. The observer now also watches `class`, `style`, `hidden` and
  `aria-hidden` — filtered rather than blanket, because every attribute would let an SPA's hover
  classes restart the debounce continuously.

  And more fundamentally, the agent read a **cache**. Even a perfect observer loses the race where
  a page finishes rendering a moment after its last mutation. Flux now asks the page to
  re-snapshot itself and waits for the answer before reading it — bounded at 500 ms, and falling
  back to the cached snapshot rather than failing, since a stale answer beats no answer.

### Added
- **"Explain this" points at your nvim selection (#181).** Select something in the editor column,
  press Esc, ask "explain this" — Gemma reads exactly what you highlighted and answers about that,
  naming the file and line range she's looking at. Works for charwise and linewise selections.

  Deliberately additive: it loads the selection into context and lets the normal answer happen,
  rather than taking over the turn. "Explain this" is a fair thing to say about a file already in
  context or the page on screen, so a version that failed without a selection would break more than
  it fixed.

  Flux reads the `'<` / `'>` marks, which are what nvim leaves *after* visual mode ends — exactly
  the state you're in when you press Esc and start typing. The text comes from `getregion()` rather
  than from slicing the line range, because nvim already resolves charwise vs linewise vs
  blockwise, and `col()` is a byte index: slicing it here would be one multi-byte character away
  from a panic.

### Fixed
- **Every chat in the UI preview was failing.** `memory_read` had no mock, so it resolved to
  `undefined`, `memText()` became `undefined`, and `convoPrompt`'s `.trim()` threw before any
  message could be sent. It presented as a `TypeError` attributed to whatever feature was being
  tested. Mocked, and the real call site now coerces an empty reply rather than poisoning the
  signal — a large failure for a small absence. The streaming chat had no mock either; it does now,
  and echoes the prompt back so a test can confirm what actually reached the model.

### Added
- **Code Visualizer opens as a floating pane**, alongside Nexus, Prism, Vector and Oracle.

  It still sends Firebase Hosting's default `X-Frame-Options: SAMEORIGIN`, so until that's
  overridden in its `firebase.json` the pane can't actually frame it — and rather than the blank
  rectangle a framing refusal normally produces, the pane now **says so and offers a way forward**
  (#180): it names the header, and gives you one click to the side panel or a tab. Once the header
  is overridden it floats like the rest, with no Flux change needed.

  Flux asks the site over `HEAD` before creating the frame, so a refusal shows immediately instead
  of flashing an empty window. That replaces the tempting frontend shortcut, which **does not
  work**: a blocked frame supposedly stays on a readable same-origin `about:blank`, but measured
  against Chromium it reports as cross-origin exactly like a loaded one — the check called a
  plainly-refused site "loaded". A site Flux can't reach is treated as framable, so a flaky network
  shows the app's own error rather than a refusal we invented.

### Added
- **Gemma can read your editor — including unsaved changes (#179).** "What am I editing" / "read my
  editor" now pulls the **live nvim buffer**, not the file on disk. If you've been editing for ten
  minutes without `:w`, that difference is the whole answer, and she says so explicitly when the
  buffer and the file disagree.

  Previously she could only see the editor the way a camera does: `read the terminal` returned
  xterm's rendered screen — your lines tangled with nvim's line numbers, `~` fillers and statusline,
  viewport only — and `read <path>` silently answered about a stale version of the file.

  The column now boots as `nvim --listen <socket>`, and Flux queries it with `nvim --server …
  --remote-expr`. Using nvim's own binary as the client means no msgpack implementation to get
  wrong, no new dependency, and it crosses the WSL boundary for free on the Windows build. She gets
  the file path, cursor position, line count, the modified flag and the buffer list along with the
  text.

  **The expressions are compile-time constants, never the model's.** `--remote-expr` evaluates
  arbitrary Vimscript, so a model-chosen expression would be remote code execution — `system('…')`
  is one call away, and page text reaches the model. Same rule the action compiler already runs on:
  the model picks *which* question from a fixed menu, Rust decides how it's asked.

### Fixed
- **The editor column no longer hijacks "read the terminal" (#178).** Registering a terminal claimed
  the agent's read target unconditionally, which was fine until a terminal could appear without you
  opening one. The nvim column boots with the window and remounts on **every `:q`** — so each
  relaunch quietly redirected "read the terminal" to nvim's screen, even mid-debug in the shell
  where you'd just run something. Mounting now claims the slot only if the pane mounted focused;
  clicking into a pane still switches it, because that part should depend on you.
- **Code Visualizer joins the app dock.** Your step-through execution visualiser
  (`codevisualizer-app.web.app`) is pinned alongside Nexus, Prism, Vector and Oracle, with its
  favicon bundled so it doesn't depend on a remote fetch, and a guide so Gemma can read the
  current step's stack and heap and explain what the program just did.

  It's marked `noFrame`, so it opens in the web-panel rail rather than a floating pane — unlike
  your other four, it still sends Firebase Hosting's default `X-Frame-Options: SAMEORIGIN`, and an
  iframe would have come up blank. Overriding that header in its `firebase.json` is enough to drop
  the flag and let it float like the rest.

### Fixed
- **Gemma's list of your apps is generated, not typed out.** It was a hand-maintained sentence
  naming four apps, so adding a fifth left her insisting she didn't know about one that was
  sitting in the dock. It now comes from the same registry the dock renders from.
- **The app dock collapses (#177).** Nexus, Prism, Vector, Oracle and the timetable were a
  permanent 250px stripe down the right edge for something you open a few times a day — and
  because the dock is pinned over the connections rail, that stripe was sitting on top of your
  Trail box. It now folds into a single handle and unfolds when you want it. Persisted, default
  open, and in the palette as **Collapse/Expand app dock**.

  The collapsed handle shows **how many apps are open**. Expanded, a running app is marked by the
  ring on its own button; collapsing would have thrown that away, and a control that hides live
  state is worse than the 250px it saved.

  The buttons aren't unmounted, just animated out — so an open app's state is intact the moment
  you reopen, and nothing re-measures. They're `inert` while hidden, so they stay out of tab order
  rather than being merely invisible.
- **The agent can find your Windows files, and you can decide how much of them it sees (#176).**
  Three related changes.

  **Drives are named places.** Your Windows drives now show up alongside `onyx` and `home`, so
  `list c` and `summarise c/Users/you/Documents/notes.pdf` work instead of you typing
  `/mnt/c/Users/...` every time. Detected from what's actually mounted and readable, so an empty
  card reader never shows up. Drive *roots* aren't listed as folders — `$Recycle.Bin` and
  `System Volume Information` are noise that would crowd the prompt.

  **Windows-dialect paths resolve on the WSL build.** Gemma can tell she's on a Windows machine
  and writes `C:\Users\you\notes.pdf`; Linux has no notion of that, so it reached the filesystem
  verbatim and failed as "no such file" — indistinguishable from a file that isn't there. It now
  becomes `/mnt/c/Users/you/notes.pdf`. Only where the drive is genuinely mounted: on a plain
  Linux box a file really could be named `C:\weird`, and silently redirecting it would be worse
  than failing. This is the mirror of the `os error 3` fix, pointing the other way.

  **And you can confine the agent's file tools.** Off by default, so nothing changes unless you
  ask. Turned on (Settings → Agent file access), its list/read/edit tools are limited to folders
  you name, and anything else is refused with a message saying which folders are allowed. Your own
  Files tab and PDF viewer are untouched — this is about what the agent reaches on its own, not
  about you opening your files.

  Worth turning on if you use cloud escalation: while that's live, a file the agent reads is a
  file Google receives. Enabling it pre-fills with your vault, Scribe, Downloads and home —
  deliberately *not* the drives, because naming a drive is a convenience and reading it is a
  decision.

  The containment check compares path components rather than string prefixes (so `/home/me` never
  admits `/home/melissa`) and canonicalises first, so `..` can't climb out and a symlink pointing
  out of an allowed folder is caught as the escape it is.
- **Opt-in cloud escalation for the agent (#175, ADR 0018).** A local 12–26B in a 16k window has a
  ceiling, and a run of recent failures — `output truncated at the token cap`, `no room to grow`,
  the whole `num_ctx` retry ladder — were all the same thing: the job was bigger than the window.
  Summarising a folder of lecture PDFs still doesn't fit.

  You can now escalate **one session** to Gemini from the agent panel's model menu. The switch is
  built to be hard to leave on by accident: it is **off on every launch** (the flag lives in memory,
  never on disk), it checks the key actually works before flipping rather than failing on your first
  question — so a refused switch means nothing was sent — clearing the key revokes it, and the
  agent header reads `☁ … · cloud` in the whole time it's live — the word, not just the colour, so
  it survives a screenshot. Local is the default *and* the fallback: no key, a failed switch, a
  removed key all run locally. Nothing in the router can fail toward the network.

  Be clear about what it costs. Agent prompts carry page text, PDFs, vault notes and terminal
  output, so escalating is a disclosure, not a speed setting. That is why it's per-session, while
  the ElevenLabs voice — which sends only Gemma's reply *text* — is a persisted preference.

  The API key goes in your OS keyring (Settings → Integrations), never localStorage, and is never
  read back into the UI. Note a **Gemini app subscription is not an API key** — you need one from
  Google AI Studio, and it's worth checking whether your tier is excluded from training.

  Under the hood the schemas needed translating: Gemini's `responseSchema` rejects the `oneOf`,
  `const` and `additionalProperties` that Flux's action schemas are built from, and treats
  `maxLength` as advisory where Ollama enforces it in the grammar. Both are handled, and a test
  asserts the *real* schemas translate cleanly so a new construct fails in CI rather than as a 400
  in front of you.
- **A permanent nvim column beside the page (#174).** Editing something while reading something
  meant a tab switch, and a tab switch means losing the page you were reading from. The content
  area now splits: the page keeps the left half, `nvim` runs in the right, booted from `~` when
  Flux starts and always there. Drag the seam to re-balance (double-click for an even split); the
  width and whether it's open both survive a restart, and the palette has **Show/Hide editor
  column**.

  The reason this can sit next to a page at all: a tab's page is a native webview — an OS layer
  above all HTML, which nothing DOM can be drawn over — but Flux's terminal is xterm.js, and the
  column is a *sibling* of the content card rather than an overlay. Shrinking the card is the
  whole mechanism; its `ResizeObserver` re-tiles the webview to the smaller rect, exactly the way
  the bookmark bar already worked.

  Quitting the editor hands back a fresh one, because a column that stays dead after a `:q` isn't
  permanent. An editor that dies *immediately* is reported instead of relaunched — that case is
  `nvim` missing from the shell's PATH, and relaunching it would spin forever rather than fix
  anything.
- **Summarise a folder one document at a time.** Reading every file and writing one note at the
  end doesn't scale, and each of the last few failures was a symptom of that: the prompt grew with
  every document until it filled the context window, the answer had nowhere to go, and a failure
  at the end lost all six summaries at once.

  The loop has a `summarise <path> into <where>` step now, used once per file. Each note is
  drafted from **one** document, so the prompt and the answer are bounded by the largest single
  file rather than the folder — and each summary is approved and written before the next file is
  read, so stopping halfway leaves you with the summaries you'd already got. The second and later
  documents append to the note the first one created, so a folder of lectures becomes one note
  with a section each, not six notes.

  `read` is still there for pulling a document in to answer a question about it; `summarise` is
  for filing one.
- **Unload the model from VRAM.** A 12B sits on several GB, and Flux deliberately keeps it warm
  for 30 minutes so your next question doesn't pay a cold model load. That trade is worth nothing
  the moment you want the GPU for something else, and the only ways out were waiting or
  `ollama stop` in a terminal. The model picker now has **⏏ Unload from VRAM**; it reloads by
  itself on your next message, so nothing is lost but the warm start.

  Done through Ollama's HTTP API (`keep_alive: 0` — the same knob that keeps it warm, set to
  zero) rather than shelling out to `ollama stop`, so it works wherever the server actually is:
  with a remote `FLUX_OLLAMA_URL` the local `ollama` binary would be talking about a different
  process, or not be installed at all.

- **The agent runs OCR itself.** A scan has no text layer, so reading one used to end with Gemma
  telling you to open the PDF viewer and click **Read with OCR** — asking you to do by hand the
  one thing you'd asked her to do. She runs it now, with per-page progress in the feed, and says
  the text was machine-read so a summary built on it carries that caveat.

  Capped at 40 pages unprompted: OCR is a subprocess per page, so a 300-page scan is five minutes
  of a task loop that looks hung. Anything longer stays a deliberate act you start from the
  viewer, where it's visible and interruptible. "No tesseract installed" and "OCR ran and found
  nothing legible" are reported as the different problems they are. The page loop is now shared
  with the viewer's own button rather than copied — the render scale and the free-the-canvas step
  are exactly the details that drift once they exist twice.

- **Named places — say "onyx", not a path.** *"Save this to Onyx under 00 - Optimization"* is how
  people actually ask, and it used to fail two ways at once. The note planner was shown a flat
  list of existing note *files* and never the vault's **folders**, so it had nothing to match
  "00 - Optimization" against — the folder came back null and the note landed at the vault root,
  or it invented a name close to but not yours. And the agent's file tools took paths and nothing
  else, so `list onyx` meant nothing at all.

  `onyx`, `scribe`, `downloads` and `home` now resolve to real absolute paths, and the vault's
  top-level folders are listed by name. One definition in Rust feeds all three consumers — the
  note planner's prompt, the agent's system prompt, and path resolution in the file tools — so
  they can't describe the same vault differently. `onyx/00 - Optimization` expands anywhere a
  path is taken, matched case-insensitively but only as a whole leading segment, so a real folder
  called `onyxdata/` is never mistaken for the vault. Places are resolved fresh on each call
  rather than cached: the vault path is a setting, and a stale answer files a note in the wrong
  directory. Only directories that actually exist are offered — naming one that doesn't would
  have the model confidently write to it.
- **The agent acts on plain language instead of narrating.** Asking Gemma to go through a folder
  of PDFs and summarise them into a notebook produced a confident plan, an offer to begin, and
  then the same offer again — forever. The cause wasn't the model: the tools only ran behind
  `/task` and `/fix`, plain chat had **none**, and nothing told her that. Narrating was the only
  thing she could do. A request that asks for *work* now routes to the same adaptive loop those
  slash commands use, so it lists, reads, and drafts one step at a time. Detection can be
  generous because every side-effecting step still stops at its approval card — a false positive
  costs a visible plan you can stop.

  Three capability gaps went with it, each of which would have stalled that request even once
  the loop started:
  - **`list <dir>`** — a folder could only be seen through `run ls`, which spends an approval
    card on a read-only look and then has to be parsed back out of terminal output. Listing is
    not a side effect, so it doesn't ask.
  - **PDFs read as text.** `read <path>` used the plain text reader, so a PDF came back as
    `%PDF-1.7` and compressed streams — and the model summarised *that*, confidently. Extraction
    now goes through the same PDF.js path the viewer and the KB already use, page-numbered so a
    summary can cite "slide 12". A scan says so instead of yielding nothing.
  - **`note <what>`** — the loop could read, run and edit but had no way to finish a job in your
    own notes, so "summarise these into Onyx" ended as a chat message that looked like it had
    been saved and hadn't. It now drafts through the same approval card, and the loop waits for
    your answer rather than declaring success over an unanswered card.

  Two limits that made long jobs quietly wrong: the step ceiling was 10 (sized for "fix the
  failing test", about a third of what a folder of lectures needs, and it reported success on
  stopping), now 28; and `note_plan` has always accepted a context argument that **nothing ever
  passed**, so a note written at the end of a task was drafted from the request sentence rather
  than from the documents just read. The files now reach it, with the budget raised from 6 KB to
  24 KB to match.
- **PDF viewer: page jump, bookmarks and comments.** A 300-page paper was navigable only by
  scrolling, which is not navigation. The toolbar now carries `⟨ 9 / 12 ⟩` — type a page number
  and press Enter, or step with the arrows — and a **Notes** panel holds bookmarks (click the
  page number to go there; rename them, since "Page 47" is not why you bookmarked page 47) and
  per-page comments.

  Both are **sidecar, not burned into the file**. The Edit tools work the other way round —
  their markup becomes part of the PDF when you hit Save — and the difference matters enough
  that the panel says so in as many words. The trade is that they live on this machine, keyed to
  the file's path: move the file and they don't follow.

### Changed
- **Launcher column: icons only, names on hover.** Seventeen labels at 12px is a wall of text
  you read past rather than scan, and the names were costing the column three times its width
  for information you need only while learning it. 154px → 54px, all of it back to the page. The
  labels return on hover *and on keyboard focus* via a portaled tooltip — the native `title` is
  a second late, unstyled, and lands in the wrong place on WebKitGTK, and a label inside the chip
  would be clipped by the column's own scrolling.

- **System monitor in the connections rail.** CPU, memory (and swap, when it's actually in use),
  GPU, VRAM, mounted disks and network throughput as one dense card directly above the Trail —
  the machine's load at a glance without opening the task-manager tab and losing the page you
  were on. It's a second *view* of the data `flux://tasks` already collects, not a second
  collector. Polling stops entirely while the card is collapsed and again while the window is
  hidden. Disks get their own 30-second timer because enumerating volumes measured 30–53s on a
  machine with a sleeping external drive, so the card fills in late rather than stalling the
  rail. Hardware that isn't there is **omitted, not zeroed**: no NVIDIA driver means no GPU
  group, because a row reading 0% claims the card is idle rather than unread.

- **A vertical launcher column.** The Flux-pages strip and the terminal-apps strip used to dock
  above the content card. Between them that cost the page ~76px of height on every tab,
  permanently, for a launcher you reach for a few times an hour — and on a 16:9 window height is
  the scarce axis, not width. Both are vertical now, in a 154px column immediately left of the
  calendar/mail column, and the content card claims the height back. Width is fixed on purpose:
  the contents are chips at one font size, so there's no second width that shows more of
  anything. The ✎ editor moved to the top of the terminal-apps list — at the bottom of a
  scrolling column you had to scroll past every app to find the way to edit them. Same toggle and
  the same stored key as before, so an "off" preference didn't silently become "on".

### Changed
- **The sidebar's toolbar and footer fold away.** Both hold a dozen controls you use occasionally
  and read past constantly; folding hands that height to the tab rail, which is the reason the
  sidebar is open at all. The state persists, and — the point of the change — it **also applies
  in the collapsed icon rail**, where the footer used to redraw as a two-column grid of icons,
  i.e. exactly the height collapsing was meant to reclaim. The sidebar toggle and the fold caret
  stay visible in every state: folding must never be a way to lose the control that unfolds.

- **Workspaces moved from the dot rail to the footer.** The thin strip of coloured dots on the
  sidebar's right edge said nothing about which workspace was which until you hovered one, and
  charged a 22px gutter down the sidebar's entire height for the privilege. One footer button —
  carrying the active workspace's colour, so there's finally something on screen that says where
  you are — opens a panel with every control the rail had: switch, recolour, rename, delete, and
  new. It renders in both sidebar states, so the collapsed rail's separate workspace button is
  gone as well; two buttons 30px apart for one list was only ever a way to make the rail taller.

### Fixed
- **The start page's calendar started the week on Sunday.** The calendar popover had been
  Monday-first for a while; the start page's month grid and its week view hadn't, so the two
  disagreed about which day a week begins. Both are Monday now, along with the weekly digest's
  cache key — so the digest rolls over on Monday morning rather than mid-weekend, which is when a
  week in review is worth reading. The Sunday-based `getDay()` now goes through one `mondayIndex`
  helper rather than being shifted at each call site, since three call sites drifting apart is how
  this happened.

  *(Unchanged on purpose: "what's on my calendar this week" still means the next seven days.
  Asked on a Saturday, a Monday–Sunday reading would answer with two.)*

- **The retry now uses the room that exists, not just the room it asked for.** Doubling the token
  cap is a heuristic; the context window is a fact. When the doubled value didn't fit, the retry
  gave up and reported "no room to grow" — while several thousand tokens of usable room sat
  unused. It clamps to what fits now, and only errors when nothing larger fits at all.

  The note prompt was also sized without reference to the window it has to share with its own
  answer: a fixed 24 KB of context, plus targets and instructions, left a 10,000-token prompt in a
  16,384-token window. It's now sized from the window with the answer's space reserved first. And
  when it genuinely can't fit, the message says what actually helps, in order — ask for less in
  one request, clear the loaded files, then raise `num_ctx` — rather than leading with the setting
  most likely to cost VRAM you may not have.

- **An unescaped quote in prose no longer throws away the note.** *"expected `,` or `}` at line
  1 column 1983"* is what a model writing `The "strong duality" theorem` into a JSON string
  produces: the inner quote ends the string early, and everything after it is nonsense to the
  parser. One character in the middle of a sentence, and the whole note is lost.

  The repair added for LaTeX now covers this and raw newlines too — the three ways a model breaks
  JSON it otherwise got right, all of them quoting slips inside string literals, all commonest in
  prose, mathematics and paths. A `"` is read as closing the string when the next non-space
  character is one that can legally follow a string, and as literal text otherwise; a raw newline
  or tab is never ambiguous at all. Still only ever after a strict parse has failed, so valid
  output is untouched.

- **LaTeX no longer throws away the reply that contains it.** *"model returned malformed action:
  invalid escape at line 1 column 2411"* was the note prompt getting what it asked for. It
  requests LaTeX — `$$\int_0^1 x^2\,dx$$` — and a model writing that into a JSON string has to
  emit `\\int`. Small models routinely don't, and `\i` / `\,` aren't valid JSON escapes, so
  serde rejected the whole object and a perfectly good note was lost to a quoting slip. It showed
  up wherever mathematics or Windows paths appear — which is exactly where the agent is most
  useful.

  A stray backslash inside a string is now repaired to a literal one, and the LaTeX reaches the
  note intact. Applied **only after a strict parse has already failed**, so valid output is never
  rewritten — the repair can add a success but can't change one. If it doesn't help, the original
  error surfaces rather than a second one describing text the model never produced. All thirteen
  structured call sites go through one parse helper, so a model's maths can't take out one
  feature and spare another.

- **A note is a summary, not a transcript.** Asked to summarise a folder of lecture PDFs, a 26B
  ran past **8192 output tokens** — roughly 32 KB of "note" — and failed with nothing usable,
  even after the automatic retry. Nothing had ever told it how long a note should be: the prompt
  said "write the body the user asked for", and with 24 KB of source material in context it tried
  to write all of it back out.

  The schema now carries a `maxLength` on every body field, which the model is grammar-constrained
  against, and the prompt asks for 300–800 words, one short section per document, and to stop
  rather than restate. Raising the token cap further wouldn't have helped: `num_ctx` covers prompt
  *and* output together and is capped, so at that size there is no room for both. The error says
  that now — ask for less in one go, rather than leading with an environment variable that can't
  fit.

- **The PDF viewer's own toolbar was overwriting the document's text.** Asked about an open PDF,
  Gemma reported she could see "only the interface elements of your PDF viewer, like the page
  count and zoom level" — and she was describing exactly what she'd been given. `InternalPage`
  publishes every Flux page's rendered DOM as that tab's snapshot, which for the viewer is the
  filename, `3 / 35`, `140%` and the mode buttons. It landed on top of the real snapshot written
  by `pdf_publish_text`.

  It became constant with this cycle's page-jump readout: the publisher is driven by a
  MutationObserver, and the page number now changes on every scroll, so the document's text was
  clobbered again and again rather than losing one race at startup. A page that publishes a better
  snapshot than its own DOM now opts out, rather than hoping to win a timing fight.

  The snapshot also names the file's **absolute path** now — the viewer only ever had it as a
  tooltip, which can't be selected, so neither the user nor the agent could get at it. The
  filename in the toolbar is a button that copies the full path.

- **A wordier model no longer breaks every structured feature.** Switching to a 26B made calls
  fail with *"output truncated at the token cap… raise it with `FLUX_OLLAMA_OPTIONS`"* — a
  correct diagnosis, handed to the user as homework for a request the machine could simply have
  made again. Schema-constrained generation stops when the object closes, so a larger ceiling
  costs nothing on a reply that was going to fit; it only rescues the one that wasn't. A
  truncated structured reply is now retried with double the room, up to 8192 tokens.

  The ceiling was also one number for every structured call, which stopped making sense once the
  agent could write notes: a phishing verdict needs a few hundred tokens, while drafting the note
  you asked for can legitimately need thousands. Doubling on demand rather than raising the
  default keeps the context (and the KV cache) small for the calls that don't need it.

  And when the prompt itself already fills the window, retrying can't help — the extra output
  tokens have nowhere to live. That case now says so, and points at trimming what's in context or
  raising `num_ctx`, instead of blaming the model's verbosity.

- **A PDF with no text layer told the agent nothing, so it guessed.** When extraction found no
  selectable text, `pdf_publish_text` published *nothing at all* — right for the knowledge base
  (an empty doc would make it claim to know a paper it can't quote a word of) and wrong for the
  live snapshot. An absent snapshot isn't a neutral state: from the model's side it's
  indistinguishable from a page it simply wasn't handed. Asked about the open document it would
  speculate about Flux's own plumbing — *"my ability to read it depends on whether the text is
  being captured and sent to me"* — and ask you to paste the slides in, when the true answer
  ("this is a scan, run OCR") was one it had no way to reach.

  The snapshot now says so, in the one place the model reads. Same for the quieter case: a deck
  whose later slides are images extracts fine for the first few and then yields nothing, which
  used to be logged and never mentioned — so it would answer about "the document" while holding
  two slides of thirty-five. Both the model and the viewer now say **which** pages are readable,
  and the viewer offers OCR for a partly-image deck instead of only a fully scanned one. The
  agent is also told, in general, never to theorise about Flux's internals: either the page text
  is in its context or it isn't, and both cases have a useful thing to say.

- **The agent couldn't read the PDFs it had just listed.** `list` returned bare filenames, and
  the next step is written by a model reading that output — so it came back as
  `read 01-lecture.pdf`, a relative path, resolved against whatever directory Flux was launched
  from. Never where the file is. From the model's side a relative-path failure looks identical to
  a missing file, so it had nothing useful to react to.

  The shape of what a tool returns decides what the next command looks like, so `list` now hands
  back **full paths, ready to use**. As belt and braces a bare name also resolves against the last
  directory listed, because a small model will shorten a long path back to its basename however
  it was given them. With no directory listed yet the name is left alone — guessing one would
  turn "not found" into "read the wrong file". A failed read now names the exact path it tried,
  since nearly every failure here is the path rather than the PDF.

- **The WSL bridge listed the wrong directory and called it success.** Asking the agent to list a
  folder returned Flux's own repo — 13 folders, 14 files — with a zero exit status, so it read
  that as the answer and kept going. Two mistakes stacked:

  The path was spliced into the shell script with hand-rolled quote escaping. `Command` quotes
  arguments by MSVCRT rules, `wsl.exe` re-parses the command line by its own, and the inner
  quotes didn't survive the round trip — so `d=""`. And the script did `cd -- "$d" && find .`,
  where `cd ""` **succeeds and stays put**: the working directory `wsl.exe` inherited, which is
  wherever Flux was launched from. A wrong answer that reports success is worse than an error.

  The path is now passed as an **argument** (`bash -c script name "$1"`), so nothing parses it and
  there is nothing to escape wrongly — verified against paths containing spaces and a double
  quote, which the old splicing mangled. `find` names the directory explicitly instead of relying
  on the working directory, an empty path exits 2 rather than listing the cwd, and the resolved
  path comes back behind a sentinel so a shell banner can't be mistaken for it. The same fix
  applies to the write path, where a mangled quote would have written an approved edit somewhere
  other than promised.

- **The agent could burn a whole task repeating one step.** A model that doesn't like a result
  will re-issue the same command verbatim; one goal spent 23 steps re-listing the same folder.
  "Don't repeat a step" was in the planner prompt, and a prompt is not a guarantee. A repeat is
  now refused and recorded in the history as a fact the model can act on; three strikes stops the
  loop and keeps whatever was achieved.

- **WSL paths worked in some commands and not others.** On the Windows build, a Unix path means
  the file lives in WSL — that's where a user who develops there keeps everything, and
  `/home/me/notes` is what they type and paste to the agent. `read_text_file` and
  `write_text_file` each grew their own `wsl.exe` shell-out for this, which was fine while they
  were the only two. The moment the agent gained `list <dir>` and PDF reading there were four
  call sites and two of them didn't know, so asking it to look in `/home/…` returned *"The system
  cannot find the path specified. (os error 3)"* — and reading the PDFs would have failed the
  same way one step later.

  The bridge now lives in one place and every filesystem entry point goes through it. Directory
  listings resolve through WSL (`find -printf`, not parsed `ls`), and file bytes come back
  base64-encoded in transit: a PDF is binary, and piping raw bytes through `wsl.exe` isn't
  guaranteed to survive intact. The decoder is deliberately not `cfg`-gated to Windows — it's the
  one piece of real logic here, and gating it would mean the only decoder in the tree that can
  silently corrupt a PDF is also the only one the test suite never runs.

- **Three surfaces you couldn't scroll — one root cause.** BACKLOG #140 settled a real
  Windows/Linux disagreement by hiding the scrollbars on Flux's chip strips, and in doing so
  removed the *only* way to scroll two of them: there was nothing left to drag, and a
  horizontal-only scroller is not obliged to translate a vertical wheel. Past the first
  screenful, **bookmarks** and **tab folders** were unreachable. Both have their scrollbars
  back — drawn by the one global treatment, not re-styled per component — and a vertical wheel
  now scrolls them, so a plain mouse works.

  The **system monitor** was a different mistake of mine: an inner scroll region capped at 34%
  of the rail. A ~280px card squeezed into ~200px hid a third of the readings, and nesting a
  third scroll box in a column that already had two meant working out which one the pointer was
  over before the wheel did anything. Its rows are fixed-size and bounded, so it now simply
  draws all of them; the *column* scrolls if the window is too short. The fade at its bottom
  edge is gone too — in a box you couldn't reach the bottom of, "there is more below" read as
  "this is cut off".

  A scrollbar is now only hidden where the wheel already does the job **and** the gutter is a
  large fraction of the element — two narrow vertical rails. Anything horizontal keeps its bar.

- **A PDF tab forgot where you were the moment you left it.** Switching tabs unmounts the
  viewer — ContentArea renders only the active tab's internal page — so coming back re-fetched
  the file and dropped you on page 1. Page, zoom, bookmarks and comments are now recorded per
  document and restored on open, so it also survives closing the tab and restarting Flux.
  Keeping every PDF mounted (the terminal's keep-alive trick) would have cost a decoded document
  per tab; remembering the position costs a few hundred bytes.

- **Zoom was scaling Flux, not the document.** Nothing disables engine-level zoom on the chrome
  window, so `Ctrl`+wheel and `Ctrl`+`=` were resizing the entire shell — sidebar, toolbar and
  all — while the page underneath stayed exactly the same size. The viewer claims both gestures
  and `preventDefault()`s them, so they do what you meant. Zoom now also **keeps your place**
  instead of snapping to the top of the document, and clicking the percentage resets to 100%.

- **The PDF viewer never fitted its own card.** The content card centres its grid items
  (`place-items: center`), and a centred grid item is sized to its *content*, so it may legally
  overflow its track. Any page zoomed past the card's width did exactly that: the viewer grew,
  carrying the toolbar off the left edge — so the zoom controls became unreachable at the moment
  you most needed them. It claims the track and clips to it now; the pages scroll in their own
  box. Two related flex bugs went with it — a missing `min-width: 0` on the page scroller, and
  the page being centred with `align-items: center`, which clips the *leading* edge of anything
  wider than its container rather than letting it scroll.

- **The sidebar toolbar was clipping its own buttons.** Eight tools never fit 252px and the
  sidebar hides its overflow, so the last two (Playground, Notebook) were being silently cut off
  the right edge at the default width. The row wraps now. Found by measuring the real layout in
  the preview harness rather than by reading the CSS.
- **The standalone UI preview (`npm run preview:ui`) was broken twice over.** It hadn't built
  since `App.tsx` began importing `addPluginListener`, which the Tauri mock didn't export; and
  once that was fixed it came up empty, because the mock had no `shell_snapshot` — so
  `refreshTabs` threw on `.tabs`, store init aborted, and the preview rendered with no tabs, no
  groups and no workspaces. Every surface that reads them looked broken for reasons that had
  nothing to do with them. Both fixed, plus mocked system stats, so the preview is representative
  enough to verify chrome changes in — which is the only way to look at them without a display.
- **Connections rail: "Show more".** The rail asked for exactly 8 related notes and there was no
  way to see past them. It still shows 8 by default — hits come back ranked, so the tail is
  monotonically weaker and a longer rail isn't a more useful one — but **Show more** refetches up
  to the backend's 20-result ceiling on demand, with **Show fewer** to collapse. A refetch rather
  than a client-side reveal, because the extra hits were never sent. The button appears only when
  the list is actually full: a short result means your corpus had nothing else, not that
  something is being withheld. Expanding resets on navigation, since it's a decision about the
  page you were reading rather than a standing preference.
- **OCR for scanned PDFs.** A PDF whose pages are images has no text layer, so Gemma and the KB
  saw an empty document and said nothing useful — with no indication why. The viewer now detects
  that case, says so plainly, and offers **Read with OCR**: each page renders at 2x (accuracy
  falls off sharply below ~200dpi) and goes to the local `tesseract` binary, one page at a time
  so progress is visible and a single unreadable page doesn't lose the rest.

  A subprocess rather than a Rust binding, because `leptess`/`tesseract-rs` link libtesseract at
  build time and would turn a pure-Rust cross-compile into a C toolchain problem on every target
  including the Android build. That also keeps OCR genuinely optional: with no binary installed
  the button never appears and Flux is exactly as it was. Images stream in on stdin and text
  comes back on stdout, so no page image is ever written to disk. The language argument is
  restricted to real traineddata names since it reaches a command line, and a page that hangs is
  killed after 45s.

  Recognised text is indexed under its own **`pdf-ocr`** source, never merged into `pdf`, so every
  citation carries that a machine read it off an image — the same treatment `scribe-ocr` gives
  handwriting.

- **Search spotlight — `Ctrl/Cmd+Shift+K`** (flux-plan1). The command palette answers "find
  something I already have"; this answers "search the web", which was otherwise only reachable
  through the omnibox — and the omnibox lives in the sidebar, so it vanished the moment you
  collapsed it. A row of quick destinations, the query field, and the engine's **related
  searches** beneath, which come from whichever engine you've set as default rather than a
  hardcoded Google.

  The toolbar carries the sidebar's **page tools** — bookmark this page, reader mode, save for
  offline, translate, capture, find, watch, install as app — rather than destinations, which the
  palette already lists and an icon-only row can't label anyway. (Bookmarking the current page was
  previously reachable only by `Ctrl+D`, with no palette entry at all.)

  Four buttons sit in the field: **⌂** start page, **🗁** file explorer, **▤** opens the result
  *beside* the current page as a split (also `Shift+Enter`), and **⌕** searches. Queries resolve through
  the same pluggable backend as the omnibox, so `!bangs`, keyword routing and the
  navigate-vs-search decision behave identically instead of being re-decided here. Typing
  something that's already a URL stops suggestions entirely — completing one returns noise, and
  it would hand the address you're navigating to over to the suggest endpoint.

  A separate lazy chunk (1.6 KB gzip); the eager chrome bundle moves 64.4 → 64.5 KB.

- **LaTeX blocks in Scribe** (#109). Insert an equation with **Σ Equation**, `Ctrl+M`, or just by
  typing `$$x^2$$` mid-sentence — it becomes a rendered block as soon as you close the delimiters.
  Click a rendered equation to edit its source; the block itself is one atom to the caret, so you
  can't land inside a fraction and corrupt it by typing, which is what makes Notion's equation
  blocks usable.

  The LaTeX lives in the node's `data-tex`, not in the rendering. That matters in three places: the
  document round-trips through `innerHTML`, so anything not in an attribute is lost the moment
  KaTeX re-renders; Rust recovers the equation by reading one attribute instead of parsing HTML;
  and a page opened before KaTeX loads still knows what it says. **Equations are indexed as their
  LaTeX** — a rendered equation's text content is KaTeX's glyph soup, which the KB would otherwise
  happily index and cite back at you.

  Half-typed LaTeX shows its source in red rather than blanking the block: an unfinished equation is
  the normal state of one you're still writing. KaTeX loads lazily (77 KB gzip, its own chunk) —
  nothing is fetched until a page actually has maths on it.
- **Gemma writes LaTeX too.** Anything she adds via `/note` goes through the same `$…$` / `$$…$$`
  convention and produces the *same* node as one you typed by hand, so her equations render as real
  typeset maths rather than arriving as escaped dollar signs.
- **Gemma can write to your notes — `/note <what to add>`** (#108). She drafts a new Onyx note, a new
  Scribe page, or an addition to an existing one, and you see **the exact text** before anything is
  written. Approving content rather than a description of content is the point: a card that said
  "adds a summary" while writing something else would be worthless.

  **She can only add.** The action vocabulary has no variant that replaces, rewrites, reorders or
  deletes — so a model that decides your notes would read better rewritten has no way to say so, and
  a prompt injection buried in a page cannot reach for a capability that doesn't exist. Appending is
  the most destructive thing expressible, and appending cannot lose text. A test fails if the
  vocabulary ever gains one of those verbs.

  Planning and applying are **two separate commands** with nothing joining them in the backend, so
  there is no path from the model's output to your vault that skips your approval — that's a missing
  edge in the call graph, not a policy someone has to remember. And because a generated path is
  still just text, it's checked to resolve inside the vault and to already exist before a byte is
  written: "append to `../../.bashrc`" would otherwise be a working instruction.

- **The canvas and WebGL surfaces follow the theme too.** The Liquid background and the agent
  Aurora had their palettes baked into GLSL, and the Trail graph, Omni graph and terminal had theirs
  as colour literals — so under Ember they'd have stayed teal and violet while everything around
  them turned red. They now read the theme's channels as numbers (`palette.ts` reads the *computed*
  custom properties, so `theme.css` stays the single definition and the two can't drift apart) and
  repaint on a theme change. The shaders take them as uniforms, refreshed only when the theme
  actually changes — `getComputedStyle` inside a draw loop would force a style resolution every
  frame.

  The terminal is the exception worth stating: its accents follow the theme, but **`red`, `green`
  and `yellow` stay put**. Those are what programs *mean* by them — a compiler error is red because
  red means error, and repainting it rose because the theme is rose would make `cargo` output
  unreadable.
- **Scribe notebooks sync through a shared folder.** Point Syncthing (or Dropbox, or anything) at
  Flux's Scribe folder and notebooks now merge across devices instead of clobbering.

  Three things had to change. `ScribeStore` read every notebook once at boot and never looked
  again — fine for a folder only Flux writes to, wrong the moment it's shared, so a notebook from
  another device was invisible until restart. It's watched now. Saving wrote the whole in-memory
  notebook over the file, so editing the same notebook on two machines meant whoever saved second
  won the lot; merging is **per page** — union by id, newer `ts` wins — so two devices adding
  different pages to one notebook keep both. And a deleted page came back on the next merge from
  the other device's older copy, so deletions leave tombstones inside the notebook file, which
  travel with it.

  Flux works out a page deletion by comparing what the editor sends back against what was stored —
  the editor deletes a page by saving a notebook without it, so there's no "delete page" call to
  hook. Re-adding a page with a newer timestamp beats its own tombstone; a tombstone isn't a
  permanent ban on the id.

  The folders, for Syncthing: `%APPDATA%\dev.flux.browser\scribe` on Windows,
  `~/Library/Application Support/dev.flux.browser/scribe` on macOS. Plaintext, like your Onyx vault
  — which also means block-level dedup works and only the changed part of a notebook transfers.
- **Closing tabs in bulk.** There was no way to close more than one tab at a time — only the per-tab
  ✕, `Ctrl+W`, and "Close current tab" in the palette. That's fine until a restored session opens
  thirty tabs across four workspaces and the only way back is thirty clicks.

  Three ways now: **✕ Close tabs** on each saved session (closes the tabs that session lists), and
  **Close all tabs in this workspace** / **Close every tab** in the command palette. All confirm
  first with the count, and say that `Ctrl+Shift+T` reopens them one at a time — and when you're
  closing more than the reopen stack holds (25), the confirmation says how many are actually
  recoverable rather than implying all of them are.

  Closing a session's tabs matches by URL, because nothing records that a tab *came from* a session.
  Tracking that would mean a tab carrying provenance it then has to keep correct through every move,
  pin and workspace change — so the simpler thing is done, and described honestly: it closes what
  the session lists, including a copy you happened to open yourself.
- **A restored session rebuilds your workspaces.** A session spans every workspace, but a saved tab
  only recorded `{url, title, pinned}` — so restoring one collapsed all of them into whichever
  workspace happened to be active, and did it on the same machine too, not just across devices.
  Tabs now carry their workspace **by name** (ids are per-device counters, so an id meaning
  "Coursework" here means something else there), and restoring matches names case-insensitively,
  creating any that are missing. Daily auto-snapshots get the same treatment — same shape, same
  problem.

  `pinned` was being recorded faithfully and then ignored on restore; it's applied now. Tabs open in
  the background, so restoring thirty of them doesn't yank focus thirty times and let the last one
  decide which workspace you end up looking at. Sessions saved before this load as before and
  restore into the current workspace.
- **Tasks and calendars sync too.** `flux-sync.enc` now carries your task lists, your Flux-local
  calendar events, and your calendar subscriptions alongside bookmarks, sessions and history — all
  with deletion tombstones, so removing a task on one device removes it on the other rather than
  having it reappear at the next merge.

  Tasks needed an `updated_ms` to work at all: an additive union sees a task it already has and
  skips it, so **ticking a box would never have propagated** — `done` would freeze at whatever the
  first device published. With the timestamp, the newer edit wins, which carries completion, renames
  and due-date changes across. Local events merge by date + time + title and an existing one is left
  alone: there's no per-event timestamp to say which wording is newer, so silently overwriting the
  other device's would be worse than keeping both devices' own.

  Calendar *events from subscribed feeds* are deliberately not synced — each device fetches those
  from the URL, so shipping them would be syncing a cache. The subscriptions themselves do sync.

  Task **list names** live in localStorage and don't sync, but each task carries its own list name,
  so the picker now derives lists from your tasks as well — otherwise a task synced from another
  device would exist with nowhere to appear.
- **Themes, and a purplish-red one: Ember.** Settings → Appearance, applied immediately. Deep
  oxblood base with a warm rose interactive colour, magenta-red for the agent surfaces, and ember
  orange for highlights — the velvet's plum undertone pushed all the way round to red, keeping the
  same near-black floor so the glass and shadows still read.

  Getting there meant tokenising the palette first: ~300 accent literals were hardcoded across the
  stylesheet, so *any* theme was a search-and-replace. They now resolve through six RGB channels
  named by role rather than hue (`--accent-rgb` is "the primary interactive colour", which happens
  to be teal in Velvet and isn't in Ember). A theme is now ~20 lines and nothing else.

  Two details worth knowing. Status colours are **separate channels**, because a theme may need to
  move them to stay legible but must never make "succeeded" and "failed" look alike — Ember's
  warnings go amber, since a pink-red warning is invisible beside a rose accent. And the theme is
  applied by an inline script **before first paint**: doing it from a Solid effect renders one frame
  in the default palette and then snaps, which reads as a bug on every launch.

### Changed
- **The toast matches the rest of Flux.** It was the one surface still styled inline in `App.tsx`,
  so it inherited none of the app's glass or motion tokens. It now rises into place rather than
  fading where it sits — a message that appears where nothing was is easy to miss at the bottom of a
  large window — and comes in three kinds, so a failure doesn't look like a confirmation. Motion is
  dropped under `prefers-reduced-motion`, and it never swallows a click on what it floats over.
- **Scrollbars match the rest of Flux, from one rule.** Every surface now draws the same rounded,
  inset thumb with hover and drag states, defined once against theme tokens
  (`--flux-scroll-*`) instead of being hand-rolled per component — five places had each written
  their own version of the same thumb at 8 or 10px wide.

  It uses `::-webkit-scrollbar` rather than the standard `scrollbar-width` / `scrollbar-color`
  deliberately: Flux ships on WebView2 and WebKitGTK, both of which implement the pseudo-elements,
  so the portability the standard properties buy is portability to browsers Flux never runs in —
  and in exchange we get width, radius, insets and hover states instead of two flat colours.

  **This fixed a live cross-platform bug.** Since Chromium 121, any non-`auto` `scrollbar-width`
  discards *every* `::-webkit-scrollbar` rule on that element. The bookmark bar, pages bar, tab-UI
  bar and folder strip each asked for `thin` *and* a hidden scrollbar — so Windows drew a bar the
  design had removed while Linux hid it. A test now enforces that the two mechanisms are never
  mixed, and that anything hiding a scrollbar hides it in both.

  Scoped to Flux's own chrome. Pages inside a tab keep their own scrollbars: restyling those means
  injecting CSS into every site, which breaks the ones that style their own.
- **The Trail moved from the sidebar to the foot of the connections rail.** Both surfaces answer
  "what else relates to what I'm looking at" — connections from your own notes, the Trail from your
  own browsing — so they now share a column instead of sitting on opposite edges of the window.
  It also buys back sidebar height, and the Trail survives collapsing the sidebar, which used to
  hide it outright.

  It sits *below* the connections rather than above: the rail's own results are what change on
  every navigation, and the Trail answers "where have I been" rather than "what do I already know".
  The map gives up height first when the column is short, since it was sized for a sidebar it had
  to itself. Connection cards now fade at the scroll edge instead of being sliced mid-height, which
  became obvious with the Trail directly beneath.

  One consequence worth knowing: with the connections rail hidden, the Trail is no longer in the
  chrome at all — `flux://trail` and the command palette are the ways back to it.
- **The collapsed sidebar is a real rail.** It used to show pinned tiles and nothing else, which
  made collapsing a way to *lose* your open tabs rather than a way to reclaim width — switching
  tabs meant expanding again first. It now mirrors the expanded sidebar's order at 72px: pinned
  tabs, open tabs, a workspaces button, then the footer, separated by hairline rules so the groups
  read as groups. Only the open-tab group scrolls, so the pinned tiles and the workspace button
  hold the position your hand expects when a page opens.

  Three things the layout needed once measured: the 22px right gutter (reserved for the workspace
  dot rail, which collapsed doesn't render) was costing a third of the usable width and the 36px
  tiles were overflowing a 25px box; the footer's dozen toggles stacked single-file ran ~440px
  tall on a 720px screen and left almost nothing for the rail, so collapsed it goes two-up; and
  tiles at the scroll boundary were sliced clean in half, which read as a rendering fault rather
  than as "there's more below" — they fade now.

  The workspace button carries the active workspace's colour (a collapsed sidebar otherwise gives
  no clue which one you're in) and opens a panel listing all of them, anchored to the button's
  measured position rather than a guessed offset from the window bottom, since the footer's height
  depends on which toggles are on.
- **KB embeddings are int8 in a binary sidecar, not JSON floats (5x smaller, 5x faster to load).**
  Every embedding was persisted as decimal text inside the index — 3.5x the size of the raw bytes,
  spent entirely on rendering numbers as strings — then re-parsed in full on every boot. Measured
  at 60k chunks x 768 dimensions: a **623 MB** file taking **1.09 s** to parse and **1.16 s** to
  write, against a retrieval scan of ~3 ms. Storage cost three orders of magnitude more than the
  thing it existed to serve.

  Vectors now live in a `kb-index.vec` sidecar, quantized to int8 with a per-row scale, as one
  contiguous matrix. Same corpus: **125 MB**, **207 ms** to load, **209 ms** to write, and the
  resident vectors drop from 176 MB to **44 MB**. Rows sit end to end at a fixed stride, so the
  scan walks memory linearly instead of chasing a pointer per chunk — which is worth more than
  hand-written SIMD would have been, since that loop is bandwidth-bound.

  **Retrieval quality is measured, not assumed:** a test scores 2k vectors against exact f32 and
  requires recall@8 of at least 99% with per-hit score drift under 0.01. Existing indexes migrate
  on first load rather than re-embedding — for a model-embedded corpus that would mean re-running
  every Ollama call. Rows are paired to chunks *by position*, so a sidecar that doesn't match the
  index is refused outright and the Notebook panel is told a reindex is needed; serving it would
  attribute every hit to the wrong document, and nothing about the results would look wrong.
- **KB retrieval now uses the whole CPU (~8x faster).** `kb_query`/`kb_related` is the
  highest-frequency CPU loop in Flux — the connections rail re-runs it on every navigation — and
  it was a single-threaded linear scan that scored *every* chunk into a freshly allocated vector
  and then paid an O(n log n) sort to return 8 rows. It now scans in parallel and keeps only a
  running top-`k`. Measured on 16 cores at 768 dimensions (embeddinggemma): 2k chunks 854µs → 147µs,
  20k chunks 8.8ms → 986µs, 60k chunks 26ms → 3.1ms.

  Ranking is **unchanged, including ties.** The old order came for free from a stable sort over
  corpus order; parallel folds have no such guarantee, so equal scores now break explicitly toward
  the earlier chunk. Without that, two identical queries could return the same hits in different
  orders and the rail would reshuffle for no visible reason. A test asserts the parallel result is
  identical to the serial scan it replaced. Corpora under 512 chunks stay serial — waking worker
  threads to rank 40 notes costs more than it saves.
- **Reindex embeds in batches instead of one HTTP round trip per document.** The KB issued a
  separate Ollama call per note, so a 500-note vault paid 500 sequential round trips to embed a few
  thousand short paragraphs. Chunking now runs in parallel across documents, and the chunks are
  embedded as one stream batched at 64. Remote batches stay *sequential* deliberately: Ollama
  serializes inference per model, so concurrent requests would move the queue rather than shorten
  it. The hash embedder, being pure CPU, does fan out across cores.

  This also removes an accidental O(n²): each document's `n_chunks` was computed by filtering
  every chunk built so far.

### Fixed
- **Unlocking a second device too early silently forked your sync.** The key comes from your
  passphrase **and the salt in the blob header** — so a device that unlocks while the folder is
  still empty mints a fresh random salt and derives a *different* key from the same passphrase. It
  then publishes a blob the first device can't open, and can't open the first device's either. Same
  passphrase, no error, two sync identities that never see each other. Unlock now reports when it
  creates a new identity, and the page says what to do about it: lock, wait for `flux-sync.enc` to
  arrive, unlock again.
- **Auto-sync rewrote the whole blob every three minutes, unchanged.** `seal` draws a fresh nonce
  each time, so identical data produces entirely different ciphertext — the file-sync tool
  underneath sees every block change and re-transfers the lot. At a half-megabyte blob that's ~10 MB
  an hour of pure churn per device, plus a full copy in versioning history each tick. The payload is
  now hashed *before* sealing (the plaintext is stable; the ciphertext never is) and the push is
  skipped when nothing changed.
- **A successful first sync reported itself as doing nothing.** `SyncReport` counts only the *pull*
  side — items new to this device — so the first machine into an empty folder got "merged 0
  bookmarks, 0 sessions, 0 history entries" despite having just published everything it had. Same
  message when a device was simply already up to date. Correct, and it reads as failure in both
  cases.

  The report now carries whether a remote blob existed and what this device published, and the page
  says which of the three things happened: *"no data from other devices yet — published 12
  bookmarks…"*, *"already up to date — published …"*, or *"received … ; published …"*. The push
  always happens, so there's always something true to say.
- **Renaming things did nothing, everywhere.** `window.prompt` is a **no-op in this webview** — it
  returns `null` without showing anything — so renaming a Scribe notebook, setting its course,
  naming a whiteboard, setting the calendar's week 1, and creating a task list were all dead. They
  looked implemented and silently weren't. Every one now uses a real dialog, and there are zero
  `window.prompt` call sites left in the app.

  Its replacement keeps `prompt()`'s shape — one `await`, resolves to the text or `null` — because
  the more a fix costs at each call site, the more sites keep the broken version.
- **Asking Gemma in plain words to write a note did nothing.** `/note` was the only route, so
  "save this into my Convex notebook" fell through to ordinary chat — and she'd answer as though
  she had written it. No approval card, no write, no indication that either was missing.

  The original reasoning was half right: writing is the one thing she does to your own files and
  must never happen because a question was misread. But that conflated *"don't write without
  asking"* with *"don't even offer"* — and the approval card is what protects your notes, while
  planning never writes. So detection is generous now: a false positive costs one click on Discard,
  a false negative costs the feature. Questions **about** your notes stay questions ("what did I
  write about duality" is not a request to write), and if the model finds nothing to propose, the
  message is answered normally rather than dead-ending. `/note` still works, and still gets told
  *why* when there's nothing to write.
- **Inserting an equation did nothing.** The Σ Equation button and `Ctrl+M` went through
  `window.prompt`, which is a **no-op in this webview** (a fact already documented in
  `Sidebar.tsx`) — so only typing `$$…$$` inline ever worked. There's a proper editor now: a
  monospace source field with a **live preview**, block/inline toggle, the parse error spelled out
  when the LaTeX doesn't compile, `Ctrl+Enter` to insert, `Esc` to cancel. Clearing the source of an
  existing equation deletes it, which is the only way to remove a block you can't select into.

  The preview is the point rather than decoration: LaTeX you can't see rendered is LaTeX you're
  writing blind. (Note for later: `window.prompt` is still used for renames in ScribePage,
  WhiteboardPage and CalendarPop, and is equally dead there.)
- **Flux's own pages were invisible to the agent.** A `flux://` page (Scribe, the Notebook, the
  Trail…) is a Solid component in the chrome's DOM, not a native webview — so nothing injected the
  capture script and **no internal page ever published its text**. "All tabs" skipped them, the
  connections rail had no page to relate anything to, and `/note` had no context, in every case
  silently: a missing snapshot looks exactly like a page that hasn't loaded yet.

  They publish now. (`domPublish` existed and had never had a caller — it targets a `fluxtab`
  plugin command, and the chrome window isn't granted `fluxtab:default`, so calling it would have
  been denied. The new path is an app command.)
- **"All tabs" quietly answered from *some* tabs.** Tabs with no captured text — asleep, or never
  brought to the front — were dropped without a word, so the model answered from a subset while
  believing it had everything, and would state a thing wasn't there when it simply hadn't been read.
  They're now listed as unread, with an instruction to say so rather than deny.
- **A handwritten Scribe notebook didn't exist as far as the KB was concerned.** Pages with no typed
  text produce no searchable body, and each was skipped — so a fully handwritten notebook indexed to
  **zero documents**, and asking about it got "the sources contain no information about that
  notebook". True of the corpus, and badly misleading about reality. Every notebook now indexes a
  card of its own: name, course, page count, and which pages are handwritten and untranscribed, so
  the answer becomes "it exists, here's how to make it readable" rather than "it doesn't exist".
- **The agent answered "My notes" from a stale index.** Indexing was manual — the ↻ button in the
  Notebook panel was the *only* caller of `kb_reindex` — so a page you'd just written in Scribe, or
  a note you'd just made in Onyx, simply wasn't there, and the agent answered from whatever that
  button last captured without any sign that it was doing so. That's the actual reason "My notes"
  came back empty.

  Scribe, its transcripts, and Onyx now reindex themselves. Edits mark the source and a background
  worker rebuilds it once the writing stops (3s), rather than on every save — `scribe_save` fires
  about twice a second while you type, and rebuilding each time would re-embed the same page dozens
  of times. Because the rebuild skips documents whose mtime hasn't moved, only the pages you
  actually changed get re-embedded.

  Onyx gets a real filesystem watch rather than a poll, since the whole point of that vault is that
  it's edited outside Flux — notes written in the Onyx TUI become answerable without touching
  Flux at all.
- **The collapsed sidebar's workspace panel rendered under the page.** Native tab webviews are an
  OS layer above *all* chrome HTML, so no amount of z-index puts an overlay over them — the page
  has to be hidden while one is open. `store.ts` has a registry for exactly this, with a comment
  warning that forgetting to add a flag is a recurring bug class; the panel's flag was a
  Sidebar-local signal the registry couldn't see. It lives in the store now, and a `createEffect`
  drives the native layer from it, since Sidebar has no access to the show/hide helpers.

  Worth noting for next time: being *in* the registry only stops something else from re-showing the
  page — it doesn't hide it. Store-driven overlays need both.
- **OCR'd PDFs indexed to nothing.** `kb_reindex` passed an empty list for the `pdf-ocr` corpus, so
  text that OCR had extracted, published and stored was dropped on the way to the index — the
  connector existed and was never called. Anything read out of a scanned PDF was therefore
  unfindable and uncitable, with no error to explain it.
- **Transcribed handwriting was excluded from "my knowledge".** Rust's `OWN_SOURCES` omitted
  `scribe-ocr` while the TypeScript mirror included it, so the two lists disagreed about whether
  your own transcribed Scribe pages count as yours. They do — a machine only read them.
- **`kb.rs` was invisible to code search.** A stray literal NUL byte inside a comment (which was
  itself describing NUL handling) made `grep` classify the 1777-line module as binary, so every
  text search of it silently returned nothing. It compiled fine, which is why it went unnoticed.
- **Mail: mark all as read.** The ✓ button marks every unread message in INBOX, after a
  confirmation naming the count — because this is the one thing the mail module changes on the
  server, and the change shows up everywhere else the account is open.

  Worth stating plainly: the module was **structurally** read-only before this, and now it isn't.
  Listing still issues only `SELECT`/`SEARCH`/`FETCH` and reads envelopes rather than bodies, so
  *looking* at the pane can never mark anything seen. `STORE +FLAGS (\Seen)` is deliberately the
  only write it can perform — no deletes, no moves, no `APPEND` — so "did Flux touch my mailbox?"
  has one possible answer rather than an audit. The module docs say so rather than still claiming
  a guarantee that no longer holds.
- **Task manager: per-interface network, disks, and a graph for every GPU.** The network card
  summed all interfaces, which hides whether it's the ethernet or the VPN doing the work — the
  usual question. Each interface now has its own row, busiest first, with loopback filtered
  server-side (it would otherwise top the list on a dev machine). A disks card shows each mounted
  filesystem's free space, colouring at 75% and 90%; capacity only, because sysinfo exposes no
  per-disk I/O and a rate invented from process counters would be a guess. And GPU history is
  tracked per device rather than for the first one, so a second card is no longer a graphless
  stub — which is the card a two-GPU machine actually wants to watch.

- **The page overhung the web-panel column on every restart until you clicked.** A tab's webview
  is opened with the card rect measured at that moment, but at startup the panel column mounts
  *while* that open is still in flight. The resize was observed, yet the re-run took the
  "currently opening" branch, which never requests a relayout — so the stale rect was applied and
  nothing corrected it until an unrelated event happened to re-run the layout effect. That
  unrelated event was your click. The bounds are now re-applied from live geometry once the
  webview is actually open. Since a native webview is an OS layer *over* the card, this also
  covered the lower part of the panel — which is why the task manager appeared to stop below the
  GPU card.
- **A calendar pinned to the dock column didn't come back on restart.** The restore check accepted
  only the older `"panel"` dock mode; the dock *column* saves `"dock"`, and that value was never
  added when the column shipped — so the one mode built to be permanent was the one that didn't
  persist.
- **Disk enumeration takes 30-53 seconds on some machines; nothing waits on it now.** The warning
  added in the previous release fired with real numbers — six volumes, 30064ms / 50816ms /
  32173ms / 52939ms — so the cache it shipped with was useless: a 30s TTL on an operation that
  takes up to 53s is stale before it lands, and the next request starts another. The wait is
  inside the OS call, so there is no timeout to set. `tasks_disks` therefore never blocks: it
  returns what was last learned (an empty list on the first call) and refreshes on a background
  thread, one at a time, with a 5-minute TTL. A disk card that populates a minute late beats an
  IPC call that can hang for a minute. The slow-enumeration warning now names the mount points so
  the offending drive can be identified and unmapped, and `FLUX_NO_DISKS=1` skips it entirely.
- **Slow startup and intermittent stalls: an Ollama round trip on the boot path.**
  `embedding::current()` reads like a cheap accessor — "which embedder would we use?" — but it
  answered by sending a real embedding request to Ollama and seeing whether one came back. That
  ran during setup, with `window up` gated behind it: 113ms on one launch and **3330ms** on the
  next, the difference being whether Ollama had the model loaded. Worst case it inherited the 30s
  read timeout. It was also called per-call on file search, watch evaluation and KB reindex.

  Three changes. The probe is now `/api/tags` instead of a trial embed, so it can't trigger a
  model load and still distinguishes "model pulled" from "server up but model missing", with 1s
  connect / 2s read timeouts because a probe that waits is a probe that hangs its caller. The
  result is cached for 60s — Ollama starting, stopping, or gaining a model are human-scale events,
  so a minute-stale answer is fine and the cost of asking wasn't. And `ArchiveStore` resolves its
  embedder lazily on first use rather than at construction, so boot performs no network I/O at
  all; `TraceSnapshots` already carried that warning in a comment and the archive store hadn't
  honoured it.
- **The build stamp lied about which commit was running.** `FLUX_BUILD_STAMP` exists so the first
  line of every log answers "is this the binary I just built?" — but it watched only `.git/HEAD`,
  which committing on the branch you are already on leaves byte-identical. Cargo therefore never
  re-ran the build script, and the stamp reported whatever commit it happened to be built at,
  sometimes many commits stale. It now watches `.git/logs/HEAD` as well (appended on every commit,
  checkout, reset and merge) and appends `+dirty` when the tree has uncommitted changes. A build
  stamp that lies is worse than none, because it gets believed — this one sent a live freeze
  diagnosis down the wrong path.
- **Flux could stop responding with the task manager open.** The disks card polled a volume
  enumeration every 2 seconds along with CPU and memory. That call is not a cheap in-memory read
  like the rest of the task manager: on Windows it stats every drive letter, and a mapped network
  share that has gone away or a sleeping external disk can block it for many seconds. A call per
  tick that each outlive the tick stack up until nothing responds. Disks are now cached for 30s
  server-side with only one enumeration ever in flight, polled once a minute instead of every 2
  seconds, and an enumeration slower than 500ms logs a warning naming the likely cause — so a
  stalling drive shows up as a log line rather than an unexplained freeze.
- **The task manager's header was hidden behind the panel toolbar.** `.panel-toolbar` is
  `position: absolute; top: 0`, and a native panel clears it because its webview is positioned
  from `.panel-placeholder`'s rect. A DOM page had no such rect and started underneath it. Same
  34px offset now, from the same reason.
- **Flux's own pages can be pinned as web panels** — the Trail, Omni, Settings, the notebook and
  the rest, beside the page rather than as a tab. This needed a refactor rather than a URL
  change: a web panel is a native webview pointing at a URL, and a `flux://` page isn't a URL at
  all — it's a Solid component `ContentArea` rendered through a 22-arm switch, so there was
  nothing for a webview to load.

  That switch is now `InternalPage`, a component any surface can host. `ContentArea` renders it
  for the whole card and once per tile; the panel column renders it in the slot a native webview
  would have covered, and the tiler is taught not to open a webview for an internal panel (an
  empty native surface over DOM). `ContentArea` lost 126 lines.

  The PDF viewer is the one exclusion: it resolves its file from the *tab* it belongs to, and a
  panel has no tab, so it would open empty. Pinning it is disabled rather than offered and broken.
- **A frontend test runner** (`npm test` in `apps/shell`, vitest) with 16 tests covering the
  tiling geometry, the group algebra and the tab-strip layout. These were verified by throwaway
  scripts when written, so nothing guarded them afterwards — and split view regressed twice in
  ways typecheck cannot catch. Configured for `node`, not jsdom: nothing here touches the DOM,
  and pulling jsdom in for tests that don't need it is install weight for no coverage. Verified
  by reintroducing the "only the active group is drawn" bug and watching the suite fail.

### Changed
- **The task manager is answer-first.** It was a good btop-style monitor: four cards of numbers,
  a sorted process list, and the work of finding the culprit left to you. Now it opens with a
  **verdict** — one line naming what's constrained and what's holding it ("Memory is the
  constraint — 91% used, and chrome holds 6.2 GB") — and each resource card names its own top
  consumer, an idea taken from COSMIC's 2026 system monitor.

  Memory is a **treemap** rather than a column of numbers. "One process holds 6 GB" and "forty
  hold 150 MB each" are indistinguishable in a sorted list and obviously different as areas.
  Tiles are grouped by process family (a browser is dozens of processes), click one to filter the
  list, and Flux's own footprint is tinted its own colour — "lighter than Chrome" is a claim this
  project makes and should be checkable at a glance.

  The layout is squarified (Bruls–Huizing–van Wijk) rather than sliced, because slivers carry no
  area a reader can judge — with 9 groups the worst aspect ratio measures 5.7 against 100%
  coverage and no overlaps. It's a pure function with 11 unit tests, which is what the new
  frontend test runner was for.

  **It works pinned as a web panel.** The breakpoints are *container* queries, not viewport ones:
  in a panel this page is ~340px wide inside a 3440px window, and a media query would lay it out
  for the display it isn't on. Each step drops what's least useful rather than scaling everything
  down — the per-core bars go first (sixteen 6px slivers are noise), then the PID column, then
  the CPU column. Tile labels are their own containers, so a name hides itself when its tile
  lacks the pixels rather than being clipped; measured at 1000/640/400/300px, zero clipped labels
  and no horizontal overflow at any width.

  **And it scrolls.** In a narrow column the cards stack tall, so the page now scrolls as one
  document rather than pinning its height and delegating to the process list — an inner scroller
  in a strip that size swallows the wheel before the page sees it. Measuring that also turned up
  a pre-existing flaw: the page was `overflow: hidden`, so in any window short enough for the
  cards to exceed the height, the surplus was clipped and unreachable at *full* width too. It
  scrolls instead of clipping now.
- **The agent's "My notes" scope no longer searches browsing snapshots.** It passed no source
  filter, so it answered from every corpus including pages you'd merely visited — which the
  Trail already graphs separately. Scoped to your own corpora, matching the connections rail.
  `OWN_SOURCES` now has one definition in `ipc.ts` instead of a per-file copy.
- **Scribe handwriting → LaTeX, transcribed by the local vision model** (BACKLOG #137's headline
  fast-follow). The 🔍 Transcribe button reads a page's ink through the same Ollama vision path
  Lens already uses (`gemma3:4b`, `FLUX_VISION_MODEL` to override) and returns LaTeX, which is
  what a maths page actually wants — a plain-text approximation of an integral is worthless.

  **The result is never written back into the page**, and it is indexed under its own KB source
  (`scribe-ocr`) rather than alongside your own writing. That is the point: a vision model can
  transcribe a symbol that was never on the paper, and once indexed that sentence would be
  citable as though you had written it. Citations now carry a **machine-read** marker, the review
  panel shows plain LaTeX rather than rendered maths (rendering hides exactly the small errors
  you are checking for), and the model that produced it is recorded with the text.

  Also: `reindex` now takes a `Corpora` struct instead of a growing list of positional `Vec`s. A
  `None` source rebuilds everything, so a call site that forgot one would silently wipe that
  corpus — there are four now, and four bare vectors in a row is the shape that invites passing
  them in the wrong order.
- **PDFs are visible to Gemma, and go into the knowledge base.** A PDF open in the built-in
  viewer used to be invisible to the agent for two separate reasons: `capture.js` never runs
  there (the viewer is Flux's own DOM, not a webview, so no snapshot existed), and the agent's
  "All tabs" scope filtered out every `flux://` url. Both are fixed.

  The text comes from **PDF.js's own text layer** — already parsed for search and selection —
  rather than parsing the file a second time in Rust with another dependency. It's published as
  the tab's snapshot, so per-page chat and "All tabs" read a PDF exactly as they read a web page,
  and it's *stored*, so the document stays answerable long after the tab closes. That store is a
  new `pdf` KB source, auto-indexed on the same settle rule as Scribe.

  A scanned PDF with no text layer stores nothing rather than an empty document — the knowledge
  base shouldn't claim to know a paper it can't quote a word of. The snapshot is built directly
  rather than routed through `dom_publish`, which would also have written browsing history, the
  Trail and Omni — none of which should record an internal viewer page.
- **Download feedback on the footer ⬇.** Previously the only signal was a count badge appearing
  and vanishing, which reads as "something stopped" rather than "your file arrived". The button
  now has three distinct states: a progress ring while downloading (aggregate across everything
  in flight), a slow bob on the arrow so activity is legible in peripheral vision, and a one-shot
  pulse with an expanding halo when a download completes.

  When no running download reports a size, the ring sweeps instead of filling — a ring that
  jumped to 100% because one item had `total: 0` would be worse than none. Under
  `prefers-reduced-motion` the movement is dropped but the *information* is kept: the ring still
  shows its fill and completion still tints the arrow.
- **Mail in the dock column — read-only IMAP, no OAuth.** Connect with an app password (Gmail
  needs 2-factor authentication to issue one) and the newest 20 INBOX messages show as sender,
  subject and age, unread carrying the weight and a teal edge. Clicking one opens *exactly* that
  message in Gmail via an `rfc822msgid:` search rather than guessing from the subject.

  **Read-only structurally, not just by intent:** the module issues `SELECT`/`FETCH` and nothing
  else — no `STORE`, no flag changes, no deletes — so glancing here cannot mark anything seen in
  your real client. The password goes to the OS keychain and only *after* the server accepts it,
  so a typo can't be stored as though it worked. Config lives beside it with no secret in the
  file.

  A connection is made per fetch rather than held open: a long-lived IMAP session needs
  keepalives, reconnect-on-drop and locking, and this pane refreshes on demand or every two
  minutes while visible. RFC 2047 header decoding is included (base64 and quoted-printable,
  UTF-8 and Latin-1) — without it any non-English subject reads as line noise — and an unknown
  charset is left as written rather than mangled.
- **A dock column: calendar above mail, in a layout column of its own.** Both used to compete
  for the web panel — docking the calendar there left a pinned site sharing the same strip — so
  this frees the panel entirely for something else. Structurally it's the agent/terminal stack
  again: one width charged once, two slots, a draggable seam, and it reuses that CSS rather than
  growing a parallel set. Toggle it from ⌘K ("Show calendar + mail column"); the width and split
  persist, and it sheds under the same responsive rule as the other columns.

  The calendar now has three placements, so its ⇥ button **cycles** — floating over the page,
  sharing the web-panel column, or its own column above mail. A two-way toggle would have
  stranded the third, and keying the dock column off "is the calendar open" rather than "is its
  placement here" would have drawn it in two columns at once.

  The mail pane is a placeholder for now, and says so — "no mail" and "not set up" look identical
  otherwise. IMAP with an app password lands next: read-only, no OAuth, no Google Cloud project.
- **Terminal tabs can be tiled.** A lecture sheet beside nvim now works: any tab joins a split,
  terminals included. They were excluded because a terminal doesn't render like the other
  internal pages — it lives in an always-mounted layer so its PTY and scrollback survive tab
  switches (#73), and that layer only ever filled the whole card. It's now positioned into its
  tile slot instead, and the panes block no longer skips itself when a terminal is the focused
  tab. No DOM pane is drawn for a terminal's slot: an empty one would sit *above* the terminal
  layer and swallow every click meant for the shell.

  `TerminalView` also gained a `visible` prop distinct from `active`. One prop was doing both
  jobs, and a tiled terminal is on screen without being focused — it has to re-measure when it
  appears, but must not steal the caret from the pane you're typing in. Only the active terminal
  draws the WebGL backdrop, so tiling several doesn't multiply GPU contexts (#75).
- **`FLUX_PAGE_SCRIPTS`** — a diagnostic switch for bisecting a page that only misbehaves under
  Flux. `none` injects no page scripts at all; a comma-separated list injects only those named.
  An unknown name selects nothing rather than falling back to everything, so a typo can't look
  like a passing test. The startup log says when it's limiting injection, since it disables real
  features while set.
- **Clear browsing data, and a warning when it grows too large** (Settings → Browsing data,
  plus the resource monitor). Flux had no way to see or clear what the engine keeps on disk —
  every other browser does — and a service-worker `CacheStorage` had quietly reached **753 MB**
  with nothing surfacing it.

  Settings measures the engine's profile by group — service workers, cache, site storage,
  cookies — flags any group far past a sane size, and clears what you select. Cookies are a
  separate group so clearing junk never silently signs you out. The resource monitor shows the
  on-disk total next to RAM and raises a banner when a group is abnormal.

  **Clearing is deferred to the next launch.** The engine holds those files open while running,
  so a live delete either fails or half-succeeds and leaves the profile worse. The queued clear
  records **absolute paths resolved at queue time**, so the boot pass deletes exactly what was
  measured rather than re-deriving the layout.

  Honest note on why this was built: it was written while chasing a renderer crash, on the
  belief that the oversized cache was causing it. It wasn't — the crash was injected scripts
  calling the IPC bridge at document-created, and clearing the caches changed nothing. The
  feature stands on its own (a browser should let you see and clear this), but it fixed no crash.

### Changed
- **The calendar + mail column has a footer button (✉).** It shipped reachable only from the
  command palette, which made it effectively invisible — every other column in Flux has a button,
  so this one looked like it didn't exist. The toggle moved into the store so the sidebar and the
  palette drive the same state.
- **Each message in the mail pane is its own card.** A borderless list ran together at column
  width, where sender and subject are both single truncated lines and the boundary between two
  messages was doing no work. Unread keeps the card and adds a lit edge and warmer fill, so the
  two states differ by more than font weight.
- **`TerminalView` is a lazy chunk.** It was imported eagerly by three files while xterm itself
  was already lazy inside it, so every session paid for it whether or not a terminal was opened.
  Moving it out took the eager chrome bundle from **70.0 KB (over budget) to 62.6 KB** — more
  than its own size, since it was pulling its dependencies in with it.
- **Scribe drawings: transparent, cropped to the ink, and resizable on every axis.** Inserting a
  drawing exported the *entire* 900×620 pad including its background and grid, so a small sketch
  arrived as a mostly-empty opaque rectangle that covered the text beneath it and looked far too
  small once placed. It now crops to the ink's bounding box and renders on transparency —
  measured on a corner sketch: 900×620 → 168×88, 97% of the exported pixels dropped, and the ink
  itself 5× wider at the same placement width. An empty pad inserts nothing instead of a blank
  box, and the object is sized from the drawing rather than a fixed 560px.

  Resizing had one corner handle that locked the aspect ratio. There are now edge handles that
  stretch width or height freely, with the corner still proportional.

### Fixed
- **The agent only saw the first ~6 KB of a page** — about ten slides of a lecture PDF, after
  which it answered confidently about the part it could see. That budget was tuned for a web
  page, where "visible text" is mostly navigation and boilerplate; a document publishes its whole
  text and needs far more. Raised to 32 KB, roughly five times as much.

  The ceiling is the context window, not the number: `num_ctx` covers prompt *and* reply, and
  when the prompt overflows Ollama drops the **oldest** tokens — which is where the instructions
  live, not the document. So a test now asserts the budget still fits inside the auto-grown
  context with room to answer, verified by raising it to 64 KB and watching the test fail with
  the exact arithmetic.

  For a document longer than this will ever hold, the answer isn't a bigger budget — it's
  retrieval. PDFs are indexed in the knowledge base now, so the agent's **My notes** scope
  answers from the relevant chunks of a whole lecture course rather than stuffing one file.
- **Scribe notebooks that arrived without being edited never reached the knowledge base.** The
  auto-indexer watches a change counter, which only moves on a mutation — so a notebook copied
  from another machine, restored from a backup, or simply present before the indexer existed
  would sit unindexed until something happened to edit it. There's now a single startup pass
  when the corpus is on disk but the KB has no `scribe` docs at all.
- **Scribe notebooks now reach the knowledge base on their own.** They were indexed only by a
  manual ↻ Reindex, so anything written since was invisible to the agent's "My notes" scope —
  only browsing had a background indexer. Scribe now uses the same settle rule: the store carries
  a change counter, and the indexer re-embeds once it stops moving, so the debounced autosave
  doesn't re-index a notebook on every keystroke. Note this covers **typed** text only; ink is
  stored as PNG objects and nothing OCRs it (BACKLOG #137), so a page of pure handwriting still
  indexes as empty.
- **The agent's "My notes" tooltip was wrong.** It claimed "Onyx + Scroll" while the scope passes
  no source filter at all, so it searches every indexed corpus — Council debates, Scribe pages
  and snapshots of visited pages included. The tooltip now says what it actually searches.
- **Scribe: each new stroke in the Draw pane erased the previous one.** `InkCanvas` is a
  *controlled* component — it rebuilds from `props.strokes` on every commit, so the parent must
  hand back the updated array. ScribeDoc passed a plain `let`, which Solid reads once at
  creation and freezes, so every stroke was appended to the original empty array and only the
  newest survived. It's a signal now, matching how the whiteboard has always fed the same
  component. Opening the pane also starts from a blank pad rather than the previous drawing.
- **Signed-in github.com crashed the renderer** (`STATUS_ACCESS_VIOLATION`). Two of Flux's ten
  injected page scripts called the IPC bridge *synchronously at document-created* — before the
  parser had produced `<html>`. Doing that kills the WebView2 renderer outright: a null-pointer
  read at a fixed offset inside `msedge.dll`, with no Flux code in the faulting process at all.
  `passwords.js` and `drafts.js` were the only two scripts that did it, and the only two that
  reproduced the crash on their own; the other eight make no bridge call until the document
  exists. Both are deferred now.

  The engine fault is Microsoft's — a null dereference is never the caller's fault, and the same
  page loads in Edge at the identical runtime version — but Flux was provoking it on every page
  load. A test now asserts no injected script calls the bridge at document-start, verified by
  reintroducing the bug and watching the test fail: this failure mode is a hard crash with
  nothing in the page console to explain it, so it needed a guard rather than a comment.
- **Flux wrote no log on Windows at all.** Release builds set
  `windows_subsystem = "windows"`, so there is no console and everything `tracing` emitted went
  nowhere — which made the browser undiagnosable on its main platform, and made every
  "check the startup log" instruction impossible to follow. Logs now also go to
  `%LOCALAPPDATA%\dev.flux.browser\flux.log` (`~/.local/share/...` elsewhere), truncated at 4 MB
  because an unbounded log is the same mistake as an unbounded cache.
- **Tracking prevention didn't persist.** The level lived in an in-memory `AtomicI32` that was
  never written to disk, so it silently reverted to Balanced on every launch — which also made
  it useless as a workaround for a site that a higher level breaks. It's saved now and restored
  at boot, with a test covering the case most likely to be mishandled: level **0 (Off)** must
  survive, rather than being treated as absent and falling back to the default.
- **`FLUX_NO_QUIC=1` didn't actually disable HTTP/3.** It only omitted `--enable-quic`, and
  HTTP/3 is the WebView2 default — so the opt-out silently did nothing and a round of debugging
  was spent treating QUIC as ruled out when it never had been. It passes `--disable-quic` now,
  with tests asserting the disable flag is present.
- **One injected script throwing silently killed every script after it.** All of Flux's page
  scripts share a single initialization script, so a top-level error aborts the rest of the
  blob — with nothing watching the page console, the features just quietly stopped existing.
  `passwords.js` observed `document.documentElement` unguarded, and that is null at
  document-created (WebView2 runs the script before the parser produces `<html>`), so on
  github.com it threw *"Failed to execute 'observe' on 'MutationObserver': parameter 1 is not
  of type 'Node'"* and took the rest of itself — including the focusin retrigger that makes
  autofill work — plus all of `drafts.js` with it. That also explains why the autofill *interval*
  fix worked where the observer never did: the interval is registered a few lines earlier, on
  the surviving side of the throw.

  Two fixes: `passwords.js` now uses the same deferred guard `capture.js` already documented,
  and each script is wrapped in its own `try/catch` when the blob is assembled, so a future
  throw is contained and *named* in the console instead of cascading. Verified by replaying the
  real concatenation under a document-created shim: before, a top-level throw and execution
  never reaching the end of the blob; after, neither.
- **Splits vanished from the tab strip when you clicked away, and a second split was never
  visible.** Both symptoms were one bug: the strip collapsed tiled tabs into a row using
  `tileGroup()` — the group the *active* tab is in — and emitted at most one such row. So a
  split dissolved into loose tabs the moment you focused an unrelated tab and re-formed when you
  clicked back, and with two splits open only the active one could ever be drawn. The strip is
  now built from every group. The tiling itself was working: both splits were live in the
  content area the whole time, which is why "multiple tiling doesn't work" and "the tabs
  ungroup" turned out to be the same report.
- **A Flux page never offered "⊟ Split with current tab"** in the tab context menu — the fourth
  place gated on "is a real web page", after the ◫ row, the picker's candidates and `tilePanes`.
  It now uses the same tileable-page rule as the rest. "Exit split view" likewise appears for a
  tab in any group, not only the active one.
- **Launching Flux from inside a tmux session broke terminal persistence.** Flux's whole process
  tree inherited `$TMUX`, so wrapping the shell in `tmux new-session` looked like nesting and
  tmux refused with *"sessions should be nested with care, unset $TMUX to force"* — leaving the
  terminal with no persistence and a cryptic message. `TMUX`, `TMUX_PANE` and screen's `STY` are
  now cleared from the spawned shell's environment: a Flux terminal is a new terminal, not a
  pane of whatever launched Flux. (Note this is *not* the same as typing `tmux attach` inside a
  Flux terminal that is already a tmux session — that message is tmux correctly refusing to
  nest, and Flux re-attaches on its own with no manual attach needed.)
- **Several split views coexist again.** The tiling rework collapsed the model to one group at
  a time, on an assumption written into the code as "tiling several independent groups was
  never used" — which was wrong. Tab A tiled with B and C tiled with D are both remembered
  again: switching to C shows C|D, switching to an untiled tab shows it whole and leaves every
  group intact. A tab still belongs to at most one tiling (otherwise switching to it couldn't
  say which split to show), so picking one that's already tiled elsewhere moves it — and the
  picker now marks those candidates with a ◫ so that isn't a surprise. Saved splits from the
  previous build are migrated rather than dropped.
- **A Files tab in a tiling rendered nothing.** `tilePanes` required `kind === "browser"`, so a
  Files pane was filtered out and the group silently fell below two panes. It now excludes only
  terminals, matching the rule the picker uses.
- **Flux's own pages can be tiled from their own toolbar.** The ◫ split-view button lived in
  a page-actions row gated on "is a real web page", so the Trail, Omni, the task manager,
  Scribe, Settings, the start page and Files tabs had no ◫ at all — tiling them was only
  possible via ⌘K → *Split view*, and they couldn't be picked as a pane either. The row now
  shows for every tileable page with only the web-specific actions (bookmark, reader, capture,
  translate, archive, watch, save-to-Omni) gated, and the picker offers any tileable tab.
- **Tiling a non-web pane could have positioned a webview that doesn't exist.** The tiled
  branch of `paneLayout` filtered panes by url alone, while the single-pane branch also
  checked `kind` — and a terminal or files tab keeps a filesystem path in `url`, so the url
  test passes for it. Both branches now apply the same rule.

### Known limitation
- **Terminal tabs still can't be tiled**, and are deliberately excluded from the picker rather
  than offered and broken: they render in a separate keep-alive layer (#73) that shows only the
  active terminal full-card, and ContentArea skips the tiled panes entirely while a terminal is
  active. Tiling one means teaching that layer about tile rects — and deciding what to do about
  the WebGL-context limit that currently lets only the visible terminal draw its backdrop (#75).
- **The connections rail is no longer hidden behind the music bubble.** The rail was never
  truncated — the bubble was pinned to the right edge and vertically centred, directly on top
  of the rail's middle, covering a 386px band of the list when expanded and swallowing clicks
  when collapsed. It's draggable now, and its default corner leaves the top of the list (the
  highest-scoring matches) clear.
- **Tiling was laggy, especially while dragging a seam** — three costs, all on the per-pointer-move
  path:
  - Panes were rendered with `<For>`, which keys by **reference** — and the geometry function returns
    fresh rect objects on every ratio change, so each pointer move tore down and **remounted every
    pane's entire page**. They use `<Index>` now (keyed by position), so the elements persist and only
    their geometry updates. This was the dominant cost.
  - Every ratio change wrote the group to `localStorage` **synchronously**, JSON-encoding it dozens of
    times a second mid-drag. The signal still updates instantly; the disk write is debounced to when
    the gesture settles.
  - The pane list was recomputed several times per render (for the rects, the seams, and once per
    pane's page lookup), each time scanning every tab. It's memoized.
- **Scribe didn't rescale to its pane, so split view was unusable** — a regression from the document
  rewrite: the old canvas fitted the page to its viewport on every resize, while the document rendered
  at a fixed 1240px and only rescaled when you pressed a zoom button. The page now **fits its pane by
  default** and re-fits whenever the pane changes — a split seam, the sidebar, the agent/terminal
  column, or the window. −/+ still set an explicit zoom, and the percentage button returns to fitting
  (and highlights while it's doing so). The scaled page also gets a real layout footprint now:
  `transform` doesn't affect layout, so the scroll box previously reserved the full 1240px and forced
  a horizontal scrollbar even when the page had been scaled down to fit.
- **The Connections rail almost never surfaced Onyx notes** — its relevance floor was a search-shaped
  number (45/100) applied to a very different kind of query: ~2400 characters of a *whole page*,
  navigation and boilerplate included, which dilutes cosine against a focused note far more than a
  typed query does. Lowered to a documented 30, so genuinely related notes actually clear it.
- **A docked calendar didn't survive a restart** — the dock *mode* persisted but the open/closed state
  didn't, so Flux always started with it closed and you had to reopen it every session. A **docked**
  calendar now reopens on launch, like the pinned web panels it shares the column with. The **overlay**
  deliberately doesn't: it hides the page, and a modal covering your first tab at startup is hostile
  rather than helpful.
- **Expanded home widgets centred on the window, not the home page** — the ⤢ overlay was
  `position: fixed` and sized in `vw`/`vh`, so with the sidebar, agent or panel columns open it sat
  visibly off-centre and its dim spilled across the whole window. It's now page-relative: the dim
  covers exactly the home page's box and the panel centres inside it. (`.start` is
  `position: relative` and never scrolls — its inner widgets box does — so this stays pinned to the
  visible page.)
- **The docked timetable view still wouldn't scroll** (the month view did) — the week grid carries its
  own scroller, which is right in the wide overlay but makes it a **nested** scroller when docked: the
  wheel over the grid was swallowed by it, so the tasks below never came into view. Docked, the grid
  now grows to its full height and the pane's single body scroller moves past it.
- **The docked calendar's body wouldn't scroll** — its sections are flex children that *can* shrink
  (`flex: 1 1 auto` + `min-height: 0`, which is how they share the wide overlay's row). In the docked
  column that layout is vertical, so instead of overflowing the scroller they collapsed to fit it:
  nothing to scroll, and the content clipped rather than reachable. Inside the docked pane everything
  is now content-sized (`flex: none`), so the body overflows and scrolls properly.
- **The docked calendar took the whole web panel, so it couldn't share with a mail/chat panel** — it
  sized to its content (`flex-basis: auto`), which pushed pinned panels out of the column entirely
  rather than sharing it. The column now splits between the calendar and the panels below it, with a
  **draggable seam** (persisted, 20–80%), and the calendar's body **scrolls internally** instead of
  growing the column: its header stays put while the month grid, agenda and tasks scroll together.
  Verified in a browser — a 454px calendar over a 372px mail panel in an 860px column, nothing pushed
  out, and the body scrolling inside its share.
- **The autofill scan is now guaranteed to run, by a timer the page can't cancel** — the previous
  max-defer ceiling wasn't enough: the rescue delay lived in the *same* timer that every DOM mutation
  clears, so on a form mutating each animation frame it was cleared before it ever got a slot, and the
  scan stayed starved. A separate interval (1.5 s, capped at ~45 s) now runs the scan independently of
  the mutation churn. A throw inside the scan is also reported now, since from outside it looked
  identical to being starved.
- **Autofill never appeared on Microsoft/Entra-style sign-ins: the scan was starved, not broken** —
  the page script debounced its form scan by 600 ms on every DOM mutation, with no ceiling, while its
  MutationObserver watched `class`/`style` across the whole subtree. A React SSO page mutates faster
  than that continuously (focus rings, spinners, ARIA), so each mutation cancelled the pending scan
  and **it never ran once** — no chip, and nothing to indicate why. The debounce now has a max-defer
  ceiling: it still waits for quiet, but never defers longer than 1.8 s. Found by the new diagnostic,
  which reported "the script is running but never finished a scan" — the exact signature of a starved
  debounce.
- **The autofill diagnostic can now tell "not injected" from "didn't scan" from "login is in an
  iframe"** — its first real run returned "the page script never reported back", which was still three
  causes wearing one answer. `passwords.js` now sends a heartbeat the moment its Tauri bridge is
  confirmed, so silence specifically means *the script isn't running here*; a scan that finds no login
  field reports whether the page contains frames, since autofill deliberately runs only in the top
  document (an embedded third party must never be able to trigger a fill).
- **Autofill never offered on two-step sign-ins (ANU / Microsoft / Google SSO)** — the offer scan
  required a visible `input[type="password"]`, and step 1 of those logins has only a username field,
  so no chip ever appeared. The *fill* path was taught about username-only screens earlier; the
  **offer** path wasn't, which is why it kept failing after that fix. The scan now falls back to the
  page's login/username field when there's no password box.
- **"Why didn't autofill offer here?" is now answerable** — `vault_page_info` deliberately collapses
  locked / phishing-blocked / no-saved-login into one identical "locked" reply, so a hostile page
  learns nothing from probing it. Correct for the page, useless for you: every failure looked the
  same. A new chrome-only `vault_why` (never in the page ACL) names the actual stage — no host, the
  Sentinel firewall withholding on a suspected impersonation, a locked vault, no match for the host —
  and the page script now reports its own bail reason from a fixed vocabulary (no form, field
  prefilled, dismissed), so DOM-side causes are visible too. Surfaced as **🩺 Why no autofill here?**
  in the Passwords popover.
- **The timetable grid stopped partway down the enlarged calendar pane** — hour rows were a hard-coded
  42px, so a typical 10-hour day filled 420px of a 661px area and left a third of the pane empty. The
  row height is now measured from the available space (min 34px, below which the grid scrolls instead
  of squashing). It has to be a measured number rather than a CSS `1fr`: event blocks are absolutely
  positioned from the same value, so letting CSS stretch the rows alone would have slid every block
  off its gridline. Verified in a real browser — the grid now fills exactly, and a 09:00 block lands
  on the 09:00 line to the pixel.
- **"＋ Calendar" vanished from the home calendar widget** — the new calendar picker widened the card's
  action row, which didn't wrap, so the last button was pushed off the edge. The action row now wraps
  and the picker is compact (and truncates) in that cramped header, so a control added there can't
  silently displace another one again.
- **The timetable's styles were overriding the home calendar's expanded week grid** — the new week view
  reused nine class names (`.cal-week`, `.cal-week-head`, `.cal-week-dow`, …) that the home calendar's
  expanded grid already owned, and being later in the stylesheet it won. The timetable's classes are
  namespaced `.tt-*`, so the two grids no longer collide.
- **The connections rail said "nothing connects" when the real problem was an empty index** — the
  empty state now names the actual cause: indexing in progress, a knowledge base with zero documents
  (pointing you at ↻ Reindex), or a genuine no-match, which reports how many docs it searched. Same
  invisible-failure class as the autofill and classifier bugs: one message covering three very
  different states made a working feature look dead.
- **Floating panes resize from any edge or corner, not just one small corner grip** — app panes and TUI
  panes are now real windows: eight grips (four edges, four corners), with north/west drags anchoring
  the opposite edge so the pane grows in the direction you pull. The grips sit above the pane body,
  which previously swallowed the pointer (an iframe or a terminal captures events over the old 18 px
  corner square). Move + resize geometry now lives in one shared `paneGeometry.ts` instead of being
  duplicated per pane.
- **Google Calendar in the app dock showed an error instead of a calendar** — it serves
  `x-frame-options: SAMEORIGIN`, so it can never render inside the pane's iframe. Apps can now declare
  `noFrame`, and those open in the **native-webview side panel** (#48) instead — a real OS webview,
  which framing rules don't apply to — pinned on first use and toggled thereafter, so the calendar
  stays glanceable beside whatever tab you're on. This is the same surface Discord/Teams already use
  for the same reason; that helper was generalized to `openSitePanel` rather than duplicated.
- **Flux wrongly warned that Microsoft's own login page was impersonating Microsoft** — and worse, the
  credential firewall then refused to autofill there. The brand-embedding rule treats a brand appearing
  as a prefix/suffix compound as an attack, which is right for `paypalsecure.com` and wrong for
  `microsoftonline.com` — Microsoft's real Entra ID sign-in domain. A whole class was affected:
  `googleapis.com`, `googleusercontent.com`, `amazonaws.com`, `githubusercontent.com` and
  `paypalobjects.com` were all flagged as high-confidence impersonations. Structure alone can't
  separate those from a real lookalike, so Flux now carries the set of domains each brand **actually
  owns** and never flags a brand on its own domain. Genuine attacks (`paypal-secure.com`,
  `microsoft-login.com`, homoglyphs like `rnicrosoft.com`) are unaffected.
- **"Fill" skipped its own copy-to-clipboard fallback whenever the fill failed** — precisely when you
  needed it. Fill now copies the password regardless of whether the injection succeeded, and says what
  went wrong *and* that the password is on the clipboard. Copy also falls back to the legacy clipboard
  path for embedded webviews that refuse the async Clipboard API.
- **Auto-archive was silently closing tabs in workspaces you weren't looking at** — the stale sweep
  filtered on kind, pinned, foldered, the active tab and staleness, but **not on workspace**. It read
  the global tab list (every other consumer filters by workspace; this one didn't), so tabs in *every*
  workspace were reaped on the same timer — invisibly, because you weren't there to see it, and with
  only the single active tab protected. The sweep is now scoped to the **active workspace**: one you
  haven't opened is parked deliberately, which is the opposite of stale.
- **Restoring an archived tab now returns it to the workspace it came from** — archive entries didn't
  record one, so anything you reopened landed in whatever workspace you happened to be in, scattering
  a project's tabs. Entries (and whole rabbit-hole branches) now remember their workspace **and its
  name**, so a workspace deleted since is **recreated under its old name** rather than dumping its
  tabs elsewhere, and the sidebar follows the restore there so it doesn't reopen out of sight. Older
  entries have no recorded workspace and restore into the current one, exactly as before.
- **Autofill did nothing on two-step sign-in pages** — Microsoft Entra, Google and most university SSO
  show the **username field first** and the password only on the next screen. The injector bailed
  entirely unless it found a password field, so those pages filled nothing at all — and because the
  injected script's result can't be read back, the UI reported success. Username and password are now
  filled **independently**, so a username-first screen gets its username, and the password screen gets
  its password. Visible/disabled fields are also filtered out, so a hidden or decorative input can't
  win over the real one.
- **Fill now also copies the password to the clipboard, and there's an explicit Copy button** — the
  fallback for anything the injector genuinely can't reach: a custom login widget, a cross-origin
  frame, or a password screen that hasn't rendered yet. Rather than claim a success it can't verify,
  Fill leaves the password on the clipboard so you can always paste.
- **Multiple PDFs can now be open in separate tabs** — opening a second PDF overwrote the first: every
  PDF tab shared a *single* viewer instance that read whichever tab was **active** rather than its own,
  so all of them showed the last-loaded file. Each PDF tab now gets its own viewer, keyed on the tab id
  (the same pattern the file browser already used), with its source, document and edits scoped to that
  tab.
- **PDFs larger than 32 MB now open** — the viewer refused them outright. The cap wasn't arbitrary:
  the bytes crossed the IPC bridge **base64-encoded**, so a 32 MB file became a 43 MB base64 string,
  which `atob` expanded into a ~64 MB binary JS string before a byte-at-a-time copy into a
  `Uint8Array` — roughly **5× the file in transient memory**, which is exactly what a low-RAM browser
  can't afford. The bytes now travel raw over Tauri's binary IPC channel and arrive as an
  `ArrayBuffer`, costing one copy instead of five, so the limit could rise to **256 MB** — it now
  tracks what the renderer can hold rather than what the transport survives. Large scanned documents
  and textbooks open, and every PDF loads faster and lighter, not just the big ones.

### Fixed
- **The workspace rail's popover vanished before you could reach it** — it sits 8px from the dot, and
  that gap was a dead zone where nothing was hovered, so the popover disappeared the moment you moved
  toward it. Its buttons (rename, delete) were effectively unreachable by mouse. A transparent hover
  bridge now spans the gap so the path is continuous.

### Changed
- **The connections rail shows your own writing only** — Onyx notes, Scroll papers, Council
  debates and Scribe pages. Visited pages (the `web` corpus) are excluded now that the Trail
  has its own graph in the sidebar; listing them in both places showed the same browsing
  history twice. Scribe pages also get their own icon, and the empty state counts only the
  corpora the rail can actually draw on.
- **Split view is now a tiling manager for up to four tabs** — it was a hard-coded pair (one seam, two
  panes). You can now tile **2, 3 or 4 tabs** in preset arrangements: side-by-side, stacked, **quad**,
  and *one large pane plus the rest* in any of the four orientations — with draggable seams
  (double-click a seam to even it out). The split picker became a multi-select: tick up to four tabs,
  then pick a layout; the layout list adapts to how many panes you've chosen, and keeps your choice
  when it still fits. Closing or leaving a tiled tab drops just that pane, and the group survives a
  restart. The sidebar shows the whole group as one row.
  - Under the hood, **one pure function owns the geometry** (`tiles.ts`). Native webviews are placed
    by the tiler in viewport pixels while Flux's own pages are DOM laid out in percentages — with a
    single hard-coded "left | right" those two agreed by accident, but across seven layouts and
    multiple seams two implementations would have drifted on the first edit. Both now call
    `tileRects()`, and a check confirms they describe the same panes to within 4px on every layout.
- **Scribe's page is now a document, not a canvas** — typing was the main activity but the old model
  made it the awkward one: every line was placed by clicking, and fixing a typo meant reopening a
  block. The page is now an ordinary **rich-text editor** — real caret, selection, backspace across
  lines, bold/italic/underline, H1/H2, bulleted and numbered lists — and **drawing is something you
  insert**: the ✏️ Draw button opens a drawing pane (the same ink engine), and what you draw lands on
  the page as an image you can **drag and resize**. Existing pages are upgraded on open: typed blocks
  become paragraphs and the ink is flattened into one full-page image, so nothing is lost (though old
  ink is no longer editable stroke-by-stroke, which is inherent to ink-as-object). Two things improve
  as a result: the knowledge base indexes the page's **real prose**, and publishing to Onyx prefills
  the note with the page's text instead of only embedding a picture of it.
- **The agent and terminal now share one right-hand column, stacked** — agent on top, terminal below,
  with a draggable seam between them. They were two side-by-side columns, so opening both cost two
  widths (~860px); now the column's width is charged **once**, which is most of the screen this gives
  back on a laptop display. Either pane alone fills the column, both together split it at a remembered
  ratio, and the responsive allocator now sheds one column instead of two. The shared width is seeded
  from the old agent column, so an existing install doesn't jump on first launch.
- **Home calendar events get the same translucent treatment as the calendar pane** — the event rows
  under the month grid are now translucent cards like the pane's agenda rows, and the expanded week
  grid's blocks are glass rather than an opaque gradient, so the grid lines read through and
  subscribed (read-only) events carry the same cooler teal tint the timetable uses.
- **The calendar pane is much larger** (up to 1040×760 from 680×600) — the week timetable needs room
  to show a full teaching day without scrolling, and the month view's day agenda gains the space too.
- **Rename buttons for tab groups and containers** — an audit after the workspace fix found the same
  asymmetry in both: delete (✕) was a visible button while rename was an undocumented double-click.
  Both now have a ✎ beside the ✕, matching what tab *folders* already did correctly. (The audit also
  checked every other offset popover — the omnibox suggestions, music toast, agent model menu, and
  footer popovers are all state-toggled rather than hover-revealed, so the disappearing-popover bug
  was unique to the workspace rail.)
- **Renaming a workspace is now discoverable** — it was already possible, but only by double-clicking
  the name inside a hover popover on the workspace rail, which left **delete (✕) as the only visible
  control**: the destructive action was one click, the safe one was hidden. There's now a **✎ rename
  button** beside it, and **"Rename workspace"** and **"New workspace"** entries in the command palette
  (workspaces had no palette entries at all). The palette route un-collapses the sidebar and leaves
  focus mode first, so it works from wherever you are.

### Fixed
- **Long AI prompts were being silently truncated, breaking the features that need them most** — the
  Ollama context window (`num_ctx`) covers prompt *and* output together, but was pinned at 4096 while
  the policy reader sends a 12 KB document and multi-tab chat sends 12 KB of page text. Ollama drops
  the **oldest** tokens on overflow — exactly where the "reply with one JSON object" instruction sits —
  so the model saw a bare document with no task, rambled, and hit the output cap, surfacing as a
  truncated-JSON parse error that looked like model weakness but was our own configuration. The context
  now grows to fit the prompt plus room to answer (clamped to 16K so RAM stays bounded), the structured
  output cap moved 512 → 1536, and a truncated reply now reports **why** it was truncated and how to
  raise it instead of failing with an opaque parse error. Flux also neutralizes the repetition penalty
  on schema-constrained calls: JSON is legitimately repetitive, so a prose-tuned `repeat_penalty` (some
  Modelfiles set 1.2) penalizes the very tokens the grammar requires.
- **Every AI feature that returns structured data was silently failing against a real model** — models
  append chat-template residue (`<|tool_response>`, role markers) *after* the JSON they were asked for,
  and Flux parsed the whole reply, so `serde_json` rejected it with "trailing characters". Because a
  parse error is treated as "model unavailable", each affected feature degraded **quietly**: the AI
  phishing verdict never refined anything, the policy reader returned no clauses, the permission note
  and tracker insight never appeared — with nothing anywhere saying why. Parsing now takes the first
  balanced JSON object from the reply (string- and escape-aware), which is strictly more permissive, so
  it only ever turns a silent failure into a success. Affects all 11 schema-constrained agent paths,
  including page actions and reader structuring. Found by the new live-model eval below.

### Security
- **Live-model behavioural eval for the agent (ADR 0013 — closes the "model capability + eval" open
  question)** — the existing tests prove the trust boundary *structurally* (hostile text always lands
  inside the untrusted fence; actions come from a fixed Rust-validated vocabulary). They cannot show
  whether a **real** model, handed a properly fenced hostile page, still misbehaves. New opt-in harness
  (`FLUX_EVAL=1 cargo test -p flux-agent --test injection_eval`) scores four batteries against local
  Ollama: chat injection resistance, destructive-action resistance, phishing-verdict accuracy on
  curated positives *and* lookalike-but-legitimate negatives, and — the case that matters most —
  whether page text can argue the classifier into **clearing** a phishing flag. Skipped entirely
  without `FLUX_EVAL=1` or a reachable model, so CI stays green. It reports a score against a floor
  rather than asserting perfection: the goal is to measure how much the deterministic layer must carry,
  not to pretend the model is trustworthy alone. Current local result (gemma3 12B): **100% on all
  four**. Its first run is also what surfaced the structured-output parse bug above.
- **Sensitive-input focus intercept (ADR 0013 — Sentinel, Pillar 1)** — the phishing warning now fires
  **before your first keystroke**. The moment a password (or one-time-code) field takes focus on a site
  that impersonates a brand you value, the chrome-layer banner names the brand and offers the exit —
  rather than warning only after the credential has already been typed and submitted. This closes the
  case the navigation check structurally can't cover: a lookalike whose own label sits in your
  known-good set *because you were phished there once*. The page is told **nothing** — the command
  answers nothing and the warning travels out-of-band to the chrome — so a phishing kit can't detect
  the guard and adapt to it, and the host is derived from the webview's own label, never from the page.
- **Agent activity log — you can finally read it (ADR 0013 — Sentinel, Pillar 0)** — the sealed
  audit log has been recording every action the agent runs on your behalf since M1, with nowhere to
  see it. New **`flux://sentinel`** page (palette: "Agent activity log", or Settings → Privacy) lists
  each action newest-first: what it was, when, which tab, whether the destructive deny-list matched,
  and whether it carried explicit confirmation. Actions that ran **unconfirmed** are called out at the
  top rather than rendered as just another row — the read≠act gate is meant to make that impossible,
  so if one ever appears it should be loud. Clearable, and clearing is sealed to disk so it survives a
  restart. Local-only, encrypted at rest with the same key ladder as your browsing history.
- **Sentinel navigation path consolidated (ADR 0013)** — the five per-navigation Sentinel IPC calls
  (phishing, OAuth, sensitive-site, phishing refinement, consent decode) are now **two**:
  `sentinel_on_navigate` runs every deterministic check in one round trip, and `sentinel_after_load`
  runs the two model-backed passes once the page text is captured — reading the page snapshot **once**
  so both agree on exactly which page they judged. The shell drops from two deferred timers to one.
  The known-good brand set (which reads the vault and 300 Trail entries) is now **memoized for 30s**
  instead of being rebuilt on every check — it moves only when you save a credential or revisit a
  host, and the seed brands are always present regardless. Behaviour is unchanged; neither pass wakes
  the local model without cause.
- **Dark-pattern / cookie-consent decoder (ADR 0013 — Sentinel, Pillar 3, M5)** — the pattern is
  familiar: "Accept all" is one tap, refusing is buried behind "Manage preferences" and a dozen
  toggles. Flux now detects a consent banner, explains **what accepting actually enables**, and gives
  the refuse button back — **one tap to "Refuse non-essential"**, from chrome the page can't restyle or
  hide. The click vocabulary ("reject all", "necessary only", "continue without accepting", …) lives
  **in Rust, not in the model** — the agent may *explain* a banner but never chooses what gets clicked,
  keeping this on the right side of the read≠act firewall — and it only fires when you press the
  button. Flux claims no success it can't verify: the page's own banner disappearing is the feedback.
- **Privacy-policy / ToS red-flags (ADR 0013 — Sentinel, Pillar 3, M5)** — nobody reads these
  documents, so the local model reads one for you. On a policy or terms page Flux offers *"Read it for
  me"*, and surfaces **at most three clauses that actually affect you** — data sold or shared, tracking
  across other sites, indefinite retention, a content licence over what you upload, forced arbitration,
  unilateral changes — each with one plain sentence on why it matters. Runs **only when you click**
  (it reads a long document), and says nothing rather than inventing concerns when the document is
  clean or no model is running. Descriptive only: it reports what the document says, it never advises.
- **Tracker-graph narrative (ADR 0013 — Sentinel, Pillar 3, M5)** — the tracker graph now explains
  itself in a sentence: *"Across 12 sites you visited, 47 third parties were contacted. Flux blocked
  312 of 418 requests (75%). google-analytics.com appeared on 9 of them, so it could link those visits
  together."* The figures are **computed in Rust**, never by the model — a small local model asked to
  summarize statistics will eventually corrupt one — and the model is asked only what the facts *mean*
  in practice, shown beside them. So the summary is always present and always matches the graph, the
  interpretation is a bonus that simply disappears when no model is running, and the narrative never
  delays the visualization.
- **Sensitive-site containerization (ADR 0013 — Sentinel, Pillar 2, M4)** — banking, health, and
  government sessions carry the highest-value cookies on the web, and a tracker in another tab has no
  business sharing a jar with them. Flux now recognizes those sites on navigation and offers a one-tap
  **"Open isolated"** — routing them into a reusable *Secure* container (#59 isolated cookie/storage
  jar). Not a warning: nothing is wrong with the site, it's a privacy upgrade, and waving it off is
  remembered per host so it never becomes a nag. The offer is also suppressed when the tab is already
  in a container or private. Deterministic and deliberately narrow — `.gov`/`.mil` domains, known
  finance brands, and explicit banking/health words in the domain — never "you have a password saved
  here", which would match GitHub and Reddit and train you to dismiss it.
- **Context-aware permission prompts (ADR 0013 — Sentinel, Pillar 2, M4)** — when a site asks for your
  camera, microphone, location, notifications, or clipboard, the local model reads what the page
  actually is and adds **one short line** to the existing prompt: a video-call app needing the camera
  is expected; a recipe blog wanting your location gets an amber *"a recipe page has no obvious reason
  to need your location."* Purely advisory — it annotates, it never allows or denies, and the buttons
  are unchanged. The bar appears instantly and the note fills in when it arrives, so the model is never
  on the prompt's path and a missing model leaves the prompt exactly as it was. Page text is fenced as
  untrusted, so a page can't talk the assessor into vouching for its own request.
- **Credential-entry firewall (ADR 0013 — Sentinel, Pillar 2, M4)** — the vault now refuses to put a
  saved password into a site that impersonates a brand you value. Autofill is **blocked with an
  explanation** naming the brand, and the in-page fill chip and credential picker don't appear at all
  (the safest prompt is the one that never invites the fill). If you *manually* type a login on such a
  site, the "Save password?" bar is replaced by a **red warning** — "you just entered a password on
  `paypa1.com`, which looks like PayPal; change your PayPal password now" — and offers no save.
  **Closes a self-whitewash hole:** saved vault origins feed the known-good brand set, so a credential
  saved *on* a phishing site would have marked that site "known-good" and permanently suppressed its
  own warning. At credential time the host's own label is now dropped from the set first, so a
  lookalike can never vouch for itself. The warning also fires ahead of the "never save here" opt-out
  and works with the vault locked — neither is a reason to stay quiet about credential theft.
- **OAuth consent review — see what an app is really asking for (ADR 0013 — Sentinel, Pillar 1, M3)** —
  the subtlest phishing uses a *real* domain: a genuine `accounts.google.com` / `github.com` consent
  screen granting a **malicious app** broad scopes ("read & send all your email", "full control of your
  repositories"). There's no lookalike to catch — the *request* is the attack. Flux now decodes the
  requested OAuth scopes into plain English and shows them in an un-spoofable chrome-layer strip
  **before you click Allow**, sensitive grants flagged and led with, the app named by its redirect host.
  Deterministic, local, and **precise by design**: routine "Sign in with Google" (`openid email
  profile`) grants nothing sensitive, so it stays **silent** — the review appears only when an app
  reaches for real access to your account.
- **AI phishing verdict — the local model refines the detector (ADR 0013 — Sentinel, Pillar 1, M3)** —
  when the deterministic layer flags a lookalike, Flux now wakes the on-device model to *read the page
  the way you see it* and judge whether it's actually impersonating the brand. It can **escalate**
  (a `paypa1.com` that renders a PayPal login → high-confidence red interstitial, with the model's own
  one-line reason) or **clear a false positive** (an unrelated site that merely shares a name → banner
  dismissed), so warnings stay rare and precise. The model never runs on clean pages (only after the
  cheap layer fires), reads page text as **fenced untrusted data**, returns a schema-constrained
  `{verdict, brand, reasons}`, and is **memoized per (url, content-hash)**. Strictly **fail-safe**: if
  Ollama is down, the model is missing, or the page text hasn't been captured yet, the deterministic
  verdict stands — a missing model can never *remove* a warning, only add nuance. 100% local.
- **Phishing detection engine (ADR 0013 — Sentinel, Pillar 1, M2)** — a deterministic, no-LLM
  detector (`sentinel::phishing`) that flags a domain trying to *look like* a brand the user values:
  homoglyph folds (`paypa1`, Cyrillic-`а`-`pple` → `paypal`), typosquats (`gooogle`, 1–2 edits), and
  brand-embedding (`paypal-secure`, `login-apple`). Suppresses the real brand and unrelated domains.
  Assessed against the user's impersonation-target set — **vault origins (strongest) + Trail-frequent
  hosts (engagement-weighted) + a curated seed** — all local. On every page load Flux now checks the
  URL and, if it resembles a brand you value, shows a **warning banner** above the content card (a
  chrome-layer strip the page can't spoof) — amber for a resemblance, red for a likely impersonation,
  with a "Leave site" exit. Advisory, never a hard block. Chrome-JS budget re-baselined 65 → 66 KB.
- **Stored-injection defense for the knowledge base (ADR 0013 — Sentinel, Pillar 0, M1)** — retrieved
  KB content (your saved notes/papers) fed back to the agent is now fenced as untrusted at the point of
  use, in both `kb_answer` (the grounded Notebook Q&A) and `kb_check` (the novelty/contradiction check
  on save). A prompt injection embedded in a page you clipped weeks ago can no longer hijack the
  agent's answer when that note resurfaces — the sources remain usable *as data* (answers still cite
  them), only embedded *instructions* are inert.
- **Prompt-injection red-team suite (ADR 0013 — Sentinel, Pillar 0, M1)** — a test battery of hostile
  page content (classic "ignore your instructions", fake requests, forged fence markers) proving the
  structural trust boundary holds: injected text always lands *inside* the fence as data and can never
  change the fence count to escape it. Complements the existing action-compiler injection test.
- **Per-tab confidentiality in multi-tab chat (ADR 0013 — Sentinel, Pillar 0, M1)** — the agent's
  cross-tab reads are limited to the tabs the frontend explicitly passes (the model can't widen that —
  it emits a text answer or a fixed-vocabulary action, never "read another tab"), and each tab's body
  is now **individually fenced as untrusted** with a sanitized one-line header, so a hostile tab in the
  set can't forge another tab's header to impersonate it or bleed into its section.
- **Agent action audit log (ADR 0013 — Sentinel, Pillar 0, M1)** — every action the agent runs on
  your behalf (`agent_run_action`) is now appended to a `crate::sentinel` log — what, when, which tab,
  whether it was flagged destructive, and that it was user-confirmed — **sealed at rest with the same
  AES-256-GCM key ladder the trace stores use**. Append-only (bounded), lazy-hydrated, flushed on the
  shared 60s tick. A security control (tamper-evident record) and a trust/debug surface (a viewer UI
  is a follow-on).
- **Agent trust boundary (ADR 0013 — Sentinel, Pillar 0, M1)** — page/DOM/tab/KB text fed to the
  local agent is now treated as untrusted input: every prompt that embeds it (`plan`, `step`, `chat`,
  multi-tab chat, reader-structure, author-CSS, translate) fences the content in
  `⟦UNTRUSTED_WEB_CONTENT⟧` markers and carries a standing instruction that nothing inside is a
  directive — so a page can't inject "ignore your instructions and …" to hijack the agent. Forged
  fence markers in page content are stripped so the fence can't be closed early. Complements the
  existing read≠act defense (agent actions come from a fixed Rust vocabulary with a destructive-action
  deny-list, never free-form from the model).

### Added
- **Mobile menu drawer + tab thumbnails (ADR 0012)** — the phone's ⋮ drawer is now a purpose-built
  menu (`MobileMenu`): a grid of Flux destinations (Notebook, Trail, whiteboard, History, Bookmarks,
  Settings, …) plus a New-tab action, replacing the desktop Arc sidebar that rendered mostly empty
  there. The **tab switcher** now shows a **cover image** per tab — a real page snapshot taken with
  `PixelCopy` (after load and when a tab is shown), downscaled and shown behind the favicon/title,
  Chrome-style. `View.draw()` renders blank for hardware-accelerated WebViews, so PixelCopy's read of
  the composited surface is the working path; if a copy fails, it falls back to the page's `og:image`,
  and tabs with neither keep the monogram.
- **Shields on macOS** — the WKWebView build gets ad/tracker blocking too. macOS compiles the *same*
  content-blocker JSON Flux already generates for WebKitGTK into a `WKContentRuleList` (declarative,
  like Linux — not per-request like Windows/Android) and attaches it to each webview's user-content
  controller via Cocoa FFI. Closes the macOS Shields no-op gap. (Untested on-device — no macOS SDK on
  the build box; the async `WKContentRuleListStore` block FFI wants a real-Mac compile + verification.)
- **Shields on the mobile WebView (ADR 0012, Milestone 3)** — ad/tracker blocking now works while
  browsing on Android. The native WebView's `shouldInterceptRequest` calls back into the *same*
  `ShieldsState::should_block` the desktop uses, over a JNI bridge (`android_jni.rs` ↔ the Kotlin
  plugin's `nativeShouldBlock`) — the mobile analogue of the Windows `WebResourceRequested` path
  (Android's system WebView can't use the WebKit content-blocker JSON that Linux/macOS do). The global
  toggle and per-site allowlist are honored (they live inside `should_block`), and the blocked count
  ticks up like on desktop. First cut is domain/URL blocking; request-type-specific rules (`$script`
  etc.) and the per-site tracker graph are follow-ons. Enabled by default.
- **macOS build support** — `scripts/install-macos.sh` runs `tauri build` and installs **both**
  `/Applications/Flux.app` (the icon'd app) and the `flux` CLI to `~/.cargo/bin`, clearing the
  Gatekeeper quarantine on the local build (macOS prerequisite checks: Xcode CLT, Rust ≥ 1.80, Node).
  macOS uses the native WKWebView, so per-tab browsing works (unlike the Linux/WebKitGTK build);
  Shields' network blocking + HTTPS-only + the download interceptor are no-ops there (Windows/Linux
  only). README gains a macOS install section.

### Changed
- **Flux pages bar is now on by default** — the quick-access strip of native pages (Notebook, Trail,
  whiteboard, …) above the content card now shows unless explicitly turned off (`flux.pagesbar`),
  matching the bookmark bar. Still hidden on the barebone mobile build.

### Fixed
- **Mobile UI no longer pinch-zooms** — the shell's viewport is locked (`maximum-scale=1,
  user-scalable=no`) so a stray pinch/double-tap can't enlarge the Flux chrome. Web pages are separate
  WebViews and keep their own zoom.
- **Mobile no longer launches with the drawer open** — the start-page effect that focuses the omnibox
  (and opened the sidebar) is now desktop-only; on mobile the omnibox lives in the top bar, so nothing
  needs to open the drawer.
- **Rounded window corners on macOS** — `round_window_corners` gains a Cocoa implementation (the
  analogue of the Windows DWM path): it rounds the `NSWindow` content-view layer and makes the window
  non-opaque so the corners (and a rounded shadow) show instead of a square fill. Best-effort +
  null-checked; the Linux/WebKitGTK build stays a no-op.
- **Desktop pinned apps restored** — the Nexus / Prism / Vector / Oracle app registry was emptied
  globally during the mobile barebone cleanup, which also removed them on desktop. It's now
  desktop-only: the full list is back in the app dock on desktop and stays empty on the (barebone)
  mobile build.
- **Mobile browsing polish (ADR 0012)** — a batch of Android fixes on top of the Chrome-style chrome:
  - **Android back gesture** now drives the page: the `FluxWebViewPlugin` registers an
    `OnBackPressedCallback` that goes back in the visible WebView when it can, asks the shell to close
    the topmost overlay (drawer / agent / tab switcher) when one is open, and otherwise leaves the app.
  - **Live omnibox + tab titles**: the native WebView emits page url/title on navigation start, finish,
    and title-received; the shell bridges them (`addPluginListener`) to the tab, so the omnibox and the
    tab-switcher cards update as you browse and follow links.
  - **Boots collapsed**: the mobile shell no longer opens with the sidebar drawer expanded (the Android
    WebView could report a desktop-width viewport before layout; the collapse now keys off the mobile
    flag).
  - **Google is the default search engine on mobile** (one-time; a later change sticks). Desktop keeps
    DuckDuckGo.
  - **Music bubble** is smaller and tucked into the bottom-right corner on mobile, below the overlay
    layers.
  - **Removed the demo pinned apps** (Nexus / Prism / Vector / Oracle) — they were fictional
    placeholders; the app registry now ships empty (also trims ~3 KB off the chrome bundle).
- **Chrome-style mobile chrome (ADR 0012)** — the Android build now wears a browser-shaped top bar
  instead of the Arc drawer-for-everything: back / forward, an omnibox (lock glyph + domain, tap to
  edit → search-or-navigate, with an inline reload), a **tab-count button** opening a full-screen
  **tab switcher** (a 2-up grid of tab cards with favicons, close ×, and a ＋ new-tab), and a ⋮ menu
  that opens the sidebar drawer (all the Flux destinations). A thin indeterminate progress bar shows
  under the bar while a page loads. The top bar lives in its own grid row *above* the content card so
  the native page WebView never covers it, and the tab switcher (like the drawer and agent) hides the
  WebView while open. Mobile-only lazy chunk (1.6 KB gz), kept out of the desktop bundle.
- **Mobile browsing — native Android WebView plugin (ADR 0012, Milestone 2 · builds, on-device
  test pending)** — browser tabs on Android now render in real `android.webkit.WebView`s instead of
  erroring. New crate **`tauri-plugin-flux-webview`** (a Tauri mobile plugin: a Rust
  `run_mobile_plugin` bridge + a Kotlin `FluxWebViewPlugin`) manages a stack of WebViews in a
  FrameLayout overlay over the content card — one per tab, positioned from the frontend's reported
  bounds scaled by display density, the mobile analogue of the desktop multi-webview layer. The
  `webview.rs` mobile stubs now drive it (open / setBounds / show / hide / close / navigate / back /
  forward / reload); unsupported-on-mobile calls (preconnect, hibernate, zoom, find…) are accepted
  as no-ops so routine browsing doesn't error. The shell's existing overlay machinery hides the
  native WebView while the mobile drawer or full-screen agent is open (the WebView is an OS layer
  above the shell HTML). Gradle auto-discovers the plugin's `android/` project from the Rust
  dependency graph — no generator step, and the desktop build is untouched (the plugin compiles to a
  no-op there). First cut is render + position + navigation; shields and DOM capture are follow-ons.
- **Reopen closed tab — `Ctrl/Cmd+Shift+T`** — Flux now keeps a recently-closed stack (last 25
  browser tabs, persisted across restarts) and reopens the most recent one on `Ctrl+Shift+T`, like
  every other browser. The chord previously opened a *terminal* tab, which shadowed the universal
  reopen gesture; the terminal is still reachable via `Ctrl+`` (toggles the terminal column) and the
  sidebar's "Terminal tab" button, so only the keybinding moved. Covers both a real close and the
  convert-last-tab-to-start case (the URL was otherwise lost).
- **Barebone mobile layout (Android APK, ADR 0012)** — the phone build now strips desktop-only
  chrome it can't use: the custom title bar + traffic-light window controls and resize grips are
  gone (no window management on a phone), and the terminal column, connections rail, web-panel
  column, PagesBar and bookmark bar are hidden. The layout collapses to a single full-bleed content
  cell, and the Arc sidebar (which carries the omnibox, tabs and nav) becomes a fixed **drawer**
  opened by a floating ☰ and dismissed by a backdrop. Detection is UA-based (`platform.ts`), so it's
  frontend-only — the desktop build is untouched. Builds on the rung-B responsive/touch work.
- **Native Android APK — cross-compiled, downloadable, no Termux (ADR 0012, rung C · Milestone 1)**
  — Flux now builds a real installable `.apk` on the dev box via Tauri v2 mobile: `cargo tauri
  android build` cross-compiles `aarch64-linux-android` with the Android NDK and Gradle assembles
  the APK — the phone just downloads and installs it (the on-device Termux/proot build kept dying to
  npm cache corruption, then OOM compiling on the phone, so we stopped compiling there). One command:
  **`scripts/build-apk.sh`** (builds the frontend from the repo root, scaffolds the Gradle project if
  missing, then assembles a debug-keystore-signed APK → `flux-arm64.apk`, sideloadable immediately).
  The port keeps the codebase single: the desktop native-multi-webview tab engine (`webview.rs`),
  floating peek windows (`peek.rs`), the PTY terminal (`terminal.rs`), the Spotify AudioPulse launcher
  (`spotify.rs`), and the Files-tab trash all compile to `#[cfg(mobile)]` **stubs with identical IPC
  signatures**, so `generate_handler!` and every store carry over untouched and the internal pages
  (Notebook, Trail, whiteboard, Settings — all shell HTML) work. Desktop-only Tauri plugins
  (`single-instance`, `window-state`) and the `portable-pty`/`trash` crates move to a
  `cfg(not(android/ios))` target section; entry point is `#[cfg(mobile)] mobile_run()`. Milestone 1 =
  APK boots the shell; real in-tab browsing (single WebView, URL-swap) and the on-device llama.cpp
  agent are Milestones 2–3. Desktop build verified unchanged.
- **Whiteboard (`flux://whiteboard`)** — a built-in whiteboard/paint surface: pen (midpoint-
  smoothed ink) + highlighter, line / arrow / rectangle / ellipse (Shift constrains to 45° / squares
  / circles), a text tool, and a **stroke eraser** (removes whole marks, no pixel smudging — the
  board is a vector model). Pan (✋ / middle-drag / Space) + wheel zoom over a dot grid; exact
  **undo/redo** (Ctrl+Z / Ctrl+Shift+Z); tool hotkeys (P/H/E/L/A/R/O/T); a color row + custom
  picker + width slider. **Multiple named boards**, autosaved locally (rename ✎ / delete, dbl-click
  a chip to rename); **export** crops to the drawing's bounds on the velvet background — ⧉ copies
  a PNG to the clipboard, ⬇ downloads it. Pointer-events throughout, so mouse, touch and stylus all
  draw (pairs with the Termux/mobile build; toolbar targets grow on touch). Opens from the PagesBar
  🎨 chip or ⌘K "Open whiteboard"; lazy chunk (4.8 KB gz), eager budget untouched.
- **Mobile Flux — Termux build + responsive chrome (ADR 0012, rungs A+B)** — Flux now runs on
  Android as its Linux build inside **Termux + proot-distro + termux-x11**: `scripts/
  install-termux.sh` provisions both layers end-to-end (X11 display, proot Ubuntu, toolchains,
  WebKitGTK, the build, and a `flux-mobile` launcher with the WebKitGTK-under-proot env — software
  GL, compositing off, dbus session). The route matters: Termux's *native* Rust targets
  `aarch64-linux-android`, where Tauri switches to its Android/JNI mode — inside the proot the
  target is plain `aarch64-unknown-linux-gnu` and the GTK path just works; every pure-Rust crate
  now checks clean on that target. **Responsive chrome** on top of the existing pane-shedding
  (#28): side surfaces start collapsed on narrow screens (without poisoning the persisted desktop
  defaults), the icon rail slims below 520 px, the calendar pane goes near-fullscreen, and touch
  targets grow under `pointer: coarse`. Honest scope per the ADR: this is the dev-grade WebKitGTK
  class (like WSL2) — whether per-tab pages render hinges on X11 webview positioning, verified
  on-device via the ADR's ladder; the true native APK (Tauri mobile + an Android WebView-stack
  plugin, llama.cpp agent) is the parked rung C.
- **Calendar from anywhere (#114 follow-up)** — a 📅 icon joins the sidebar footer: one click opens
  a centered **calendar pane you can edit in** — month grid with event dots and ‹ › / Today nav on
  the left, the selected day's agenda on the right with **inline add / edit / delete** for local
  events (title, start–end time, location, repeat presets → RRULE; ICS-feed events shown read-only
  with a 🔒). Esc closes (or cancels the form first); ↗ jumps to the full home calendar. Rendered
  over the content card via the overlay registry (webviews hidden while open). Same data as
  the home calendar (ICS feeds + Flux-local events, recurrence expanded). The icon shows a magenta
  **dot when an event starts within 30 minutes** (polled every 10 min, visibility-aware). Also in
  **⌘K**: "Open calendar". Gemma already handles "what's on Friday" / "schedule lunch tomorrow at
  noon" from anywhere, completing the picture. Budget-funded by splitting the Shields popover body
  into a lazy chunk (the footer keeps only the icon + badge): eager chrome **65.0 → 64.4 KB** with
  everything added.
- **Discord & Teams quick panels** — ⌘K "Open Discord panel" / "Open Teams panel" pins the site as
  a **web panel** (#48) on first use and toggles it after: a slim native-webview pane beside any
  tab for checking messages without leaving the page — with the panel rail's unread badges once
  pinned. (Web panels, not app panes: both sites forbid iframing, so the native webview is the only
  surface that works — and it keeps your login session.)
- **Draft capture — the Time Machine remembers what you were typing (ADR 0011 final phase, opt-in,
  OFF by default)** — with "Capture typed drafts" enabled (Settings → Privacy & security), pausing
  mid-type in a comment box / issue form / long textarea saves the draft to the page's Trail visit,
  so a closed tab can't eat your words: the node's detail panel grows a **📝 Drafts** section with
  one-tap copy. Privacy is structural, three gates deep: the injected `drafts.js` **never reads**
  password/hidden fields, cc/OTP autocomplete fields, `[data-sensitive]` fields, or *any* field in
  a form containing a password input (login/sign-up forms wholesale — the ADR's vault-form rule);
  the Rust side independently re-rejects sensitive field names and any value containing a
  **Luhn-valid card number** (a card number is impossible to store even if the page lies about
  input types — tested); and the command layer drops private tabs and everything when the toggle
  is off (the script attaches no listeners at all in that case). Drafts are sealed at rest like
  the other trace stores, capped (latest per field, 12 fields/visit, 300 visits), and forgotten
  with the visit. This completes ADR 0011 — every planned phase of the Research OS is now shipped.
- **Trace stores are now encrypted at rest (ADR 0011, draft-capture phase — part 1)** — the Trail
  records what you read (and, next, fragments of what you type), so its files no longer sit in
  plaintext: `trace.json`, `snapshots.json`, and `chats.json` are sealed with **AES-256-GCM**
  (reusing the vault's audited seal/open), keyed from the **OS keychain** (`Flux`/`trace-key-v1`)
  with a 0600 key-file fallback beside the stores when no keychain exists (headless WSL) — the same
  ladder the password vault uses. If neither is available, persistence falls back to plaintext with
  a warning rather than losing the Trail. **Migration is transparent:** legacy plaintext files load
  normally and are rewritten sealed on the next flush. History/archive encryption remains a
  separate decision (flagged in ADR 0011).
- **Structural reading mode (#41 upgrade)** — reader mode now *understands the document's shape*,
  two layers deep: an **outline rail** (deterministic, built from the heading blocks — instant,
  works offline, ≥3 headings) with click-to-jump; and **section chips** — one small
  schema-constrained call to local Gemma classifies the document (**research paper / recipe /
  documentation / news**) and maps its headings onto that type's canonical sections, so a paper
  reads as 📄 Abstract · 🧪 Methods · 📊 Results · 💬 Discussion and a recipe as 🧂 Ingredients ·
  👨‍🍳 Steps, each chip a jump. The model's mapping is **validated in Rust** against a per-type label
  allowlist (wrong labels/indices/duplicates dropped — a wrong chip is worse than a missing one),
  and with Ollama down the chips simply don't appear while the outline still works. A type badge in
  the reader bar shows what was detected. New `structure_reading` planner method +
  `reader_structure` command; 1 new test.
- **Rabbit-hole auto-archive — stale research branches archive as one named unit (#46 upgrade,
  ADR 0011 payoff)** — the original "Semantic Tab Mapping and Auto-Pruning" idea, built on the
  Trail. When the auto-archive sweep (Settings → Tabs, off by default) finds stale tabs, it now
  asks the Trail to group them into **branches** — connected components over the tabs' visits and
  their Nav/Semantic/Cites edges (with a newest-visit-by-URL fallback, since hibernated tabs lose
  their live pointer across restarts). A branch of ≥2 tabs archives **as one unit**: closed
  together, recorded together, and **named by Gemma** ("CUDA OOM debugging", best-effort async —
  a placeholder until the model replies). The Archived panel shows branches as 🌿 rows with a page
  count, the member titles as chips, one-tap **restore-all**, and ✕; loners keep the flat per-tab
  list. Gentle: one branch + ≤5 singles per sweep. The whole sweep is now a lazily-imported module,
  so none of it rides in the boot bundle. New `trace_branches` command (union-find in Rust, tested);
  nothing is lost — every page stays in the Trail regardless.
- **Trail refinements — the page's thread in the agent sidebar + a real timeline scrubber
  (ADR 0011, #136)** — two follow-ups from the payoff layer:
  **💬 Page thread scope** — the agent sidebar grows a fourth scope next to This page / All tabs /
  My notes: when the active page has a Visit, a "💬 Page thread" button appears (with a message
  count once the thread exists). Selecting it replays the conversation's tail into the feed and
  routes your messages through the *persistent* per-page thread — the same one the Trail's detail
  panel shows, grounded in the page's dwell snapshot. Start a conversation while browsing, find it
  again months later on the Trail node (or the moment you revisit the page). Falls back to plain
  page chat on pages with no Visit (internal pages, private tabs — which never get one).
  **Histogram scrubber** — the Trail's time scrubber is now a real timeline: an activity histogram
  (visit density, √-scaled, from a new one-pass `trace_histogram`) renders behind a full-history
  slider — no more 8-window limit — with the viewed span drawn as a teal band you drag through
  your past. Refreshes after forgets.
- **Ambient watcher — "you've seen/solved this before" (ADR 0011, #136, local-only)** — the final
  payoff-layer piece, scoped to the case that can be made *precise*: when the current page shows a
  shaped **error signature** (a Rust panic / `error[E…]`, a `SomethingError:`/`…Exception:` trace
  line, `fatal:`, CUDA-OOM/segfault phrases — deterministic patterns, never prose), Flux checks your
  dwell snapshots for past pages where the **same normalized error** appeared, and the Connections
  rail shows a quiet **"⚡ Seen before"** block: the past page, when, and a 💬 flag when a chat
  thread is attached (you may have solved it there). Matching is whitespace/case-tolerant, requires
  a different URL, caps at 3 hints, and the snapshot scan only runs at all when the current page has
  an error — on a normal page the check is a no-op. **No LLM in the loop and no network**: it reads
  only the local trace stores (the "newer paper version exists" watcher idea stays parked pending a
  network-policy decision). New `trace::ambient` module + `trace_ambient` command; 3 new tests.

### Changed
- **Sidebar footer ⇄ PagesBar reconciled** — the two surfaces had drifted into overlap. New rule:
  the **footer holds only act-in-context panels** (Shields, Downloads, Calendar, per-site Passwords,
  page Notes, Web panels, Archived tabs, Extensions, Containers); **full-page destinations live on
  the PagesBar + ⌘K only**. Concretely: the footer 🔖 "Library" popover is gone — its ★ bookmark
  action already lives in the page-actions row (Ctrl+D), and its All-bookmarks/Sessions/History
  links duplicated PagesBar chips. And the naming collision between the read-later **Archive** page
  and the footer's **Archived tabs** panel is resolved: the PagesBar chip is now **"Saved pages"**.
  (The footer ⚙ popover stays — Containers management is unique to it, with an "Open full
  Settings ↗" escalation; the per-site Passwords popover and the 🔑 Vault page are complementary,
  not duplicates.) Eager chrome down again: 64.4 → 64.1 KB.
- **Find-in-page is now permanently visible (#33)** — the find bar lives right under the search
  bar in the sidebar instead of appearing on Ctrl+F. Ctrl+F now just focuses it; **Escape clears**
  the query + page highlight (the bar never unmounts); the ‹ › navigation and ✕ clear buttons show
  only while a query is active, and the ✦ semantic-find shortcut stays. The global Escape chain
  still ends a find session from anywhere (the bar syncs its input when it does). Still a lazy
  chunk — fetched right after boot, off the eager bundle, so the chrome budget is untouched.

### Internal
- **Code audit — formatting/lint baselines, App.tsx decomposition, budget re-baseline (branch
  `chore/code-audit-136`)** — four-part professionalization pass, no behavior change:
  **(1) rustfmt baseline** — one mechanical `cargo fmt --all` (default profile, no custom config);
  the `event_parity` guard now scans a 3-line window so rustfmt's argument reflow can't blind it.
  **(2) clippy-clean workspace** — all 47 findings fixed (Reverse-key sorts, checked division,
  boxed `ureq::Error`, type alias, `is_empty`, …; deliberate escapes are per-site `#[allow]` with a
  reason) plus a shared `[workspace.lints]` baseline (clippy defaults + `dbg_macro`/`todo`/
  `print_stdout`) inherited by every crate — zero warnings is now the bar.
  **(3) Prettier baseline** for the shell (pinned, 110-col, house style; `bindings.gen.ts` excluded
  — the drift test byte-compares it against codegen). Both mechanical commits are listed in
  `.git-blame-ignore-revs`.
  **(4) App.tsx decomposed** (4.1k lines → `App.tsx` 1.6k + `Sidebar.tsx` 2.2k + `ContentArea.tsx`
  0.25k) and the **cold chrome lazified** — FindBar, ReaderView, SemanticFind, ShellHistory,
  WatchPanel, TrackerGraph, and AppPane now load on first open behind store-gated `<Show>`s,
  cutting the eager bundle **70.1 → 64.4 KB gzip** and turning the **failing CI budget gate green**.
  The chrome-JS budget itself was re-baselined 50 → 65 KB with a dated rationale in ADR 0001 (the
  50 was set ~30 chrome features ago; what remains eager is load-bearing boot chrome).
  **(5) `trace.rs` split into a module** — 1 981 lines holding five concerns became
  `trace/{mod,store,snapshots,chats,entities}.rs` (IPC surface in `mod.rs`; every public path
  `crate::trace::X` unchanged, so callers and bindings are untouched), with each unit's tests moved
  next to it. A README "Code style" section documents the fmt/clippy/prettier commands.

### Added
- **The Trail payoff layer, part 2 — entities & citation edges (ADR 0011, #136)** — the Trail now
  understands what a page *is or mentions*: **arXiv papers** (id normalized, version stripped),
  **DOIs** (Crossref-shape scan, balanced-paren aware), **GitHub repos** (owner/name from any
  sub-page, non-repo sections skipped), and **datasets** (Hugging Face / Kaggle). Extraction is
  **deterministic** — hand-rolled scanners, no LLM, no new dependency — because a false positive
  here becomes a wrong edge in the graph. URL-derived entities land at nav time (marked *primary*:
  the page IS the thing — so even a bounced paper page can be cited into); text mentions land at
  dwell capture. Shared entities derive typed edges: a repo mentioning a paper →
  **`Implements` repo→paper**; any other page mentioning it → **`Cites`**; two pages both merely
  mentioning the same thing → **`Same`**. One edge per pair, both-direction dedup, capped per
  derivation, forgotten with the visit. In the Trail these render **long-dashed magenta**
  ("citations" in the HUD), and the detail panel shows **entity chips** (📄 arXiv / 🔗 DOI /
  ⌨ repo / 🗃 dataset; bright = the page is it, dim = mentioned). 2 new tests (174 total).
- **The Trail payoff layer, part 1 — semantic edges, auto-indexed browsing, time-travel scrub
  (ADR 0011, #136)** — three features on top of the completed spine, each a thin layer because the
  data was already there:
  **Semantic edges** — at capture time each new dwell snapshot is compared (cosine) against the
  stored snapshot embeddings and linked to its 3 nearest neighbours above 0.55, as `Semantic` edges
  persisted alongside the Nav ones. In the Trail they render **dashed teal** ("related", counted in
  the HUD) vs the solid violet navigation steps, and pull related pages gently together in the
  layout — so topic clusters emerge *across* navigation branches. Mismatched embedders compare as 0
  (a corpus mid-migration just yields fewer links); duplicates are checked in both directions.
  **Auto-indexed browsing** — the KB `web` source now updates itself: when new snapshots have
  *settled* (no new capture for a full 60 s flush tick), the background thread folds them into the
  KB incrementally — only new pages embed. Active browsing defers it; a pause indexes. If the
  embedder changed since the corpus was built (Ollama came up), it heals by rebuilding **all**
  sources rather than letting a single-source pass wipe the others. `FLUX_TRAIL_AUTOINDEX=0` opts
  out. The Notebook's ↻ Reindex still works and takes priority (the auto pass just retries later).
  **Time-travel scrub** — pick a span (24h / 7 days / 30 days) and a slider appears: drag the
  window back through history (up to 8 spans), the graph replays what you were working on around
  then, and **⏪ Reopen these pages** brings that moment's most recent pages (up to 6, confirmed)
  back as tabs — "I had a great setup for this research yesterday" is now one drag + one click.
  Dragging fully right snaps back to live "now". No backend change — the scrub is pure
  `trace_graph(after, before)` windowing, which is the spine paying off again. 2 new tests
  (172 total).
- **Per-page chat — a conversation attached to every page, slice step d (ADR 0011, #136)** — the
  last core piece of the Trail: click a node in `flux://trail` and **ask Gemma about that page**, in
  a thread that is *bound to the Visit* — it persists (`trace/chats.json`) and is still there when
  you come back months later. Replies are **grounded in the page's dwell-snapshot text** (the model
  is told plainly when no capture exists, instead of guessing), stream in token-by-token (same
  channel pattern as `kb_answer`), and see the last 12 turns of the thread. Threads are capped at
  200 messages (oldest dropped) and are **forgotten together with the visit** — `trace_forget` now
  cascades to snapshots, chat threads, *and* the KB. New `TraceChats` store +
  `trace_chat`/`trace_chat_send` commands + a chat section in the Trail detail panel.

- **The Trail view — `flux://trail`, slice step c (ADR 0011, #136)** — the first *visual* payoff of
  the Research OS: your browsing rendered **as a graph**. A force-directed map (the same small canvas
  sim as the Omni/tracker graphs — no dependency) where nodes are Visits and edges are how you got
  from one page to the next (the free Nav edges); node colour encodes the research *task* (workspace),
  a filled node has a dwell snapshot, a hollow ring is metadata-only. Click a node → a detail panel
  with its title, URL (opens the page), provenance ("via <referrer> · <task>"), timestamp, and the
  **captured snapshot text**. A time filter (All / 24h / 7 days / 30 days) windows the view via
  `trace_graph`, and **Forget** removes a single page or the whole window — the day-one privacy
  control, made visible. Opens from the ⌘K palette ("Open the Trail"), a 🧭 PagesBar chip, or
  `flux://trail`; DOM-rendered in the content card (no webview), lazy-loaded (8.6 kB chunk). Pure
  frontend over the existing `trace_*` IPC.
- **The Trail feeds the Knowledge Base — browsing as a cited `web` source, slice step b (ADR 0011,
  #136)** — the co-scientist can now answer over what you've *read*, not just your Onyx/Scroll/
  Council corpora. The Trail's dwell snapshots become a new KB source, **`web`**: on reindex, each
  snapshotted visit is chunked + embedded like any other document (one KB doc per visit, `doc_id` =
  visit id so incremental reindex keeps unchanged pages), and its **citation points back at the page
  URL** — so a Notebook `[n]` chip re-opens the page, and the ✦ My-notes / ambient rail surface
  browsed pages too. Snapshots carry the visit title for self-contained, citation-ready docs. Wired
  through the existing Notebook **↻ Reindex** (labelled "Browsing"; no location box — it's an
  in-process corpus); `kb_reindex` pulls the snapshots from the Trail store and hands them to the KB,
  which owns chunking/embedding. Budget-evicted snapshots drop out of the KB on the next reindex. 2
  new tests. _Follow-up:_ a debounced auto-reindex so browsing flows in without hitting Reindex.
- **The Trail — dwell-triggered content capture, slice step 1 (ADR 0011, #136)** — the Trail now
  captures each engaged page's **content snapshot + embedding**, not just its metadata. The gate is
  *dwell*: only after the active browser tab holds steady (same tab + URL) for **8 s** does the
  frontend fire `trace_snapshot`, which reads the already-cached DOM text (no new page capture),
  embeds it **off the async runtime** (Ollama `embeddinggemma`, hash fallback), stores it, and
  attaches a `snapshot_id` to the tab's current Visit — so bounced pages and quick tab-flips never
  pay the embed cost (the perf gate). Snapshots live in a **separate budgeted store**
  (`trace/snapshots.json`) so the tiny visits+edges flush stays cheap; **storage budget resolved:**
  1500 snapshots × 20 KiB text, oldest-evicted (~35–40 MB incl. vectors), embeddings persisted +
  embedder-tagged. `trace_forget` cascades to a visit's snapshots; `trace_snapshot_get` returns a
  node's stored content. This is the corpus the next step (feed the KB as a cited `web` source) and
  semantic edges will read. 3 new tests (9 total in `trace`).
- **The Trail — browsing provenance spine, slice 1 (ADR 0011, #136)** — the foundation of the
  Research OS / external scientific memory. Every non-private navigation now becomes a **Visit**:
  a node carrying *why* you got there — the page you came from is a free `Nav` **edge**, plus the
  active workspace as the task label — so browsing becomes a **graph**, not a flat list (A→B→A is
  three connected nodes, not one). Recorded from `dom_publish` inside its existing `if !private`
  guard, so **private windows leave no trace**, same rule as history; deduped per tab/URL so SPA
  re-publishes don't fork nodes. New `crate::trace` `TraceStore` persists visits+edges as JSON
  (`app_data/trace/trace.json`, empty→hydrate→60s-flush like history), capped + oldest-evicted.
  Day-one privacy control: `trace_forget` drops a URL / host (registrable-boundary match) / time
  range / all. IPC: `trace_recent`, `trace_visit`, `trace_graph`, `trace_forget` (+ `Visit`,
  `Provenance`, `Edge`, `EdgeKind`, `TraceGraph`, `ForgetScope` bindings). Coexists with History
  (unchanged). 6 new tests. Later slice steps: dwell-triggered snapshot+embed → feed the KB as a
  cited `web` source → the Trail view (timeline + graph) → per-page chat.
- **`/pac` — Power Platform CLI as an approval-gated agent tool (#135)** — the deterministic ALM
  companion to the browser playbooks: `/pac <request>` (e.g. "export my solution Contoso",
  "unpack the solution zip", "list my canvas apps") maps a natural-language request to **one**
  `pac` command, grounded by a curated in-Rust cheatsheet (auth/env, solution export-import-pack-
  unpack-clone-check, canvas download-unpack-pack, data export-import; plus the note that Power
  Automate flows live inside solutions as JSON). Risk is classified **in Rust, never by the model**:
  environment-mutating or interactive commands (import / delete / publish / reset / upgrade /
  `auth create`) get a heads-up banner before the approval card; read-only ones (list / export /
  unpack / check) get a reassuring badge. A `pac_status` preflight checks the CLI is installed and
  signed in, so the agent nudges you to install `pac` or `pac auth create` instead of failing
  opaquely. Nothing runs until you tap Run — it reuses the existing shell approval card and PTY
  read-back, and the same destructive-command denylist. New `flux-agent::pac` module + `PacPlan`/
  `PacStatus` IPC types; 5 new tests.
- **Agent domain playbooks — teaching the local model to work in Power Platform (#A)** — the
  planner now injects a domain-specific *harness* into its prompt when the active page is a known,
  hard-to-navigate web app, starting with **Power Automate** (`make.powerautomate.com`,
  `flow.microsoft.com`) and **Power Apps** (`make.powerapps.com`). Flux's agent is a *local* Gemma
  model that doesn't carry deep first-party knowledge of the maker portal, so each playbook hands
  it an explicit recipe — the landmarks to click, the order of operations (create → trigger →
  add-step → configure via dynamic content → save → test), an aria-label-first selector strategy,
  verification gates (check for the saved toast / no red error cards before moving on), and a hard
  **STOP list** (never type into sign-in/OAuth/connection dialogs, never publish to production or
  delete; hand bulk Dataverse work back to the `pac` CLI / Dataverse MCP). The harness only changes
  *what the model is told* — the `AgentAction` vocabulary and compile templates are untouched, so
  the "Rust decides how, the model only picks what" security model is preserved. Host matching is at
  a registrable-domain boundary (a lookalike like `evilpowerautomate.com` does **not** match).
  Generic pages get an empty block, so their prompts are byte-for-byte unchanged. New
  `flux-agent::playbooks` module; `plan`/`plan_step` thread the page URL; 6 new tests.
- **Playground: six more games — 23 total (#133)** — **Missile Command** (click-to-intercept
  city defense, waves), **Bubble Shooter** (aim + match-3 pops, dropping ceiling),
  **Bejeweled** (swap-to-match-3 with cascades, ends when no move remains), **Centipede**
  (splitting centipede through a mushroom field, waves + lives), and two **vs-AI board games**:
  **Connect Four** (alpha-beta minimax) and **Reversi/Othello** (weighted 3-ply minimax). The
  board games score as a **win streak** — win to keep the run going, a loss or draw ends it,
  best streak is the high score — so they fit the existing `onGameOver` harness with no change.
- **Playground: eight more games — 17 total (#133)** — **Pac-Man** (dots + power pellets, three
  chasing ghosts that turn edible, connectivity-safe maze), **Dino Run** (one-button jump/duck
  runner), **Stack** (time the drop, tower narrows), **Frogger** (road traffic + ride the river
  logs, 3 lives), **Whack-a-Mole** (click moles, dodge bombs), **Doodle Jump** (endless
  auto-bounce climb with edge-wrap), **Simon** (grow-and-repeat memory, Web-Audio tones), and
  **Columns** (falling gem trios, match-3 in any direction with cascading combos). Same
  self-contained canvas-engine harness; scores persist locally per game; still a lazy chunk.
- **Playground: four more games (#133)** — the arcade grows to nine with **Flappy**
  (flap through the gaps — Space/↑/click), **Asteroids** (rotate/thrust/fire, rocks split,
  screen-wrap, waves + lives), **2048** (slide-and-merge with the arrow keys), and
  **Minesweeper** (16×12, left-reveal / right-flag, first click always safe, full-clear bonus).
  Each is another self-contained canvas engine behind the same harness; scores persist locally
  per game. Still one lazy chunk — no eager-bundle cost.
- **Timer, stopwatch & alarms (#134)** — a new **Time** start-page widget with three tabs:
  a **stopwatch** (start/stop/lap/reset), a **timer** (preset chips + custom minutes, +1:00,
  pause/reset, progress bar), and **alarms** (add time + label, enable/disable, remove; ring
  daily). Crucially the state lives in a module-level store (`clocks.ts`), not the component,
  so a **running timer and your alarms survive leaving the start page** — an always-on driver
  (started in App) checks absolute target times (so it's immune to background throttling) and,
  when one elapses, rings: a Web-Audio beep, a docked in-app banner (Dismiss / Snooze 5m,
  visible over any tab like the permission bar), and an **OS notification** via a new reusable
  `os_notify` command (so it reaches you even when Flux is minimized). Alarms + the timer
  length persist locally.
- **Playground — offline arcade (#133)** — a 🎮 icon next to the file-explorer icon opens a
  large glass popout with a neon hub of five classic games, all playable offline: **Snake**,
  **Tetris** (rotation, ghost piece, NEXT, levels), **Breakout** (mouse/keys, endless waves),
  **Pong** (endless survival vs a ramping AI), and **Space Invaders** (waves, bombs, lives).
  Each is a self-contained `<canvas>` + rAF engine behind a shared harness (`playground/`);
  high scores are kept locally (localStorage) with a NEW RECORD flourish. Esc steps back
  (game → hub → close); the pane hides the native webview while open like Files/Notebook. The
  whole thing is a lazy 6 KB chunk — zero eager-bundle cost. Online play + leaderboards are a
  later layer (BACKLOG #133).
- **Repeatable local calendar events (#114)** — local (on-device) events can now be set to
  **repeat**: a Repeat control in the event editor offers Daily / Weekly / Every 2 weeks /
  Monthly / Yearly (an agent-authored custom RRULE is preserved), and the recurrence engine
  that already expanded ICS-feed rules now expands local events over the same grid window; a
  🔁 marks recurring events. Previously local events were one-off only — the model, commands,
  and expansion path existed solely for read-only ICS feeds. `LocalEvent`/`CalEvent` gain an
  `rrule` field (RRULE sanitized to supported FREQs on save); 3 new tests. _Note:_
  editing/deleting a series affects all occurrences (they share the event id); per-occurrence
  exceptions ("this event only") are a follow-up.
- **Save-password prompt for manually-typed logins (#61 follow-up)** — the sentinel used to
  only remember passwords it generated. Now, when you submit a login (or sign-up) form with
  a password Flux didn't fill or generate, it captures the credential and — if it's genuinely
  new for that site — raises a glass **"Save password for site.com?"** bar above the content
  card (**Save**/**Update**, **Not now**, **Never** for this site). Same trust model as the
  rest of the sentinel: the password is held only in Rust between submit and your answer, the
  host comes from the tab's webview label (never the page), and a per-site **never-save** list
  is persisted. New commands `vault_offer_save` (fluxtab) + `vault_save_confirm` /
  `vault_save_dismiss` / `vault_never_save`.
- **Credential picker when several logins match (#61 follow-up)** — the **"🔑 Fill"** chip used
  to silently fill the first match when a site had more than one saved login. It now expands
  into an in-page picker listing each username; choosing one fills that credential via a new
  host-validated `vault_fill_page_id` (a page still can't coax a fill for an unrelated entry).
  Single-match sites are unchanged (one-click fill). New page command `vault_page_matches`.
- **Chrome & Bitwarden password import (#61 follow-up)** — the importer (was Proton-only) now
  auto-detects and ingests **Chrome** password CSV, **Bitwarden** CSV, and **Bitwarden** JSON
  (unencrypted) alongside Proton's CSV/ZIP/PGP/JSON — format detected from content, no vendor
  picker. Bitwarden's `login_*` CSV columns and its `items[].login{uris,uri}` JSON shape are
  mapped to Flux credentials; trashed/non-login items are skipped and an *encrypted* Bitwarden
  export fails with a clear "re-export unencrypted" message. 4 new unit tests. The vault
  Import pane copy now names all three sources.
- **Password sentinel: strong-password suggestions + one-click autofill (#61 follow-up)** —
  the vault now watches every page for password forms (SPA-aware). On a **registration**
  form (`autocomplete="new-password"`, password+confirm pair, or sign-up wording) a small
  in-page chip offers **"✦ Use a strong password"**: the Rust vault generates a 20-char
  password (OS-CSPRNG, rejection-sampled, no ambiguous glyphs — unit-tested), fills the
  password + confirm fields, and **saves it to your vault when you actually sign up**
  (with the username you entered; a chrome toast confirms). On a **login** form with a
  saved match, a **"🔑 Fill · user"** chip one-click-autofills via the existing
  Rust-injects-into-page path — the password never passes through chrome JS. Privacy/
  security: top-level documents only (nothing shows in iframes), the calling tab is
  identified from its webview label (a page can only ever act on itself), the chips are
  dismissible per page, and suggestions require the vault to be unlocked so the
  save-on-submit promise always holds. New page commands `vault_page_info` /
  `vault_fill_page` / `vault_suggest_password` / `vault_save_from_page` (fluxtab plugin);
  `flux_vault::generate_password` with 3 new unit tests.
- **Downloads work on Linux (WebKitGTK hook, #34 follow-up)** — the download manager was
  WebView2-only; on the Linux build a download just vanished. WebKitGTK's `download-started`
  signal (hooked once per shared web context) now routes downloads to your OS Downloads
  folder with numbered de-duplication (`file (1).zip`), feeds the same live model as
  Windows — the footer ⬇ popover shows real-time progress via `flux://download-updated` —
  and supports cancel. Pause/resume remain Windows-only (WebKitGTK has no pause API).
- **Flux-styled permission prompts (#38)** — when a site asks for camera / microphone /
  location / notifications / clipboard and there's no remembered decision, Flux no longer
  falls back to the engine's native dialog. The WebView2 request is **deferred** and a glass
  **permission bar** docks above the content card (a sibling, so the page shrinks — nothing
  fights the native webview layer): *"site.com wants to use your microphone"* with
  **Allow** / **Block**, a **Remember for this site** checkbox (writes to the #38 store, so
  next time it's silent), and ✕ to deny just once. Multiple simultaneous asks queue with a
  "+N more" hint. Windows/WebView2; the deferral is completed on the UI thread
  (`permission_answer` → main-thread pending registry). COM surface compile-verified against
  `x86_64-pc-windows-msvc`.
- **Ad/tracker blocking on Linux (WebKitGTK content blocker)** — network-level shields were
  Windows-only (WebView2's request hook); on the Linux build they silently did nothing (only
  cosmetic hiding worked). Shields now also exports its filter lists as **WebKit
  content-blocker JSON** (`flux_filter::to_content_blocker_json`, seeded from the bundled
  list at first boot, upgraded to full EasyList + EasyPrivacy on refresh, capped at 75k rules
  with exceptions preserved), which WebKitGTK compiles natively via `UserContentFilterStore`
  and enforces inside the engine — attached to every tab/peek webview, compiled once per run.
  Same JSON will serve WKWebView if Flux lands on macOS. Known trade-off vs Windows: the
  declarative path has no per-request callback, so the tracker graph and HTTPS-only upgrades
  stay Windows-only. Conversion + persistence unit-tested (6 new tests); FFI compile-verified
  on Linux.
- **TUI-apps bootstrap (`tools/setup-tui-apps.sh`)** — pull Flux on a new machine (e.g. a
  Mac) and one command clones + builds all your terminal apps (Onyx, Scroll, Council,
  AudioPulse, Kata, …) onto your PATH, driven by a `tools/tui-apps.json` manifest (per-app
  repo + build command). Idempotent (re-run to update); macOS + Linux. The TUI-bar chips are
  already seeded by Flux, so they light up once the binaries are installed.
- **Pinned app dock + floating app panes** — a vertical launcher in the bottom-right corner
  for your own web apps (Nexus, Prism, Vector, Oracle), using each app's favicon. Clicking
  opens the app as a **movable + resizable floating pane** (multiple can stack). Each app
  ships a usage guide that Gemma reads when its pane is focused, so she can help with the
  app's features and results; she's also told the apps exist in every chat.
- **Tracker graph (privacy viz)** — a force-directed map (command palette → "Tracker graph")
  of which third-party domains each site you visit talks to. The request interceptor records
  every first-party → third-party contact (and whether shields blocked it); ubiquitous
  trackers surface as high-degree hubs, edges/nodes tint red where blocked. Drag, zoom, click
  a domain to open it. Live + in-memory (fills as you browse; **Clear** resets), nothing
  persisted or sent anywhere. New `tracker_graph` / `tracker_clear` commands.
- **Watch a page for semantic changes** — hit 👁 in the toolbar to pin a page; a background
  scheduler re-fetches it on an interval, extracts the readable text, and compares it to the
  last baseline by **embedding** — so it reports what *meaningfully* changed (a section added,
  a claim removed), not a noisy character diff. Changes fire an OS notification and show in a
  **Watched pages** panel (command palette → "Watched pages") with the added/removed passages
  marked +/−. Fully local — the only network is fetching the page you asked it to watch. New
  `watch_*` commands + `flux://watch-changed` event.
- **Semantic find — in-page + across tabs** — a find-by-*meaning* companion to Ctrl+F: ask
  "where does it explain the pricing" and it ranks the page's passages by embedding (not
  string) match, with a **This page / All tabs** toggle to search every open tab at once.
  Picking a result switches to that tab and uses the same native `window.find` to scroll +
  highlight the passage. Reuses the per-tab captured DOM text + the local embedder (Ollama
  model → hashing fallback) with keyword boosts. Open it from the ✦ in the find bar or the
  command palette. New `semantic_find` command.
- **Weekly research digest in the Notebook** — Gemma reviews everything you added to your
  knowledge base this week (Onyx notes written, Scroll papers clipped, Council debates) and
  writes a private briefing: **Threads** (this week's themes), **Connections** (non-obvious
  links between items), and **Open questions** (what to follow up). Generated on demand,
  cached per ISO week, fully local. Backed by a new true `indexed_at` timestamp on KB docs
  (the connector `mtime` is a change-key, not a clock) and a `kb_recent` command.
- **Semantic shell-history search (Ctrl+Shift+R)** — find a past command by *meaning*, not
  substring: "convert a video to webm", "that long ffmpeg one", "git undo last commit". Reads
  your real `~/.bash_history` + `~/.zsh_history` (through the terminal's shell, so it works
  across the WSL boundary), embeds each unique command locally with `flux-embed` (instant,
  on-device, no model), and ranks by a hybrid of embedding similarity + keyword/token boosts.
  Pick a result to drop it at the active terminal's prompt (you press Enter) — or it's copied
  if no terminal is open. Also in the command palette. New `shell_history_search` /
  `shell_history_reindex` commands.
- **Split view: a one-tap picker** — a ◫ button in the page-actions row tiles the current
  page beside another tab. It opens a picker listing your other open web pages (pick one to
  split with) plus **New blank tab** (opens a fresh navigable pane on the right). Toggles off
  to merge. Complements the existing drag-a-tab-to-the-right-edge gesture; both drive the
  same split engine (draggable seam, per-pane toolbars).
- **Calculator, unit-converter & maps home widgets** — three new start-page widgets
  (toggle/reorder like the rest). **Calculator**: a compact keypad that expands (⤢
  Scientific) into a full scientific calculator — trig (DEG/RAD), ln/log, √, powers,
  factorial, π/e, parentheses, ANS — backed by a small safe expression evaluator (no
  `eval`). **Unit converter**: length / mass / temperature / volume / area / speed /
  time / data, plus a live **currency** converter (ECB rates via a new `currency_rates`
  backend command — frankfurter.app, no key, no user data). **Maps**: an Australia cover
  that opens the full map panel (the toolbar 🗺 still works too).
- **Editable calendar + Gemma calendar control** — the calendar is no longer read-only.
  A new **on-device event store** (`cal_events.json`) backs full **add / edit / delete /
  drag-to-move** in the expanded week grid: click an empty slot to create, click an event
  to edit, drag a block to reschedule (15-min snap, overlap-aware), **+ New** in the
  toolbar, and an editor with title / all-day / date / start–end / location / notes.
  Google ICS-feed events stay read-only (shown muted; clicking opens a read-only view).
  **Gemma can now read and write your calendar**: "what's on my calendar today / this
  week / friday", "schedule lunch with Sam tomorrow at noon for 1h", "move my standup to
  10am", "cancel the dentist appointment" — she manages Flux-local events and reads the
  ICS overlay too. New commands: `cal_local_events`, `cal_event_add/update/delete`.

### Fixed
- **Trace spine correctness/privacy pass (review of ADR 0011 steps a–c)** — five issues found and
  fixed before they could bite: **(1 — privacy)** `trace_forget` left a forgotten page's text in the
  KB `web` index until the next manual reindex; it now purges the KB immediately
  (`KbStore::remove_docs`). **(2 — boot perf)** `TraceSnapshots` probed the local Ollama server *on
  the boot path* (`embedding::current()` is an HTTP call); the embedder is now resolved lazily at
  first capture, off the async runtime. **(3 — disk churn)** an SPA republish inside the 30 s dedup
  window re-marked the trace store dirty, rewriting `trace.json` every flush while you sat on a
  mutating page — now a read-lock fast path, the exact fix history.json shipped with. **(4 — data
  loss)** a navigation landing before the background hydrate thread could start a fresh store and
  later overwrite the persisted Trail (and reuse visit ids); all trace stores now hydrate lazily on
  first touch, so the race can't occur. **(5)** navigating away from an evicted/forgotten page no
  longer records a provenance pointer/edge to a node that's gone. Plus: the dwell effect skips
  private tabs client-side too, and the Trail view caps the O(n²) force-sim at the 1200 most-recent
  nodes. 5 new regression tests (170 total).
- **Autofill often didn't populate the field even when the credential matched (#61)** — the
  injection (`autofill.js`) set the value via the native setter + `input`/`change` only, in the
  top document. Hardened for the common "detected but didn't fill" cases: it now pierces
  **shadow DOM** and same-origin **iframes** (many login widgets are web components / framed),
  temporarily clears `readOnly`, focuses the field, and fires the full
  `keydown/keypress/input/keyup/change` sequence (with a real `InputEvent`) so React/Vue/Angular
  controlled inputs actually adopt the value — while deliberately **not** blurring (some sites
  clear/validate on blur). Applies to both the footer 🔑 popover and the in-page sentinel chip
  (both route through the same Rust→page fill).
- **Several page-callable commands were silently uncallable (fluxtab drift)** — Tauri routes
  `plugin:fluxtab|cmd` **only** through the fluxtab plugin handler, gated on the plugin ACL,
  with no fallback to the app handler; a command missing from *either* the ACL (build.rs) or
  the handler (lib.rs) is rejected at runtime, and the injected scripts swallow the rejection
  in `.catch()` — so the feature just quietly does nothing. Four commands had shipped this way:
  the #61 sentinel's `vault_page_info` / `vault_fill_page` / `vault_suggest_password` /
  `vault_save_from_page` and `panel_badge` were in the ACL but no handler (chips never
  appeared, panel unread-badges never updated); `macro_record_step` was in the handler but not
  the ACL (macro recording of clicks/typing no-op'd); and `peek_open` sat in the fluxtab
  handler while the chrome invokes it as a plain command (right-click / Alt-click **Peek** was
  dead). All page commands now live in the fluxtab handler *and* the ACL; `peek_open` moved to
  the app handler where it belongs. A new **`fluxtab_acl` guard test** parses both source lists
  and fails the build on any future drift, in either direction.
- **Dead `flux://panel-loaded` emit removed + event-parity guard** — a companion audit of
  backend→frontend `flux://…` events (Rust `emit`/`emit_to` vs the shell's `listen`) found one
  one-sided signal: `panel-loaded` was emitted when a web panel finished loading but nothing
  listened — a harmless-but-dead emit, now removed. A new **`event_parity` guard test** scans
  both trees and asserts every emitted event has a listener and vice-versa (allowlist for
  intentional one-way signals), so a renamed/typo'd event — which fails silently, the listener
  simply never firing — can't ship. No dead *listeners* were found.
- **Command-registration guard (IPC surface now fully guarded)** — a third guard test
  (`command_registration`) asserts every command the shell `invoke()`s — plus every
  `plugin:fluxtab|…` literal in the injected page scripts — exists in a `generate_handler!`,
  closing the last "compiles, never runs" axis: a call to an unregistered command 404s at
  runtime and the caller swallows it. No drift found (the main command surface was already
  disciplined). Together the three guards — fluxtab ACL↔handler,
  event emit↔listen, invoke→handler — cover the whole page↔Rust↔shell IPC surface at build
  time.

### Changed
- **Multiple split-view pairs at once (#43)** — split view held only one pair, so splitting a new pair silently merged the previous one. Split state is now a list of independent pairs: any number can coexist in the strip, a tab belongs to at most one, and the pair containing the active tab is the one tiled in the content card (focus a member of another pair to tile it instead). Merge/exit acts on the specific pair (the strip seam and per-tab menu) or the active pair (toolbar/palette). Split pairs now **persist across restart** — saved to localStorage and re-tiled on launch once the session's tabs load (stale pairs whose tabs are gone are dropped).
- **Split-view tabs sit side by side in the strip (#43)** — the two tiled tabs used to stack vertically inside a labelled box; they now render as two half-width chips next to each other joined by a bracket + a center ⤢ merge seam, matching Chrome's paired split tabs.
- **Specta type tail generated (BACKLOG #12, batch 4)** — 15 more IPC types are now
  codegen'd from Rust instead of hand-mirrored in `ipc.ts`: LaunchIntent, Reminder, MemInfo,
  hibernation/eviction/prefetch structs, SearchEngine/Resolution (flux-search),
  AgentAction/EditPlan/NextStep (flux-agent), and the Chrome-import types. Only shapes with
  no Rust struct at all (Omni dashboard passthrough JSON, ad-hoc channel payloads) remain
  hand-written. Also caught one real drift: `NextStep`'s fields are `#[serde(default)]`, so
  the true wire type is optional — the UI now handles that.
- **Typed error foundation (`error.rs`, BACKLOG #132)** — new `FluxError` (thiserror) with
  named kinds (Io/Json/Http/NotFound/Locked/Invalid/Other) and `From<FluxError> for String`,
  so commands keep their `Result<T, String>` IPC contract while internals get `?` instead of
  `.map_err(|e| e.to_string())` chains and matchable error kinds. `currency.rs` and `pdf.rs`
  migrated as the pattern exemplars; the rest migrate opportunistically as modules are
  touched.
- **Boot sequence decomposed into named phases** — `run()`'s 330-line setup closure is now
  ten ordered `init_*` functions (`restore_window_geometry`, `init_core_state`,
  `init_privacy`, `init_extensions`, `init_page_intel`, `init_knowledge`,
  `init_user_content`, `init_sessions_history`, `init_vault`, `finish_boot`), each with a
  doc comment saying what it wires. Boot order is unchanged and now readable at a glance;
  adding a store means editing one named phase instead of scrolling a god-closure.
- **No production panics left in flux-core** — audited every `unwrap`/`expect` outside test
  code (release builds abort the whole browser on panic). Three real ones fixed: a failed
  GGUF model load now falls back to Ollama instead of aborting at boot; `watch_add` no
  longer re-reads its entry after releasing the lock (a racing remove could panic a
  command); a boost save dropped its redundant find-again unwrap. The two that remain are
  deliberate fail-fast boot/codegen guards (`tauri::run`, specta export).
- **All stores now save atomically (`persist.rs`)** — every feature store (bookmarks,
  history, calendar, todos, sessions, feeds, extensions, permissions, sync config, the
  encrypted vault blob, …23 sites) wrote its JSON with a bare `fs::write`, so a crash or
  power loss mid-write could truncate the file and silently wipe that store on next boot.
  New `persist::write_atomic`/`save_json[_pretty]` helpers stage to a temp file in the same
  directory and rename over the target (atomic on NTFS and POSIX): readers now see the old
  file or the new one, never a torn mix. Same best-effort error contract as before.
- **Refactor: `commands.rs` split by domain** — the 1060-line, 69-command module is now
  three: `commands.rs` (shell chrome: tabs, groups, folders, workspaces, containers, web
  panels, clustering), `dom.rs` (DOM snapshot ingestion + the context-aware terminal env
  bridge), and `agent.rs` (Gemma chat/stream/plan/execute + semantic omni-search). Pure
  moves — every command name, signature, and the generated TS bindings are unchanged
  (`bindings_up_to_date` still green; all 146 tests pass).
- **Refactor: webview tiling extracted to `tiling.ts`** — the geometry engine that glues
  native webviews to the DOM chrome (content-card measurement, split/panel rect math, the
  show/hide reconciliation effects, and the layout constants `SPLIT_GAP`/`PANEL_TOOLBAR`/
  `PANEL_GUTTER`) now lives in one module, `createWebviewTiling()`, instead of being spread
  through App.tsx (−230 lines). App supplies its overlay/drag/focus accessors and keeps the
  returned liveness bookkeeping (opened/opening sets, `lastActive`) for hibernation and
  workspace switching. Pure extraction — no behavior change.
- **Refactor: one overlay registry for webview hiding** — the four hand-rolled boolean
  chains that decided "hide the native webviews, an overlay is open" (tiling effect, panel
  effect, relayout guard, post-open re-check) drifted apart and kept dropping newer overlay
  flags — the root cause of the buried-home-widget and hidden-split-view bugs. All overlay
  flags are now OR'd once in `pageOverlayActive()` (store.ts); the effects read only that.
  Adding an overlay is now a one-line registration. Also fixes two latent cases the old
  chains missed: a webview finishing its async open under an app pane / newer overlay would
  show on top of it, and an expanded home widget didn't hide a split-view neighbour's page.
- **Toolbar: Notebook (KB) pane replaces the Maps button** — the left nav cluster's 🗺 Maps
  button is now a 📓 **Notebook** button that opens your Onyx + Scroll knowledge base as a
  **floating glass pane** (like the file explorer) — a first-class entry to the second brain
  next to files (files = your filesystem, Notebook = your knowledge). ⤢ promotes it to a full
  `flux://notebook` tab; Esc / click-outside closes. Maps lives on as a home widget.
- **Expanded calendar is now a Google-Calendar-style time grid** — the home calendar's
  **⤢ Expand** opens a **Week / Day** view with an hours×days grid, events placed as
  positioned blocks (overlap-aware column packing, so concurrent meetings sit side by
  side), an all-day row, a live red **now** line, and ‹ › / **Today** navigation. Click a
  day header to drop into Day view. Uses the new `DTEND` end-times so blocks show real
  duration. (Was "I want the expanded calendar to resemble Google Calendar so I can see
  all my events lined up for the day and week".)
- **Task manager rebuilt btop-style (full page)** — `flux://tasks` is now a full-page
  system monitor: **CPU** overall graph + **per-core** load bars + model name, **RAM +
  swap** bars with a graph, **network** throughput (↓/↑ bytes/sec with a graph), and a
  **GPU** panel per card (utilization, VRAM, temp, power) via `nvidia-smi` (hidden on
  non-NVIDIA / no driver), plus uptime, process count, and the sortable process list
  with end-task filling the rest. (`SysStats` gained per-core/swap/uptime/net; new
  `gpu_stats` command.)
- **Terminal renders TUIs much better** — the terminal now uses a **GPU renderer**
  (`@xterm/addon-webgl`, like Windows Terminal / VS Code) for crisp glyphs and smooth
  scrolling, falling back to the DOM renderer if WebGL is unavailable; and `lineHeight`
  is 1.0 so box-drawing frames (btop, vim, lazygit) connect without gaps. With the
  bundled Nerd Font (#76), most TUIs now look right.

### Internal
- **flux-term grid: scrollback + reflow (#9)** — the (future) WGPU terminal renderer's
  grid now keeps scrolled-off rows in a bounded ring buffer and re-wraps content on
  resize instead of clearing (soft-wrap flags → logical lines → re-split to the new
  width). Pure logic, unit-tested. Not yet wired in — the shipping terminal is still
  xterm.js; the GPU renderer (#7/#13) stays deferred until WGPU-under-webview
  compositing is solved.

### Added
- **Music bubble: real beat-synced visualiser (#126)** — the orb now pulses to the *actual*
  audio. A tiny WSL helper (`tools/audioviz`, single Go binary, no deps) taps the PulseAudio
  monitor, computes energy + bass/mid/treble, and streams it as SSE ~40fps; Flux relays it
  (`audioviz_stream`, lazily starting the helper on first play) and the orb scales/glows + the
  EQ bars dance to the beat. Works for any audio, no Spotify API. One-time build:
  `go build -o ~/.local/bin/audioviz ./tools/audioviz`.
- **Floating music bubble — AudioPulse/Spotify mini-player (#125)** — a Siri-style orb pinned
  to Flux's right edge that expands on hover into a rounded player: play/pause, prev/next, shuffle,
  repeat, volume, album art + now-playing, and a **playlist menu** (pick a playlist → it plays).
  Drives the same Spotify Connect playback AudioPulse uses (reuses Flux's Spotify backend; new
  `spotify_state` / `spotify_playlists` / `spotify_play_context`). The orb breathes while playing;
  a real beat-synced visualiser is next. Purple/pink/indigo; toggle via Ctrl+K → "music bubble".
- **Contradiction / novelty check on save (#124)** — when you save a note to Onyx via the
  agent ("save that to Onyx"), Flux now checks it against your knowledge base and posts a verdict:
  ⚠ contradicts / ↔ overlaps / ➕ adds to / ✦ new — with a one-line explanation and clickable
  links to the related notes. `kb_check` retrieves the closest existing items and has the agent
  judge; fully local, best-effort (never blocks the save).
- **Ambient connections rail (#123)** — a slim toggleable column (Ctrl+K → "Show connections
  rail") that, as you browse, surfaces your own related Onyx notes / Scroll papers / Council
  debates for the current page — the second brain compounding passively. `kb_related` embeds the
  page's captured text and runs a score-thresholded `kb_query`; the rail refreshes on each
  navigation and tab switch; click an item to open it. Fully local.
- **Terminal "Explain" speaks the diagnosis** — the agent-aware terminal's ✦ Explain now reads
  its answer aloud via the configured TTS voice (closing the overlay stops it).
- **Auto-start local services (Omni / Scroll)** — on boot Flux probes Omni (`:8080`) and Scroll
  (`:3131`) and, if down, launches them via your shell (so they start inside WSL on a Windows
  build), backgrounded so they outlive Flux. Opt out with `FLUX_NO_AUTOSTART=1`; override the
  commands with `FLUX_OMNI_START` / `FLUX_SCROLL_START`. The Notebook shows a Services strip with
  status + a manual Start.
- **Agent-aware terminal — explain / fix a failed command (#121)** — when a command exits
  non-zero (detected via the OSC 133 marks), the terminal shows a "⚠ exit N · ✦ Explain · ⚙ Fix"
  bar. **Explain** asks Gemma why it failed (answer in an overlay); **Fix** proposes a corrected
  command and types it at your prompt (Ctrl-U-cleared) for you to review and run. Fully local;
  needs shell integration on. A browser-and-shell feature no other browser has.
- **Co-scientist specialist voices (#120)** — fine-tuned council-specialists models are now
  routable. Flux auto-discovers any Ollama model named `<domain>-specialist:*` (physics / math /
  cs) and, when a grounded Notebook / "✦ My notes" question carries enough of that domain's
  vocabulary, answers it with the specialist instead of the default Gemma — shown as a "⚛ Physics
  specialist" badge. Routing is per-answer (thread-local model override; the global pick is
  untouched) and conservative; falls back to Gemma when no specialist is installed. New
  `agent_specialists` lists what's available.
- **Knowledge Base: Council briefs as a third source (#116)** — Gemma now also indexes your
  Council co-scientist debate briefs (`~/Research/debates/*.md`), so past hypotheses/debates
  are retrievable in the Notebook and "✦ My notes". Same Markdown pipeline as Onyx; the
  brief's `question:` frontmatter becomes the title. Override the dir with `FLUX_COUNCIL_DIR`
  or the in-app location field.
- **Drag-to-reorder pinned web panels** — drag the app-rail icons to reorder your pinned
  sites (persisted via a new `panel_reorder`); the drop target highlights teal.
- **Agent panel: "📎 Clip to Scroll" chip** — a one-tap hint (shown when a page is open) that
  clips the current page into Scroll.
- **Graph view: labels on hover only (#119)** — site names are hidden by default; hovering a
  node reveals its label and its direct neighbours', keeping the map clean.
- **Omni dashboard: semantic graph view (#119)** — a new **Graph** toggle in the Omni
  dashboard renders an Obsidian-style force-directed map of the index: top documents by
  PageRank as nodes (sized by rank), linked to their nearest neighbours by embedding. Drag
  nodes, scroll to zoom, pan the canvas, hover for titles, click a node to open it. Data comes
  from a new Omni `/graph` endpoint (separate omni repo), proxied through Rust (`omni_graph`).
- **Agent write access to Scroll & Onyx (#118)** — ask Gemma in the sidebar to **clip an
  article to Scroll** ("clip this page to scroll", "clip https://… to scroll tags: ai, rl") —
  it POSTs Scroll's /clip so Scroll scrapes + stores it — and to **save notes to Onyx**
  ("save that to Onyx", "save to Onyx: …[as <title>]") which writes a Markdown note into your
  vault (never overwriting). Backends `scroll_clip` / `onyx_new_note` honour the in-app
  Scroll-URL / vault-path you set in the Notebook.
- **Fix: terminal splits white-ing out the agent panel** — each terminal pane was running a
  WebGL2 shader backdrop (LiquidBackground) on top of the xterm WebGL renderer, so splitting
  (and the now-persistent column + TUI-app tabs) stacked enough WebGL contexts to make
  WebView2 mis-composite other glass surfaces white. The decorative backdrop is now drawn only
  for a single (unsplit) column pane and the visible terminal tab — hidden/extra panes no
  longer each hold a context.
- **Terminal: resizable splits + keep the column on terminal tabs** — split panes in the
  dev-terminal column now have draggable seams (drag to resize; weight shifts between the two
  neighbours, works for both side-by-side and stacked layouts). The terminal column also stays
  visible when a Terminal *tab* is active (e.g. after launching a TUI app), instead of vanishing —
  the column is your persistent shell, the tab lives alongside it.
- **Terminal apps: more defaults + seed migration (#117)** — the launcher now seeds
  audiopulse, boxtube, kata, mamba, forge, lazygit, conduit, mirage, tuxedo (alongside
  onyx/scroll/council). A seed-version bump merges the new entries into an existing list
  once, by id, without clobbering your renames/reorders or re-adding ones you deleted.
- **Terminal apps launcher bar (#117)** — a curated, editable strip beside the native pages
  bar with a chip per terminal/TUI app; clicking opens a new Terminal tab and auto-runs the
  app's command (cwd-aware). Seeded on first run with onyx / scroll / council; the ✎ editor
  adds/removes/reorders/renames apps (name · icon · command · working dir) and a ⌕ Scan pulls
  candidate binaries from your bin dirs. Persisted server-side (`tui_apps_*`). Shares the pages-bar toggle.
- **Agent panel: ask your notes & papers (#116)** — a third grounding scope, **✦ My notes**,
  next to "This page" / "All tabs" in the Liquid AI sidebar. With it on, your question is
  answered from the knowledge base (Onyx + Scroll) via `kb_answer`, streamed into the chat with
  clickable citation chips (Onyx notes open the file, Scroll papers open the source). The
  Notebook page stays the dedicated view; this is the quick in-conversation path.
- **Knowledge Base: in-app source locations (#116)** — set the Onyx vault path / Scroll URL
  directly in the Notebook (inline editor on any source that can't be found), persisted in
  Flux's config via `kb_set_source` — no more fragile `setx`/env-var propagation. Resolves a
  Windows build pointing at a WSL vault: paste the `\\wsl.localhost\<distro>\…\OnyxVault`
  UNC path and hit Save & index. In-app location wins over the env var; both beat autodetect.
- **Knowledge Base: Scroll large-library + binary fixes (#116)** — the Scroll connector no
  longer fails with "response too big" (`/api/articles` returns every article's full text;
  read past ureq's 10 MB cap). Articles whose `content_markdown` is escaped PDF/binary are
  detected and dropped (their `ai_summary` is still indexed) so they don't pollute retrieval.
  The Onyx "vault not found" error now echoes the exact `FLUX_ONYX_VAULT` value it tried.
- **Knowledge Base: explain an empty index + vault override (#116)** — a source that finds
  nothing now says *why* in the Notebook status (e.g. "Onyx vault not found", "Scroll not
  reachable") instead of a silent `0 docs`. New `FLUX_ONYX_VAULT` env override points Flux at
  a vault that lives elsewhere — notably a Windows Flux build indexing a WSL vault via
  `\\wsl.localhost\<distro>\home\you\OnyxVault`. A failed source no longer aborts a full reindex.
- **Knowledge Base: Scroll connector (#116)** — the second brain now also indexes your
  **Scroll** read-later library (articles + papers) via its `localhost:3131/api/articles`
  endpoint (override with `FLUX_SCROLL_URL`; reindex skips it gracefully if Scroll isn't
  running). `ai_summary` is embedded alongside the body; Notebook citations to a Scroll
  article open the original source in a tab, while Onyx citations open the note file. A
  **Notebook** chip is now pinned first on the pages bar.
- **Notebook view — ask your own knowledge (#116)** — `flux://notebook` (Ctrl+K → "Open
  Notebook"): a NotebookLM-style page where you ask a question and Gemma answers grounded in
  your indexed corpora, streaming the reply with clickable **citation chips** that open the
  source note. Shows per-source index status (docs/chunks/last-indexed) + a one-click Reindex.
  Onyx vault wired; Scroll papers next.
- **Knowledge Base backend — Gemma as a private second brain (#116, ADR 0010)** — new
  `crate::kb`: a local RAG vector store (flux-embed, persisted to `<app_data>/kb/kb-index.json`)
  with an **Onyx vault connector** (`~/OnyxVault/**/*.md`, frontmatter-aware, chunked, incremental
  by mtime). Commands: `kb_status`, `kb_reindex`, `kb_query` (cosine top-k) and `kb_answer` —
  a grounded, streamed answer that cites the user's own notes as `[n]`. Fully on-device;
  retrieval works even without Ollama (hash-embedder fallback). Notebook UI + Scroll source next.
- **Start page: daily briefing (#71, closes the item)** — a new widget where the local
  agent (Gemma) condenses today's feed headlines into 3–5 bullets. Generated on demand
  (✦ Brief me on today), cached per day so opening a new tab doesn't re-hit the model, with
  ↻ Refresh to regenerate. Fully on-device — headlines never leave the machine.
- **Terminal: in-column splits (#75)** — the dev terminal column can now hold several
  PTY panes at once. A hover toolbar (top-right) splits the focused pane, flips the layout
  between side-by-side and stacked (persisted), and closes the focused pane; click a pane
  to focus it (teal-ringed). Each pane is its own shell with the OSC 133 integration; the
  app's Terminal *tabs* still cover the tabbed-terminal case.
- **Files: streamed listing for huge directories (#86)** — `fs_list_stream` delivers a
  directory in chunks over a Channel (head → entries… → done) instead of one giant JSON
  payload, so a 100k-entry folder appears almost instantly and fills in progressively
  ("loading more…" in the status bar). The directory is read once (no per-page re-scan);
  navigations supersede in-flight streams via a generation token. Resolves the
  single-payload tradeoff noted in ADR 0006.
- **Terminal: shell integration (OSC 133, #16)** — bash terminals now emit semantic
  prompt marks (auto-injected via `bash --rcfile`, re-sourcing your `~/.bashrc`; opt out
  with `FLUX_NO_SHELL_INTEGRATION=1`). Each command gets a **gutter status bar** (violet
  running / green ok / magenta non-zero exit), **jump between prompts** with `Ctrl+Shift+↑/↓`,
  and **copy the last command's output** with `Ctrl+Shift+E`. zsh/PowerShell snippets in
  `docs/shell-integration.md`.
- **Files: "Open in browser" + agent file actions (#87, closes the item)** — right-click a
  file for **Open in browser** (renders html/pdf/svg/images/text/media in a Flux tab via a
  `file://` URL; PDFs route through the built-in viewer), **Summarize with Gemma** (sends the
  file text to the local agent, shows the summary in a modal with Copy), and **Rename by
  content…** (the agent proposes a kebab-case name; you confirm before the rename applies).
- **Files: preview pane (#87)** — toggle ◰ in the explorer to preview the selected
  file on the right: image thumbnails, text/code contents, and an "Open in default app"
  fallback for everything else. Reuses the existing `attachment_read` (images→data URL,
  text→contents). Persisted toggle.
- **Bring-your-own proxy (#63)** — Settings → Privacy & security → **Proxy (HTTP /
  SOCKS5)**: route page traffic through any proxy you supply (e.g. `socks5://127.0.0.1:1080`
  for an SSH `-D` tunnel, Cloudflare WARP, Tor, or a self-hosted Shadowsocks/Dante;
  `http://host:port` too). Applies to new and reloaded tabs; empty = direct. Validated
  (only http/socks5 accepted) and persisted; a bad value safely degrades to direct. Flux
  doesn't run a VPN — it points WebView2 at the endpoint you give it.
- **Files: search subfolders (#88)** — the ⌕ toggle next to the explorer's Filter box
  flips it from filtering the current folder to **recursively searching filenames** in
  the whole subtree, **fuzzy-ranked** (fzf-style subsequence match with start /
  word-boundary / contiguous bonuses — so "mcf" finds "MyConfigFile.json"). Debounced;
  skips `node_modules`/`.git`/`target` and other heavy/hidden dirs; bounded so big
  trees stay responsive. Each hit shows its relative folder; click to jump there. An
  optional **✦ semantic** toggle re-orders matches by filename relevance using the
  local embed model (one batched `/api/embed` call; no-op on the hashing fallback).
  (`fs_search`, unit-tested.)
- **Bundled terminal font (#76)** — CaskaydiaCove (Cascadia Code) Nerd Font Mono is now
  bundled (woff2, ~2.4 MB) and preferred by the terminal, so prompt/powerline/icon
  glyphs render out of the box without installing a font. Falls back to installed
  Nerd/programming fonts if you prefer them.
- **Start page: Omni glance widget (#97)** — a card showing your local Omni index at a
  glance (pages indexed, vectors, embedder) with a one-tap link to the full dashboard.
  Toggle/reorder it like any widget.
- **Start page: custom background (#71)** — the ⚙ customize popover takes an image URL
  or any CSS color/gradient for the start-page background (empty = the liquid/wave
  backdrop). Persisted.
- **Files: "Open terminal here" (#87)** — right-click a folder (or the empty area) in
  the file explorer → opens a Terminal tab already `cd`'d into that directory.
- **Terminal links open Flux tabs (#17)** — clicking a URL in the terminal now opens a
  Flux **browser tab** (closing the terminal↔browser loop) instead of the OS browser —
  both auto-detected URLs and explicit OSC 8 hyperlinks. Web URLs only; other schemes
  are left untouched.
- **Boosts: edit the CSS + manage every site (#49)** — the ✨ Boosts popover now has an
  **AI / CSS** toggle (let the agent write the CSS, or paste your own), an **✎ edit**
  button on each boost to tweak its CSS inline, and an **All sites** view that lists and
  manages every boost across hosts (toggle / edit / delete). Boosts now also match
  **subdomains** — a boost on `github.com` applies to `gist.github.com` too (a
  subdomain-specific boost stays scoped; a leading `*.` is accepted); suffix-spoofs
  like `github.com.evil.com` don't match. Still CSS-only by design (raw JS isn't exposed).
- **Start page: customize widgets (#71)** — a **⚙** in the top corner opens a checklist
  to **show/hide** widgets you don't use (Recent, Shortcuts, Top sites, Headlines,
  Scratchpad, Calendar, Tasks, Quick actions) and **↑/↓ reorder** them; both persisted
  locally (applied via CSS `order`, which the card grid honours). The clock/search hero
  always stays first.
- **Single-instance launch (#20)** — a second `flux <url>` (or a link opened from the
  OS) now adds tabs to the **already-running** Flux window and focuses it, instead of
  spawning a whole second process. Reuses the same argv parser as cold launch (so
  multiple URLs and `-t` for a terminal tab work), via `tauri-plugin-single-instance`.
  Under **WSL**, `flux <url>` would otherwise hit the Linux dev build (a separate
  process the plugin can't dedupe across to Windows) and open a second *"Flux
  (Ubuntu-…)"* window — so the Linux build now forwards GUI launches to `flux.exe`
  (which single-instances into the running Windows Flux). `FLUX_LINUX_GUI=1` opts out.
- **Auto-archive stale tabs (#46)** — Settings → *Auto-archive stale tabs* (Off by
  default; 1–30 days): browser tabs left untouched that long are closed into a
  restorable **Archived Tabs** list (the 🗄 footer button, shown once anything's
  archived) — reopen any with one tap. Pinned, foldered, active and start tabs are
  never archived; the sweep is gentle (a few per minute). Last-access is keyed by URL
  so it survives restarts, and freshly-restored tabs are seeded as fresh so they're
  never archived on sight. Hibernation already reclaims their RAM; this clears the
  clutter. (Arc-style.)
- **Responsive layout (#28)** — the fixed column grid (sidebar · content · web panel ·
  terminal · agent) no longer crushes the content card on a narrow window. As width
  shrinks, panes are shed in priority order — terminal, then web panel, then agent,
  then the sidebar collapses to its icon rail — and restored as the window grows back.
  Non-destructive: your open/closed intent is untouched (the toggles stay set), only
  the rendered layout adapts to keep the content card at a usable width. (ADR 0002
  mitigation; a `responsive` memo over a tracked window width.)
- **Adaptive fix loop (#115)** — *"/fix &lt;goal&gt;"* (e.g. *"/fix make the tests in
  src/foo.rs pass"*) runs an iterative agent loop: plan ONE step → run it → read the
  result → re-plan, reacting to failures — run the tests, read the failure, edit a fix,
  re-run — until the model says it's done/stuck or a 10-step cap. Each step routes
  through the same tools, so edits/commands still ask for approval, and the step's
  output (terminal text, edit status) is fed back into the next plan. (`agent_next_step`
  / `plan_next_step` + `runAdaptiveTask`.)
- **Multi-step chains (#115)** — chain Gemma's tools in one request: join steps with
  *"then"* / *"+"* (e.g. *"read src/foo.rs then fix the bug then run the tests"*, or
  *"play my liked songs + shuffle on"*). Explicit connectors are split directly (so
  *"search rust async + remind me to read it tonight"* reliably becomes two steps
  instead of being searched whole); only implicit phrasing falls back to the model
  (`agent_plan_steps`). Each step is routed through the same tools as a typed message,
  in order; edit/shell steps still show their approval card and the chain
  pauses there until you Apply/Run (continue) or Cancel (abort the rest). Works typed or
  by voice. Only fires on a connector + a real first action, so single commands and chat
  fall straight through.

### Performance
- **Idle polling pauses when hidden** — the panel refresh timers (downloads, shields,
  boosts, passwords, macros, tasks, resources, vault, omni dashboard, settings RAM
  readout, start-page clock) used a bare `setInterval`, so a minimised / backgrounded
  Flux kept hitting the backend every 2–4 s. A new `visibleInterval` primitive ticks
  only while the document is visible and refreshes once on return — zero idle polling
  when you're not looking at it. (`poll.ts`.)

### Added
- **Gemma runs commands in your live terminal (#65)** — *"run cargo test"* / *"execute
  ls -la"* (or ask naturally, *"what's in my downloads"*) → a **▶ Run in terminal**
  approval card → on tap she types the command into your **real embedded terminal**
  (your cwd / env / history), you watch it run live, and she **reads the output back**
  from the scrollback to report / re-plan. Opens a terminal first if none is up; same
  rm/destructive **denylist** as the headless path (enforced via `shell_guard` before
  the keystrokes hit the PTY). Together with file editing this closes **read → reason →
  change → verify** — edit a file, run the tests, read the failure, fix it.
- **Split web panel (top / bottom)** — stack two pinned panels in the side pane, e.g.
  **calendar over email**, both live at once. In *Web panels* tap a panel for the top
  slot and **⬓** to stack one below; drag the divider between them to re-balance (the
  split ratio + both open panels persist across launches). Each panel keeps its own
  reload / close toolbar; closing the top promotes the bottom up. (Frontend-only — the
  backend already keys panel webviews per id.)
- **"Hey Gems" wake word** — Gemma now answers to the shorter *"hey gems"* / *"gems"*
  (added to the wake regex + the Vosk wake grammar) alongside *"hey gemma"*.

### Fixed
- **Flux reopens windowed at its last size (never fullscreen)** — the window-state plugin
  was restoring the *maximized* flag, so once you'd ever maximized it, Flux relaunched
  maximized (looking full-screen with the custom title bar) and appeared to "forget" its
  size. Now we skip the plugin's auto-restore for the main window and restore only its
  size + position, so it always reopens at the last floating (un-maximized) geometry. The
  save still tracks everything, so the windowed size is preserved even if you close while
  maximized.
- **Split view works for Flux's own pages** — you can now tile the home page, task manager,
  Notebook, history, etc. (not just web pages). Internal pages are DOM-rendered, not native
  webviews, so the old tiling (which only positioned webviews) showed nothing for them; the
  content card now renders each split pane's page into its half. Trigger it from the command
  palette ("Split view"), the tab right-click menu, or dragging a tab to the right edge.
- **Web panel resize handle sits on the panel's edge** — the handle is now a full-height
  cyan line anchored to the pane's *own* left edge, so it's always at the panel boundary. The
  previous shell-level divider positioned itself by summing column widths but omitted the
  connections-rail width, so with that rail open it drifted into the middle of the panel;
  anchoring the handle inside the pane removes the width-math entirely. It lives in the
  reserved gutter the native webview is inset from (so it's visible and grabbable) and the
  webview hides while dragging so the pointer tracks freely.
- **Expanded home widgets no longer hide behind the web panel** — a start-page widget's
  expand modal is plain HTML, but a pinned **web panel is a native child webview that the
  OS composites *above* all page content**, so no `z-index` could cover it. The modal now
  flags `homeModalOpen`, and App hides the panel webview(s) while any widget is expanded
  (same mechanism as reader / files popout). (Was "the expanded panes get covered by the
  web app panel".)
- **Calendar: show recurring events + fix the cap dropping upcoming ones** — the ICS parser now
  expands `RRULE` recurrences (FREQ=DAILY/WEEKLY/MONTHLY/YEARLY with INTERVAL/COUNT/UNTIL, weekly
  BYDAY, and EXDATE) within a window from today, instead of emitting only each series' first
  instance — so weekly meetings etc. now appear on every upcoming date. Events are windowed to
  ~today−14…+180d so the 500→1500 cap keeps what's *upcoming* rather than the oldest history.
  Also captures DTEND for the day/week view. (Was "not all my Google Calendar events showed up".)
- **Fix: Spotify control buttons returned 411** — bodyless PUT/POST control calls (pause, next,
  prev, shuffle, repeat, volume) hit `ureq`'s `.call()` with no `Content-Length`, which Spotify
  rejects with `411 Length Required`. They now send an explicit empty body. Fixes the music bubble
  *and* the agent's existing Spotify controls.
- **Music bubble: feedback + vertical layout + device control (#125)** — every action now
  surfaces its result/error as a toast (previously failures were silent — usually "no active
  device"); a "Start ▶" button appears when there's no Spotify device (launches AudioPulse); and
  the expanded player is now a tall **vertical strip** (the bubble stretches up/down) instead of a
  square card, with a Portal'd playlist menu that survives the mouse leaving the strip.
- **Fix: service auto-start was unreliable** — Omni/Scroll are now launched in the shell's
  foreground (spawn-and-don't-wait) instead of `nohup … &`, whose backgrounded job could die
  with the transient one-shot WSL session. The shell host process keeps the server (and the WSL
  session) alive and survives Flux closing.
- **Fix: Omni dashboard/graph used `https://localhost:8080`** — `omni_base()` inherits its
  scheme from the default search-engine template, which can be https; a local Omni serves plain
  HTTP, so every call refused/failed. Loopback origins are now forced to `http://`.
- **"Group by topic" did nothing** — it grouped from whatever clusters happened to
  exist, so if they were stale or single-tab it silently created nothing. It now
  re-embeds the open tabs from their current page content first (fresh clusters), then
  groups, and shows a toast either way ("Grouped into N topics" or "no clear topics yet
  — open a few related pages and try again").
- **A console window flashed repeatedly on launch (Windows)** — the task manager's GPU
  poll spawned `nvidia-smi` without `CREATE_NO_WINDOW`, so a `C:\Windows\System32\
  nvidia-smi.exe` console flashed open/closed every couple of seconds. Both that and
  the headless `run_shell` fallback now spawn hidden, matching the rest of the app.
- **Always-on voice wouldn't turn on (clicking did nothing)** — if your previously
  selected microphone was unplugged/changed, the `deviceId: { exact }` constraint made
  `getUserMedia` throw, so the toggle silently reverted. It now **falls back to the
  default mic** (dropping the dead selection) and **surfaces the real reason** (mic
  permission denied / no mic / mic busy) in the agent panel instead of failing quietly.
- **File-explorer right-click menu didn't appear** — the context menu used
  `position: fixed`, but it renders inside the glass content card whose
  `backdrop-filter` is a containing block for fixed elements, so the menu landed
  off-screen (it had always been broken; surfaced by the new "Open terminal here"
  item). Now portalled to `<body>` like the agent menus.
- **Gemma's chat replies cut off** — free-text chat was capped at a flat 1024 output
  tokens, so longer answers stopped partway (you had to say "keep going"). The default
  is now **2048** (up from 1024). NB: it is *not* `-1` — some Ollama/llama.cpp builds
  treat `num_predict = -1` as a tiny value and cut off after a few words (the opposite
  of "infinite"), so a generous positive is used. `FLUX_OLLAMA_NUM_PREDICT` overrides;
  structured JSON replies keep their tight 512. (If long answers still clip, raise
  `FLUX_OLLAMA_NUM_CTX` above 4096 — costs a little RAM.)
- **Voice commands ignored after the wake ack** — `voiceRespond` bailed on `working()`,
  which includes `listening()` — and the voice pipeline sets `listening()` true *while
  handling the command*, so every spoken command rejected itself (and before the
  `ttsSpeaking` fix it threw outright). Now it only bails on a real in-flight request.
- **Gemma never reported terminal output** — the read-back baseline used the xterm
  buffer *length*, but on a fresh terminal the prompt is near the top with empty rows
  below, so it read below the output and saw nothing. Baseline is now the cursor row
  (`baseY + cursorY`), so the command's echo + output are captured and reported back.
- **TTS cut off at `<`** — many TTS backends parse `<…>` as SSML and stop speaking at
  the `<` (e.g. "volatile `<dtype>`" stopped after "volatile"). `cleanForSpeech` now
  drops angle brackets so the whole line is read.
- **Empty chat replies ("(no response)")** — small local models sometimes return
  nothing on a terse, symbol-heavy prompt under the big system preamble; chat now
  retries once with the bare question before giving up.
- **Chrome vanishing after fullscreen video** — exiting an HTML5 video fullscreen left
  the native page webview oversized, covering the bookmark bar / sidebar footer: on
  exit wry restores the webview to fill the parent window (Flux tiles bounds itself),
  and no DOM event the chrome can see fires. Now the page webview's WebView2
  `ContainsFullScreenElementChanged` is hooked on the backend (`install_fullscreen_relayout`,
  Windows) and emits `flux://fullscreen-changed` on *exit only* — the frontend re-applies
  the tiled bounds so the chrome comes back. (Supersedes the earlier focus/visibility
  attempt, which couldn't observe the page webview's fullscreen.)
- **Agent panel `working()` crash** — `working()` referenced an undefined `ttsSpeaking`
  (only the prod build, which skips typechecking, let it through); now uses the imported
  `speaking` signal.

- **Gemma edits files (with approval)** — *"edit src/foo.rs: rename X to Y"* (or, after
  reading a file, *"change it to …"*) → she proposes surgical search/replace edits, you
  see a **colored diff**, and **nothing is written until you tap ✓ Apply**. WSL-aware
  writes; applied edits update the file context. Completes read → reason → change.
  (`plan_edit` + `write_text_file`.)
- **UI introspection (debug Flux itself)** — *"app state"* snapshots the live UI
  (tabs, workspace, panels, overlays, appearance, agent model); *"css variables"* /
  *"what's --flux-teal"* dumps the theme vars; *"inspect <css selector>"* reports an
  element's computed style + visibility (why it's hidden / a var isn't applying).
  Results drop into context for follow-ups. (SolidJS signals are closures, so this is
  curated DOM/CSS + store snapshot, not arbitrary signal reads.) (`debug.ts`,
  `fluxStateSnapshot`.)
- **Terminal context ("read the terminal")** — *"read the terminal"* / *"what's in my
  terminal"* pulls the active Terminal tab's recent scrollback into Gemma's context
  (a chip like a file), so she can debug a failed command / read build output you ran
  yourself — not just commands she runs. (`terminals.ts` xterm-buffer registry.)
- **File context ("read this file")** — *"read src/foo.rs"* / *"look at <path>"* pulls
  a file into Gemma's context so she can answer about it without copy-paste, and it
  **stays for follow-ups** (chips above the input show what's loaded; ✕ or "forget the
  files" clears). WSL-aware: unix paths (`~/Flux/Cargo.toml`) are read through WSL on
  a Windows build. Capped so the prompt stays sane. (`read_text_file`.)
- **System awareness** — ask Gemma *"system status"* / *"how's my CPU"* / *"what's
  using my memory"* and she reports CPU%, RAM used/total, and the top processes by
  memory (`mem.rs` `system_stats`).
- **Editable personality** — Gemma now has an upbeat, energetic default persona
  prepended to every reply; customize it (or go terse/formal) in Settings →
  Integrations → "Gemma's personality".
- **Faster Windows links (auto)** — `install-windows.ps1` auto-uses the LLD linker
  (`lld-link.exe`) when it's on PATH, falling back to MSVC link.exe otherwise; with
  the `-Fast` `release-fast` profile that gets a full build well under the old time.
- **Microphone controls (recognition tuning)** — Settings → Integrations now has a
  **Microphone** device picker (the OS default mic is a common cause of poor
  recognition) and a **Noise suppression** toggle. Noise suppression is now **off by
  default** for both the always-on loop and push-to-talk — browser NS is tuned for
  human listening and tends to degrade whisper/Vosk; auto-gain stays on. (`mic.ts`.)
- **Proactive reminders & to-dos** — *"remind me to <x> in 10 minutes / at 3pm /
  tomorrow"* schedules a reminder; when it's due Gemma shows it, says it aloud
  (*"Hey Razeen, just popping in — …"*), **and pops an OS notification**. Undated ones
  become to-dos; *"what are my reminders"* lists them. Set your name + toggle spoken
  reminders in Settings → Integrations. Now **backend-scheduled** (`reminders.rs`):
  reminders persist in `app-data/reminders.json` (survive restarts) and a background
  task fires them even with the agent panel closed — so the OS toast shows regardless.
  (Cross-*launch* alarms while Flux is closed would still need an OS scheduled task.)
- **Whisper wake word falls back to Vosk** — selecting Whisper for the wake word no
  longer silently dies on short clips / when whisper isn't configured; it falls back
  to the Vosk grammar + full-model pass so "hey Gemma" still registers.
- **Gemma's long-term memory** — say *"remember that …"* (or "/remember", "note …",
  "keep in mind …") and Gemma saves the fact to a Markdown file that's injected into
  every chat as context, so it persists across conversations (beyond the per-chat
  window). *"what do you remember"* reads it back; Settings → Integrations shows the
  file path + a Clear button. It's a plain `.md` at `<app-data>/memory.md` you can
  open/edit (`FLUX_MEMORY_FILE` relocates it). Fully local. (`memory.rs`.)
- **Voice barge-in** — talk over Gemma and she stops: while she's speaking, clearly
  louder sustained speech cuts the TTS (the threshold sits above echo-cancelled
  residual so she doesn't stop herself), and the warm window opens so your next words
  are taken as the command.
- **Whisper wake word** — a third wake-word option (Settings → Integrations → Wake
  word) that runs whisper.cpp on each utterance for the most accurate "hey Gemma"
  detection (more CPU than Vosk grammar-spotting). Mic now uses **autoGainControl**
  so a quiet mic is normalized (helps both detection and command recognition), and
  the VAD is more sensitive again.
- **Saved chats** — every conversation persists; a **🕘** menu in the panel header
  lists past chats (titled from the first message) to reopen or delete, and **＋ New
  chat** saves the current one and starts fresh. The most recent reopens on launch.
- **Interrupt Gemma** — a **■ Stop** button appears in the input row while she's
  thinking or speaking: it cuts the TTS and abandons the streaming reply (so a
  mis-heard prompt doesn't make you sit through the answer). Spoken replies are also
  capped to a sentence or two (the full text still shows in the panel).
- **Chat memory** — Gemma now remembers the recent conversation: each reply is sent
  with the last several turns as context, so follow-ups ("what about the second one?")
  work. A **＋ New chat** button in the panel header clears the conversation when you
  want a fresh context.
- **"Search …" opens a tab** — "search <x>", "google <x>", "look up <x>", or "open a
  new tab and search <x>" (typed or by voice) opens a new browser tab with the result
  (respecting your default engine). Note: this is separate from `/act` and `/task`,
  which act on the *current page's* DOM and can't open tabs.
- **Gemma can run terminal commands (with one-tap approval)** — "run <cmd>" /
  "execute <cmd>" / "/run <cmd>" (typed or by voice) proposes a shell command as a
  card with **▶ Run / Cancel** buttons; **nothing executes until you tap Run**. It
  runs in the same shell the embedded terminal uses (WSL on Windows) and shows the
  output in the panel. Two safety layers: the approval gate, plus a backend
  **denylist** that blocks `rm` and other destructive commands (rmdir/del/dd/mkfs/
  format/shutdown/…, matched against every token so `sudo rm`/`find -exec rm` are
  caught). `FLUX_EXEC_SHELL` overrides the shell. (`exec.rs` `run_shell`.)
- **Natural-language commands** — you no longer need the literal "run" prefix.
  Ask *"list all the files in my home directory"* and the local model translates it
  to a command (`ls ~`) and proposes it with the same Run/Cancel approval card.
  Gated to machine/file-type requests so normal chat isn't slowed by an extra
  round-trip — Settings → Integrations has a **"Translate every message to a
  command"** toggle to instead try it on every message. (`agent_shell_plan` →
  `AgentPlanner::plan_shell`.)
- **More reliable Vosk wake word (grammar spotting)** — the default "hey Gemma"
  detection now runs a **grammar-restricted** Vosk pass that only recognizes the
  wake phrase (everything else collapses to "[unk]"), so random speech rarely
  false-triggers and it's lower-CPU than full transcription. The command is then
  taken from an accurate full transcription (Vosk or whisper), so same-breath
  commands ("hey gemma, play jazz") still work. Zero setup; needs no account —
  unlike Porcupine, which gates its console behind a business email.
  (`voice.rs` `wake_transcribe` via `vosk_recognizer_new_grm`.)
- **Porcupine wake word (opt-in)** — a dedicated "Hey Gemma" wake-word model as an
  alternative to the default Vosk transcribe-and-match: far fewer false triggers and
  lower CPU. Runs the Porcupine **Web** SDK in the renderer (dynamically imported, so
  its WASM only loads when enabled), fed from the same mic pipeline — detection stays
  **on-device, no audio leaves**. Pick **Porcupine** under Settings → Integrations →
  Wake word; needs a free Picovoice access key (stored in the **OS keyring**) plus a
  custom `Hey-Gemma.ppn` (generated on console.picovoice.ai) and `porcupine_params.pv`.
  Falls back to Vosk if not configured. (`porcupine.rs` + `porcupine.ts`.)
- **Whisper.cpp speech recognition (opt-in)** — a more accurate STT engine for the
  spoken command than the small Vosk model, especially with accents/noise. Pick
  **Whisper (accurate)** under Settings → Integrations → Recognition; set
  `FLUX_WHISPER_MODEL` to a ggml model (e.g. `ggml-base.en.bin`). Runs via the
  `whisper-cli` binary (no link deps, like Piper), resampling the mic to 16 kHz;
  falls back to Vosk if whisper isn't installed. Wake detection stays on the fast
  Vosk pass, so whisper only runs on the command (~1–3 s). Fully local — audio goes
  to a temp WAV that's deleted right after. (`stt.rs` `stt_whisper`.)
- **ElevenLabs shared voice import** — pasted ElevenLabs voice-library links now
  add the shared voice to the configured ElevenLabs account before selecting it,
  and the Settings **Test** button reports ElevenLabs API errors instead of
  silently falling back to the system voice.
- **Manual ElevenLabs voice links** — Settings → Integrations now accepts a
  pasted ElevenLabs voice link or raw voice ID when a shared/custom voice is not
  returned by the account voices dropdown.
- **ElevenLabs voice (opt-in, cloud)** — a third TTS engine alongside System and
  Piper, for a much more natural voice. Pick **ElevenLabs (cloud)** in Settings →
  Integrations, paste an API key (stored in the **OS keyring**, never plaintext /
  localStorage), and choose from your account's voices (fetched live; 🔊 Test to
  preview). Clearly labeled cloud: choosing it sends Gemma's **reply text** — not
  your mic audio (STT stays local) — to ElevenLabs, and it's metered. Falls back to
  the System voice on any error (no key, offline, quota). System/Piper remain the
  local default. (`tts.rs` `elevenlabs_*` + `speak.ts`.)
- **"Hey Gemma" — always-on, fully-local voice conversation** — say *"hey Gemma"*
  and the agent acknowledges, listens, answers **out loud**, then stays warm for
  follow-ups (no wake word needed) so you can keep talking. The whole loop is
  on-device: wake + speech-to-text via **Vosk**, the reply via **Ollama**, and the
  spoken voice via the webview's **speechSynthesis** (OS voices, zero setup) or
  **Piper** (local neural TTS — set `FLUX_PIPER_MODEL`; falls back to the system
  voice if absent). Voice commands route through the same pipeline as typed input,
  so *"hey Gemma, play my liked songs and shuffle on"* works too.
  **Privacy by construction:** nothing leaves the device (no cloud STT/TTS ever);
  audio before the wake word is discarded immediately and never written to disk;
  the mic is gated shut while Gemma speaks so it can't hear itself; a live mic
  indicator + hard toggle sit in the agent panel; **off by default**, opt-in in
  Settings → Integrations. (`tts.rs` `voice_speak` + `speak.ts` + `heygemma.ts`.)
  Gemma now speaks with a **female voice by default** (auto-picks a natural female
  English voice; pick a specific one in Settings → Integrations → System voice, with
  a **🔊 Test** button to preview it).
- **cr-sqlite CRDT sync — prototype** (BACKLOG #62 evolution, behind the `crsync`
  cargo feature) — explores replacing the single-encrypted-blob sync with **SQLite
  CRR tables + changeset exchange**: each device keeps its own DB, exports compact
  `crsql_changes` deltas (which would be encrypted + dropped in the existing
  bring-your-own folder), and merges them **conflict-free** — concurrent edits
  resolve last-writer-wins, deletes propagate with no tombstone bookkeeping. Keeps
  the no-server, local-first model while removing the history cap. `crsync.rs` +
  3 tests proving two devices converge. Needs the native cr-sqlite extension
  (`third_party/crsqlite/`, BYO per platform); not yet wired to the live stores.

### Fixed
- **Misheard music verbs + filler** — STT often turns "play" into "played"/"playing",
  so the music intents now accept those, and "play the song <x>" / "this track <x>"
  filler is stripped from the search. More sensitive always-on VAD (lower threshold,
  longer pre-roll). "search up <x>" is recognized as a search too.
- **Compound music commands run every step** — "launch spotify and play my liked
  songs, shuffle on" now launches AudioPulse *and* plays *and* shuffles. Previously
  the leading "launch …" intent matched first and swallowed the rest; the compound
  split is now tried before a single intent, and "with" joins steps too ("play my
  liked songs **with shuffle on**"). The voice path uses the same logic now, so
  compound spoken commands work. (`handleMusic` in AgentPanel.)
- **Agent model picker** — the Flux Agent model dropdown is now opaque and sits
  above the chat feed, so model rows highlight on hover and can be clicked.
- **Omni answer popup dismissal** — completed Omni answer cards now auto-dismiss
  after a short delay and include a close button, so they no longer sit over the
  pinned tabs area indefinitely.
- **Music with no active device auto-starts AudioPulse** — asking to play something
  when no Spotify Connect device is online now **launches AudioPulse for you** (idempotent)
  and tells you to try again in a few seconds, instead of just erroring. (`spotify.rs`.)
- **More reliable natural-language → command** — the shell-translation prompt now
  includes worked examples (`"list the files in my home directory"` → `ls -la ~`),
  so the local model emits the command reliably instead of declining. (`plan_shell`.)
- **"Launch AudioPulse" from a Windows build now works** — instead of scanning the
  `\\wsl.localhost` mount (which often found nothing), Flux launches it through
  `wsl.exe` and lets the WSL login shell expand `~/AudioPulse/audiopulse`. Override
  the path with `FLUX_AUDIOPULSE_BIN` (WSL-side) and the distro with
  `FLUX_AUDIOPULSE_DISTRO`. (`spotify.rs`.)
- **"Hey Gemma" always-on now reliably hears the wake word** — the voice activity
  detector used a fixed threshold that was too high for some mics (push-to-talk
  worked because it captures regardless). It's now **adaptive** (tracks your ambient
  noise floor) with pre-roll so the start of "hey" isn't clipped, and wake detection
  falls back from the grammar pass to the full model — the same one push-to-talk
  uses — so if PTT hears it, always-on does too.
- **ElevenLabs selected voice display on reload** — the Settings dropdown now
  renders the saved voice as an explicit current option before the live
  ElevenLabs voice list loads, so it does not visually reset to "Select a voice…".
- **Typed Gemma replies use the selected voice** — normal Agent panel replies now
  speak through the configured TTS engine after the text response finishes
  streaming, matching the Hey Gemma voice loop.
- **ElevenLabs selected voice persistence** — the chosen ElevenLabs voice now
  persists both its ID and display name, so shared/custom voices remain selected
  and readable after reopening Settings or restarting Flux.
- **Generated TTS playback fallback** — if WebView rejects generated audio
  `blob:` URLs, Flux now decodes the returned MP3/WAV bytes with Web Audio and
  plays the buffer directly.
- **ElevenLabs preview audio in WebView** — generated MP3/WAV playback now uses
  Blob object URLs instead of `data:` URLs, avoiding WebView's URL safety check
  rejection for ElevenLabs preview audio.
- **ElevenLabs test playback reporting** — the Settings **Test** button now
  reports browser audio playback failures instead of saying "Voice tested" when
  ElevenLabs returned billable audio but the webview could not play it.
- **ElevenLabs synthesize diagnostics** — TTS now preflights the selected voice
  before synthesis and preserves ElevenLabs 401 response bodies instead of
  labeling every synthesize 401 as an API-key failure.
- **ElevenLabs typed-key verification** — Settings now verifies the exact key in
  the input before writing it to the OS keyring, strips hidden clipboard
  characters, then verifies the stored key separately so 401s reveal whether the
  typed value or the keyring value is being rejected.
- **ElevenLabs keyring refresh** — saving a new ElevenLabs key now deletes the
  previous OS keyring entry first, verifies the saved value round-trips, and
  reports a masked length/prefix/suffix label so a 401 can be compared against
  the key that works in curl without exposing the full secret.
- **ElevenLabs key snippet cleanup** — Settings now extracts the actual API key
  from pasted JSON, curl/header snippets, and multi-line copied text before
  storing it in the OS keyring.
- **ElevenLabs API key paste handling** — Settings now strips common copied
  wrappers such as `Bearer ...`, `xi-api-key: ...`, and
  `ELEVENLABS_API_KEY=...` before saving, then verifies the stored key with
  ElevenLabs so bad credentials fail at Save instead of during voice playback.
- **"Launch AudioPulse" from a Windows Flux build** — AudioPulse lives in WSL, so
  the Windows build now crosses the boundary with `wsl.exe -d <distro> -- ~/AudioPulse/
  audiopulse` (auto-detecting the distro/user; the ConPTY gives the TUI a real
  terminal). Previously it looked for the binary at a Windows path and failed.
  `FLUX_AUDIOPULSE_BIN` still overrides. (`spotify.rs`.)

### Changed
- **"launch spotify" launches AudioPulse** — Vosk often mishears "pulse", so the
  launch intent now accepts "spotify"/"audiopulse" as well as "audiopulse".
- **Quieter build** — the ~3.3 MB Porcupine lazy chunk no longer trips Vite's
  500 kB chunk-size warning (`chunkSizeWarningLimit`); the eager-chrome budget is
  still enforced by the manifest gate.
- **Concise ElevenLabs voice preview** — the Settings **Test** phrase for
  ElevenLabs is now "Hi, I'm Gemma" so previewing a paid cloud voice stays short.
- **ElevenLabs status messages are readable** — the Settings API-key save result
  and diagnostic 401 text now render below the key field in a wrapped status line
  instead of being squeezed into the Save button.
- **Faster Windows builds** — `[profile.dev] debug = "line-tables-only"` cuts the
  debug info the MSVC linker writes (still keeps file:line in backtraces), and a new
  `.cargo/config.toml` documents the bigger lever (the LLD linker) plus `sccache`
  and `cargo tauri dev`. Backtraces are unchanged on release.

### Fixed
- **Vosk DLL dependency loading on Windows** — voice transcription now loads
  `libvosk.dll` with Windows' altered DLL search path so companion DLLs beside
  Vosk are discoverable, and loader errors now show whether each configured path
  exists.
- **Windows voice builds no longer require `libvosk.lib`** — the `voice` feature
  now loads Vosk dynamically at runtime, so MSVC release builds do not fail at
  link time with `LNK1181: cannot open input file 'libvosk.lib'`. Set
  `FLUX_VOSK_LIBRARY` or `FLUX_VOSK_LIB_DIR` when using voice transcription.
- **Windows voice install path is explicit** — `scripts/install-windows.ps1 -Voice`
  now builds and installs a voice-enabled `flux.exe`, and the non-voice runtime
  message points at the installed-binary mismatch instead of implying Vosk failed
  to link.

### Added
- **Push-to-talk voice input** (offline) — a 🎤 button on the agent input: **hold to
  talk, release to transcribe** locally with **Vosk** (reusing AudioPulse's model);
  the text drops into the input to review/edit before sending. Mic is captured
  in-browser (Web Audio → 16 kHz mono PCM) and transcribed on-device — no cloud.
  Behind the `voice` cargo feature (loads native `libvosk` at runtime; the default
  build ships the command as a graceful "not built" stub). `FLUX_VOSK_MODEL` points at a model
  dir (defaults to AudioPulse's `~/AudioPulse/third_party/vosk/model`). (`voice.rs`
  + `voice_transcribe`.)
- **Drag a file from the explorer into the agent** — with the file popout open, the
  agent panel lifts above its dimmed backdrop (stays visible + interactive) and
  becomes a **drop target**: drag a file from the explorer onto it and it attaches
  (image → vision model, text/code → chat context), with a dashed "drop here"
  highlight. Also accepts OS file drops. (`attachment_read` reads the dropped path
  → base64/text.)

### Changed
- **Push-to-talk sends after transcription** — releasing the agent mic now submits
  the Vosk transcript immediately, combining it with any typed prefix already in
  the input instead of only placing the text in the box.
- **Agent panel animation refresh** — the ambient panel effect now uses slower
  glassy ribbon currents at rest, then tightens into brighter focused currents
  with a slimmer dual edge sweep while the agent is thinking.
- **Liquid-glass home surfaces** — the start-page widget cards, the search hero,
  and the expanded-widget modals now have a richer "liquid glass" look: a glossy
  top-light reflection over the frosted fill, layered inner shadows for thick-glass
  depth, a top-left specular highlight, and a soft lift on the cards on hover (over
  the particle backdrop showing through the blur). Pure CSS.

### Added
- **Attach files/images in the agent panel** — a 📎 button on the agent input
  takes an **image** (→ sent to the local vision model, `gemma3:4b`, so you can
  ask about any picture, not just the current page) or a **text/code file** (→ its
  contents become context for your question). The attachment shows as a chip until
  you send; images render as a thumbnail in the conversation. Read entirely in the
  browser (FileReader), capped at 20 MB; video/other binaries are declined with a
  note. (`agent_vision` command.)
- **Visual Lens (local vision model)** — ask the agent **"what is this?"** /
  **"identify this"** / **"/lens"**, or ⌘K → **"Identify page (Lens)"**: Flux
  captures the active page (WebView2 `CapturePreview`) and asks a **local
  multimodal model** (`gemma3:4b` by default, `FLUX_VISION_MODEL` to override) over
  Ollama's `/api/generate` `images` field to identify the main subject — product,
  book, plant, animal, landmark, text, etc. Fully on-device, no cloud
  (`lens.rs` + `agent_lens`). Needs a vision model pulled (`ollama pull gemma3:4b`).
- **Ask Gemma to control music (AudioPulse / Spotify)** — the agent panel now
  understands music commands: **"play <song>"**, **"skip"/"next"**, **"pause"**,
  **"resume"**, **"previous"**, **"what's playing"** (optionally addressed —
  "hey gemma, play …", "can you skip"). It drives the **Spotify Web API** by
  **reusing AudioPulse's cached OAuth token** (`~/.config/audiopulse/token.json`),
  so when AudioPulse is running its librespot device is the active one and these
  control exactly what it's playing — no changes to AudioPulse needed. Token is
  refreshed on demand (held in memory, never rewrites AudioPulse's file); a clear
  message if AudioPulse isn't signed in or no device is active. On a **native
  Windows** Flux build (where AudioPulse lives in WSL) it auto-probes
  `\\wsl$\<distro>\home\<user>\.config\audiopulse`, or honours a
  `FLUX_AUDIOPULSE_DIR` override. (`spotify.rs` +
  `spotify_play`/`_pause`/`_resume`/`_next`/`_prev`/`_now_playing`.)
- **More music control + compound commands** — Gemma now also understands
  **"shuffle on/off"**, **"repeat one/all/off"** (and "loop this"), **"volume 40"**,
  **"play my liked songs"**, **"play my <name> playlist"**, and **"launch
  AudioPulse"** — the last runs the TUI inside a headless PTY so its Spotify
  Connect device comes online (Linux/WSL build; the handle is kept alive so the
  TUI isn't SIGHUP'd). Commands now **chain**: *"launch audiopulse and play my
  liked songs, make sure shuffle is on"* runs each step in order (only when every
  clause is a known music intent, so a normal "play X and Y" search still works).
  (`spotify_shuffle`/`_repeat`/`_volume`/`_play_liked`/`_play_playlist`/`_launch`.)
- **Google Maps popout** — a 🗺 button next to the file-explorer button opens a
  large floating Maps pane (mirrors the files popout: a centered DOM panel that
  hides the active tab's webview while open, click-outside / Esc to close). Embeds
  Google Maps via its keyless `output=embed` endpoint with a search box to jump to
  a place; the last search persists. (CSP gains `frame-src https://*.google.com`.)
- **Particle-flow home backdrop** (BACKLOG #77) — the start page's flowing wave
  can now be a **WebGL particle field**: ~8,000 fine **monochrome** particles
  advected by a curl-noise flow that leave **fading trails** (frame-feedback) so
  they bunch into flowing fingerprint/topographic ridges, over a velvet base with
  soft drifting glow blobs — a smoke/ferrofluid look, no fixed hue. Built lean for
  the low-RAM wedge — a few draw calls + ping-pong framebuffers, no Three.js — and
  it **only animates while the start page is the active, focused, visible tab**
  (switching away tears the GL context down to zero), pauses on blur / resize,
  renders the field at ~0.8× resolution + ~40 fps, honours `prefers-reduced-motion`,
  and **auto-falls back to the lightweight wave** if WebGL2 isn't available or a
  shader fails. Toggle in Settings → Appearance ("Liquid home background", on).
- **Agent panel ambient glow** — a Gemini-style soft multi-colour gradient now
  **flows around within** the Flux Agent panel, and while the agent is working a
  bright arc **orbits the panel's edge** as a "thinking" indicator. Pure CSS on a
  dedicated effects layer (so it never affects layout or clips the model
  dropdown); honours `prefers-reduced-motion`.
- **Web panel unread badges** (BACKLOG #48) — pinned web panels (Discord, Proton
  Mail, LinkedIn, Gmail, WhatsApp…) now show a **phone-style red unread bubble** on
  their rail icon. An injected title-watcher parses the unread `(N)` count from the
  page title (the convention these apps all use) and reports it to the chrome; no
  content is captured, so panels stay history-clean. Live for the currently-open
  panel; the others keep their last-known count until reopened. (A new
  `capabilities/panel.json` grants panel webviews the `fluxtab` bridge for the
  report — which also makes keyboard-chord forwarding work inside panels.)
  _Coming next, if wanted:_ an opt-in "keep pinned panels live" mode so every
  badge updates without opening each panel (trades RAM for always-fresh counts).
- **Pages bar** — an opt-in quick-access strip docked **above** the content card
  (mirroring the bookmark bar below it) with one chip per Flux native page —
  Sessions, Archive, Feeds, History, Bookmarks, Task manager, Resources, Speed
  test, Omni, Apps, Passwords, Sync, Settings. Each chip **opens in a new tab**.
  Horizontal + horizontally scrollable; toggle from ⌘K ("Show pages bar") or
  Settings → Appearance (default off). A sibling of the card, not an overlay, so
  the card shrinks and the native webview relayout follows.
- **Peek / glance windows** (BACKLOG #50) — open a link in a transient,
  always-on-top **floating window** without committing it to a tab (Arc's "Little
  Arc"). **Alt-click** a link or right-click → **Peek** on any page, or **Peek**
  from the internal-page link menu. A floating bar offers **⊕ Open as tab**
  (promote the page — wherever you've browsed to inside the peek — to a real
  focused tab, also **Ctrl/⌘+Enter**), **📌 Pin** (keep it: drop always-on-top so
  it stays open as a normal window), and **✕ / Esc** to dismiss; promoting also
  surfaces the main window so the new tab is actually seen. Built as its own
  `WebviewWindow` (the right model under Flux's native-webview overlay constraint)
  with only the `fluxtab` bridge, Rust-guarded so a peek can self-close/promote/pin
  but a normal page can't. **Shields apply to peeks** — the same content-blocker /
  HTTPS-only / lean request interceptor and cosmetic element-hiding that protect
  tabs are wired into peek windows too.

### Fixed
- **Page link "open in new tab" bridge grant** (BACKLOG #109) — `newtab.js`
  correctly called `plugin:fluxtab|chrome_open_url`, but that command was missing
  from the inlined `fluxtab` plugin declaration used to generate remote-page
  permissions. Remote pages can now invoke the bridge for right-click, `_blank`,
  middle-click, and modifier-click new-tab requests.

### Added
- **Expandable home widgets** (BACKLOG #71) — every start-page widget (recent tabs,
  shortcuts, top sites, headlines, scratchpad, tasks, quick actions, calendar) now
  has a **⤢ Expand** button that opens its full content in a modal, so the
  dashboard cards keep a compact fixed footprint while still giving you the whole
  list on demand (Esc / click-outside to close).
- **Daily session auto-snapshots** (BACKLOG #47) — Flux now quietly snapshots your
  open tabs into a per-day bucket on a background timer (keeps the last week), so
  you can **"reopen yesterday"** without ever having saved a session. The Sessions
  page shows a "Recent days" list (Today / Yesterday / weekday) with one-click
  Reopen, above your named sessions. Stored locally in `snapshots.json`.
- **Editable per-site privacy exceptions** (BACKLOG #78) — the Settings page's
  Privacy section now lists every host you've made an exception for — shields
  turned off, HTTP allowed under HTTPS-only, or lean mode on — each with a
  one-click ✕ to restore the default. Previously these could only be toggled from
  the Shields popover while on the site itself.
- **Sync expansion: history, deletion propagation, auto-sync** (BACKLOG #62) — E2E
  sync now also carries **browsing history** (merged by URL, keeping the higher
  visit count; capped to the most-frecent ~4000 so the encrypted blob stays
  small), **propagates deletions** via tombstones (a new `tombstone.rs` deletion
  ledger per store, synced in the blob, newest-wins — so deleting a bookmark or
  session on one device removes it on the others instead of it resurrecting on the
  next merge; a re-add with a newer timestamp still wins), and gains an opt-in
  **auto-sync** toggle that re-syncs every ~3 minutes while unlocked (and once
  right after unlock), emitting `flux://sync-done` so open pages refresh live. The
  on-disk bookmark/session format migrated to an `{items, tombstones}` envelope
  (still reads the legacy bare-array). The Sync page shows the auto toggle and a
  per-type merge summary.
- **Settings page** (BACKLOG #78) — a real `flux://settings` page (⌘K "Open
  Settings", or "⚙ Open full Settings ↗" from the footer popover) that gathers the
  toggles previously scattered across the footer ⚙ popover and the Shields popover
  into one organized, full-width place: **Appearance** (website dark mode, bookmark
  bar), **Search** (default engine, suggestions, AI answers, Omni-answer-on-search),
  **Privacy & security** (shields + session blocked count, HTTPS-only, tracking-
  prevention level, global block of camera/mic/location, clear-all-cookies, link to
  per-site permissions), **Navigation** (vim hints, mouse gestures), **Memory**
  (sleep-inactive-tabs + timeout, memory-pressure eviction, live RAM readout +
  links to the Resource monitor / Task manager), and **Data** (quick links to Sync,
  Sessions, History, Bookmarks, Archive). Backed by the existing store signals +
  flux-core commands; lazy-loaded so the eager chrome bundle is unaffected.
- **Right-click "open in new tab" on web pages** (BACKLOG #109) — right-clicking a
  link on any normal page now shows a small Flux menu (open in new tab / new
  background tab / copy link) and actually opens a Flux tab. The native WebView2
  menu's "open link in new tab" fires a new-window request Flux doesn't host, so
  it was a silent no-op; `newtab.js` now intercepts `contextmenu` on links and
  routes through the same `chrome_open_url` path as the other new-tab gestures.
  The menu is rendered in a shadow root inside the page (isolated from page CSS,
  and the page's own layer — so it doesn't fight the native-webview overlay);
  right-clicking anywhere that isn't a link still gets the native menu.

### Changed
- **Tab folders lay out horizontally** (BACKLOG #111) — the Folders section now
  arranges folders **side by side as compact columns** and scrolls horizontally,
  so adding folders grows the section sideways instead of pushing the sidebar
  down. (Members stay a vertical list within each folder column.)
- **Home widgets use fixed cards with expandable detail views** — Start-page
  widgets now keep a consistent dashboard footprint and expose an Expand action
  for full lists/details, so longer recent tabs, feeds, tasks, shortcuts,
  calendar events, and scratchpad content no longer resize the widget grid.
- **Archive startup hydration moved off the boot path** — Flux now registers an
  empty archive store during setup and loads `archive.json` on a background thread,
  preserving immediately saved pages if hydration finishes afterward. This removes
  archive disk I/O and embedding-migration checks from the critical window-show path
  while keeping archive search/list behavior intact once hydration completes.
- **Footer tool popovers split on first use** — Boosts, Macros, and Passwords now
  stay out of the initial shell chunk and load the first time their footer buttons
  are clicked. Shields and Downloads remain eager so their live badges/events are
  still available immediately.
- **Shell chrome refresh batched into one IPC snapshot** — startup and tab
  mutations now fetch tabs, active tab, groups, folders, workspaces, panels, and
  containers with `shell_snapshot` instead of fanning out through separate invokes.
  The frontend still preserves live tab URLs/titles while applying structural state.
- **Vault auto-lock watchdog backs off when idle** — the background vault thread now
  keeps the 20s check only while a password-protected, unlocked vault has auto-lock
  enabled; otherwise it sleeps for 60s to reduce default/keychain-mode wakeups.
- **Windows startup profiling guide** — `docs/perf/startup-profiling.md` documents
  native Windows boot-phase logging (`flux::boot`) plus ETW/WPR capture steps for
  diagnosing launch latency beyond Rust setup.
- **Generated TS bindings — batch 3** (BACKLOG #12) — 28 more IPC types are now
  derived from their Rust definitions (`specta::Type` → `bindings.gen.ts`, drift-
  gated in CI) instead of hand-mirrored in `ipc.ts`: shields/privacy
  (ShieldsStatus, HotRule, LeanStatus, HttpsStatus, CookieStatus), permissions
  (PermKind, PermDecision, SitePerm), vault (CredentialMeta, VaultStatus),
  extensions (Manifest, ContentScript, UiContrib, ToolbarButton, InstalledExt),
  macros (Step, Macro, MacroStatus), Boost, DownloadItem, files (FileEntry,
  DirListing, QuickLocation), sync (SyncStatus, SyncReport), OmniHit, ReaderBlock.
  Removes the corresponding hand-written interfaces (~51 IPC types now generated).
- **Archive wire/persist split** (BACKLOG #12) — `archive_get` now returns
  `ArchiveEntryWire` (id/url/title/saved_ms/text), keeping the persisted entry's
  embedding vector + embedder tag off the wire (they're an on-disk concern the
  reader never needs); this also lets the wire shape be specta-generated.

### Added
- **Streaming agent replies + schema-constrained actions** (BACKLOG #82, closes it)
  — the agent sidebar now renders chat answers **token-by-token as the model
  generates them** (both the active-page and all-tabs scopes), instead of waiting
  for the whole completion: a Tauri `Channel<String>` relays each Ollama chunk
  (`/api/generate` `stream:true`) straight into the reply bubble. And page actions
  are now constrained by the **`AgentAction` JSON Schema** passed as Ollama's
  `format` (`flux_agent::action_schema` — a `oneOf` of tagged variants, with
  `finish` only in the multi-step loop) — strictly stronger than the old
  `format:"json"`, which only guaranteed *valid* JSON and leaned on the prompt to
  describe the fields. Non-streaming backends (the mock, the llama scaffold) keep
  working via a one-chunk trait default.
- **Open links in a new tab from internal pages** — right-clicking a link in Flux's
  own DOM pages (Archive, Feeds, History, Bookmarks, the bookmark bar) now shows an
  **Open in new tab / Open in new background tab / Copy link** menu — previously
  those pages had no context menu (real web pages still get WebView2's native one).
- **Clickable calendar days** (BACKLOG #114) — date cells in the home calendar now
  select that day and show only its events in the widget; the expanded calendar uses
  the same selection, including an empty state when the chosen day has no events.
- **Expandable calendar** (BACKLOG #114) — an **⤢ Expand** button on the home
  calendar opens a larger view: the month grid beside **every upcoming event grouped
  by day**, scrollable, so a busy schedule is readable at a glance. Click outside /
  Esc / ✕ to close.
- **Files popout panel** (BACKLOG #6) — a 🗁 button in the sidebar controls opens
  the file explorer as a medium-large floating panel over the page (no need for a
  dedicated Files tab). Its current directory **persists** — close it from
  `Documents/Books/` and it reopens right there. Click outside or Esc to close.
  Built on the DOM `FilesView`; opening the panel hides the active tab's native
  webview (the same overlay trick the command palette uses), so it's never
  occluded by the OS webview layer.
- **Calendar sync + Tasks widgets** (BACKLOG #114) — the home page calendar now
  shows your **real Google Calendar** (or any calendar) events, synced read-only
  via its **secret ICS feed URL** — no Google login, no OAuth, nothing phones home
  to an account (just an HTTP GET of a feed you control). Add one with "＋ Calendar"
  on the widget; days with events get a dot and the next few events list under the
  grid. ICS parsing is a lean hand-rolled scanner (VEVENT, line-unfolding, DATE vs
  DATE-TIME), kept in the feed's own calendar terms to stay timezone-bug-free. A new
  **Tasks** card adds an on-device to-do list (add / check / remove / clear-done,
  persisted). _Note:_ Google Tasks two-way sync needs OAuth and is deferred (#114);
  the tasks widget is local-only for now.
- **Bookmark bar** (BACKLOG #22) — a chip row docked under the content card for
  one-click access to your bookmarks, no need to open `flux://bookmarks`. Click a
  chip to open it; hover to remove. Toggle with ⌘K "Show/Hide bookmark bar"
  (persisted, on by default). It's a sibling *below* the card (not an overlay), so
  it never collides with the native tab webview — the card shrinks and the webview
  relayout follows. Stays in sync with the address-bar star / Ctrl+D.
  **Rename** a bookmark by double-clicking its chip (or the **✎** button on
  `flux://bookmarks`) — inline edit, Enter saves / Esc cancels, blank → host
  fallback (`bookmark_rename`).
- **Generated TypeScript bindings** (BACKLOG #12) — the frontend's `ipc.ts` no
  longer hand-mirrors the Rust IPC structs (which had drifted). `specta::Type` is
  derived on **21 IPC structs** and emitted to `apps/shell/src/bindings.gen.ts`
  (`FLUX_WRITE_BINDINGS=1 cargo test -p flux-core bindings`), with a **drift test
  gated in CI** so the two can't diverge. `ipc.ts` re-exports them all — the
  `state.rs` types plus `Bookmark`, `Feed`, `FeedItem`, `PwaApp`, `HistoryEntry`,
  `SavedTab`, `SavedSession`, `ProcInfo`, `SysStats`, `SpeedResult`, and
  `ArchiveMeta`. _Follow-up:_ the remaining misc structs; full command-wrapper
  codegen (tauri-specta) is deferred — it requires the pre-release specta v2 /
  tauri-specta v2 stack (incompatible with the stable specta v1 in use).
- **Multi-step agent tasks** (BACKLOG #8/#82) — the local agent can now carry out
  a *goal*, not just one action. **`/task <goal>`** in the agent sidebar runs an
  iterative loop: it plans the single next step from the **live** page + the steps
  done so far, you **Approve / Skip / Stop** each one (or tick **Run all** to
  auto-approve), it executes, then re-plans from the updated page — across
  navigations — until it declares the goal `finish`ed, `refuse`s, or hits an
  8-step cap. Re-planning per step (vs. a fixed up-front plan) is what lets a task
  cross pages, since page-2 selectors aren't knowable on page 1. Every step still
  goes through the closed `AgentAction` vocabulary → audited JS compiler, and
  destructive clicks stay blocked at click-time (#104) even in Run-all. _Follow-up
  (#82):_ schema-constrained Ollama `format` output, token streaming to the sidebar.
- **Performance-budget gates** (BACKLOG #10, ADR 0001) — the low-RAM wedge is now
  measured and protected. `npm run perf` (and CI, `.github/workflows/perf.yml`)
  hard-gates **chrome JS ≤ 50 KB gzip** (the eager shell bundle, computed from the
  Vite manifest so lazy route chunks don't count — currently **48.9 KB**, 1 KB of
  headroom) and **release binary ≤ 25 MB** (currently ~13.6 MB). `criterion`
  benches `ipc_roundtrip` and `dom_snapshot` (`crates/flux-core/benches/ipc.rs`)
  cover the IPC hot paths. A repeatable **Flux-vs-Chrome memory methodology** lives
  in `docs/perf/memory-benchmark.md` (idle / 10 / 30 tabs; the display-dependent
  budgets are a self-hosted/manual gate).

### Changed / Fixed
- **Boot timing instrumentation** — startup setup now logs `flux::boot` phases with
  per-phase and cumulative milliseconds for session restore, store hydration,
  vault load, and window decoration. This gives the Windows build a concrete launch
  latency profile before moving more work off the startup path.
- **Right-click link menus now actually open tabs** — the injected link menu inside
  real web pages no longer closes itself during capture before the menu item click
  runs, and Flux's internal DOM-page link menu routes through the app-level opener
  so PDFs and foreground/background tab behavior match normal navigation.
- **Home widgets scroll in their own box** — the start page no longer scrolls as a
  whole (which pushed the bottom wave animation out of view); the widget cards now
  live in a contained scroll area under the fixed search hero, and the wave stays
  pinned to the bottom. Add as many widgets as you like — only the card area scrolls.
- **Leaner chrome bundle, round 2** (BACKLOG #79/#10) — the start page (`StartPage`)
  is now lazy-loaded too, pulling its ~16 KB chunk off the eager bundle (down to
  **44.6 KB / 50 KB**) — comfortable headroom as more home widgets get added. It
  already loads its data async, so the new-tab page is unaffected in practice.
- **Web panels now open as a separate pane** — opening a pinned web panel adds a
  real grid column beside the main page instead of overlaying a strip inside the
  content card. The main page pane resizes and recenters to the left, while the
  panel's native webview is bounded to its own framed surface below the panel
  toolbar. Focus mode and full-window overlays hide the panel webview cleanly.
- **Files explorer no longer hangs on Windows-backed folders** — the initial
  listing no longer stats every entry before painting, quick-location discovery
  runs off the IPC/UI path, and live watcher setup is moved to a blocking worker.
  Size/modified columns show `—` when metadata has not been hydrated yet.
- **Faster app startup with the password vault enabled** — keychain-mode vault
  auto-unlock and decrypt now happen after Tauri setup on a background thread;
  password UI surfaces refresh on the new `flux://vault-ready` event.
- **Closing a tab always leaves a start page** — closing a browser tab when no
  other **flux://start** tab is open now converts it into a fresh start tab instead
  of removing it, so there's always a new tab to start from (close the last tab and
  you land on the dashboard, not an empty window).
- **Leaner chrome bundle** (BACKLOG #79/#10) — the agent sidebar (`AgentPanel`) is
  now its own lazy chunk (loads when first opened), pulling ~3 KB gzip off the
  eager chrome bundle. Back to **47.0 KB / 50 KB** budget headroom after the recent
  agent-task + bookmark-bar work crept it to 49.8.
- **Smoother resizing** (BACKLOG #79) — the glass backdrop-blur is now dropped
  while you resize a pane, resize the window, or drag a split/panel divider. The
  blur re-samples + repaints every frame, which was the main source of resize
  jank; it snaps back the instant you let go.

### Added
- **More home-page widgets** (BACKLOG #71) — the start page gains four cards on
  top of the existing clock/weather/recent/speed-dial: **Headlines** (latest items
  across your subscribed feeds #72, click to open; links to Feeds), **Top sites**
  (most-visited hosts auto-derived from history, vs. the manual speed dial),
  **Scratchpad** (a persistent home note, auto-saved via the notes store), and a
  **Calendar + world clocks** card (current-month grid with today highlighted,
  plus New York / London / Tokyo times beside the local clock). _Follow-up:_
  drag-reorder + show/hide widgets, agent summaries, custom backgrounds.
- **PDF form fill** (BACKLOG #113) — the PDF editor (#112) gains a **🖊 Forms**
  mode. Fillable AcroForm fields (text, checkbox, radio, dropdown/list) become
  editable **in place, directly on the page** — interactive widgets positioned
  over each field via PDF.js geometry (rotation-aware) — and a side panel lists
  every field for quick navigation; the two stay in sync. **Apply to document**
  renders the values onto the page, **Save** writes a filled copy to Downloads,
  and an optional **Flatten on save** bakes the values in so they're no longer
  editable. Field reading/writing uses `pdf-lib`'s typed form API via
  `instanceof` (survives minification); form values and drawn annotations are
  both burned into the saved copy. _Follow-up (#113):_ true text editing, OCR,
  digital signatures.
- **PDF editor** (BACKLOG #112) — the built-in PDF viewer (#35) gains **Edit** and
  **Pages** modes, all on-device (no Acrobat, no cloud round-trip). _Edit:_ markup
  with highlight, pen/ink, text, rectangle, and arrow tools, a colour palette,
  eraser, and undo. _Pages:_ a thumbnail panel to **reorder (drag), rotate, delete,
  extract** a page, or **merge** another PDF. **Save** burns the edits into the
  page bytes with `pdf-lib` and writes the result to your Downloads folder
  (`pdf_save`, de-duplicating the filename). Annotations are stored in PDF-point
  space (survive zoom) and are always flattened before a page-op, so annotation→
  page mapping never drifts. `pdf-lib` loads lazily, so the editor adds nothing to
  the chrome bundle until you open a PDF. _Follow-up:_ AcroForm fill/save, true
  in-place text editing, OCR for scanned PDFs, digital signatures.
- **Translate page** (BACKLOG #40) — **🌐** in the page-actions row (or ⌘K
  "Translate page → …") translates the current page with your **local Gemma
  model** — private, no cloud translation service — and shows it in the reader
  view. The 🌐 button translates to your own language; ⌘K offers common targets.
  _Limitation:_ translates the leading visible text (model context cap), and
  renders as clean text (not layout-preserving).
- **Install site as app / PWAs** (BACKLOG #42) — ⌘K "Install this site as app"
  opens the current site in its **own window** (just the page, no Flux chrome) —
  Discord, WhatsApp, Figma, etc. feel like native apps. Installed apps persist
  and live at **`flux://apps`** (⌘K "Open installed apps") to relaunch or remove;
  relaunching focuses the existing window instead of duplicating it.
- **Native RSS / Atom reader** (BACKLOG #72) — **`flux://feeds`** (⌘K "Open Feeds"):
  subscribe to feeds and read them inside Flux, no extension. Subscriptions
  persist (`feeds.rs`); items are fetched **live** on open (always fresh, nothing
  cached to go stale). Master-detail UI — a feed list plus an **All feeds**
  aggregate on the left, the selected feed's items on the right; clicking an item
  opens it in a new browser tab. Parsing is a lean hand-rolled RSS 2.0 / Atom 1.0
  scanner (CDATA, common entities, tag-stripped snippets) rather than an XML
  dependency, to keep the binary small. A dead feed is skipped in the aggregate
  view so one bad URL doesn't blank the page. _Follow-up:_ unread/read state,
  OPML import/export, auto-refresh on a timer, fold feeds into Omni search.
- **E2E-encrypted sync** (BACKLOG #62) — **`flux://sync`** (⌘K "Sync"): bookmarks
  + sessions follow you across devices, **account-optional and local-first**.
  No Flux server — point it at a folder your devices already sync (Dropbox,
  Syncthing, iCloud Drive, a USB stick) and Flux writes **one end-to-end
  encrypted file** there (AES-256-GCM, key derived from a passphrase via
  Argon2id; the salt lives in the blob so every device with the same passphrase
  derives the same key). The sync service only ever sees ciphertext; the
  passphrase never leaves your machine. Merge is an additive union (bookmarks by
  url+folder, sessions by name). _Follow-up:_ history/tabs, deletion propagation,
  auto-sync on a timer.
- **Scriptable macros** (BACKLOG #67) — a footer **⏺ Macros** popover to record
  a browsing flow (navigations + clicks + typing) into a named macro, then
  **replay** it with one click. Recording captures your actions live across page
  navigations; replay walks them against the active tab with waits between steps.
  Passwords are never recorded; macros persist. _Follow-up:_ agent-authored
  macros, scheduling, and the inherently brittle-selector cases.
- **Agent boosts** (BACKLOG #49) — a footer **✨ Boosts** popover to *make this
  site better*: describe a change in plain language ("hide the cookie banner",
  "dark mode", "widen the article") and the **local agent writes the CSS**, saved
  per host and re-applied on every visit (toggle / delete per site, applies
  live). CSS-only by design — it's injected into the page and CSS can't
  execute/exfiltrate, so a prompt-injected model can't do harm (unlike generated
  JS). _Follow-up:_ hand-edited JS boosts; a manage-all page.
- **Real embeddings for search** (BACKLOG #11) — semantic search now prefers a
  proper model (**EmbeddingGemma** via Ollama, `/api/embed`) instead of the
  feature-hashing fallback, so it understands synonyms/paraphrase, not just
  shared words. Wired into the **offline archive** (#69) first; falls back to the
  hashing embedder automatically when Ollama is down or the model isn't pulled,
  so search never breaks. Vectors are persisted + tagged with their embedder; if
  you pull the model later, the archive **re-embeds itself in the background**.
  Set up with `ollama pull embeddinggemma` (override via `FLUX_EMBED_MODEL`).
  _Follow-up:_ Omni + tab clustering (they embed per-keystroke / constantly, so
  they need a vector cache before moving off the instant hashing embedder).
- **Rename tabs & folders** — double-click a tab's name (or right-click → *Rename
  tab*) to give it a **custom name** that sticks (survives page-title updates;
  clear it to revert). Folders get an explicit **✎ rename** button (plus
  double-click). Both persist.
- **Tab folders** (BACKLOG #111) — a collapsible **Folders** section above the
  footer holds tabs that are kept **hibernated (≈0 RAM)**. Right-click a tab →
  *Move to folder* (or *+ New folder with tab*) to park it; it drops out of the
  strip and sleeps. Click a folder tab to wake + view it; switching away
  re-sleeps it, so a folder of 50 tabs still costs almost nothing. Distinct from
  tab groups (inline/colored/strip-resident) — folders are for getting tabs out
  of memory. Persisted; *Take out of folder* / delete return tabs to the strip.

### Changed / Fixed
- **Page-action icons moved below the address bar** — the ★ bookmark, 📖 reader,
  📸 capture, and ✦ save-to-Omni buttons now sit in their own row beneath the
  address bar instead of inside the address pill.
- **Tab right-click menu no longer clipped** — the context menu is clamped to the
  chrome (left of the content card) so it can't spill under the native tab
  webview (an OS layer the DOM can't z-index over). Applies to the tab and group
  menus.

### Added
- **Offline archive + semantic search** (BACKLOG #69) — **Save page for offline**
  (⌘K or the 📚 page-action) stores a page's text locally; **`flux://archive`**
  lets you **semantically search** your saved pages and **read them fully offline**
  (clean text view, no remote resources). Search runs the local `flux-embed`
  embedder — no network, no service — so it works on a plane; re-saving a URL
  updates it in place, and private pages are never archived. _Follow-up:_ full
  rendered-page (MHTML) capture; surfacing the archive inside Omni search.
- **DOM-aware terminal** (BACKLOG #65/#4) — the `flux` CLI, run **inside Flux's
  terminal**, reads the **active page**: `flux url`, `flux title`, `flux dom`
  (visible text), `flux links`, and `flux extract-json` (pipe to `jq`). Flux
  writes the active browser tab's context to a file the shell points at via
  `FLUX_RPC_DIR` — a *file*, not a socket, so it works across the WSL↔Windows
  boundary (`WSLENV /p` translates the path into WSL). Private tabs expose
  nothing. _Setup:_ the `flux` binary must be on the terminal's PATH — in a WSL
  terminal that means the Linux build; native consoles can call `flux.exe`.
  _Follow-up:_ agent-driven terminal control; native-Windows-console stdout
  (`windows_subsystem`) needs an AttachConsole shim.
- **Picture-in-picture** (BACKLOG #37) — pop a video into a floating always-on-top
  window: hover any sizable video for a **⧉ PiP** button, or press **Alt+P**
  (press again or use the OS control to exit). Flux also **auto-PiPs a playing
  video when you switch away from its tab** (best-effort). Implemented as an
  injected page script (`pip.js`) so the trigger carries the in-page user
  activation the PiP API requires — a chrome button/eval can't. (WebView2; older
  WebKitGTK may lack PiP support.) _Follow-up:_ a Settings toggle.
- **Built-in PDF viewer** (BACKLOG #35) — PDFs open in a **Flux-owned viewer**
  (`flux://pdf`) powered by PDF.js: continuous page scroll, zoom, page count, and
  download. Works on both engines (WebKitGTK has no native PDF viewer), with
  consistent chrome. Entering a `.pdf` address, ⌘K, a `target="_blank"` PDF
  link, or **opening a PDF in the built-in file explorer** routes here; the
  bytes are fetched by the Rust core (`pdf_fetch`, http(s) + local files) to
  sidestep cross-origin CORS, and PDF.js is lazy-loaded so it never weighs down
  the chrome bundle. _Follow-up:_ annotation + form-fill; intercepting in-page
  link clicks (those still use the engine's native viewer on WebView2).
- **New windows & "open in new tab"** (BACKLOG #109) — `window.open()`,
  `target="_blank"` links, and **middle-click / Ctrl-click (⌘-click)** on any
  link now open as **new Flux tabs**. Previously they silently did nothing —
  native child webviews ignore page-initiated windows. Middle/modifier clicks
  open in the **background** (focus stays put); explicit `_blank` links open in
  the foreground. (Injected `newtab.js` forwards them via the `chrome_open_url`
  command → `flux://open-url` → the chrome opens the tab. A *connected* popup
  window with a live opener — for OAuth/`postMessage` handshakes — is separate
  and still out of scope.)
- **Site permissions manager** (BACKLOG #38) — **`flux://permissions`** (⌘K
  "Site permissions", or "Manage site permissions…" in the Shields popover): a
  per-site, per-kind manager for **camera / microphone / location / notifications**
  (+ clipboard). Set **Allow / Block / Ask** per site or add a rule manually;
  decisions persist. A remembered Allow/Block is applied automatically on
  WebView2 (`PermissionRequested`), short-circuiting the native prompt; **Ask**
  leaves the engine's own prompt. The global "block camera/mic/geo" switch (#58)
  still overrides everything. _Follow-up:_ a Flux-styled prompt for the Ask case
  (needs a WebView2 deferral) + the WebKitGTK signal on the Linux backend.
- **Devtools (F12)** — press **F12** (chrome- or page-focused) to open the
  inspector for the active tab's webview. (Tauri `devtools` feature + a
  `webview_devtools` command; forwarded from focused pages via `shortcuts.js`.)
- **Quick bookmark** (BACKLOG #22) — a **★ star in the address bar** and
  **Ctrl/⌘+D** bookmark (or un-bookmark) the current page; the star reflects
  whether it's already saved. (Previously bookmarking was buried in the 🔖
  Library popover.)
- **Built-in task manager** (BACKLOG #107) — **`flux://tasks`** (⌘K "Open Task
  manager"): a system-wide process monitor with **live CPU & memory graphs** up
  top and a sortable list (name / CPU% / resident memory) with one-click **end
  task**. **Flux's own process tree** (engine + helper processes) is flagged by
  walking parent pids, and ending the main Flux process asks for confirmation.
  Gives real per-process CPU/RAM, which the per-tab resource monitor (#70) can't
  (engines share processes).
- **Network speed test** (BACKLOG #108) — **`flux://speedtest`** (⌘K "Network
  speed test"): an Ookla-style test against Cloudflare's public speedtest backend
  (no API key) with **animated dial gauges** for download / upload — the download
  dial tracks live throughput as it streams — plus ping + jitter.
- **Research-driven optimization pass** (BACKLOG #99–#106) — eight techniques
  distilled from the 40-paper survey (`research/RESEARCH.md`), implemented in the
  Rust core with unit tests (cache 7 · shields 5 · prefetch 6 · agent guard 4 ·
  hibernation rank 3 · ollama 4 · lean mode 4):
  - **Shields decision cache + hot-rule observation** (#99, arXiv 1810.09160) —
    block/allow verdicts are memoized per `(url, source-host, type)` so repeated
    tracker/CDN/beacon requests skip the engine entirely; the **Shields popover**
    now shows the cache hit-rate and the **live hot rule set** (the ~10% of
    loaded rules actually firing on your traffic).
  - **TTL/LRU cache utility** (#101, arXiv 2602.06074) — a bounded `TtlCache`
    in the core, reused by shields (and available for favicon/metadata/settings).
  - **Predictive prefetch** (#103, arXiv 1906.00877) — a per-origin Markov chain
    (LFU-decayed) learns navigation transitions and, on each page load, the
    chrome **preconnects** (`<link rel=preconnect>`) to the hosts the model
    expects next — confidence-gated and silenced under memory pressure.
  - **Agent destructive-action guard** (#104, arXiv 2511.19477) — every
    agent-driven click is gated in the **execution layer**: the injected JS reads
    the element's *real* accessible name and aborts on a destructive deny-list
    (delete / pay / place order / refund …), independent of the model's claim
    (defense against prompt injection). Read-only actions and the headline
    "unsubscribe" task are unaffected. _Follow-up:_ a11y-tree primary context +
    versioned element refs (ties into the agent epic).
  - **Belady/Markov hibernation ranking** (#106, arXiv 1202.5539) — the
    memory-pressure eviction now sleeps the tabs *least likely to be needed next*
    (discounting idle time by the #103 prediction, keeping predicted-return
    tabs) instead of plain LRU.
  - **Agent latency levers** (#102, arXiv 2203.16487) — the model is kept warm
    (`keep_alive`) to drop per-call reload latency, context is capped
    (`num_ctx`), and an options passthrough (`FLUX_OLLAMA_OPTIONS`) is the hook
    for enabling speculative decoding when the local Ollama build supports it.
  - **HTTP/3 / QUIC** (#100, arXiv 2102.12358) — Flux makes the WebView2 engine
    negotiate QUIC explicitly (`--enable-quic`); no-op on WebKitGTK (limited H3).
  - **Per-site lean mode** (#105, arXiv 2106.08948) — a **Shields-popover toggle**
    ("Lean mode here") that, for sites you turn it on for, blocks heavy
    non-essential third-party scripts (tag managers, analytics, A/B, session
    replay, chat/social widgets) on top of shields, via the request interceptor.
    _Follow-up:_ dynamic per-function dead-JS elimination needs a webview
    coverage trace the engines don't yet expose.
- **Agent model picker** (BACKLOG #81) — the Flux Agent header now shows the
  active model and opens a dropdown of your locally-pulled **Ollama models**;
  pick one to switch the agent **live** (no restart) — the choice persists. (Was
  fixed to the `FLUX_MODEL` env var.)
- **Per-page notes** (BACKLOG #53) — a footer **📝** popover holds a note tied to
  the current page's URL, **auto-saved locally** and restored when you revisit
  (clearing it deletes it). Nothing leaves your machine.
- **Focus / compact mode** (BACKLOG #55) — **Ctrl+Shift+F** (or ⌘K "Focus mode")
  hides the sidebar, terminal, and agent for a content-only view; **Esc** or the
  chord exits (a toast reminds you).
- **Vim link-hints + mouse gestures** (BACKLOG #52 / #51) — opt-in Settings
  toggles (under **Navigation**). With hints on, **`f`** labels every clickable
  element (type the label to click); **`j`/`k`** scroll, **`gg`/`G`** jump
  top/bottom — and never while you're typing in a field. With gestures on, hold
  the **right mouse button and drag**: left = back, right = forward, down =
  reload, up = top. (Injected `nav.js`, inert until enabled; both off by default.)
- **Resource monitor** (BACKLOG #70, partial) — **📊** `flux://resources` (+ ⌘K)
  shows overall Flux/free RAM and a per-tab list (captured-page weight + live /
  💤 sleeping), with one-click **💤 Sleep background tabs** to reclaim RAM. (True
  per-tab CPU isn't shown — browser engines share processes across tabs, so it
  isn't cleanly attributable; payload weight + sleep is what's actionable.)
- **Web capture / screenshot** (BACKLOG #54) — **📸** in the address row (or ⌘K
  "Capture page") saves the visible page to a PNG in the app's `screenshots`
  folder, with a toast on completion. (WebView2 `CapturePreview`, COM-verified vs
  msvc; Windows for now. Full-scrolling-page, region select, and annotation are
  follow-ups.)
- **Named multi-account containers** (BACKLOG #59) — create containers in Settings
  (name + color); **"Open in container ▸"** in the new-tab picker opens a tab with
  an **isolated cookie/storage jar** (a per-webview `data_directory`), so you can
  be logged into two accounts of the same site at once. The container's color
  marks the tab's rail; containers persist. (Completes #59 alongside the earlier
  private/incognito tabs.)
- **Reader mode + text-to-speech** (BACKLOG #41) — **📖** in the address row (or
  ⌘K "Reader mode") declutters the current article into a clean, typographic view
  over the page, and **🔊 Listen** reads it aloud (Web Speech API). The article is
  extracted into structured blocks (headings/paragraphs/lists/quotes/images) and
  rendered as **text + image src only** — never raw HTML, so there's no injection
  surface. Esc, ✕, or switching tabs closes it.
- **Per-site zoom** (BACKLOG #36) — **Ctrl +/−/0** zoom the active page; the level
  is **remembered per site** and re-applied automatically on every visit. A `%`
  pill appears in the address row when zoom ≠ 100% (click to reset), and zoom
  in/out/reset are in ⌘K. (`webview.set_zoom`; persisted in the shell.)
- **Private tabs** (BACKLOG #59) — "🕶 Private tab" (new-tab picker + ⌘K "New
  private tab") opens a tab on an **in-memory session** (`incognito` webview): no
  cookies/storage persisted, wiped on close, **never recorded in history or
  Omni**, and never restored across restart. A violet rail/tint marks it. (The
  ephemeral half of multi-account containers; named persistent containers via
  per-webview `data_directory` are the documented follow-up.)
- **Agent actions are now preview-and-approve** (BACKLOG #8) — `/act` plans the
  action and shows it as a **preview with Approve / Skip** instead of touching the
  page immediately. Approve runs it (with the magenta highlight); Skip discards it;
  a refusal shows as a note. (`agent_plan` + `agent_run_action`.) Autonomous
  multi-action sequences from one prompt are a follow-up (#82); for now you
  confirm each step.
- **Named sessions** (BACKLOG #47) — save the current set of tabs as a named
  session and restore it later (reopens every tab) from a new `flux://sessions`
  page, ⌘K "Open Sessions", or the Library popover. Persisted separately from the
  always-on "continue where you left off" session.
- **Semantic everything-search** (BACKLOG #66) — ⌘K now searches *everything* in
  one ranked list: open tabs **by page content** (not just title), bookmarks, and
  history, scored by the local embedder (`omni_search`). Large corpora are
  lexically pre-filtered then embedding-reranked, so it stays fast per keystroke;
  an empty query still browses your open tabs. (Searching open-tab *contents* is
  the part that's weak in other browsers; true synonym-level semantics arrive
  with the stronger embedder, #11.)
- **Chat with this page / your tabs** — the Flux Agent now has a **scope toggle**
  (📄 This page · 🗂 All tabs) and one-tap prompts (**Summarize · Key points ·
  Explain**). "This page" grounds the local Gemma in the active tab's captured
  text (already the default); "All tabs" feeds it every open browser tab in the
  workspace (`agent_chat_tabs`, per-tab-capped). Fully local — no page text
  leaves the machine.
- **Web panels** (BACKLOG #48) — pin a site (chat, docs, music, claude.ai) to a
  slim pane on the right of the content card that **persists across tab
  switches**. Manage from the footer **◨** popover: "Pin this page", toggle a
  panel open/closed, unpin (all persisted across restart). Draggable divider to
  resize; a small DOM toolbar (title / reload / close) sits above the pane. Each
  panel is its own native webview, deliberately **without** the DOM-capture
  script — a pinned panel never pollutes history or tab clustering — and only the
  open panel holds a live webview (inactive pins are just metadata).
- **Bookmarks** (BACKLOG #22) — a persisted, folder-aware bookmark store with a
  `flux://bookmarks` page (search, folder grouping, delete, clear), a footer 🔖
  popover (**★ Bookmark this page**, All bookmarks, History), and a ⌘K "Open
  Bookmarks" action. **Chrome import** pulls every bookmark from a chosen profile
  (de-duped, under an "Imported" folder). Each folder has **"⊞ Open as group"**,
  which opens its bookmarks as tabs in a new Flux tab group (capped at 20) — the
  practical bridge for bringing Chrome tab groups over. (Chrome's *saved* tab
  groups live in a separate SQLite db, parsed in #23; live/unsaved groups are an
  undocumented session blob — your profile had none.)
- **Split tabs show as one combined unit in the strip** (BACKLOG #43) — like
  Chrome's paired split tabs: the two tiled tabs render together inside a teal
  "◧◨ Split" bracket with a ⤢ merge (un-split) button, instead of as two
  scattered rows. (Replaces the earlier separate "Merge" bar.)
- **Install scripts — `flux` on your PATH.** `scripts/install-linux.sh` and
  `scripts/install-windows.ps1` build a self-contained binary (the frontend is
  embedded) and install it to `~/.cargo/bin` (`%USERPROFILE%\.cargo\bin` on
  Windows), so `flux` launches from any directory. The Windows script checks
  prerequisites (Rust msvc, the MSVC C++ build tools / `link.exe`, Node) and
  prints exact fixes. README gains an **Install** section.
- **Split view** (BACKLOG #43) — two browser tabs tiled side by side in the
  content card. Start one by **right-clicking a tab → "Split with current tab"**
  or by **dragging a tab onto the right edge of another**. A draggable seam
  resizes the panes (double-click to even out); the split pauses when you focus a
  third tab and resumes when you return to a pair member. Both panes stay live
  (neither hibernates) and re-tile across resizes. Built over the existing
  child-webview model: the seam is a DOM splitter in the gap the OS webview
  layers don't cover, and dragging briefly hides the panes so the chrome can
  track the pointer (a native webview captures the mouse otherwise). **Merge**:
  a "⤢ Merge" control appears in the sidebar while split — it lives in the chrome
  because the webviews cover the page — and un-splits back to a single tab.
- **Send a tab or a whole group to another workspace** (BACKLOG #44) —
  right-click a tab or a group header → "Send to workspace …". Moving a group
  carries all its tabs; the moved webviews are torn down (they left the active
  space), and if you sent the active tab away, focus falls back to a remaining
  tab in the current space.
- **Dark mode for all sites** — a Settings toggle that force-darkens every page
  by injecting a CSS "smart invert" (invert the page, re-invert images/video so
  media looks normal). Engine-agnostic — works on both WebView2 (Windows) and
  WebKitGTK (Linux) and on every site regardless of `prefers-color-scheme`
  support. Toggles live on all open tabs; new tabs apply it at document-start.
  Persists across launches. (An earlier attempt used WebView2's profile-level
  `PreferredColorScheme`, which only darkened opt-in sites and was a no-op on the
  WebKitGTK build — replaced by this.)
- **Drag a tab onto a group to join it** (BACKLOG #56) — drop a tab on a group
  header (or onto the middle of another tab) to add it to that group; dropping
  on an ungrouped tab's middle starts a new group with both. Tab-row edges still
  reorder.
- **Workspaces** (BACKLOG #44) — Arc-style named, colored tab spaces. Each tab
  belongs to a workspace; the strip (pinned + groups + tabs) shows only the
  active one. A switcher above the sidebar tools: click a pill to switch, **+**
  to create, double-click to rename, click the dot to recolor, right-click to
  delete (closes its tabs). **Highly RAM-optimized**: switching away **destroys
  the leaving workspace's webviews**, so inactive workspaces cost only their
  tab metadata (kilobytes) — and tabs are created lazily anyway, so an unvisited
  workspace holds no webviews at all. Workspaces + per-tab membership + the
  active one persist across restart.

### Changed
- **Sidebar layout refresh.** Pinned-tab tiles are smaller (6 per row, up from 4).
  Workspaces moved from a horizontal pill bar to a **vertical color-dot rail on
  the right edge** — hover a dot to pop out its name + recolor/rename/delete. An
  **Opera-style app rail on the left edge** shows your pinned web-app panels as
  icons (appears once you've pinned one); click an icon to toggle that panel,
  `+` to pin more. A **home button** (⌂) sits next to reload (loads the new-tab
  page). The sidebar widened slightly to make room.
- **History: deferred load + precomputed search keys.** `history.json` is now
  loaded on a background thread after the window shows instead of being parsed
  synchronously on the boot path (a large history no longer delays first paint).
  Each entry carries a precomputed lowercased search key (skipped on disk/IPC,
  recomputed on load), so omnibox search no longer re-lowercases every entry on
  every keystroke — it matches against the cached key.
- **Favicons are fine-grained reactive.** Moved the favicon cache from one big
  object signal to a per-host store, so loading one site's icon only re-renders
  the rows showing that host — not every favicon consumer (it was ~O(rows²) when
  many tabs fetched icons at once on session restore). `activeTab()` is now
  memoized too (it's read in many reactive scopes per render).
- **Dropped per-event work that shipped in release.** Removed debug `console.log`s
  that fired on every DOM capture (~every 400ms on active pages), every page-load,
  and every tab-open — plus a `webview_debug` IPC round-trip that ran on every tab
  open purely to log diagnostics. capture.js no longer builds/logs a string per
  publish. History `record` now takes a read-only fast path for a URL seen within
  the dedup window: it no longer write-locks or marks the store dirty for a page
  you're just sitting on, so an actively-mutating tab stops rewriting the whole
  ~2 MB `history.json` every 60s.
- **Responsiveness: cheaper sidebar renders + no resize IPC spam.** The tab-list
  derivations (pinned/unpinned tabs, per-group members, ungrouped remainder, the
  split fold) are now memoized instead of re-filtering `tabs()` once per tab row —
  was O(tabs²) per render, now one pass per change. The native-webview layout
  effect issues show/hide IPC only on visibility transitions (tracked in a `shown`
  set): a window resize now triggers just the throttled bounds update, not a
  hide-every-tab sweep each frame. Redundant `refreshGroups` calls (already done
  inside `refreshTabs`) were dropped from 8 mutation paths.
- **Binary: cold-path crates built for size.** PGP/zip/csv (import) and `image`
  (favicon transcode) now compile at `opt-level="z"` — they're one-shot/occasional
  operations where latency is irrelevant — while the hot browsing/render path
  stays at `opt-level=3`. Trims ~98 KB off the release binary with no runtime
  cost. (The binary was already lean: fat-LTO + strip + `panic=abort`; further
  cuts would require sizing the whole build, which would regress the speed work.)
- **RAM: hibernated tabs release their DOM snapshot.** Sleeping a tab now drops
  its cached DOM (up to ~1.25 MiB/tab) instead of keeping it resident; it
  re-captures on the wake reload. In a many-tab session this is the main Rust-side
  retained-memory win (the process RSS is otherwise dominated by the webview
  engine itself, which is already managed by hibernation + workspaces).
- **Startup: smaller boot bundle.** The flux:// pages (Vault, History, Bookmarks,
  Omni), the file manager, the command palette, and the extensions panel are now
  lazy-loaded — none of them show on a fresh window, so they no longer sit in the
  initial parse. The boot JS bundle dropped ~157 KB → ~112 KB (gz 49.8 → 36.3);
  the deferred chunks load on first use, which is instant since assets are local.
  (xterm was already lazy — only loaded when a terminal tab opens.)
- **CPU/battery: idle is now near-silent.** Several always-on polling timers that
  woke every 2–3s regardless of whether their UI was open are now event-driven /
  open-gated: the Settings RAM readout (2.5s), Shields status (2s × 5 IPCs →
  badge refreshes on navigation, full poll only while open), Passwords matches
  (2.5s → only while open), and Downloads (3s → only while open or a download is
  in flight). The hibernation sweep moved 30s→60s and now skips the `sysinfo`
  memory scan entirely when there are no background tabs to evict; the history
  autosave moved 15s→60s. Net: a fully idle window goes from ~sub-second
  aggregate wakeups to a handful per minute.

### Fixed
- **Built `flux`/`flux.exe` showed `ERR_CONNECTION_REFUSED` (localhost:1420).**
  A plain `cargo build --release` doesn't enable Tauri's `custom-protocol`
  feature, so the app served the dev-server URL instead of the embedded
  frontend. Added a `custom-protocol` feature and both install scripts now build
  with `--features custom-protocol`. A boot log prints `dev=<bool>` so the mode
  is visible from the terminal (a release binary must show `dev=false`).
- **ICO favicons: self-heal stale cache.** Favicons cached as `data:image/x-icon`
  before the ICO→PNG transcode landed were served straight from disk (still
  unrenderable on WebKitGTK); those entries are now skipped on read, forcing a
  fresh fetch that transcodes to PNG.
- **ICO favicons now render** (e.g. medium.com). WebKitGTK doesn't decode
  `data:image/x-icon` in `<img>`, so ICO-only sites showed no icon; favicons are
  now transcoded to PNG in Rust (and fetched with a browser User-Agent, so
  Cloudflare-fronted sites don't serve a challenge page instead of the icon).
- **Tab/group right-click menu no longer clips off-screen** — the menu is bounded
  to the viewport height (scrolls if taller) in addition to the Portal + clamp, so
  it can't run past the bottom of the panel.
- **Ctrl+Tab / Ctrl+Shift+Tab cycle only non-pinned tabs** (and stay within the
  active workspace) — previously the cycle wrapped through pinned tabs (and, in
  principle, other workspaces). If a pinned tab is active, the cycle enters at the
  first/last non-pinned tab.
- **The tab/group right-click menu is no longer clipped** by the sidebar edges or
  its bottom. The sidebar's `backdrop-filter` made it the containing block for the
  `position:fixed` menu, and its `overflow:hidden` cropped it — the menus now
  render through a Portal to `<body>` and clamp to stay on-screen.
- **Ctrl+Tab / Ctrl+Shift+Tab cycle tabs.** A focused page webview ate the chord
  before the injected forwarder ran (WebView2 treats it as a built-in browser
  accelerator), so cycling never fired. Now intercepted natively at the
  controller's `AcceleratorKeyPressed` event and forwarded to the chrome as
  next/prev-tab. COM verified vs msvc.
- **Sidebar popovers are opaque.** Shields / Settings / Passwords / Downloads /
  Extensions menus float over the native webview — a separate OS layer the
  backdrop-blur can't sample — so glass translucency read as see-through. They're
  now solid (keeping the glass rim + sheen).
- **Group + workspace rename now work.** They used `window.prompt`, which is a
  no-op in the webview — replaced with inline editing (double-click the name,
  Enter/blur to commit, Esc to cancel).
- **New tabs focus the address bar** so you can type immediately — now works
  when opened with **Ctrl+T** from a focused page too. A focused page webview
  holds OS keyboard focus (it's a separate child window), so focusing the chrome
  omnibox was a no-op; the chrome now reclaims OS focus (`chrome_focus`) first.
  Same fix applies to Ctrl+L.
- **Tab groups** (BACKLOG #56) — named, colored, collapsible groups in the tab
  strip. Right-click a tab for: pin, **new group**, **add to** an existing group,
  **remove from group**, close. Group headers collapse/expand, rename
  (double-click), recolor (click the dot), and ungroup (✕). A **"⊞ Group"** button
  by the Tabs header runs **group-by-topic**, seeding groups from Flux's existing
  semantic clusters (flux-embed). Groups + per-tab membership persist across
  restart. Backend model is `TabGroup` + commands; the UI reuses one drag-aware
  `TabRow` for grouped and ungrouped tabs.
- **Drag-and-drop tab reordering** (BACKLOG #30). Tabs in the strip are now
  draggable — drop above/below another tab to reposition (the drop point follows
  the cursor's half of the target row). The order is an explicit, persisted
  sequence in the backend (`tab_reorder`), so a drag-reordered strip survives
  restart. Reorder within the pinned grid + dragging into/out of it are
  follow-ups.

### Changed
- **Window remembers its size + position** across launches
  (`tauri-plugin-window-state`) — Flux reopens exactly as you left it instead of
  resetting to the default size.
- **Content card: padding on all sides + rounded page corners.** The page area
  now floats with even padding (previously it was flush against the sidebar).
  Internal pages (start, history, passwords, omni) get the card's rounded
  corners for free; live web pages are a separate OS layer, so on Windows their
  host window is clipped to a matching rounded region (`SetWindowRgn`,
  re-applied on resize; harmless square fallback if the engine doesn't honor
  it). COM verified against the msvc target.

### Added
- **Download manager** (BACKLOG #34) — Flux now intercepts WebView2's
  `DownloadStarting`, tracks each download's live progress + state, and owns the
  UI (the default WebView2 bubble is suppressed). A footer ⬇ popover (with an
  active-count badge) shows downloads with progress bars and controls:
  pause/resume/cancel while running, open / show-in-folder when done. Live COM
  operations are held on the UI thread and driven via `run_on_main_thread`; the
  serializable model is unit-tested and the WebView2 COM was compile-verified
  against the msvc target. (Windows/WebView2 for now; the WebKitGTK download
  hook is a follow-up.)
- **Command palette** (BACKLOG #6) — **Ctrl+K** opens a centered fuzzy search over
  open tabs (switch to), actions (new tab/terminal/files, toggle terminal/agent/
  sidebar, open History/Passwords/Omni, find, reload, close tab), and browsing
  history (as you type). Arrow keys + Enter + Esc; click/hover too. This also
  wires up the one shortcut that was previously blocked on this feature. Because
  it's a centered modal and the native webview is a separate OS layer over the
  content card, the active page is hidden while the palette is open and restored
  on close.
- **Omnibox live suggestions** (BACKLOG #32) — as you type in the address bar, a
  dropdown shows local **history matches** (with favicons) followed by **search
  suggestions** from the default engine's suggest endpoint (OpenSearch JSON, as
  DuckDuckGo/Google/Bing return). Arrow keys move the selection, Enter opens it,
  Esc dismisses, click/hover work. The dropdown lives in the sidebar (never under
  the native webview). A **"Search suggestions" toggle** (Settings ⚙, on by
  default) gates the remote fetch — turn it off and only local history is used,
  so your keystrokes never leave the machine.
- **Browsing history** (BACKLOG #39) — a persisted, searchable history at
  `flux://history`. Visits are recorded automatically from the DOM-capture pipe
  (real navigated URL + page `<title>`), deduped per visit and ranked by a
  simple frecency (recency + visit count); the store is capped + saved on a
  debounced background timer. The full-page view (DOM-rendered, like
  `flux://passwords`) shows recents grouped by day, live search, per-row
  favicons (#21), click-to-open, remove-one, and clear-all. Reachable from the
  Start page and the 🔖 Library popover. Store logic is unit-tested. Local-only.
- **Favicons** (BACKLOG #21) — the tab strip + pinned rail now show each site's
  real favicon instead of a letter glyph. Fetched **directly from the site and
  without cookies** (a plain `<img>` would send them) — never a third-party
  favicon service, in keeping with Flux's privacy stance — by a Rust command
  that tries `/favicon.ico`, falls back to the page's declared
  `<link rel="…icon">`, validates the bytes are actually an image (filtering
  soft-404 HTML), and caches the result **per host on disk** as a `data:` URL.
  The letter glyph remains as the fallback while loading or when a site has no
  usable icon. Image-type detection, HTML attribute parsing, and URL resolution
  are unit-tested.
- **Full-page password manager** at `flux://passwords` (BACKLOG #61). The sidebar
  popover was too cramped for a real vault (narrow + lots of scrolling), so the
  management UI moved to a roomy in-content page (DOM-rendered like
  `flux://omni`, no webview): a **searchable two-pane** layout — login list with
  avatars on the left, a detail pane on the right (reveal/copy username +
  password, open websites, delete) — plus **New login**, **Import from Proton
  Pass** (CSV/ZIP/PGP), and **Security** (master password + auto-lock) as tabs.
  The footer 🔑 popover is now lean and *contextual* (Proton-extension-style):
  logins that match the current site with one-click **Fill**, unlock/lock, and
  an "Open Passwords manager" link to the full page.
- **Tab hibernation / sleeping tabs** (BACKLOG #45) — the RAM win. Background
  browser tabs idle past a timeout have their **native webview destroyed**,
  freeing its memory; the tab stays in the strip (dimmed, with a 💤) and the
  page **reloads when you click back to it** (Flux's lazy-webview path re-creates
  it). On by default with a 30-minute timeout, configurable in Settings (⚙ →
  Memory: on/off + 5 min / 15 min / 30 min / 1 hour). The active tab and
  start/terminal/files tabs are never slept; hibernating does **not** run
  clear-on-close (the tab isn't closing).
- **Memory-pressure tab eviction** (BACKLOG #45). Beyond the idle timer, Flux now
  reads actual system + process memory (`sysinfo`) and, when free RAM is
  genuinely low (<12%, more aggressively under 6%), sleeps the
  least-recently-used background tabs early to relieve pressure. Adaptive to the
  machine — it stays quiet while there's headroom — and on by default. Settings
  (⚙ → Memory) gains the toggle plus a live readout of Flux's RSS and free RAM.
- **Sleeping tabs keep their scroll position + form input** (BACKLOG #45).
  Switching away from a tab snapshots its scroll offset and non-password form
  fields (text/select/checkbox/radio) into a **RAM-only** store; when the tab
  later wakes and reloads, Flux re-applies them once (matched to the same URL).
  **Password fields are never captured** and nothing is written to disk.
  (_Follow-up left:_ memory-pressure-based eviction.)
- **Vault master password + auto-lock** (BACKLOG #61, ADR 0009). Optional
  hardening that seals the vault even from the logged-in OS user. Setting a
  master password derives an **Argon2id** key (19 MiB / t=2) that wraps the data
  key on disk (`keywrap.json`) and **removes the key from the OS keychain**, so
  the data key is recoverable only with the password. The vault then boots
  **locked**; `vault_unlock` decrypts it into memory, **idle auto-lock**
  (configurable Off/1/5/15/30 min) and a "Lock now" button clear the decrypted
  vault + key from memory, and the master password can be changed or removed
  (which moves the key back to the keychain). The 🔑 footer button shows 🔒 +
  an unlock prompt when locked, and a Security section manages it all. Argon2id
  wrap/unwrap is unit-tested. (Default stays keychain-mode — no password — so
  nothing changes unless you opt in.)
- **Password manager + autofill** (BACKLOG #61, ADR 0009). A local-first vault
  with a **Proton Pass importer** — since Proton Pass ships only a WebExtension
  (which can't run in native webviews) and has no public API, Flux owns the data
  and autofills via injection.
  - New `flux-vault` crate: credential model, **AES-256-GCM** seal/open (random
    nonce per write, decrypted plaintext in `Zeroizing` buffers), conservative
    host matching, and a **Proton Pass importer** for every format Proton
    actually exports — **CSV**, **ZIP** (JSON/CSV inside), **PGP-encrypted**
    (decrypted with a passphrase via the pure-rust `pgp` crate), and raw JSON;
    format auto-detected from magic bytes + filename. The JSON/CSV parsers
    tolerate Proton's schema quirks (the `username` vs `itemUsername`/`itemEmail`
    split, header-name column mapping), skip trashed + non-login items, and
    dedupe. Unit-tested (incl. a real gpg-made PGP fixture).
  - **OS-keychain data key** (`keyring`: Windows Credential Manager, macOS
    Keychain, Linux Secret Service) with a file-backed fallback when no store is
    available; the encrypted vault lives at `app_data/vault/vault.bin`.
  - **Autofill** (`vault_fill`): fills the active page's login form on explicit
    user action, **same-origin enforced**, injected straight into the page — the
    password never passes through the chrome's JS.
  - **Vault UI**: a footer 🔑 popover — lists logins (matches for the current
    site float to the top with a **Fill** button), copy/reveal/delete, **Import
    from Proton Pass** (point it at the `.csv`/`.zip`/`.pgp`/`.json` export — a
    passphrase field appears for `.pgp`), and add a login.
  - ADR 0009 sets the security model (threat model, local-first/no auto-sync,
    same-origin user-initiated autofill, passkeys left to the native webview,
    future master-password option). _Follow-ups:_ save-password prompt on login,
    Chrome/1Password/Bitwarden importers, optional master password + auto-lock.

### Fixed
- **Shields popover clipped by the sidebar.** The footer popovers (shields,
  bookmarks, extensions, settings) carried fixed min-widths (226–300px) wider
  than the narrow sidebar, so they overflowed — clipped by the sidebar's
  `overflow:hidden` and, worse, the overflow fell *behind* the native webview
  (a separate OS layer over the content card). They now anchor to the sidebar
  footer and span its width with small side margins (`.footer-pop`), so the box
  always fits and is fully visible without widening the sidebar.

### Changed
- **Bounded the per-tab DOM snapshot cache** (BACKLOG #79 — RAM). Each tab's
  captured page (`dom_publish`) is now capped at 1 MiB of HTML + 256 KiB of
  text before caching. A page's outerHTML is often several MB; cached across
  many open tabs that was the dominant chunk of Flux-controlled heap. The caps
  are generous for the real consumers (agent, embedder, `flux extract-json`),
  turning unbounded growth into O(tabs × cap).

### Added
- **Find-in-page** (BACKLOG #33) — `Ctrl+F` opens a find bar. Typing drives the
  engine's native `window.find()` (works on both the Chromium-based WebView2 and
  WebKitGTK) to highlight + scroll to matches; Enter / Shift+Enter (and the
  ‹ › buttons) step forward/back, and a case-insensitive **match count** is
  reported back to the bar over a new `find_result` event. Esc closes it. Like
  the loading bar, the find bar lives in the sidebar — the native webview is a
  separate OS layer over the content card. (Follow-up: precise current/total
  index + highlight-all; `window.find` only gives a single native highlight.)
- **Navigation polish** (BACKLOG #31) — **stop** (a `webview_stop` command;
  the reload button becomes ✕ while a page loads, and `Esc` stops the active
  tab), per-tab **loading state** driven by the page-load events, a
  **security/TLS badge** left of the omnibox (🔒 for HTTPS, ⚠ for plain HTTP),
  and an indeterminate **loading bar** under the omnibox. (The progress bar
  lives in the sidebar, not the content card: the native webview is a separate
  OS layer that overlays the card and would hide an in-card bar.)
- **Keyboard shortcuts** (BACKLOG #18) — Windows/Linux Ctrl-based bindings
  (Cmd also works on macOS): new browser tab `Ctrl+T`, terminal tab
  `Ctrl+Shift+T`, close tab `Ctrl+W`, next/prev tab `Ctrl+Tab` /
  `Ctrl+Shift+Tab`, jump to tab `Ctrl+1‑9`, toggle terminal `` Ctrl+` ``,
  toggle agent `Ctrl+Shift+A`, toggle sidebar `Ctrl+B`, focus omnibox `Ctrl+L`,
  reload `Ctrl+R`/`F5`, back/forward `Alt+←`/`Alt+→`. The chrome handles these
  via a capture-phase listener; when a page webview has focus (which eats the
  keyboard), an injected `shortcuts.js` forwards the chord to the chrome through
  a new `chrome_key` fluxtab command. A terminal-focus guard leaves
  readline/tmux chords (Ctrl+R/W/L/B) to the shell. (Avoided ⌃A/⌘S from the
  original spec — they collide with select-all / save-page on Win/Linux; the
  `Ctrl+K` command palette waits on #6.)
- **Extension manager UI** (BACKLOG #95). The footer 🧩 panel is now a real
  manager: it lists installed extensions with name/version + permission chips,
  an enable/disable toggle, a remove button, and an **install-from-folder** row
  (point it at a folder with `flux.extension.json` — e.g.
  `examples/extensions/hello` — and validation errors surface inline). Backed by
  the #92 registry commands. This completes the extension epic (#92–95):
  install → inject → grant-checked API → manage. (Still to come: `flux.ui`
  extension-contributed chrome, `flux.events`, and a native folder picker.)
- **Extension `flux.*` API + capability broker** (BACKLOG #94, ADR 0008). A
  privileged Rust broker (`broker.rs`) is the one door extension content scripts
  may call. Each content script gets a JS shim exposing `flux.runtime`
  (id/version/permissions), `flux.storage` (per-extension persisted KV),
  `flux.tabs` (query/open/navigate), and `flux.dom` (read cached snapshot /
  inject JS) — every method forwards to `plugin:fluxtab|ext_broker_call` tagged
  with a per-extension **capability token**. The broker resolves the token →
  extension and checks every call against the manifest's grants:
  **deny-by-default**, so unknown calls and ungranted permissions are rejected.
  Grant model, token mint/resolve, storage round-trip, and the shim are
  unit-tested. (`flux.ui` and `flux.events` land with the manager UI in #95.)
  Security caveat (documented in ADR 0008): on WebView2 the shim runs in the
  page world, so the token isn't hidden from a hostile same-page script —
  WebKitGTK script worlds are the future hardening path.
- **Extension content-script injection** (BACKLOG #93, ADR 0008). On each page
  load, `ExtRegistry::injection_for(url, phase)` assembles the CSS + JS of every
  enabled extension whose `@match` patterns hit the URL — honoring `run_at`
  (document_start vs document_end/idle) — and injects them through the existing
  `on_page_load`/`eval` path (the same one cosmetic filtering uses). Each
  extension's JS runs inside its own IIFE scope guard (WebView2 has no isolated
  worlds) carrying a frozen `flux` identity object. New match-pattern + glob
  engine (`https://*/*`, `*://*.example.com/*`, `<all_urls>`, path globs),
  unit-tested. The callable `flux.*` broker API replaces the identity shim in
  #94.
- **Extension manifest + loader + registry** (BACKLOG #92, ADR 0008) — the
  foundation of Flux's mini-extension model. `flux.extension.json` declares
  id/name/version, deny-by-default `permissions`, `content_scripts`
  (match globs + js/css + run_at), an optional `background` worker, and `ui`
  contributions. `Manifest::parse` validates (id shape, known permissions only,
  non-empty matches); `ExtRegistry` loads an extension folder, verifies its
  content-script files exist, and persists `extensions/registry.json`
  (install / list / enable-disable / remove). New commands
  `ext_install`/`ext_list`/`ext_set_enabled`/`ext_remove` + ipc bindings + mock.
  Ships a reference example at `examples/extensions/hello`. (Content-script
  *injection* is #93, the `flux.*` broker API is #94, the manager UI is #95.)
- **Block site permission requests** (BACKLOG #58, completes it). A Shields-
  popover toggle that auto-denies camera/mic/geolocation/notifications via
  WebView2's `PermissionRequested` (off by default — WebView2's own prompt
  handles the normal case; this is one-switch hardening). COM verified against
  the msvc target. The HTTPS downgrade *interstitial* was deliberately skipped —
  the per-site "Allow HTTP" toggle already recovers from a no-HTTPS site.
- **Clear cookies on close** (BACKLOG #58). A per-site "Clear cookies on close"
  toggle (Shields popover): when a flagged site's tab closes, its cookies are
  wiped. Cookie ops now run through the always-alive **main** webview (shared
  cookie store) instead of a tab webview, avoiding a teardown race with the
  closing tab.
- **Tracking prevention** (BACKLOG #58, third-party trackers/cookies). A
  "Trackers" selector (Off/Basic/Balanced/Strict, default **Balanced**) in the
  Shields popover drives WebView2's native Edge tracking prevention
  (`ICoreWebView2Profile3`) — profile-wide third-party tracker + cookie blocking
  that complements the EasyList content blocker. Applied to each tab webview on
  creation and on change. COM verified against the msvc target.
- **Extension architecture decided — ADR 0008** (BACKLOG #96). Flux's mini-
  extension model: a manifest (`flux.extension.json`), content scripts injected
  via the existing path, and the capable `flux.*` API in a **Rust broker**
  (content scripts treated as untrusted vs the page). A document-start
  **capability-token handshake** authenticates the extension (WebView2 has no
  isolated worlds; WebKitGTK adds a script world where it can), permissions are
  deny-by-default with install consent, and hard boundaries wall off other
  extensions' storage, raw IPC, and blanket net/fs. Implementation is #92–95.
- **Cookie controls** (BACKLOG #58). The Shields popover can now **clear cookies
  for the current site** or **clear all cookies** — WebView2 `CookieManager`
  (`DeleteCookies` / `DeleteAllCookies`), reached through any open tab webview
  since they share one cookie store. COM verified against the msvc target;
  Windows-only for now. (Clear-on-close + third-party-cookie blocking are next.)
- **HTTPS-only mode** (BACKLOG #58). Opt-in (Shields popover toggle): Flux
  upgrades `http://` navigations + subresources to `https://` via a 307 from the
  **same WebView2 interceptor** as the content blocker (ADR 0007) — the request
  hook now returns allow/block/**redirect**. Skips loopback/`.local` and a
  per-site "allow HTTP" allowlist (also in the popover) for sites with no HTTPS.
  COM verified against the msvc target; runtime needs a Windows smoke test.
  (Cookie/permission controls + a downgrade interstitial are the next #58 steps.)
- **Content blocker — cosmetic (element-hiding) filtering** (BACKLOG #57,
  completes it). On each page load Flux injects the filter lists' element-hiding
  CSS for that URL (`Filter::cosmetic_css` → one `{ display: none !important }`
  rule over the matched selectors), so blocked ad slots + leftover placeholders
  are *hidden*, not just emptied. It's plain CSS injection, so it works on
  **every** backend — including the WebKitGTK/WSL build where the network hook
  isn't wired yet. Respects the global + per-site shields toggle.
- **Content blocker — full EasyList + shields UI** (BACKLOG #57). On top of the
  bundled starter list, Flux now **fetches + caches EasyList + EasyPrivacy**
  (in the background on boot, re-fetched when older than 5 days; `tls`/`gzip`
  ureq) and hot-swaps them into the live filter — a big jump in coverage. A new
  **Shields control** in the sidebar footer shows a live blocked-count badge and
  a popover to toggle blocking **globally or per-site**, plus an "update filter
  lists" action. Commands: `shields_refresh` (+ the existing status/toggles).
- **Content-blocker engine + shields** (BACKLOG #91/#57, ADR 0007) — the
  foundation of the security pass. New `flux-filter` crate wraps Brave's
  `adblock` engine (EasyList/uBO syntax → per-request block decisions); it's made
  `Send + Sync` via serialize-once + thread-local deserialize so it can live in
  shared state and be called from the native request interceptor. A `shields`
  policy layer adds a global on/off + per-site allowlist + blocked-request count
  (commands `shields_status` / `_set_enabled` / `_set_site` / `_check`), seeded
  with a bundled curated starter list of the major ad/tracker networks. Fully
  unit-tested (blocks trackers, honors `@@` exceptions + the toggles).
- **Content blocker — WebView2 interceptor wired** (BACKLOG #91/#57). Each tab
  webview now installs a `WebResourceRequested` hook (via `with_webview` → raw
  `ICoreWebView2`) that asks `ShieldsState` per request and answers blocked ones
  with a bodyless `403`, so trackers/ads never download. The COM code is
  compile-verified against the `x86_64-pc-windows-msvc` target (webview2-com 0.38
  / windows 0.61, pinned to match wry so the types unify); its *runtime* blocking
  needs a Windows smoke test. WebKitGTK interceptor + full EasyList fetch follow.
- **Terminal sessions survive tab switches** (BACKLOG #73). Terminal tabs are
  now kept mounted in a keep-alive layer (only the active one is shown), so
  switching to another tab and back no longer kills the shell — the PTY,
  scrollback, and any running process persist. A terminal's PTY is now torn down
  only when its tab is actually closed.
- **Terminal sessions survive *closing Flux*** — opt-in, via `tmux`. Set
  `FLUX_TERM_PERSIST=1` and each terminal runs inside a per-tab tmux session
  (attach-or-create, `flux-<tab-id>`). Because tmux's server lives outside Flux
  (in WSL / on Unix), closing Flux only *detaches* — reopening re-attaches the
  **live** session: running processes, scrollback, cwd, all intact (tab ids
  persist via session restore #19, so re-attach is automatic). Falls back to a
  plain shell if tmux isn't installed (cached check); an explicit tab-close
  kills the tmux session so nothing leaks. Persists across Flux restarts, not a
  `wsl --shutdown` / reboot. WSL/Unix only — native Windows shells have no tmux.
- **`flux://omni` — native Omni index dashboard.** A velvet/glass view of the
  Omni search index's live health, reachable from the omnibox (`flux://omni`) or
  a start-page quick action: stat cards (live docs, segments, tombstones,
  embeddings, ANN, avg length), per-segment fill bars, a live essential-sites
  grid (from Omni's `/sites` bang table), and the PageRank authority list —
  clickable, auto-refreshed every 2.5s. Data comes from Omni's `/stats` +
  `/sites` via the `omni_stats` / `omni_sites` Rust commands (proxied through
  Rust because the shell CSP blocks a direct `http://localhost:8080` fetch); the
  Omni base URL follows the configured search engine, with `FLUX_OMNI_URL` as an
  override.
- **Session restore** (BACKLOG #19). Open tabs now survive a restart. Flux
  persists the tab strip — url, title, `pinned`, `kind`, order, and the active
  tab — to `session.json` in the app data dir on every change, and repopulates
  `FluxState` on boot ("continue where you left off"). The backend is now the
  source of truth: a new `tab_set_url` syncs in-webview navigation so restored
  tabs reopen *where you left them*, not at their start page; `tab_list` is
  ordered by id (creation order) so the strip is stable across reads/restores;
  the id counter is bumped past every restored id. Pages load lazily (only the
  focused tab opens a webview). **Fixes pinned tabs vanishing on relaunch.**
- **Files tab — marquee (rubber-band) selection** (BACKLOG #90).
  Click-drag on empty space to sweep a selection rectangle over rows; ⇧/⌘/Ctrl
  while dragging adds to the existing selection. Works with the virtualized list
  (coordinates are in scroll-independent content space) and **auto-scrolls** when
  the pointer nears the top/bottom edge.
- **Files tab — WSL distros in the rail.** On Windows the quick-access rail now
  lists installed **WSL distributions** under a "Linux" section (e.g.
  `Ubuntu-24.04`), enumerated via `wsl.exe -l -q` and opened at
  `\\wsl.localhost\<distro>`. `clean()` now folds the `\\?\UNC\…` form
  `canonicalize` returns back to a navigable `\\server\share\…` path.
- **Files tab — live directory watch + undo** (BACKLOG #85/#89, ADR 0006).
  The listing now **updates itself** when the shown directory changes on disk
  (the `notify` crate — inotify/ReadDirectoryChangesW — one watcher per Files
  tab, emitting `flux://fs-changed`; the UI re-lists, debounced, preserving
  scroll + selection). And file ops are now **undoable** (⌘/Ctrl-Z, or the
  context menu): rename, move, and trash reverse cleanly — undo only ever puts
  files *back* (rename→rename, move→move, trash→restore via the `trash` crate's
  `os_limited` API on Windows/Linux), never deletes. The undo stack is
  backend-owned (so the platform-specific restore handle never crosses IPC).
- **Files tab — file operations** (BACKLOG #83/#84, ADR 0006). The explorer is
  now read-*write*: **new folder/file** (inline-named), **rename** (inline,
  F2), **copy/cut/paste** (⌘/Ctrl-C/X/V — paste duplicates as "name copy" on
  collision), **drag-to-move** (onto folder rows, the quick-access rail, or
  breadcrumbs), and **delete** — to the **OS trash** by default (recoverable;
  the new `trash` dep) or permanent with ⇧. **Multi-select** via click /
  ⌘-click (toggle) / ⇧-click (range) / ⌘A, a right-click **context menu**, and
  a glass **confirm dialog** on every destructive op. Backend commands
  (`fs_create_dir/_file`, `fs_rename`, `fs_move`, `fs_copy`, `fs_trash`,
  `fs_delete`) all run off the main thread; `fs_move` falls back to copy+delete
  across filesystems, `fs_copy` recurses directories.
- **Files tab — a native filesystem explorer** (ADR 0006). Open a 📁 **Files
  tab** like the terminal: an explorer rendered in the content card (no
  webview), backed by `std::fs`. Toolbar with back/forward/up + breadcrumb +
  live filter, a quick-access rail (home, Desktop/Documents/Downloads, drive
  roots), and a **virtualized** columned list — only the visible rows are in the
  DOM, so a 10k-entry directory scrolls smoothly. Sortable (name/size/modified,
  folders-first), hidden-file toggle, full keyboard nav (↑↓ select, Enter open,
  Backspace up); files open with the OS default app. The listing call
  (`fs_list`) runs off the main thread (`spawn_blocking`) and returns **compact**
  entries, so even huge directories never freeze the UI.
- **Agent chat mode.** The agent sidebar is now a **chat-first** interface — talk
  to your local Gemma with no page required (`agent_chat`); if a page is open its
  text is passed as context so you can ask *about* it. Page actions still work via
  an explicit **`/act …`** prefix (e.g. `/act click the login button`). New typed
  chat feed (user / assistant / action / error bubbles) with auto-scroll.
- **Flux Agent is live — local Gemma via Ollama** (BACKLOG #1/#64, ADR 0005).
  `flux_agent::OllamaBackend` POSTs to a local Ollama server (`/api/generate`,
  `format:"json"`, temp 0.1) and the planner parses the reply into an
  `AgentAction`, which the (injection-safe) compiler turns into JS injected
  into the active tab. Default model `gemma4:12b-it-qat` (`FLUX_MODEL` to
  switch to `e4b`/`e2b` for speed); endpoint via `FLUX_OLLAMA_URL`. Backend is
  selectable: Ollama (default), `FLUX_AGENT_BACKEND=mock` (dev), or `llama`
  (in-process, feature-gated). No FFI/GGUF — pure Rust, unit-tested.

### Fixed
- **Files tab drag-to-move did nothing.** The main window left `dragDropEnabled`
  at its default `true`, so Tauri's native OS drop handler claimed drag events
  and **suppressed the webview's HTML5 drag-and-drop**. Set
  `dragDropEnabled: false` on the window so in-app DnD works.
- **Opening/closing a tab reset other tabs to the home page.** The backend only
  stores each tab's *creation* url (in-webview navigation is frontend state), so
  `refreshTabs()`'s `setTabs(await tabList())` clobbered every open tab's live
  url back to its start page — the affected tab then rendered the dashboard
  instead of its page on next focus. `refreshTabs` now *merges*: it preserves
  the live url/title of tabs it already holds and takes only structural fields
  (kind/pinned/cluster) + add/remove from the backend.
- **Files tab froze the app.** ContentArea keyed the Files `<Show>` on the tab
  *object*; `onPathChange` rebuilds that object (`{ ...t, url }`) on every load,
  so the keyed Show remounted FilesView → reload → onPathChange → an infinite
  remount loop (UI pinned, listing never settled). Keyed on the stable tab *id*
  instead.
- **Files list wouldn't scroll** with more entries than fit the viewport. The
  whole content-card height chain was unbounded: `.content` lacked
  `min-height: 0` (so the shell's `1fr` content row grew to the list's full
  height) and `.card` (a `place-items: center` grid) sized its cell to content,
  so a child's `height: 100%` resolved to content height — nothing to scroll.
  Bounded `.content` (`min-height: 0`) and `.card`
  (`grid-template: minmax(0,1fr) / minmax(0,1fr)`), plus the `.files-body` row
  (`minmax(0, 1fr)`); the list's `overflow-y:auto` now actually has a bounded
  height. (Fixes the card for the terminal/start tabs too.)
- **DOM capture on non-default ports** (e.g. a local search engine at
  `http://localhost:8080`). The `tab.json` capability used `http://*` /
  `https://*`, whose URLPattern port is unspecified and so only matches the
  scheme's *default* port (80/443) — capture was ACL-rejected on `:8080`.
  Changed to `http://*:*` / `https://*:*` (any port), verified against the
  `urlpattern` matcher.
- **DOM capture now works on real pages** (the agent's "no page content" error).
  Real sites set restrictive CSPs (e.g. DuckDuckGo's `connect-src`) that block
  Tauri's fetch-based IPC, forcing the `postMessage` path — which **doesn't
  carry a raw request body**, so the zero-copy `dom_publish` rejected every
  capture. Switched `dom_publish` + `capture.js` to **plain JSON args** (survive
  both IPC paths). Also fixed a `MutationObserver` crash (`documentElement` null
  at injection time) by deferring it to `DOMContentLoaded`.
- **Browsing on Windows — webview commands are now `async`.** `webview_open`
  (and friends) call `Window::add_child`, which blocks on the main thread; as
  *sync* commands they ran on the main thread on Windows → **deadlock**, so the
  command never returned, the page never rendered, and the UI froze. Async runs
  them off-main. (This was the real "stuck on loading" + freeze cause; the
  transparency fix below was also necessary.)
- **Browsing on Windows**: turned the window **opaque** (`transparent: false`).
  WebView2 can't composite per-tab child webviews on a transparent host, so
  pages were positioned correctly but invisible. **Native Win11 rounded corners**
  restored via the DWM `DWMWA_WINDOW_CORNER_PREFERENCE` API (windows-sys,
  cross-verified against the Windows target) — no transparency needed.
- **Close button** now force-closes via `destroy()` (the red light's `close()`
  only emitted `closeRequested`, which wasn't closing the borderless window).
- **Terminal on Windows**: default to **WSL** (`wsl.exe` — the user's dev env),
  starting in the **Linux home** (`--cd ~`) rather than the translated Windows
  cwd (`/mnt/c/Users/...`), forwarding Flux context vars into the distro via
  `WSLENV`; overridable with `$FLUX_SHELL` (powershell.exe / cmd.exe / pwsh.exe). Earlier: only set an
  existing cwd (an invalid cwd made spawn fail silently), and **surface spawn
  failures + process exit in the terminal** with the shell + cwd in the error.
- **CSP**: allow the chrome to `connect-src`/`img-src` over `https:` so the
  home-page weather (and future suggestion/favicon fetches) aren't blocked.
- **Webview**: explicitly `show()` + focus a tab's page after `add_child`, and
  log page-load events — diagnostics for the "search stuck on loading" report.
- **Window dragging**: added a full-width draggable **title bar** (own grid row,
  traffic lights + centered tab title) using `data-tauri-drag-region="deep"`.
  The old sidebar-only drag sliver was too small and everywhere else along the
  top was the resize edge or the page; the title bar gives a generous grab area
  that a tab's webview can never cover (it renders in the row below). `deep` is
  required because Tauri's drag script only honors a *bare* attribute on the
  exact element clicked, which the header's children always cover.
- **Search bar** had a second border inside the pill while typing — the global
  `input:focus` ring; suppressed it on the start-page search input.
- **Pane-resize latency**: dragging a splitter now disables the grid transition
  (1:1 pointer tracking) and coalesces webview bounds updates to one IPC per
  frame instead of one per pointer move.
- **Terminal special characters**: enabled xterm `customGlyphs` (box-drawing,
  block, and powerline glyphs are drawn by xterm itself) and broadened the
  monospace fallback chain. Full icon-font (Nerd Font) coverage is BACKLOG #76.
- **Webview positioning** (search showing "loading…" with the page in the wrong
  place): the active tab's bounds are now measured fresh from the DOM, re-applied
  on the next frame and again on load-finished, and webview command failures are
  logged to the console. *Needs live confirmation* — see Known issues.

### Known issues
- **Per-tab web pages don't render under WSL2** (root cause identified):
  launching from WSL2 produces a **Linux/WebKitGTK** build (via WSLg), where
  Tauri's multi-webview child positioning doesn't work — pages render stacked at
  the window bottom instead of over the content card. Everything else works
  there. **Fix: build/run natively on Windows (WebView2) or macOS (WKWebView).**
  Diagnostics retained for confirmation: the `webview_debug` command + the
  `[flux webview]` console logs.

### Added
- **Rounded window corners**: the velvet surface moved to `.shell` (12px radius,
  transparent body) so the window corners clip cleanly.
- **Resizable panes** (BACKLOG #27): drag the splitters between the sidebar,
  terminal column, and agent panel; widths persist to `localStorage`.
- **Sidebar footer**: bookmarks, extensions, and settings icons join the
  terminal/agent toggles. Settings opens a working default-search-engine picker;
  bookmarks/extensions show their roadmap status.
- **Home page**: real weather (Open-Meteo + IP geolocation, graceful offline
  fallback), **editable shortcuts** (add/remove, persisted to `localStorage`),
  and a subtle flowing **wave animation** for the "flux" feel.
- **Start page / new-tab dashboard** (BACKLOG #71): `flux://start` tabs render a
  glassmorphic dashboard in the content card (no webview) — a central search
  hero wired to the pluggable backend (#68), a live clock + greeting, recent
  tabs, a quick-link speed dial, and quick actions (new terminal / ask the
  agent). New browser tabs and fresh sessions land here; typing a query or
  clicking a shortcut transparently opens the tab's webview.
- **Pluggable search backend** (BACKLOG #68): new `flux-search` crate — engines
  are pure data (name + URL template + optional suggest template + keyword), and
  `resolve()` decides navigate-vs-search, applies `!bang`/keyword routing, and
  percent-encodes the query. `flux-core` persists the config to the app config
  dir and exposes `search_resolve/engines/default/set_default/add_engine/
  remove_engine`; the omnibox now routes through it. Seeded with DuckDuckGo
  (default), Google, Bing — and a custom engine (e.g. your own) drops in by
  `search_add_engine` + `search_set_default`, no code change.
- **DOM capture** (BACKLOG #5, ADR 0004): `capture.js` streams the active
  page's DOM to the `dom_publish` command, which now lives in an **inlined
  `fluxtab` plugin** so remote tab pages can call it (Tauri blocks remote→app
  commands). Tab webviews are granted exactly one capability —
  `fluxtab:dom_publish` via `capabilities/tab.json` — and nothing else; the
  local chrome's other ~26 commands stay unrestricted. Compile-time validated;
  end-to-end delivery pending live verification.
- **Real web pages** (BACKLOG #2): each Browser tab is now a native child
  webview (`flux-core::webview`, `add_child` over the content-card rect),
  with `webview_open/set_bounds/show/hide/navigate/back/forward/reload/close`
  commands. The frontend tracks the card rect with a `ResizeObserver` and keeps
  the active tab's page positioned over it (hiding the rest); the address bar
  navigates the active tab and the back/forward/reload buttons work. Page-load
  events stream via `flux://tab-loaded`. `capture.js` is injected into every
  tab webview as an init script (stamped with the tab id).
- **New brand logo** — a DeepMind-inspired spiral vortex: three logarithmic-
  spiral arms (teal→royal→magenta) swirling into a glowing core on the velvet
  squircle. Master at `assets/brand/flux-icon.svg`, rasterized via headless
  Chromium (gradients/glow) and regenerated across all desktop icon formats.
- **Custom window chrome**: macOS-style traffic lights (close/minimize/zoom)
  in the sidebar header, a draggable title region, and borderless-window
  **edge/corner resize** via Tauri `startResizeDragging`. Min window size
  lowered to 720×480.
- **Working embedded terminal** (ADR 0003): real PTY sessions via
  `portable-pty` in `flux-core::terminal` (spawn `$SHELL` with the `FLUX_TAB_*`
  context env, background reader thread, `terminal_spawn`/`write`/`resize`/
  `kill` commands streaming over a Tauri `Channel`), rendered by **xterm.js**
  in `TerminalView.tsx`. xterm + addons are **lazy-loaded** (~72 KB-gzip chunk,
  off the base bundle which stays ~9.6 KB gzip). The vertical terminal column
  hosts a persistent dev shell; Terminal tabs each get their own session.

### Changed
- **Premium UI pass — Royal Velvet × Liquid Glass**: richer layered velvet
  background (deep plum-navy + teal/royal/magenta light pools + faint grain),
  Apple-style frosted **liquid glass** panels (sidebar, agent, popovers) with
  specular top rim, inner highlights, and depth shadows; smoother premium
  easing on every interactive state; refined glass scrollbars, focus rings, and
  pin/tab treatments. Dark Deep Space Blue identity deepened toward royal
  velvet — same brand, far more premium feel.
- **Shell redesigned to an Arc-style vertical layout** (ADR 0002). The top tab
  strip and bottom terminal pane are gone. Navigation now lives in a **left
  sidebar** (window controls, address pill, pinned-tab grid, vertical tab
  list with cluster-color accents, footer tool toggles) that **collapses to an
  icon rail**. The active tab renders into a **floating rounded content card**
  on a subtle gradient frame. Dark Deep Space Blue identity preserved — only
  the structure changed.
- **The terminal is now a vertical right-side column**, not a bottom strip;
  toggleable and collapsible to 0 width. With the agent open the order is
  `sidebar | content | terminal | agent`.
- Tab selection is seeded on load so a tab is always active (address bar +
  highlight reflect it); tab rows gained hover close buttons.

### Added
- **UI preview harness**: `npm run preview:ui --workspace apps/shell` builds
  the shell with mocked Tauri IPC (`src/mock/`, `vite.preview.config.ts`) and
  serves it for inspection/screenshots without a Rust runtime.

### Added (0.1 scaffold)
- **Monorepo scaffold**: Cargo workspace (`flux-core`, `flux-term`, `flux-agent`,
  `flux-embed`, `flux-import`) + npm workspace (`apps/shell`), fat-LTO release
  profile, ADR 0001 with CI-enforceable performance budgets.
- **flux-core**: `FluxState` (DashMap tab table, `Arc<DomSnapshot>` zero-copy
  cache, atomic active-tab), raw-ArrayBuffer IPC (`dom_publish` /
  `dom_active_bytes`), `terminal_env` context bridge, `agent_execute`
  plan→compile→inject pipeline, per-tab `capture.js` bridge script.
- **flux-agent**: GBNF-constrained planner over a closed `AgentAction` enum,
  injection-safe JS compile templates (tested), `MockBackend` for weight-free
  dev/CI, feature-gated llama.cpp backend skeleton.
- **flux-term**: vte-backed grid with per-row damage tracking (SGR colors,
  CUP/ED, wrap/scroll), feature-gated WGPU instanced renderer + WGSL cell shader.
- **flux-embed**: hashing embedder + greedy cosine clustering with the Flux
  cluster palette.
- **Shell (SolidJS)**: CSS-grid layout (tab strip / content / terminal pane /
  agent sidebar / status bar), full "Tactile Brutalism × Liquid AI" theme
  (`#0B132B` / `#00E5FF` / `#D100D1`, kinetic gradients, glassmorphism),
  agent sidebar with live status states, typed IPC layer.
- **CLI launch**: `flux [URL]... [-t|--terminal]` from any terminal —
  parsed pre-GUI (`--help`/`--version` never flash a window), materialized as
  tabs on shell mount via the `launch_intent` command.
- **Tab kinds**: tabs are first-class Browser *or* Terminal; the new-tab “+”
  opens a glass picker offering both. Terminal tabs fill the content cell and
  suppress the bottom terminal pane.
- **Pinned tabs (Arc-style)**: right-click pins/unpins; pinned tabs render as
  squares in a left rail, are excluded from semantic clustering, and drop
  their cluster tag on pin.
- **flux-import**: Chrome profile discovery (`ProfilePreview` per profile),
  full bookmarks import (folder paths preserved, tested), extension
  *inventory* from manifests, Saved-Tab-Groups detection. Exposed as
  `chrome_import_preview` / `chrome_import_bookmarks` commands.
- **App icon**: master SVG (`assets/brand/flux-icon.svg`) — three slanted
  flux lines forming an abstract italic F (stepped teal→violet) plus a
  magenta terminal-cursor block on the Deep Space Blue tile; all desktop
  platform formats (`.icns`, `.ico`, PNGs) generated via `tauri icon` and
  wired into `tauri.conf.json`.
- **Docs**: this `CHANGELOG.md`, `BACKLOG.md` (stable-numbered, referenced
  from code comments), README setup/layout/flags.

[Unreleased]: https://github.com/flux-browser/flux/commits/main
