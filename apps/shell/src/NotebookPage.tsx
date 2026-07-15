/**
 * Notebook — Gemma as a private NotebookLM / co-scientist (BACKLOG #116, ADR 0010).
 *
 * Ask a question and get an answer grounded in YOUR own corpora (Onyx vault notes
 * today; Scroll papers next), with clickable citations back to each source note.
 * Retrieval + generation are fully local: the knowledge base lives in
 * `<app_data>/kb`, embeddings come from flux-embed/Ollama, and the answer streams
 * from the local Gemma agent. Nothing leaves the machine.
 */
import { For, Show, createSignal, onMount, type Component } from "solid-js";

import { agentChat, fsOpen, kbAnswer, kbRecent, kbReindex, kbSetSource, kbStatus, servicesStart, servicesStatus, type KbHit, type KbStatus, type ServiceStatus } from "./ipc";
import { openTab } from "./store";

const SOURCE_LABEL: Record<string, string> = { onyx: "Onyx vault", scroll: "Scroll papers", council: "Council briefs", web: "Browsing" };
const SOURCE_HINT: Record<string, string> = {
  onyx: "Vault path — e.g. \\\\wsl.localhost\\Ubuntu-24.04\\home\\you\\OnyxVault",
  scroll: "Scroll base URL — e.g. http://localhost:3131",
  council: "Briefs dir — e.g. \\\\wsl.localhost\\Ubuntu-24.04\\home\\you\\Research\\debates",
};

