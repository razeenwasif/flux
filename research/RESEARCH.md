# Flux Optimization Research — Strategies from 40 Papers

A synthesis of 40 academic papers on **web-application optimization** and **compiler
optimization**, distilled into concrete techniques Flux can use to become the fastest,
lowest-RAM, most capable browser.

- **Corpus:** 40 arXiv papers (~79 MB of PDFs) downloaded into `research/papers/`.
  The PDFs are gitignored; `curated.json` holds id/title/topic/summary for each and is
  enough to re-fetch any of them from arXiv.
- **Method:** every PDF was read (abstract, intro, method, results) and each technique
  was scored for direct applicability to Flux's architecture: Rust + Tauri v2 core,
  native OS webviews (WebView2 on Windows, WebKitGTK on Linux), a SolidJS chrome, a local
  LLM agent (Ollama/Gemma), built-in terminal, content-blocking shields, tab hibernation,
  workspaces, web panels, per-site zoom.

A key framing fact shapes everything below: **Flux does not own a JS/Wasm engine.** We
embed the OS webview's engine (V8 / JavaScriptCore), so we cannot patch register
allocation, the JIT, or GC. The compiler papers therefore matter in three ways: (a) as
*config levers* on the embedded engine, (b) as *patterns for our own Rust hot paths*, and
(c) as *patterns for the local LLM agent*. The web-app/network/energy papers are where the
most directly shippable browser wins live.

---

## 1. Top priorities — highest ROI, directly shippable

These map a strong paper result onto a feature Flux already has or can add cheaply.

| # | Strategy | Source | Flux opportunity | Effort |
|---|----------|--------|------------------|--------|
| 1 | **Two-tier (hot/cold) filter lists** | 1810.09160 | ~90% of EasyList rules never fire. Split shields into a small synchronous "hot" set (rules observed to match) + an async "cold" long-tail checked off the request critical path; promote cold→hot on first match. ~62% lower per-request cost, >99% coverage. | Med |
| 2 | **Per-site dead-JS stripping** | 2106.08948, 2308.16729, 1803.01683 | 70% of functions on the median page are never called. Offer an optional "lean mode" that, via the webview DevTools protocol, trims/lazy-loads unused JS → ~60% smaller JS, ~30% faster load on low-end machines. Use screenshot-diff as the correctness oracle. | High |
| 3 | **HTTP/3 + QUIC + 0-RTT, fewer connections** | 2102.12358, 2306.11643 | Ensure webviews negotiate H3; prefer **DoQ over DoH** with connection coalescing + 0-RTT to erase the encrypted-DNS latency tax (DoH adds >30% desktop / >50% mobile load time; coalescing recovers 1/3–1/2). Shields cutting third-party domains compound the win. | Low–Med |
| 4 | **Confidence-gated predictive prefetch** | 1906.00877, 1505.03899, 2602.04100 | Model next-navigation / next-resource as a **per-origin Markov chain with LFU-decayed counts**; preconnect/prefetch only transitions above a probability threshold, scaling depth by how often a link is actually followed, and **back off under RAM/bandwidth pressure**. Avoids prefetch waste. | Med |
| 5 | **Accessibility-tree-first agent + safety guards** | 2511.19477 | Blueprint for Flux's AI agent: use the webview **accessibility tree** (cheap, low-token) as the primary page representation instead of screenshots; add **versioned element refs** (`snapshot_ver:elem_ref`) to fail safe on stale DOM; enforce **destructive-action guards in the Rust layer** (block clicks on "delete"/"refund"); batch actions to cut LLM round-trips. ~85% task success vs ~50% prior. | Med |
| 6 | **Speculative decoding for the local agent** | 2203.16487, 2510.10302 | Draft-then-verify gives ~5× lossless LLM speedup. Pair a tiny draft model with Gemma (llama.cpp/Ollama support it) — trade a little RAM for big latency cuts on CPU/low-end GPU. Relaxed top-β acceptance accepts more drafts. | Low |
| 7 | **TTL/LRU caching of expensive recomputes** | 2602.06074, 2104.15098 | In-memory TTL cache yields 90–95% response-time cuts on repeats. In the Rust core, cache compiled filter-rule sets, favicon/metadata, per-site settings, and repeated local-LLM prompt results; persist the durable ones to disk so they survive restart. | Low |
| 8 | **Default dark theme + content blocking as energy features** | 2205.11399, 2304.01646 | Content blocking measurably cuts CPU/network **energy**, not just bytes (biggest win on page-load-heavy sites; smaller on video). A true dark theme is an OLED energy win. Aggressive background-tab hibernation/throttling is CPU-scheduling savings. Frame these as battery features. | Low |

