# 0011 — Browsing provenance spine ("the Trail") — a Visit data model for the Research OS

Status: **accepted (vertical slice in progress)**
Date: 2026-07-15
Extends: [0010 — Knowledge Base](0010-knowledge-base-second-brain.md). Relates to
[0001 — performance & storage budgets](0001-architecture-and-performance-budgets.md),
[0004 — DOM capture](0004-dom-capture-inlined-plugin.md), [0007 — content filtering](0007-request-interception-and-content-filtering.md).

## Context

We want to turn Flux from a browser into a **Research OS / external scientific
memory**: a personal knowledge graph built automatically from what the user
reads, with an AI conversation attached to every page, papers linked to code and
datasets, contradictions surfaced, *why* each page was visited remembered, and
any research session resumable months later.

A long brainstorm produced ~30 feature ideas. They collapse to ~7 primitives
(provenance/per-page memory, knowledge graph, time-travel, semantic retrieval,
structural reading, ambient agents, collaboration). **The trap is building them
as 30 disconnected features.** Almost every compelling one — graph, time-travel,
"why did I visit," per-page chat, "you've solved this before" — is a *view or
query over one shared object: the visit*. Without that shared object we rebuild
the storage layer five times and the features never compose.

Flux already has most of the ingredients, disconnected:

- **History** (`history.rs`, `HistoryEntry{url,title,last_visit_ms,visits}`) — a
  flat list. No content, no provenance, no edges.
- **Archive** (`archive.rs`, `ArchiveStore` + `ArchiveMeta`) — a *local embedded
  vector store* of saved page snapshots with embeddings, persisted as JSON. This
  is the snapshot+embedding precedent, but manual (user saves).
- **KB** (`kb.rs`, ADR 0010) — cited retrieval over **external** corpora (Onyx,
  Scroll, Council) via per-`source` namespacing, `kb_query`/`kb_answer`, Notebook.
- **DOM capture** (`state.rs`, `DomSnapshot{url,html,text,captured_at_ms}`) — the
  visible-text extraction the embedder and agent already consume.
- **Session snapshots** (`sessions.rs`, `SnapshotStore`/`DaySnapshot`,
  `SavedSession`/`SavedTab`) — daily workspace snapshots; the basis for restore.
- **Tracker graph** (`trackers.rs` + its frontend viz, `TrackerNode`/`Edge`/`Graph`)
  — an existing force-directed graph renderer we can reuse for the research tree.
- **Vault** (`vault.rs`) — encryption-at-rest precedent and login-form detection
  (`vault_page_matches`) we need for draft redaction.
- **Agent** (`planner().chat_stream`) — the per-page chat engine.

The missing piece is the **spine that unifies them**: a first-class *Visit*.

## Decision

Introduce a browsing **provenance spine** — a new `crate::trace` module owning a
`Visit` store — and make **browsing a native KB source** (`source:"web"`) so the
existing co-scientist retrieval (ADR 0010) works over the user's own reading with
zero new retrieval code. Every graph/time-travel/search feature is then a *read
model* over Visits + Edges, not a new subsystem.

Guiding rule: **reuse, don't fork.** Snapshots reuse the archive vector-store
pattern; retrieval reuses KB; the graph reuses the tracker renderer; workspace
reconstruction reuses `SnapshotStore`; per-page chat reuses `chat_stream`.

### Data model (`crate::trace`)

```
Visit {
  id: VisitId,
  url, title,
  first_ms, last_ms, dwell_ms, visits,          // engagement, not just a click
  why: Provenance,                              // where this came from + intent
  snapshot_id: Option<u64>,                     // -> archive entry (content + embedding)
  chat_id: Option<ChatId>,                      // the Gemma conversation attached here
  marks: Vec<Mark>,                             // highlights / notes / drafts
  entities: Vec<Entity>,                        // concepts, authors, DOIs, repos (later phase)
}

Provenance {
  from_visit: Option<VisitId>,                  // the visit we navigated from (the free nav edge)
  referrer: Option<String>,
  query: Option<String>,                        // the search/omnibox text that led here
  task: Option<String>,                         // the active goal/workspace label, if any
}

Edge { from: VisitId, to: VisitId, kind: EdgeKind }
EdgeKind = Nav | Semantic | Cites | Implements | Same   // Nav is free; the rest are derived

Mark { kind: Highlight | Note | Draft, text, anchor: String, ms }   // anchor = CSS/text-quote selector
Entity { kind: Concept|Author|Dataset|Doi|Repo, value, ms }

VisitStore = persisted JSON at <app_data>/trace/trace.json (Visits + Edges),
             heavy snapshots live in the archive store (its own file + budget).
```

