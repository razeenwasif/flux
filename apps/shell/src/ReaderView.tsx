// Reader mode view (#41), extracted from App.tsx. The decluttered article shown
// over the (hidden) webview, with Web-Speech TTS. Block data comes from the
// reader store; rendering is text + <img src> only (no raw HTML → no XSS).
//
// Structural reading upgrade: an **outline rail** (deterministic, from the
// heading blocks — works offline) plus **section chips** (local Gemma classifies
// the document and maps headings onto canonical sections: a paper reads as
// Abstract/Methods/Results, a recipe as Ingredients/Steps). Rust validates the
// model's mapping, so a hallucinated label never renders; with the model down,
// the chips simply don't appear and the outline still does.
import {
  For,
  Match,
  Show,
  Switch,
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  type Component,
} from "solid-js";
import { readerStructure, type ReaderBlock, type ReadingStructure } from "./ipc";
import { closeReader, readerBlocks, readerTitle } from "./store";

const ReaderBlockView: Component<{ b: ReaderBlock; idx: number }> = (props) => {
  const b = props.b;
  return (
    <Switch fallback={<p class="reader-p">{b.text}</p>}>
      <Match when={b.kind === "h"}>
        <p id={`rb-${props.idx}`} classList={{ "reader-h": true, [`h${b.level || 2}`]: true }}>
          {b.text}
        </p>
      </Match>
      <Match when={b.kind === "li"}>
        <div class="reader-li">{b.text}</div>
      </Match>
      <Match when={b.kind === "quote"}>
        <blockquote class="reader-quote">{b.text}</blockquote>
      </Match>
      <Match when={b.kind === "pre"}>
        <pre class="reader-pre">{b.text}</pre>
      </Match>
      <Match when={b.kind === "cap"}>
        <div class="reader-cap">{b.text}</div>
      </Match>
      <Match when={b.kind === "img"}>
        <img class="reader-img" src={b.src} alt={b.text} loading="lazy" />
      </Match>
    </Switch>
  );
};

/** Chip icon per canonical section label (fallback: §). */
const SECTION_ICON: Record<string, string> = {
  Abstract: "📄",
  Methods: "🧪",
  Experiments: "🧪",
  Results: "📊",
  Discussion: "💬",
  Conclusion: "🎯",
  References: "🔗",
  Ingredients: "🧂",
  Equipment: "🍳",
  Steps: "👨‍🍳",
  Nutrition: "🥗",
  Install: "📦",
  Quickstart: "⚡",
  API: "⌨",
  Examples: "🧩",
  Troubleshooting: "🔧",
  Summary: "📄",
};

const DOC_TYPE_LABEL: Record<string, string> = {
  paper: "research paper",
  recipe: "recipe",
  docs: "documentation",
  news: "news",
};

/** The decluttered article view, shown over the (hidden) webview. TTS via the
 *  Web Speech API. */
const ReaderView: Component = () => {
  const [speaking, setSpeaking] = createSignal(false);
  const [structure, setStructure] = createSignal<ReadingStructure | null>(null);
  let doc: HTMLElement | undefined;
  let gen = 0;

  // Deterministic outline: the heading blocks (levels 1–3), with their block
  // index so both the rail and the chips can jump to `#rb-{idx}`.
  const outline = createMemo(() =>
    readerBlocks()
      .map((b, idx) => ({ b, idx }))
      .filter(({ b }) => b.kind === "h" && (b.level ?? 2) <= 3 && (b.text ?? "").trim())
      .map(({ b, idx }) => ({ text: b.text!, level: b.level ?? 2, idx })),
  );

  // The smart layer: ask local Gemma to classify + map the headings. Guarded to
  // documents with enough structure; stale replies (doc changed) are dropped.
  createEffect(() => {
    const heads = outline();
    setStructure(null);
    if (heads.length < 3) return;
    const mine = ++gen;
    void readerStructure(
      readerTitle(),
      heads.map((h) => h.text),
    )
      .then((s) => {
        if (mine === gen && (s.sections?.length ?? 0) > 0) setStructure(s);
      })
      .catch(() => {});
  });

  const jump = (idx: number) => {
    doc?.querySelector(`#rb-${idx}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
  };
  /** Map a section's heading-list position back to its block index. */
  const blockIdxOf = (headingPos: number) => outline()[headingPos]?.idx ?? 0;

  const speakable = () =>
    readerBlocks()
      .filter((b) => b.kind === "p" || b.kind === "li" || b.kind === "quote" || b.kind === "h")
      .map((b) => b.text)
      .join(". ");
  const toggleSpeak = () => {
    const synth = window.speechSynthesis;
    if (!synth) return;
    if (speaking()) {
      synth.cancel();
      setSpeaking(false);
      return;
    }
    const u = new SpeechSynthesisUtterance(`${readerTitle()}. ${speakable()}`.slice(0, 20000));
    u.onend = () => setSpeaking(false);
    u.onerror = () => setSpeaking(false);
    synth.cancel();
    synth.speak(u);
    setSpeaking(true);
  };
  onCleanup(() => window.speechSynthesis?.cancel());

  return (
    <div class="reader">
      <div class="reader-bar">
        <button class="reader-btn" onClick={toggleSpeak}>
          {speaking() ? "⏹ Stop" : "🔊 Listen"}
        </button>
        <Show when={structure()}>
          {(s) => (
            <span class="reader-type" title="Detected by the local model from the headings">
              {DOC_TYPE_LABEL[s().doc_type ?? ""] ?? "article"}
            </span>
          )}
        </Show>
        <span class="reader-count">{readerBlocks().length} blocks</span>
        <button class="reader-btn" onClick={() => closeReader()} title="Close (Esc)">
          ✕ Close
        </button>
      </div>
      {/* Section chips: the document's canonical shape, one tap to jump. */}
      <Show when={structure()}>
        {(s) => (
          <div class="reader-chips">
            <For each={s().sections ?? []}>
              {(sec) => (
                <button class="reader-chip" onClick={() => jump(blockIdxOf(sec.i))}>
                  {SECTION_ICON[sec.label] ?? "§"} {sec.label}
                </button>
              )}
            </For>
          </div>
        )}
      </Show>
      <div class="reader-body">
        <Show when={outline().length >= 3}>
          <nav class="reader-outline">
            <For each={outline()}>
              {(h) => (
                <button
                  class="reader-outline-item"
                  classList={{ [`lv${h.level}`]: true }}
                  title={h.text}
                  onClick={() => jump(h.idx)}
                >
                  {h.text}
                </button>
              )}
            </For>
          </nav>
        </Show>
        <article class="reader-doc" ref={doc}>
          <h1 class="reader-title">{readerTitle()}</h1>
          <For each={readerBlocks()}>{(b, i) => <ReaderBlockView b={b} idx={i()} />}</For>
        </article>
      </div>
    </div>
  );
};

export default ReaderView;
