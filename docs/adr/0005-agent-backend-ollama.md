# ADR 0005 — Flux Agent Backend: Ollama over Embedded llama.cpp

| | |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-06-14 |
| **Deciders** | Flux Core Team |
| **Relates to** | ADR 0001 (which assumed in-process llama.cpp / GGUF), BACKLOG #1/#64 |

## Context

The Flux Agent needs a local LLM to turn a natural-language request + the page
DOM into a structured `AgentAction`. ADR 0001 assumed embedding **llama.cpp**
(`llama-cpp-2`) and loading a GGUF directly. In practice that means: an FFI
build dependency, CUDA/Metal toolchain coupling, GGUF path/quant management,
and code that can only compile on a machine set up for it — none of which is
verifiable in our dev environment.

The user already runs **Ollama** with the Gemma models pulled
(`gemma4:12b-it-qat`, `e4b`, `e2b`).

## Decision

Default the agent to an **Ollama HTTP backend** (`flux_agent::OllamaBackend`):
a blocking `ureq` client (http + json only — Ollama is localhost) POSTing to
`/api/generate` with `format: "json"`, `temperature: 0.1`. The `Inference`
trait is unchanged, so the planner → compile → inject pipeline is untouched;
only the brain swaps.

- **Model:** `FLUX_MODEL` env, default `gemma4:12b-it-qat`. **Endpoint:**
  `FLUX_OLLAMA_URL`, default `http://localhost:11434`.
- **Backend selection** (`flux-core::agent_bridge`): default Ollama;
  `FLUX_AGENT_BACKEND=mock` for the deterministic dev/CI backend;
  `=llama` (with the `llama` feature) keeps the in-process path alive.

### Why

- **Uses what's installed.** No bundling, no GGUF wrangling — Ollama owns model
  loading and GPU offload.
- **Verifiable + portable.** Pure Rust HTTP; compiles and unit-tests anywhere
  (the FFI path could not). Works identically on Windows/macOS/Linux.
- **Structured output for free.** Ollama's `format` constrains the model to
  valid JSON, which the planner parses into `AgentAction` (with the policy
  gate + injection-safe JS compiler still doing the security work).
- **Reversible.** `llama-cpp-2` stays behind the `llama` feature for users who
  want a single self-contained binary later.

## Consequences

- **Positive:** simplest path to a working agent on the user's machine; the
  whole pipeline is now testable; model is a one-env-var switch (12B for
  quality, E4B/E2B for speed).
- **Negative:** requires a running Ollama server (a dependency outside Flux).
  A failed request surfaces in the agent feed; a bundled fallback is future
  work.
- **Neutral:** the GBNF `ACTION_GRAMMAR` is now only used by the `llama` path;
  Ollama uses `format: "json"` + an explicit prompt instead.
