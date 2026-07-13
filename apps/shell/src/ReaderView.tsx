// Reader mode view (#41), extracted from App.tsx. The decluttered article shown
// over the (hidden) webview, with Web-Speech TTS. Block data comes from the
// reader store; rendering is text + <img src> only (no raw HTML → no XSS).
import { type Component, For, Match, Switch, createSignal, onCleanup } from "solid-js";
import { type ReaderBlock } from "./ipc";
import { closeReader, readerBlocks, readerTitle } from "./store";

const ReaderBlockView: Component<{ b: ReaderBlock }> = (props) => {
  const b = props.b;
  return (
    <Switch fallback={<p class="reader-p">{b.text}</p>}>
      <Match when={b.kind === "h"}><p classList={{ "reader-h": true, [`h${b.level || 2}`]: true }}>{b.text}</p></Match>
      <Match when={b.kind === "li"}><div class="reader-li">{b.text}</div></Match>
      <Match when={b.kind === "quote"}><blockquote class="reader-quote">{b.text}</blockquote></Match>
      <Match when={b.kind === "pre"}><pre class="reader-pre">{b.text}</pre></Match>
      <Match when={b.kind === "cap"}><div class="reader-cap">{b.text}</div></Match>
      <Match when={b.kind === "img"}><img class="reader-img" src={b.src} alt={b.text} loading="lazy" /></Match>
    </Switch>
  );
};

/** The decluttered article view, shown over the (hidden) webview. TTS via the
 *  Web Speech API. */
const ReaderView: Component = () => {
  const [speaking, setSpeaking] = createSignal(false);
  const speakable = () =>
    readerBlocks().filter((b) => b.kind === "p" || b.kind === "li" || b.kind === "quote" || b.kind === "h").map((b) => b.text).join(". ");
  const toggleSpeak = () => {
    const synth = window.speechSynthesis;
    if (!synth) return;
    if (speaking()) { synth.cancel(); setSpeaking(false); return; }
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
        <button class="reader-btn" onClick={toggleSpeak}>{speaking() ? "⏹ Stop" : "🔊 Listen"}</button>
        <span class="reader-count">{readerBlocks().length} blocks</span>
        <button class="reader-btn" onClick={() => closeReader()} title="Close (Esc)">✕ Close</button>
      </div>
      <article class="reader-doc">
        <h1 class="reader-title">{readerTitle()}</h1>
        <For each={readerBlocks()}>{(b) => <ReaderBlockView b={b} />}</For>
      </article>
    </div>
  );
};

export default ReaderView;
