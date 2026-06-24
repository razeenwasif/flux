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

import { fsOpen, kbAnswer, kbReindex, kbStatus, type KbHit, type KbStatus } from "./ipc";
import { openTab } from "./store";

const SOURCE_LABEL: Record<string, string> = { onyx: "Onyx vault", scroll: "Scroll papers" };

const NotebookPage: Component = () => {
  const [status, setStatus] = createSignal<KbStatus | null>(null);
  const [q, setQ] = createSignal("");
  const [answer, setAnswer] = createSignal("");
  const [hits, setHits] = createSignal<KbHit[]>([]);
  const [busy, setBusy] = createSignal(false); // streaming an answer
  const [reindexing, setReindexing] = createSignal(false);
  const [err, setErr] = createSignal<string | null>(null);
  const [asked, setAsked] = createSignal(false);

  const refresh = () => void kbStatus().then(setStatus).catch(() => {});
  onMount(refresh);

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
    setErr(null);
    try {
      await kbAnswer(query, (e) => {
        if (e.kind === "sources") setHits(e.hits);
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

      <Show when={totalChunks() === 0 && !reindexing()}>
        <div class="nb-empty">
          Nothing indexed yet. Hit <b>↻ Reindex</b> to pull in your Onyx vault, then ask away.
        </div>
      </Show>

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
