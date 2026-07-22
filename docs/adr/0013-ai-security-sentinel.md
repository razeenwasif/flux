# 0013 — Sentinel: a local-agent security layer (phishing guard + hardened agency)

Status: **accepted — M1–M5 shipped**
Date: 2026-07-21 (implemented 2026-07-21)
Relates to: [0005](0005-agent-backend-ollama.md) (the local agent),
[0007](0007-request-interception-and-content-filtering.md) (Shields / tracker graph),
[0008](0008-extension-api-and-security-model.md) (extension trust model),
[0009](0009-password-manager-and-autofill.md) (vault / autofill),
[0011](0011-browsing-provenance-spine.md) (the Trail).

## Context

Flux already has strong **privacy** primitives — Shields (ad/tracker blocking),
the tracker graph, HTTPS-only, per-site permissions, cookie clear-on-close, the
AES-256-GCM vault, sealed trace stores, and private tabs. But its **active-threat**
defenses are blocklist-based: Shields matches EasyList-style rules, which lag
zero-day phishing and scam pages and can't reason about a page's *intent*.

The thing that makes Flux different is a **local agent** (Gemma via Ollama, ADR
0005) that can reason over page content **without any cloud egress** — exactly the
capability content-aware security needs but normally can't have privately. "Does
this page's content match its claimed identity?" is a judgment a blocklist can't
make and a cloud service shouldn't be trusted with.

Cost discipline: an LLM verdict per request/page would be unusable. A cheap,
always-on Rust layer must answer instantly; the model runs only on *suspicion* or
at the *sensitive-input* moment.

### Threat model

**The agent is a privileged confused deputy.** It acts with the user's full
authority — their cookies, vault, open tabs, and its own tools (`agent_run_action`,
`agent_shell_plan`, `agent_pac_plan`, files, terminal). Any manipulation of the
agent is a confused-deputy attack, so **every capability reachable from
page-derived context is the real attack surface.** In scope:

- **Prompt injection, in three flavors — the stored and cross-tab ones are the
  dangerous part, not the reflected one:**
  - *Reflected:* a page tells the live agent to misbehave.
  - *Stored / indirect:* page text is ingested into the **KB / Trail** and re-fed
    to the agent *later* as "your notes/context" — the injection fires out of its
    original context, when the user's guard is down.
  - *Cross-tab exfiltration:* page A manipulates the agent into reading a
    *different* tab (your banking session) and leaking it. The boundary isn't
    "page vs. agent" — it's **per-tab confidentiality within the agent.**
- **Deception — and the best deceptions use *real* domains, so a domain-centric
  model is too narrow:**
  - Lookalike / homograph / typosquat phishing (the classic).
  - **OAuth consent phishing** — a genuine `accounts.google.com` screen granting a
    malicious app broad scopes. No fake domain; the *request* is the attack.
  - **Self-XSS / console-paste scams** ("paste this to unlock") — relevant because
    Flux has a terminal.
  - **Watering-hole / compromised-legit-site** — a site you trust, malicious today
    (why "known-good ≠ safe", below).
- **Malicious page behavior:** clickjacking overlays, clipboard hijack,
  wallet-drainer prompts, tech-support popups, redirect chains.
- **Risky grants + wrong-origin sensitive input:** permission over-grants; handing
  a password / 2FA code / payment / PII to the wrong party (broaden "credentials"
  to **sensitive input**).

**Trust tiers** (the model is *not* monolithic "the page"):
your-navigation (you vetted the URL) > **agent-initiated navigation** (the attacker
chose the URL, you never saw it — strictly *more* dangerous) > third-party
embeds/ads/iframes. Extensions have their own model (ADR 0008).

**Adversary adapts.** Once Sentinel exists, phishers will **cloak** — show the
*agent* benign DOM while the *user* sees a malicious render, or hide text in
images. So Sentinel analyzes **what the user actually sees (rendered), not the DOM
the site chooses to expose**, and treats deterministic signals (homograph, domain
provenance) as the robust floor since content reasoning is the part attackers can
target.

**Out of scope:** malware sandboxing, OS-level exploitation, network MITM beyond
HTTPS-only. Sentinel is about **deception and agent integrity**, not exploitation.

## Decision

A layered subsystem, codename **Sentinel** (`crate::sentinel`, shaped like
`trace`), four pillars, all **local-first** — nothing leaves the device.

