/**
 * The omnibox's grounded answer from the Omni index, streamed, with numbered
 * citations that open their source (Sidebar.tsx). Lazy: drawn only once asked.
 */
import { For, Show, type Component } from "solid-js";

import type { OmniAnswerSource } from "./ipc";

/** Split an answer into text runs and `[n]` citation markers, so the markers can
 *  render as clickable footnotes inline with the streamed prose. */
type AnswerPart = string | { cite: number };
function answerParts(text: string): AnswerPart[] {
  const parts: AnswerPart[] = [];
  let last = 0;
  const re = /\[(\d+)\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) parts.push(text.slice(last, m.index));
    parts.push({ cite: parseInt(m[1]!, 10) });
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}

const OmniAnswerCard: Component<{
  ans: { text: string; sources: OmniAnswerSource[]; streaming: boolean };
  onDismiss: () => void;
  onNavigate: (url: string) => void;
}> = (props) => (
  <div class="omni-answer">
    <div class="omni-answer-head">
      <span class="spark">✦</span> Omni answer
      <Show when={props.ans.streaming}>
        <span class="omni-answer-dot" />
      </Show>
      <button
        type="button"
        class="omni-answer-close"
        title="Dismiss Omni answer"
        onMouseDown={(e) => {
          e.preventDefault();
          props.onDismiss();
        }}
      >
        ×
      </button>
    </div>
    <div class="omni-answer-body">
      <Show when={props.ans.text} fallback={props.ans.streaming ? "Thinking…" : "No answer."}>
        <For each={answerParts(props.ans.text)}>
          {(part) =>
            typeof part === "string" ? (
              <span>{part}</span>
            ) : props.ans.sources[part.cite - 1] ? (
              <sup
                class="omni-cite"
                title={props.ans.sources[part.cite - 1]!.title}
                onMouseDown={(e) => {
                  e.preventDefault();
                  props.onNavigate(props.ans.sources[part.cite - 1]!.url);
                }}
              >
                {part.cite}
              </sup>
            ) : (
              <span>[{part.cite}]</span>
            )
          }
        </For>
      </Show>
    </div>
    <Show when={props.ans.sources.length > 0}>
      <div class="omni-answer-src">
        <For each={props.ans.sources}>
          {(s) => (
            <button
              type="button"
              class="omni-answer-cite"
              title={s.url}
              onMouseDown={(e) => {
                e.preventDefault();
                props.onNavigate(s.url);
              }}
            >
              [{s.n}] {s.title}
            </button>
          )}
        </For>
      </div>
    </Show>
  </div>
);

export default OmniAnswerCard;
