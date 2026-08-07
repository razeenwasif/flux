# ADR 0018 — Opt-in cloud escalation for the agent (Gemini)

| | |
|---|---|
| **Status** | Accepted — shipped |
| **Date** | 2026-08-07 |
| **Deciders** | Flux Core Team |
| **Relates to** | [0005](0005-agent-backend-ollama.md) (the local agent backend, which this amends), [0013](0013-ai-security-sentinel.md) (the local agent as a *privacy* primitive), BACKLOG #175 |

## Context

Flux's agent is local: Gemma on the user's own GPU via Ollama (ADR 0005). That
is the product's central claim, and ADR 0013 leans on it directly — content-aware
security is defensible precisely because the reasoning never leaves the machine.

But a 12–26B model in a 4k–16k context window has a hard ceiling, and we have
been hitting it. A run of failures over the past weeks — `output truncated at the
token cap`, `no room to grow`, the `num_ctx` clamping and its retry ladder — were
all the same underlying problem: the job was bigger than the window. The
per-document summarise loop (#159) bought headroom by shrinking each unit of
work, but "summarise this folder of lecture PDFs" and long reasoning chains
remain out of reach for the local model.

A frontier model would do these jobs today. The cost is that the agent's prompts
carry **page DOM text, PDF contents, vault notes and terminal output** — so
routing them off-device is a disclosure, not a configuration change.

## Decision

Add **one** cloud backend (Gemini, via the Google AI Studio API) behind a switch
that is designed to be hard to leave on by accident.

`flux_agent::Inference` already abstracted the brain, so the mechanism is a new
`GeminiBackend` plus a `RoutingBackend` that holds local and cloud side by side.
The rules that make this acceptable are in `flux_agent::route`:

1. **Local is the default and the fallback.** Cloud is used only when it is both
   switched on *and* configured. No key, key removed, backend failed to build —
   all run locally. Nothing in the router can fail *toward* the network.
2. **The switch does not persist.** It lives in an atomic, never on disk, so
   every launch starts local. A toggle flipped last week for one folder of PDFs
   must not silently be shipping this week's browsing.
3. **Clearing the key revokes the request.** Removing the backend also drops the
   flag, so entering a key later can't silently resume an old escalation.
4. **The switch verifies before it flips.** Turning it on costs one round trip to
   confirm the key works. That buys the difference between "the toggle refused,
   and nothing was sent" and a switch that reads *cloud*, a question that then
   errors, and no way to tell whether the prompt left the machine before it
   failed. For a control whose job is to be trustworthy about egress, that
   ambiguity is the thing worth a round trip to avoid.
5. **The UI shows what is true, not what was asked.** The agent header reads
   `· local` or `☁ … · cloud`, derived from the route the backend reports.
   The word carries the meaning, so it survives a screenshot and colour blindness.
6. **The key lives in the OS keyring**, never in localStorage, and is never read
   back into the renderer — the handling already established for ElevenLabs.

This is the second cloud exception in Flux, and it is deliberately larger than
the first. ElevenLabs (ADR-less, in `tts.rs`) sends *reply text only* — output
the user has already seen. This sends **input**, and potentially all of it. The
asymmetry is why escalation is per-session while the TTS engine choice is a
persisted setting.

### Schema translation

Ollama is handed JSON Schema directly and grammar-constrains generation with it.
Gemini's `responseSchema` is an OpenAPI subset that does not accept several
constructs Flux's schemas use, so `gemini::to_gemini_schema` translates:

| Flux (JSON Schema) | Gemini |
|---|---|
| `oneOf` | `anyOf` |
| `const: "x"` | `type: STRING, enum: ["x"]` |
| `type: ["string","null"]` | `type: STRING, nullable: true` |
| `additionalProperties: false` | *dropped* |
| `type: "string"` | `type: "STRING"` (proto enum name) |

`maxLength` is the important one: under Ollama it is a **hard** stop in the
grammar, and `NOTE_BODY_MAX` exists because an unbounded note body once consumed
a whole generation budget and produced nothing. Gemini may treat it as advisory,
so `clamp_to_schema` re-imposes it on the reply rather than trusting the wire.
A test asserts the *real* schemas translate cleanly, so a construct added
upstream fails here rather than as a 400 in front of a user.

## Consequences

**Good**
- The jobs that motivated this become possible: a ~1M-token window removes the
  entire class of context-window failures for the escalated session.
- The seam is small and reversible — one module, one match arm; the planner,
  playbooks, trust boundary and compile pipeline are untouched.
- Model names are *asked for* (`/models`), not hardcoded, so a new Gemini line-up
  doesn't need a Flux release.

**Bad / accepted**
- Flux now contains a path that sends user content to a third party. It is
  off, session-scoped and visible — but it exists, and that is a real change to
  the product's story.
- Free-tier API traffic is typically used for product improvement; paid tiers
  typically aren't. Flux cannot enforce which tier a key belongs to, so the
  Settings copy tells the user to check.
- Gemini applies safety filters. A page that trips one returns a *successful*
  response with no text, so `extract_text` reports the block explicitly rather
  than looking like the model had nothing to say. The local model has no such
  filter, which is now a behavioural difference between the two paths.
- `flux-agent` gains TLS (`ureq` `tls` feature). Previously it was http-only on
  the stated grounds that Ollama is localhost.

**Follow-on**
- This ADR is what motivated **agent file-access roots** (#176). "The agent can
  read anything this process can" was a defensible default while every byte
  stayed on the machine; it is a different sentence once a read can be forwarded
  to Google. The allowance is opt-in and lives in `fsroots.rs`, gating the
  agent's own list/read/write/PDF commands while leaving the Files tab and the
  PDF viewer — the user opening their own files — untouched.

**Explicitly not decided**
- No other providers. The `Inference` trait would take an OpenAI or Anthropic
  backend in the same shape, but each one is another disclosure surface, and
  "which cloud" is a decision to make once per provider, not a plugin point.
- No automatic escalation. Routing on prompt size or on a local failure was
  considered and rejected: it would make the disclosure a side effect of a
  heuristic rather than a choice.