const NotebookPage: Component = () => {
  const [status, setStatus] = createSignal<KbStatus | null>(null);
  const [q, setQ] = createSignal("");
  const [answer, setAnswer] = createSignal("");
  const [hits, setHits] = createSignal<KbHit[]>([]);
  const [voice, setVoice] = createSignal<string | null>(null);
  const [services, setServices] = createSignal<ServiceStatus[]>([]);
  const [busy, setBusy] = createSignal(false); // streaming an answer
  const [reindexing, setReindexing] = createSignal(false);
  const [err, setErr] = createSignal<string | null>(null);
  const [asked, setAsked] = createSignal(false);
  // Per-source location edit buffer (Onyx vault path / Scroll URL).
  const [loc, setLoc] = createSignal<Record<string, string>>({});

  // Weekly research digest (#125) — Gemma reviews what you indexed/clipped/debated
  // this week and writes a private briefing. Cached per ISO week so it's generated
  // on demand, not on every open. Fully local (agentChat → Gemma).
  type Digest = { state: "idle" | "loading" | "ok" | "empty" | "error"; text?: string; error?: string };
  const [digest, setDigest] = createSignal<Digest>({ state: "idle" });
  const DIGEST_KEY = "flux.kb.digest";
  const weekKey = () => {
    const d = new Date();
    const onejan = new Date(d.getFullYear(), 0, 1);
    const week = Math.ceil(((d.getTime() - onejan.getTime()) / 86400000 + onejan.getDay() + 1) / 7);
    return `${d.getFullYear()}-W${week}`;
  };
  const generateDigest = async () => {
    if (digest().state === "loading") return;
    setDigest({ state: "loading" });
    try {
      const items = await kbRecent(7);
      if (!items.length) { setDigest({ state: "empty" }); return; }
      const list = items
        .map((i) => `- [${SOURCE_LABEL[i.source] ?? i.source}] ${i.title}${i.snippet ? ` — ${i.snippet.replace(/\s+/g, " ").trim()}` : ""}`)
        .join("\n");
      const prompt =
        "You are my private research companion. Below is everything I added to my knowledge base this week " +
        "(notes I wrote, papers I clipped, debates I ran). Write a short weekly briefing in Markdown with these sections:\n" +
        "**Threads** — the main topics/themes this week, one line each.\n" +
        "**Connections** — non-obvious links between different items worth noticing.\n" +
        "**Open questions** — what's unresolved or worth following up next.\n" +
        "Reference items by title, be specific, and keep it tight — no preamble or sign-off.\n\nThis week's items:\n" +
        list;
      const reply = await agentChat(prompt);
      const text = reply.trim();
      setDigest({ state: "ok", text });
      localStorage.setItem(DIGEST_KEY, JSON.stringify({ week: weekKey(), text }));
    } catch (e) {
      setDigest({ state: "error", error: String(e) });
    }
  };

  const refresh = () => void kbStatus().then(setStatus).catch(() => {});
  const refreshServices = () => void servicesStatus().then(setServices).catch(() => {});
  onMount(() => {
    refresh();
    refreshServices();
    // Restore this week's cached digest (don't auto-generate).
    try {
      const c = JSON.parse(localStorage.getItem(DIGEST_KEY) || "null");
      if (c && c.week === weekKey() && c.text) setDigest({ state: "ok", text: c.text });
    } catch { /* ignore a bad cache entry */ }
  });
  const startService = async (name: string) => {
    try { await servicesStart(name); } catch { /* best-effort */ }
    setTimeout(refreshServices, 1500); // give it a moment to come up
  };

  // Save a source's location, then reindex just that source so the user sees it work.
  const saveLocation = async (source: string) => {
    const value = (loc()[source] ?? "").trim();
    setErr(null);
    setReindexing(true);
    try {
      await kbSetSource(source, value);
      setStatus(await kbReindex(source));
    } catch (e) {
      setErr(String(e));
    } finally {
      setReindexing(false);
    }
  };

  const totalChunks = () => status()?.sources.reduce((n, s) => n + s.chunks, 0) ?? 0;

  const reindex = async () => {
    if (reindexing()) return;
    setReindexing(true);
    setErr(null);
    try {
      setStatus(await kbReindex());
    } catch (e) {
      setErr(String(e));
    } finally {
      setReindexing(false);
    }
  };

  const ask = async () => {
    const query = q().trim();
    if (!query || busy()) return;
    setBusy(true);
    setAsked(true);
    setAnswer("");
    setHits([]);
    setVoice(null);
    setErr(null);
    try {
      await kbAnswer(query, (e) => {
        if (e.kind === "sources") setHits(e.hits);
        else if (e.kind === "voice") setVoice(e.label);
        else if (e.kind === "token") setAnswer((a) => a + e.text);
      });
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  };

  // Onyx citations are file paths (open the .md); Scroll citations are article
  // URLs (open the source in a browser tab).
  const openCitation = (h: KbHit) => {
    if (/^https?:\/\//i.test(h.path)) void openTab("browser", h.path);
    else if (h.path) void fsOpen(h.path).catch(() => {});
  };

  const fmtAgo = (ms: number): string => {
    if (!ms) return "never indexed";
    const mins = Math.round((Date.now() - ms) / 60000);
    if (mins < 1) return "just now";
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.round(mins / 60);
    return hrs < 24 ? `${hrs}h ago` : `${Math.round(hrs / 24)}d ago`;
  };

  return (
    <div class="nb">
      <header class="nb-head">
        <span class="nb-brand"><span class="nb-spark">✦</span> Notebook <span class="nb-sub">your knowledge, grounded</span></span>
        <button class="nb-reindex" disabled={reindexing()} onClick={reindex}>
          {reindexing() ? "Indexing…" : "↻ Reindex"}
        </button>
      </header>

      {/* Source status strip */}
      <div class="nb-sources">
        <For each={status()?.sources ?? []}>
          {(s) => (
            <div class="nb-source-chip" classList={{ empty: s.chunks === 0, error: !!s.error }} title={s.error ?? undefined}>
              <span class="nb-source-name">{SOURCE_LABEL[s.source] ?? s.source}</span>
              <Show
                when={!s.error}
                fallback={<span class="nb-source-err">{s.error}</span>}
              >
                <span class="nb-source-stat">{s.docs} docs · {s.chunks} chunks · {fmtAgo(s.last_ms)}</span>
              </Show>
            </div>
          )}
        </For>
        <Show when={status()}>
          <span class="nb-embedder" title="Which embedder the corpus is on">
            {status()!.embedder === "model" ? "embeddinggemma" : "hash (offline)"}
          </span>
        </Show>
      </div>

      {/* Local services (auto-started on boot; manual start if down). */}
      <Show when={services().length > 0}>
        <div class="nb-services">
          <span class="nb-services-label">Services</span>
          <For each={services()}>
            {(s) => (
              <span class="nb-svc" classList={{ down: !s.running }}>
                <span class="nb-svc-dot" />{s.label}
                <Show when={!s.running}>
                  <button class="nb-svc-start" onClick={() => void startService(s.name)}>Start</button>
                </Show>
              </span>
            )}
          </For>
        </div>
      </Show>

      {/* Fix a source that can't be located (vault path / server URL). */}
      <For each={(status()?.sources ?? []).filter((s) => !!s.error)}>
        {(s) => (
          <div class="nb-fix">
            <label class="nb-fix-label">{SOURCE_LABEL[s.source] ?? s.source} location</label>
            <input
              class="nb-fix-input"
              placeholder={SOURCE_HINT[s.source] ?? ""}
              value={loc()[s.source] ?? s.location ?? ""}
              onInput={(e) => setLoc((m) => ({ ...m, [s.source]: e.currentTarget.value }))}
              onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void saveLocation(s.source); } }}
            />
            <button class="nb-fix-save" disabled={reindexing()} onClick={() => void saveLocation(s.source)}>
              Save &amp; index
            </button>
          </div>
        )}
      </For>

      <Show when={totalChunks() === 0 && !reindexing() && !(status()?.sources ?? []).some((s) => s.error)}>
        <div class="nb-empty">
          Nothing indexed yet. Hit <b>↻ Reindex</b> to pull in your Onyx vault, then ask away.
        </div>
      </Show>

      {/* Weekly research digest (#125) — what you added this week, synthesised. */}
      <div class="nb-digest">
        <div class="nb-digest-head">
          <span class="nb-digest-title">📅 This week in your knowledge base</span>
          <button class="nb-digest-go" disabled={digest().state === "loading"} onClick={() => void generateDigest()}>
            {digest().state === "loading" ? "Writing…" : digest().state === "ok" ? "↻ Regenerate" : "Generate digest"}
          </button>
        </div>
        <Show when={digest().state === "idle"}>
          <div class="nb-digest-hint">Let Gemma review what you indexed, clipped, and debated this week — threads, connections, and open questions. Stays on your machine.</div>
        </Show>
        <Show when={digest().state === "empty"}>
          <div class="nb-digest-hint">Nothing new indexed in the last 7 days. Clip a paper to Scroll or add an Onyx note, then ↻ Reindex.</div>
        </Show>
        <Show when={digest().state === "error"}>
          <div class="nb-err">{digest().error}</div>
        </Show>
        <Show when={digest().state === "ok"}>
          <div class="nb-digest-body">{digest().text}</div>
        </Show>
      </div>

      {/* Ask box */}
      <div class="nb-ask">
        <textarea
          class="nb-input"
          placeholder="Ask your notes & papers… e.g. “summarise what I've saved on diffusion models”"
          value={q()}
          onInput={(e) => setQ(e.currentTarget.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void ask(); } }}
        />
        <button class="nb-go" disabled={busy() || !q().trim()} onClick={() => void ask()}>
          {busy() ? "Thinking…" : "Ask ⌘↵"}
        </button>
      </div>

      <Show when={err()}>
        <div class="nb-err">{err()}</div>
      </Show>

      {/* Answer + citations */}
      <Show when={asked()}>
        <div class="nb-answer-card">
          <Show when={voice()}>
            <div class="nb-voice" title="A fine-tuned domain specialist answered this">⚛ {voice()} specialist</div>
          </Show>
          <Show when={answer()} fallback={<div class="nb-thinking">{busy() ? "Searching your knowledge base…" : ""}</div>}>
            <div class="nb-answer">{answer()}</div>
          </Show>
          <Show when={hits().length > 0}>
            <div class="nb-cites">
              <div class="nb-cites-title">Sources</div>
              <For each={hits()}>
                {(h, i) => (
                  <button
                    class="nb-cite"
                    title={`Open ${h.path}`}
                    onClick={() => openCitation(h)}
                  >
                    <span class="nb-cite-n">{i() + 1}</span>
                    <span class="nb-cite-body">
                      <span class="nb-cite-title">{h.title}</span>
                      <span class="nb-cite-snip">{h.snippet}</span>
                    </span>
                    <span class="nb-cite-src">{SOURCE_LABEL[h.source] ?? h.source}</span>
                  </button>
                )}
              </For>
            </div>
          </Show>
        </div>
      </Show>
    </div>
  );
};

export default NotebookPage;