- **Navigation edges are free**: on nav-commit, `from_visit` = the tab's previous
  committed Visit → one `Nav` edge, no computation. This alone yields the
  research tree.
- **Semantic edges are lazy**: top-k cosine neighbours over the visit's snapshot
  embedding (reusing `embedding.rs`), computed on idle, thresholded, capped per
  node. `Cites`/`Implements`/`Same` come from link/DOI/repo detection on the
  captured DOM (later phase).
- Visits register with the KB as `source:"web"` (doc_id = VisitId, path = url),
  so `kb_query`/`kb_answer`/Notebook retrieve and **cite** browsing immediately.

### Capture — lazy, batched, idle-scheduled (perf is a first-class constraint)

Per ADR 0001's budgets and Flux's perf-maximizer bar, "always extracting" cannot
make the browser feel slow. Two-tier capture:

1. **On nav-commit (cheap, synchronous-ish):** upsert the Visit — url, title,
   `why` (from the committing nav + omnibox query + active workspace), the `Nav`
   edge. Tiny; this is just structured history.
2. **On dwell (deferred, idle):** only after the page is *engaged* (visible +
   dwell > threshold, e.g. 8 s) do we take the content snapshot (reuse the
   existing `DomSnapshot` capture), enqueue the embed (reuse the archive embed
   queue), and run entity extraction. Bounced/immediately-closed pages never pay
   the cost. Embedding runs on the existing blocking pool, batched.

Metadata (Visits + Edges) is kept effectively forever (tiny). **Content
snapshots are the storage cost** and are budgeted: an LRU/age cap (N snapshots or
M MB, per ADR 0001) evicts the heavy HTML while the lightweight Visit survives —
so the graph and provenance stay complete even after content is aged out.

### Privacy — designed in, not bolted on (this is the highest-risk data in Flux)

The spine records what you read, and optionally *what you typed*. For a
privacy-purist browser this is the most sensitive store we would ever keep, so
the rules are part of the decision, not an afterthought:

- **Private windows are never recorded** — no Visit, no snapshot, no edge.
- **Draft capture (half-typed form text) is OFF by default.** When enabled it is
  redacted *before* persistence: never capture `input[type=password]`, fields
  with `autocomplete` in the cc/one-time-code family, `[data-sensitive]`, or
  *any* field on a form the vault recognises as a login (`vault_page_matches`).
  Half-typed passwords/card numbers must be structurally impossible to store.
- **Per-site + domain controls**: a "don't remember this site" toggle and a
  built-in denylist seed (banking/health) that suppress capture entirely.
- **At rest**: reuse the vault's encryption precedent for the trace store, or at
  minimum ship `trace_forget(scope)` (this page / this site / this time range)
  and a global purge before the feature is user-visible.
- **Never a network source.** The spine is local-only; it is never uploaded,
  synced, or exposed to a page. (Sync, if ever, is a separate ADR.)

### Read models (the features, as queries over the spine)

- **The Trail (graph + timeline)** — render Visits+Edges via the tracker graph
  viz; the research tree, branch revisit/compare, "rabbit hole" detection, and
  stale-branch auto-archive are filters/clusters over this.
- **Time-travel / scrub** — a slider over `first_ms..now`; "restore workspace at
  T" reconstructs the tab set from Visits (+ `SnapshotStore`) and re-opens
  **stored snapshots** (not a refetch — the live page may have changed or gone).
  v1: tab set + scroll; drafts later.
- **Per-page chat** — `chat_id` binds a `chat_stream` conversation to the Visit;
  it persists and re-attaches when you return months later.