Cross-cutting invariants:
- **Fail-safe, never fail-open.** The layer depends on Gemma; if Ollama is down,
  the model is missing, or a *poisoned* model gives soft verdicts, Sentinel
  degrades to **deterministic-only and says so** — it never silently stops
  protecting. Model provenance is pinned (it's a supply-chain dependency).
- **Advisory, never a trap.** LLM verdicts have false positives, so Sentinel warns
  and explains but never hard-blocks the user out of their own choice.
- **Un-spoofable UI.** Warnings live in the **chrome layer**, which — thanks to
  Flux's native-webview-overlay constraint — the page physically cannot draw over.
  And **warning fatigue is a modeled threat**: warn rarely and precisely, make the
  safe path the easy one, or the feature is worse than nothing.

### Pillar 0 — Hardened agency (the prerequisite, ships first)

- **Trust boundary.** Page-derived content is **DATA, never INSTRUCTIONS.** Every
  agent prompt that includes page/DOM/KB text wraps it in a delimited, labeled
  `UNTRUSTED_CONTENT` block; the system prompt states the model must treat it as
  inert and never follow directives inside it. One `sentinel::wrap_untrusted()`
  primitive, used by *all* such prompts (retrofit the existing ones too).
- **Provenance-tag ingested content.** KB/Trail entries carry an "untrusted origin"
  marker so stored injection can be down-weighted or fenced when that content is
  later fed back to the agent.
- **Per-tab confidentiality.** The agent's cross-tab reads are scoped to the tabs
  the user explicitly put in context; page-derived instructions can't widen that
  scope. Cross-tab access is a capability, not a free-for-all.
- **Read ≠ act firewall.** The agent may *read* page content for a verdict, but
  page-derived text MUST NOT reach `agent_run_action` / shell / pac / files
  without explicit, separate user confirmation. Enforced in the agent bridge (a
  capability gate), not by prompt wording alone.
- **Schema-constrained outputs.** Security verdicts return a fixed schema
  (`{verdict, brand, reasons[]}`), validated like the existing
  `validate_reading_structure`; free-form is rejected, so the model can't be
  talked into emitting an action.
- **Action audit log.** Append-only, **sealed (AES-256-GCM, reuse
  `trace::sealed`)**: what action, when, which tab, user-confirmed? A security
  control *and* a trust/debug feature.

### Pillar 1 — Phishing / impersonation guard (the headline)

Two stages, cheap-first, over the **rendered** view.

**"Known-good" is an impersonation-*target* set + a false-positive suppressor —
NOT an allowlist.** "Unknown domain" is a useless signal (almost every domain is
new to you). The signal is **"unknown domain that *resembles* a domain you
value."** Known-good gives (a) the set of brands worth impersonating, and (b)
suppression so Flux never flags *your own* bank. It never means "known = safe"
(watering-hole).

**Known-good sources, tiered by strength:**
1. **Vault origins (strongest).** Domains where you've actually *saved/entered
   credentials* (ADR 0009) — the exact high-value impersonation targets, small and
   user-vetted.
2. **Trail dwell / interaction (broad).** Frequently visited, high-dwell origins,
   weighted by real engagement — *not raw visit count* (so a drive-by lookalike
   never becomes "a brand to protect": poisoning defense falls out of the reframe).
3. **Curated top-brands (cold-start only).** A small seed so a fresh install has
   day-1 protection; the personal set grows in and, being your live behavior,
   **self-maintains** (half-solving the corpus-freshness problem — only the seed
   goes stale).

**Deterministic pre-filter (Rust, always on):**
- **Provenance as a first-class signal (Flux uniquely has this).** Phishing almost
  never arrives by typing or bookmark — it arrives via an **external link / ad /
  redirect chain**. The Trail's Nav/redirect edges (ADR 0011) make "reached a
  lookalike **via an ad/email redirect**" a strong signal. Combine:
  *unexpected referrer + resembles a vault brand + has a credential form* → high
  confidence, far better than resemblance alone. This makes Pillar 1 a **path
  detector**, not just a domain-list check.
- **Resemblance done right:** cluster domains into **brands** (a brand may span
  `chase.com` / `chaseonline.com` / `jpmorgan.com`; the agent can help cluster),
  key on eTLD+1, use **homoglyph-normalized visual confusability** (not raw
  Levenshtein), and only compare a suspect against your **top-N** valued brands.
- Plus: credential field on a young/never-seen domain, cross-origin form action,
  mixed content / cert anomalies.

**Agent verdict (LLM, only on suspicion or sensitive-input focus):**
schema-constrained over the rendered text + title + form fields + domain (as
`UNTRUSTED_CONTENT`) → `{verdict, brand, reasons}`, **memoized per
`(url, content-hash)`** like Shields' decision cache.

**Triggers:** sensitive-input focus (intercept *before* typing), navigation to a
suspicious domain, vault autofill requests, and **OAuth consent screens** (assess
the app + scopes).

**UX:** low confidence → non-blocking banner; high confidence → a cert-warning-style
**interstitial** in the chrome layer: *"This looks like **PayPal**, but the site is
`paypa1-secure.com`, reached via an ad redirect. …"* Always overridable.

### Pillar 2 — Guardrails at sensitive moments

- **Credential-entry firewall.** Vault autofill/save **warns or refuses when the
  requesting origin ≠ the saved origin** (defeats autofill-phish), agent-explained.
- **Context-aware permission prompts.** The agent adds a one-line justification
  assessment to the *existing* permission prompt.
- **Sensitive-site containerization.** The agent offers an isolated container /
  private tab for bank/health/gov logins.

### Pillar 3 — Explainers over existing signals (low-effort early wins)

Read-and-summarize, reusing `reader_structure` + Flux's telemetry:
- **Tracker-graph narrative** (the graph → a sentence).
- **Privacy-policy / ToS red-flags** (the 3 clauses that matter).
- **Dark-pattern / consent decoder** (what "Accept" enables + one-tap real reject).

### Architecture + perf

- `crate::sentinel`: deterministic detectors (Rust) + an agent-verdict bridge
  (`flux-agent`) + a memoized verdict cache + the sealed audit log. Shape mirrors
  `crate::trace` (lazy hydrate, sealed persistence).
- **The model is never on the hot path.** Deterministic answers instantly and
  always; the LLM runs only on suspicion / sensitive-input and *refines* the
  deterministic verdict async — no typing latency, bounded cost.
- **Chrome-JS budget:** UI is thin (banner/interstitial reuse existing styles); all
  logic is Rust + agent, so the eager-JS ceiling (ADR 0001) is unaffected.
- **Privacy:** a verdict never persists page content — only the verdict + redacted
  reasons. Private tabs get detection but leave no Sentinel trace.

## Consequences

- **Positive:** content-aware, **zero-day-capable** detection that stays 100%
  local — a differentiator no cloud-list browser can match privately. Provenance
  makes Pillar 1 sharp in a way only Flux can (it records the path). Hardening the
  agent is overdue given its action powers. Pillar 3 is nearly free.
- **Negative:** LLM verdicts err → Sentinel must stay advisory and tunable; a small
  model (Gemma 2–4B) may be weak at subtle phishing, so it needs an eval set and a
  confidence threshold, with deterministic-only as the floor. Cloaking is an arms
  race; the rendered-view commitment mitigates but doesn't end it.
- **Neutral:** this formalizes a threat model Flux implicitly had; the trust
  boundary + audit log are good hygiene regardless of the fancier pillars.

## Scope / rollout

- **M1 — Pillar 0** ✅ **shipped** (trust-boundary `wrap_untrusted`, provenance-tag
  ingested content, per-tab-confidentiality + read≠act capability gate, schema
  validation, sealed audit log) **+ an injection red-team suite** proving the
  boundary holds. Prerequisite; mostly Rust + prompt plumbing, no user-facing UX.
  (Audit-log viewer UI is a follow-on.)
- **M2 — Pillar 1 deterministic pre-filter + banner** ✅ **shipped** (no LLM yet).
  Catches homographs / typosquats / brand-embedding against the impersonation-target
  set immediately; chrome-layer warning strip.
- **M3 — Pillar 1 agent verdict + OAuth-consent trigger** ✅ **shipped**. The local
  model refines a deterministic flag over the rendered page (escalate / clear,
  memoized, fail-safe); the OAuth decoder surfaces sensitive scope grants on genuine
  consent screens. (A dedicated sensitive-input *focus* intercept — before typing —
  is folded in via the credential-field signal; a keystroke-level trigger needs page
  focus-event plumbing and remains a follow-on.)
- **M4 — Pillar 2 guardrails** ✅ **shipped**: credential-entry firewall (autofill
  refused + no fill chip on an impersonating origin; a login typed into one warns
  instead of offering to save, and a lookalike can't whitewash itself by being
  saved), agent-annotated permission prompts (advisory line only — never decides),
  and sensitive-site containerization (bank/health/gov → offer an isolated jar).
- **M5 — Pillar 3 explainers** ✅ **shipped**: tracker-graph narrative (figures
  computed in Rust, model supplies only the "so what"), privacy-policy / ToS
  red-flags (≤3 clauses, on demand), and the dark-pattern / consent decoder
  (explains what "Accept" enables + one-tap real reject, whose click vocabulary
  is Rust-owned so the model never chooses what is clicked).

**Follow-ons deliberately not in M1–M5:** the sealed audit-log viewer UI, a
keystroke-level sensitive-input focus intercept (needs page focus-event
plumbing), and a live-model behavioural injection eval (needs Ollama in CI).

## Open questions

- **Rendered-view analysis feasibility** — capturing "what the user sees" vs. the
  raw DOM cheaply enough (screenshot + OCR is heavy; a rendered-text extraction may
  suffice). Determines how well cloaking is resisted.
- **Cross-tab isolation mechanism** — how to enforce per-tab confidentiality inside
  the agent bridge concretely (context allowlist per task).
- ~~**Model capability + eval**~~ — **answered** by the opt-in `injection_eval`
  harness (`FLUX_EVAL=1`). Local gemma3 12B scores 100% on injection resistance,
  destructive-action resistance, phishing accuracy (incl. lookalike-but-legitimate
  negatives), and verdict-injection resistance. Smaller models should be re-scored
  before trusting the refinement; deterministic-only remains the fallback, and the
  harness reports a floor rather than asserting perfection.
- **First-visit-to-a-real-new-site** — the case known-good can't cover (no history);
  lean on curated brands + content + cert/domain age + a soft "learning period".
- **Private-tab brands** — sites visited only privately leave no Trail, so they're
  invisible to known-good; how to protect them without breaking the privacy invariant.
