/**
 * An Indexer answer read as what it is. A note's card is Onyx Markdown (bold,
 * lists, fenced diagrams, `$…$` maths) and showed as raw text, `**` and all,
 * with a box diagram's lines wrapping into nonsense. It's parsed by mdlite, so
 * nothing in a note reaches the page as markup, and its maths is set by KaTeX,
 * which loads with the first answer that has any. A book passage is prose out
 * of a PDF, where a `-` or a `$` is just a character, so it stays text, its
 * paragraphs set a short gap apart rather than a blank line.
 */
import { For, Match, Switch, createEffect, on, type Component } from "solid-js";
import { renderMath, texToNodes } from "./mathblock";
import { parseBlocks, type Block, type Inline } from "./mdlite";
import "./AnswerText.css";

/** One kind of block, or false: a `Match` that narrows. */
const kind =
  <K extends Block["t"]>(t: K) =>
  (b: Block) =>
    (b.t === t ? b : false) as Extract<Block, { t: K }> | false;
const heading = kind("h");
const para = kind("p");
const item = kind("li");
const task = kind("task");
const quote = kind("quote");
const code = kind("code");

/** Text, with any `$…$` / `$$…$$` in it as maths. */
const withMath = (text: string) => texToNodes(text);

const Inlines: Component<{ inl: Inline[] }> = (p) => (
  <For each={p.inl}>
    {(x) => (
      <Switch>
        <Match when={x.t === "b"}>
          <strong>{withMath(x.v)}</strong>
        </Match>
        <Match when={x.t === "i"}>
          <em>{withMath(x.v)}</em>
        </Match>
        <Match when={x.t === "code"}>
          <code>{x.v}</code>
        </Match>
        <Match when={x.t === "link" && x}>
          {(l) => (
            <span class="ans-link" title={l().href}>
              {l().v}
            </span>
          )}
        </Match>
        <Match when={x.t === "text"}>{withMath(x.v)}</Match>
      </Switch>
    )}
  </For>
);

const AnswerText: Component<{ text: string; book: boolean; class: string }> = (p) => {
  let root!: HTMLDivElement;
  // A new answer's maths, once its nodes are in the page.
  createEffect(on([() => p.text, () => p.book], () => queueMicrotask(() => void renderMath(root))));
  return (
    <div ref={root} classList={{ [p.class]: true, "ans-answer": !p.book, "ans-book": p.book }}>
      {p.book ? (
        <For each={p.text.split(/\n{2,}/)}>{(para) => <p>{para}</p>}</For>
      ) : (
        <For each={parseBlocks(p.text)}>
          {(b) => (
            <Switch>
              <Match when={heading(b)}>
                {(h) => (
                  <div class={`ans-h ans-h${h().level}`}>
                    <Inlines inl={h().inl} />
                  </div>
                )}
              </Match>
              <Match when={para(b)}>
                {(x) => (
                  <p>
                    <Inlines inl={x().inl} />
                  </p>
                )}
              </Match>
              <Match when={item(b)}>
                {(x) => (
                  <div class="ans-li" style={{ "padding-left": `${x().depth * 18 + 16}px` }}>
                    <span class="ans-marker">{x().marker}</span>
                    <Inlines inl={x().inl} />
                  </div>
                )}
              </Match>
              <Match when={task(b)}>
                {(x) => (
                  <div class="ans-li" style={{ "padding-left": `${x().depth * 18 + 16}px` }}>
                    <span class="ans-marker">{x().done ? "☑" : "☐"}</span>
                    <Inlines inl={x().inl} />
                  </div>
                )}
              </Match>
              <Match when={quote(b)}>
                {(x) => (
                  <blockquote>
                    <Inlines inl={x().inl} />
                  </blockquote>
                )}
              </Match>
              <Match when={code(b)}>
                {(x) => (
                  <pre class="ans-code">
                    <code>{x().text}</code>
                  </pre>
                )}
              </Match>
              <Match when={b.t === "hr"}>
                <hr />
              </Match>
            </Switch>
          )}
        </For>
      )}
    </div>
  );
};

export default AnswerText;