- **Context/semantic search** — `kb_query` over `source:"web"` already answers
  "the CUDA-error page," "the diffusion paper"; provenance makes "the page I
  found *from* that repo" a graph walk.
- **Ambient** (later) — watchers over `entities`/edges surface "newer version
  exists," "you solved this error before" — gated hard on precision.

### Commands (sketch, specta-typed like the rest)

- `trace_record(...)` — internal, on nav-commit (not page-callable).
- `trace_visit(id) -> Visit` · `trace_recent(range) -> [VisitMeta]`
- `trace_graph(range?, filter?) -> TraceGraph` (Visits + Edges for the viz)
- `trace_scrub(ms) -> Workspace` (reconstructed tab set at time T)
- `trace_mark_add(visit, mark)` · `trace_chat(visit) -> ChatId`
- `trace_forget(scope)` · registers `"web"` with `kb_status`/`kb_query`.

### Surface

A **Trail view** (`flux://trail`): a timeline scrubber above the tracker-style
research graph; click a node → its snapshot, marks, and attached chat. Reuses the
Notebook's citation-chip pattern (ADR 0010) and the tracker graph renderer.

## Consequences

- **Positive:** one spine makes graph, time-travel, per-page chat, and context
  search *compose* instead of fragmenting; browsing becomes a cited co-scientist
  corpus for free (reuses KB); heavy pieces (snapshots, graph viz, session
  restore, embeddings, chat) are all existing code. This is the concrete path
  from "browser" to "Research OS."
- **Negative:** it is the most privacy-sensitive store in Flux — the redaction/
  encryption/forget rules are a hard prerequisite, not optional. Content
  snapshots carry a real storage budget (metadata is cheap; HTML is not).
  Continuous background embed/extract has a CPU cost that *must* stay lazy and
  idle-scheduled or it violates the perf bar.
- **Neutral:** partially supersedes flat History — History can become a thin view
  over Visits, or coexist. Semantic-edge quality tracks the embed model (ADR 0010's
  caveat); the hash fallback still yields navigation edges + the graph.

## Scope

Vertical slice, end-to-end, before any of the higher layers:

1. **`crate::trace`**: Visit + Nav-edge capture on nav-commit; dwell-triggered
   snapshot + embed; JSON store; **private-window exclusion + `trace_forget`**
   from day one.
2. **Feed KB as `source:"web"`** — prove `kb_query`/Notebook retrieve+cite browsing.
3. **Trail view v1**: timeline + graph (tracker renderer) + click-to-snapshot.
4. **Per-page chat** bound to the Visit.

Then, in order: semantic edges → time-travel scrub → entity/citation extraction
(paper↔code↔dataset) → ambient watchers. Draft capture is a **later, opt-in**
phase gated on the redaction rules above — not in the slice.

## Resolved decisions

- **Encryption (was Q1) — RESOLVED: forget/purge in the slice; encrypt the trace
  store when draft capture ships.** The slice records only URL/title/nav-edges —
  the *same* sensitivity class as the existing plaintext `history.json`, and
  content snapshots reuse the (also plaintext today) archive store. Encrypting
  only the trace store now would be inconsistent with those and adds friction
  before the genuinely sensitive data (typed drafts) even exists. So: ship
  `trace_forget(scope)` + a global purge from day one; introduce encryption in
  the draft-capture phase, and revisit encrypting `history`/`archive` at rest
  then too (one consistent decision, not a one-off).
- **History coexistence (was Q3) — RESOLVED: coexist; do NOT touch History in the
  slice.** Visits are the richer superset, but `HistoryStore` powers omnibox
  suggestions, frecency, and the sync push (#62) and all work — replacing it is
  pure risk. Both stores write on nav-commit from `dom_publish` (both cheap).
  Collapsing History into a thin view over Visits is a *later* follow-up, out of
  the slice.

## Open questions (still to settle, not slice-blocking)

- **Storage budget numbers** for snapshots (count vs MB; eviction age) — settle
  with the dwell-snapshot phase (step 1's second tier), not the nav-capture step.
- **Dwell threshold** and whether it adapts (papers vs quick lookups).
