# 0016 — Letting the agent write to your notes

Status: **accepted — shipped 2026-08-02**
Date: 2026-08-02
Relates to: [0005](0005-agent-backend-ollama.md) (the local agent),
[0010](0010-knowledge-base-second-brain.md) (the KB / Onyx vault),
[0013](0013-ai-security-sentinel.md) (agent threat model, confused deputy),
[0014](0014-scribe-handwritten-notebooks.md) (Scribe).

## Context

Gemma could already *read* the user's corpus — Onyx notes, Scribe pages, papers,
browsing. Writing was the obvious next capability and the first where the model
changes **the user's own files** rather than a web page.

ADR 0013 establishes the threat model: the agent is a privileged confused deputy,
and page-derived context reaches it constantly (the KB indexes visited pages; the
Trail stores them; `/note` deliberately passes the current page as context). So
"could a prompt injection make it do this?" is not hypothetical here — it is the
default assumption.

The existing `AgentAction` vocabulary was the wrong vehicle. It is page
automation compiled to injected JavaScript. Sharing an enum would mean one policy
check guarding two entirely different blast radii: a bad click versus a rewritten
notebook.

## Decision

**A separate, closed vocabulary that cannot express a destructive edit.**

```rust
enum NoteAction {
    NewNote { title, body, folder, tags },   // new Onyx note
    AppendNote { path, body },               // add to an existing one
    NewPage { notebook, title, body },       // new Scribe page
    AppendPage { notebook, page, body },     // add to an existing one
    Nothing { reason },
}
```

There is no variant that replaces, rewrites, reorders or deletes. This is the
load-bearing decision, and it is *structural rather than procedural*: a model
that decides the user's notes would read better rewritten has no way to say so,
and an injection buried in a page cannot reach for a capability that does not
exist. Appending is the most destructive expressible operation, and appending
cannot lose text. A test fails if the vocabulary ever gains `delete`, `replace`,
`rewrite`, `overwrite`, `remove` or `edit`.

**Planning and applying are two commands with nothing joining them.**
`note_plan` produces a proposal; `note_apply` writes one. No backend path
connects them. The user's approval is therefore a **missing edge in the call
graph**, not a policy someone has to remember to check.

**The user approves content, not a description of it.** The confirmation card
shows the exact text that will be written. A card reading "adds a summary" while
writing something else would be worthless.

**Generated paths are validated, not trusted.** The model is *told* which notes
exist, but being told is not a control. An `append_note` path is canonicalized
and required to resolve inside the vault and to already exist — otherwise
`../../.bashrc` is a working instruction. Both sides are canonicalized before
comparison, because comparing strings first is how traversal guards fail.
Appends use `OpenOptions::append`, so no code path here can truncate a note even
mid-failure.

**Detection of intent is generous; execution is not.** Requests are recognised in
plain language, not only behind `/note`. This looks like a loosening and isn't:
the approval card is what protects the notes, and planning never writes, so a
false positive costs one click on Discard while a false negative costs the
feature. What detection must *not* do is fire on questions **about** notes, which
are far commoner than requests to add to them.

## Consequences

- Adding a variant to `NoteAction` widens what a bad generation can do to data
  the user cannot easily reconstruct. It is not a routine change.
- Scribe appends only target document pages. An ink page's content is a stroke
  array and there is no honest way to add typed text to one, so it refuses rather
  than converting handwriting into something else.
- The agent cannot correct its own earlier writing — it can only append a
  correction. That is the intended trade.
- `plan_note`'s prompt quality is unverified against real model output; the
  schema constrains the *shape* of what comes back, not how well it chooses.
