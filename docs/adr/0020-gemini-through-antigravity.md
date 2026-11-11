# ADR 0020 — Gemini through the Antigravity CLI, as a standing choice

| | |
|---|---|
| **Status** | Superseded (2026-11-11): Fairy is now Flux's agent, so Antigravity as a model server was removed along with cloud escalation ([ADR 0018](0018-cloud-escalation.md)) |
| **Date** | 2026-11-07 |
| **Deciders** | Maintainer |
| **Relates to** | [0018](0018-cloud-escalation.md) (cloud escalation, which this amends), [0013](0013-ai-security-sentinel.md) (what stays on device) |

## Context

The maintainer wants Gemini as the agent's model, through the Antigravity
subscription they already sign in to, not an AI Studio key. Antigravity offers no
model API. It ships a CLI, `agy`, that is an agent in its own right: it brings
its own system prompt and the user's global rules (`~/.gemini/GEMINI.md`), has
tools (files, shell, web), and keeps working after it has answered. Measured on
2026-11-04: about 50 s a call left alone; the answer itself after about 6 s of
model time; and Gemini 4 Argon, given a page that said to read `~/.zshrc`, tried
to.

## Decision

**Settings → Model server gains "Gemini (Antigravity)". Chosen, it is the
router's cloud route, on across launches until another server is chosen.**

- **Cloud, not the default model.** The router's default model stays local, so
  what must not leave the machine (form help, which already used it, and now
  Sentinel's checks) keeps doing so. The agent panel reads `☁ … · cloud` the
  whole time, as ADR 0018 requires.
- **Persistent, as an exception to ADR 0018's rule 2.** That rule is against a
  toggle left on by accident. Here the user picks a model server in Settings,
  next to a statement of what it sends, so it's a standing decision. The panel's
  "Back to local" still turns it off for the session.
- **No tools.** `agy` runs in a private folder (`antigravity/` in the app's data,
  `0700`) whose `hooks.json` sends every tool call to `flux --antigravity-gate`.
  That parses the call and allows only `finish`, which is how the CLI returns a
  structured answer (`--json-schema`). It doesn't match on text, because the hook's
  input also carries the prompt, which a page can write.
- **The first answer.** Flux reads the CLI's stream-json events and stops it at
  the first complete answer: the `finish` call's arguments, a reply holding the
  JSON asked for, or for chat the first reply, streamed as it comes.
- **Prompts on stdin** (stream-json), never in the command line, so page text
  doesn't show in the process list.

## Consequences

- **Positive:** Gemini 4 Argon and 3.8 Flash as the agent, with the user's own
  account and no key. Checked natively on 2026-11-07: a `/task` on the smoke page
  with Gemini 3.8 Flash planned three steps from one look by tree ref, asked once
  for the commit, sent the message once and finished, in two model calls.
- **Negative:** slow, about 25–35 s per model call, almost all of it the CLI.
  Every prompt carries the CLI's own instructions (thousands of tokens) and the
  user's global Antigravity rules, which can colour answers; there's no switch for
  either. The Antigravity terms, not an API's, govern this use.
- **If the CLI changes** its event stream, hook format or flags, this breaks
  loudly: the agent reports that `agy` stopped without an answer.