---

## 2. Theme: Content blocking & network (the biggest browser wins)

- **Crowdsourced filter bloat (1810.09160).** EasyList is ~90% dead weight; only ~10% of
  rules ever match, ~5% per day. **Action:** hot/cold tiering (priority #1). This is the
  single most directly applicable result in the corpus given Flux's shields.
- **HTTP/3 adoption & performance (2102.12358).** H3 helps most under high latency / low
  bandwidth, and only when sites consolidate onto few connections/domains. **Action:**
  prefer H3 on poor networks; our shields (fewer third-party domains) amplify it.
- **QUIC + encrypted DNS cross-layer (2306.11643).** Encrypted DNS is slow unless you
  **coalesce DoQ name resolution and H3 content onto one QUIC connection** and use 0-RTT.
  Caveat: largely governed by the underlying engine — Chromium/WebView2 supports H3/QUIC,
  WebKitGTK is weaker, so this lands first on the Windows build.
- **Server-side TTL caching (2602.06074).** Principle transfers to our client core: cache
  expensive recomputes behind TTL/LRU (priority #7).
- **Just-in-time networking (2109.03032).** Wireless TDMA, mostly tangential; only the
  "produce/prefetch data just before it's needed, not too early" principle carries over.

## 3. Theme: JavaScript dead-code & page-load reduction

- **Muzeel (2106.08948)** — dynamic per-function logging + bot-triggered event firing
  (BFS event-dependency graph) removes unused functions: ~60% smaller JS, ~30% faster on
  low-end devices. Implementable against the webviews' DevTools/CDP protocols.
- **Lacuna (2308.16729)** — static+dynamic call graph, reachability-from-root, **four
  elimination levels** (no-op / lazy-load-on-first-call / empty-body / full removal). The
  lazy-load level is a model for deferring rarely-used scripts on background/hibernated tabs.
- **Evolvability of page-load time (1803.01683)** — mutate-and-test deletion of executed
  JS guided by DevTools traces (time / event-count / event-chain-depth), screenshot-diff as
  oracle: 41% / 30% / 26% reductions. **Action:** surface those three metrics per-site as a
  perf signal and let the local agent suggest deferring/blocking redundant scripts.
- Combined **Action:** an optional "lean mode" (priority #2) built on the webview CDP, with
  conservative empty-body/lazy-load defaults and a screenshot-diff safety check.

## 4. Theme: Prefetching (predict what's needed next)

Four prefetcher papers (1505.03899 2D selection, 1906.00877 Pangloss Markov, 2602.04100
SPPAM, plus MoE prefetch 2510.10302) are hardware/microarchitecture, but converge on
software-transferable principles:

- **Predict from history:** per-context Markov chains over transitions (Pangloss), with
  per-page/per-origin tracking so interleaved tabs don't pollute predictions.
- **Adapt the degree:** prefetch most aggressively for common + high-latency targets, least
  for rare ones (2D selection: depths 1/4/8).
- **Throttle by usefulness & resources:** confidence-gate every speculative fetch and back
  off under bandwidth/RAM pressure (SPPAM's three throttles) to avoid cache pollution.
- **Action:** priority #4 — a confidence-gated predictive preconnect/prefetch for likely
  next navigations, off by default under memory pressure (ties into the resource governor).

## 5. Theme: The local LLM agent

- **Speculative decoding (2203.16487)** — draft-then-verify, Capability + Latency
  principles (accurate drafter, deep-encoder/shallow-decoder), relaxed top-β acceptance.
  ~5× lossless. **Action:** enable Ollama/llama.cpp speculative decoding (priority #6).
- **SP-MoE (2510.10302)** — only if Flux ever runs an **MoE** model: cutoff-bounded async
  expert prefetch + LRU expert cache keeps an offloaded model responsive without exhausting
  RAM. Dense Gemma doesn't benefit, but the offload architecture generalizes.
- **Browser agents (2511.19477)** — architecture > model scale: a11y-tree-first context,
  versioned element refs, Rust-layer destructive-action guards, batched tool calls,
  compressed history. **Action:** priority #5 — the agent blueprint. The paper also stresses
  **prompt injection is unsolved** → keep programmatic guards, don't trust LLM judgment.
- **Quantization (2210.15016)** — INT8/INT4 post-training quantization (with per-stage
  cosine-similarity checks) to cut Gemma's RAM/latency; central to the low-RAM goal.
- **DCE-LLM (2506.11076) / LPO (2508.16125) / 2501.00655** — all teach the same agent
  pattern: **cheap pre-filter → expensive LLM → formal/programmatic verification with
  counterexample feedback**. Apply to any agent action that must be validated before it
  runs (automation, config edits). 2501.00655's LLM-mutation + differential-testing harness
  could even hunt size/perf regressions in our own Rust binary across toolchain versions.

## 6. Theme: Rendering & UI (the SolidJS chrome)

- **Million.js (2202.08409)** — compiler-augmented vDOM: static-subtree skipping, **static
  hoisting** out of render, keyed LCS diffing, **scheduling/batching behind input priority**
  (`isInputPending`) to hold 60 FPS. SolidJS already kills the vDOM, but the principles
  apply directly: hoist static chrome out of reactive scopes, batch low-priority chrome
  updates (tab strip, panels) behind user interaction, keep keyed lists (tabs, history) on
  **stable `tab.id` keys** — reinforces the existing memory note on keying tab views.
- **City-on-Web (2312.16457)** — neural rendering, mostly tangential; the transferable
  mental model is **load/unload-by-viewport + level-of-detail**, which mirrors tab
  hibernation: keep what the user looks at fully resident, downgrade the rest.

## 7. Theme: Memory management & the Rust core

- **GCList concurrent sets (1806.00834)** — object **Pool / free-list** reuse + stamped
  pointers to avoid ABA. **Action:** for hot, frequently-rebuilt shared structures (tab
  registry, blocker rule sets, agent task queues) use object pools + epoch-based reclamation
  (`crossbeam`/`arc-swap`) to cut allocator churn and keep RAM steady.
- **Bronze GC for Rust (2110.01098)** — optional `GcRef<T>` cuts dev time ~3× on
  heavily-aliased code. **Action:** consider it only for non-hot, heavily-aliased subsystems
  (agent graph/DOM-like state) as a dev-velocity lever; keep it off low-RAM hot paths.
- **VGC zone-based GC (2512.23768)** — conceptual: **access-frequency zoning** (hot/warm/
  cold) loosely mirrors hot/cold tab hibernation; could inform an eviction heuristic. No
  shippable implementation (Rust has no GC; webview JS GC is out-of-process).
- **Register allocation as caching (1202.5539, 1409.7628, 2011.05608)** — not engine-
  patchable, but two ideas transfer: (a) **Belady / NEXT-USE eviction** — rank hibernation
  candidates by *predicted next focus* (recency + Markov prediction), not plain LRU;
  (b) **rematerialization** — discard a hibernated tab's cached render and recompute on
  reactivation when RAM is tighter than recompute cost; (c) **skip expensive bookkeeping
  when the common case is trivial** (2011.05608's "90% of live ranges are trivial").

## 8. Theme: WebAssembly (relevant if Flux ships/runs Wasm components)

- **Runtimes survey (2404.12621)** — interpreter vs JIT vs AoT trade-offs; **cache compiled
  Wasm modules across sessions** to cut repeat JIT cost/RAM. Menu for a sandboxed-plugin
  runtime: WAMR/wasm3 (interpreter), wasmtime/wasmer (JIT/AoT).
- **SQL→Wasm on V8 (2104.15098)** — **lean on the embedded engine's tiered JIT + code
  cache** rather than building your own; generate type-specialized inlined code; "rewiring"
  maps host data into linear memory without copying. Good pattern for compiling hot
  terminal/agent logic to Wasm and letting WebView2/WebKit JIT it.
- **Lacking compiler protection (2111.01421)** — C→Wasm **silently drops stack canaries**
  (24% of overflow programs diverge). **Action:** treat ported-C Wasm as untrusted; don't
  assume source-language memory protections carry over.
- **Reusing legacy code (2412.20258)** — concrete Emscripten build pitfalls (undefined
  symbols/SSP, exception-catching, 64KB stack, `ALLOW_MEMORY_GROWTH`, `-Oz` for size +
  shallower recursion). Reference if we ever bundle C/C++-derived Wasm.
- **WAMI (2506.16048)** — for Wasm targets, **Binaryen** peephole/coalescing matters more
  than classic register/scheduling passes. Niche.

## 9. Theme: Compiler optimization patterns (mostly indirect)

These are not engine-patchable, but seed two things: agent-tooling design and our own build.

- **Equality saturation (2101.01332 TENSAT, 2111.13040 sketch-guided, 2505.09363 eqsat)** —
  e-graphs apply all rewrites at once, dodging phase-ordering; the Rust **`egg`** library is
  reusable. Possible use: collapse/dedupe **content-blocker rule sets** or optimize the
  agent's plan graphs. Sketch-guidance keeps the search tractable.
- **Peephole inference/verification (1611.05980 Alive-Infer, 2407.03685 LeanMLIR,
  2411.09391 Rotor JIT)** — the durable lesson is **generate-then-verify with inferred
  preconditions / counterexample feedback**, the gate pattern for agent-generated code
  (§5). DCE/CSE-as-fold and usage-counter DCE are reference designs for any ahead-of-time
  pass over our agent/automation language.
- **Code-size hunting with LLMs (2501.00655)** — reuse the cheap LLM-mutation +
  differential-testing harness to find size/perf regressions in the Flux binary.
- **TPU-MLIR (2210.15016)** — quantization + **operator/layer fusion to keep working sets
  resident** (avoid DRAM round-trips). Quantization → local LLM; fusion → keep hot working
  sets resident in our data paths.
- **Security-aware JIT (2202.13134)** — timing-side-channel mitigation in JITs; tangential
  (we can't patch the engine JIT), useful only for agent/terminal threat modeling.

---

## 10. Cross-cutting principles distilled

1. **Most work is wasted work — measure, then skip it.** Dead JS (~70% of functions),
   dead filter rules (~90%), trivial live ranges (~90%). The biggest wins come from *not
   doing* work: hot/cold tiering, dead-code stripping, skipping bookkeeping in the common
   case.
2. **Speculate, but gate by confidence and resources.** Prefetch, predictive hibernation,
   and speculative decoding all win — but every speculation needs a confidence threshold and
   a back-off under memory/bandwidth pressure, or it becomes pollution.
3. **Cache the expensive, recomputed thing** (TTL/LRU), and persist what should survive
   restart.
4. **Lean on the embedded engine; don't rebuild it.** Use the OS webview's JIT, code cache,
   H3/QUIC stack, and accessibility tree rather than reimplementing them.
5. **Verify before you act** — the generate-then-verify loop is the safety backbone for the
   LLM agent (and prompt injection is unsolved, so guards live in Rust, not the prompt).
6. **Energy is a first-class metric.** Blocking, dark mode, and hibernation are battery
   features; measure energy per scenario rather than assuming "faster = greener."

## 11. Suggested sequencing for Flux

1. **Now (low effort, high ROI):** hot/cold filter tiering (#1); H3/DoQ/0-RTT + coalescing
   on the Windows build (#3); TTL/LRU recompute cache (#7); speculative decoding for the
   agent (#6); frame dark mode + shields + hibernation as energy features and measure (#8).
2. **Next (medium):** confidence-gated predictive prefetch wired into the resource governor
   (#4); the accessibility-tree agent with versioned refs + Rust-layer destructive guards
   (#5); Belady/Markov-ranked hibernation eviction (§7); SolidJS static-hoist + input-
   priority batching audit (§6).
3. **Later (higher effort / research-y):** per-site dead-JS "lean mode" over the webview CDP
   with screenshot-diff oracle (#2); local-LLM quantization + (if MoE ever) offload prefetch;
   `egg`-based filter-rule dedupe; LLM-mutation differential harness for binary size/perf.

---

*See `curated.json` for the full id → title → topic → summary index of all 40 papers.
PDFs live under `research/papers/` (gitignored; re-fetchable from arXiv).*
