# 0010 — Knowledge Base ("second brain") over the user's own corpora

Status: accepted (vertical slice in progress)
Date: 2026-06-24

## Context

The user wants Flux's local Gemma agent to act as a private, NotebookLM-style
**co-scientist**: ask a question and get an answer *grounded in their own
corpora*, with citations back to the source. The corpora already exist as
separate tools:

- **Onyx** — an Obsidian/Notion-clone vault at `~/OnyxVault/**/*.md` (plain
  markdown + YAML frontmatter, `[[wikilinks]]`, tags). No API; read the files.
- **Scroll** — a TUI read-later/research app; articles + papers in a SQLite DB at
  `~/.local/share/scroll/scroll.db` (`articles.content_markdown`, `ai_summary`,
  FTS5), also a REST API on `localhost:3131`.
- (Later) **Council** debate briefs (`~/.openclaude/council-runs.jsonl`,
  `~/Research/debates/*.md`) and the **council-specialists** fine-tuned GGUF
  models as routable domain voices.

Flux already has the retrieval stack: `flux-embed` (local hashing embedder) +
`crate::embedding` (prefers Ollama `embeddinggemma`, falls back to hashing,
cosine over L2-normalized vectors), the `archive.rs` precedent (a local
embedded vector store persisted as JSON), and the Gemma agent
(`planner().chat_stream`).

## Decision

Build a **native Flux Knowledge Base** rather than (a) routing everything into
the external Omni engine or (b) wiring real MCP servers. Rationale: full control
over per-source namespacing and **citations** (a co-scientist must say *which*
paper a claim came from), works offline, stays fully local, and reuses
`flux-embed`/`embedding` — Flux's agent is a local Gemma with custom planners,
not an MCP tool-loop, so native connectors are far less plumbing than MCP. (Real
MCP — e.g. exposing Scroll, already Rust+Axum, as a server — is a later option.)

### Data model (`crate::kb`)

```
KbChunk { source, doc_id, title, path, ord, text, embedding: Vec<f32>, embedder }
KbDoc   { source, doc_id, title, path, mtime, n_chunks }   // for listing + incremental
KbIndex { embedder, docs, chunks }                          // persisted JSON
```

- `source`: `"onyx" | "scroll" | …`. `doc_id`: stable within a source (Onyx =
  vault-relative path; Scroll = article id). `path`: filesystem path or URL for
  the citation link.
- Persisted to `<app_data>/kb/kb-index.json` (mirrors `archive/archive.json`).
  Embeddings **are** persisted (model embeddings are network calls; don't recompute
  per load), tagged with the embedder; a corpus re-embeds if the embedder changes.
- Chunking: skip YAML frontmatter, merge paragraphs to ~200-word chunks (matches
  Onyx's own RAG chunker), carry the chunk ordinal for citation context.
- Retrieval: brute-force cosine top-k (a few thousand chunks → <10 ms). Good enough
  before any ANN index.

### Connectors

A small `Connector` surface per source that yields `(doc_id, title, path, mtime,
text)` documents. **Incremental**: skip docs whose `mtime` is unchanged.

- **Onyx**: vault from `$FLUX_ONYX_VAULT`, else `~/.config/onyx/config.toml`
  `last_vault`, else `~/OnyxVault`; skips `.onyx/`. The env override matters when
  Flux and the vault live on different OSes — e.g. a **Windows** Flux build indexing
  a vault in **WSL** points `FLUX_ONYX_VAULT` at `\\wsl.localhost\<distro>\home\you\OnyxVault`.
- **Scroll**: over its HTTP API (`$FLUX_SCROLL_URL`, default `localhost:3131`) — no
  SQLite dep, no locking against the live app; the server must be reachable.

A failed source is recorded (`KbSourceStat.error`) and surfaced in the Notebook UI
so a `0 docs` always explains itself (vault missing, server down, …); a full
reindex skips a failed source instead of aborting the others.

### Commands

- `kb_status() -> { sources:[{source,docs,chunks,last_ms}], embedder, indexing }`
- `kb_reindex(source?) -> status` — (re)build a source (or all), incremental.
- `kb_query(query, k, sources?) -> [KbHit{source,doc_id,title,path,snippet,score}]`
- `kb_answer(query, sources?, on_token)` — retrieve top-k, build a grounded prompt
  (numbered sources + "cite as [n]"), stream the reply over a `Channel` as JSON
  events (`{kind:"sources",hits}`, `{kind:"token",text}`, `{kind:"done"}`, like
  `omni_answer`), reusing `planner().chat_stream`.

### Surface

A dedicated **Notebook view** (`flux://notebook`): pick sources, ask, get a
streamed answer with clickable citation chips that open the underlying note/paper.

## Consequences

- **Positive:** private, offline-capable, cited answers over the user's real
  knowledge; reuses existing embedder + store patterns; retrieval is verifiable
  on a box without Ollama (the hash embedder still ranks related chunks).
- **Negative:** answer *quality* needs Ollama + a good embed model (`embeddinggemma`);
  the hash fallback retrieves but less sharply. Brute-force cosine won't scale to
  100k+ chunks — revisit with an ANN index then.
- **Neutral:** Onyx already keeps `nomic-embed-text` vectors in `.onyx/rag-index.json`;
  we re-embed with `embeddinggemma` instead (cosine is only meaningful within one
  embedder, and Flux standardizes on its own).

## Scope

Vertical slice first: **Onyx → embed → kb_query → kb_answer → Notebook view with
citations**, end-to-end. Then the Scroll connector, then Council briefs + the
specialist GGUF models as routable voices.
