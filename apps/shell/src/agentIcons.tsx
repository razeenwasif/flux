/**
 * The agent panel's icons, drawn for it: line icons on a 24-unit grid, 1.6
 * strokes with round ends and joins, in the text colour, so they sit with
 * Fairy's eye (FairyEye.tsx) and take any theme. Each button that shows one
 * also carries its name, shown on hover (`data-tip`, AgentPanel.css).
 */
import type { Component, JSX } from "solid-js";

export type AgentIconName =
  | "page"
  | "tabs"
  | "notes"
  | "thread"
  | "summarize"
  | "keypoints"
  | "explain"
  | "clip"
  | "attach"
  | "mic"
  | "voice"
  | "newchat"
  | "history"
  | "send"
  | "stop"
  | "close";

const DRAW: Record<AgentIconName, () => JSX.Element> = {
  // A page with its corner folded and two lines of text.
  page: () => (
    <>
      <path d="M7 3.5h7l4 4V19a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 6 19V5a1.5 1.5 0 0 1 1-1.5z" />
      <path d="M14 3.5V7.5h4M9 12h6M9 15.5h4" />
    </>
  ),
  // Two windows, one behind the other.
  tabs: () => (
    <>
      <path d="M9 4.5h9.5A1.5 1.5 0 0 1 20 6v8.5" />
      <rect x="4" y="8" width="12.5" height="11.5" rx="1.8" />
      <path d="M4 11.5h12.5" />
    </>
  ),
  // An open book, with a spark over the spine: what you've kept.
  notes: () => (
    <>
      <path d="M12 7.5C10.4 6.2 8 5.6 4.5 5.6v12.2c3.5 0 5.9.6 7.5 1.9 1.6-1.3 4-1.9 7.5-1.9V5.6c-3.5 0-5.9.6-7.5 1.9zM12 7.5v12.2" />
      <path d="M12 2.2v2.4M10.8 3.4h2.4" />
    </>
  ),
  // A speech bubble with two lines: the page's own conversation.
  thread: () => (
    <path d="M5 6.5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2h-5.5L8 19v-3.5H7a2 2 0 0 1-2-2zM8.5 8.5h7M8.5 11.5h4.5" />
  ),
  // Long lines gathered into short ones.
  summarize: () => <path d="M4.5 6.5h15M4.5 10.5h15M7.5 14.5h9M10 18.5h4" />,
  // A list, each line with its point.
  keypoints: () => (
    <>
      <path d="M10 7h9.5M10 12h9.5M10 17h6" />
      <circle cx="5.8" cy="7" r="1.3" fill="currentColor" stroke="none" />
      <circle cx="5.8" cy="12" r="1.3" fill="currentColor" stroke="none" />
      <circle cx="5.8" cy="17" r="1.3" fill="currentColor" stroke="none" />
    </>
  ),
  // A lightbulb.
  explain: () => (
    <path d="M9.5 17.5h5M10.3 20.5h3.4M12 3.5a5.8 5.8 0 0 0-3.4 10.5c.6.5.9 1.1.9 1.8v.2h5v-.2c0-.7.3-1.3.9-1.8A5.8 5.8 0 0 0 12 3.5z" />
  ),
  // A bookmark ribbon taking a page in: save to Scroll.
  clip: () => (
    <path d="M7.5 3.5h9a1.5 1.5 0 0 1 1.5 1.5v15.5l-6-3.6-6 3.6V5a1.5 1.5 0 0 1 1.5-1.5zM12 7.5v5.5M9.3 10.25h5.4" />
  ),
  // A paperclip.
  attach: () => (
    <path d="M15.6 7.4l-6.3 6.3a1.8 1.8 0 0 0 2.6 2.6l6.5-6.5a3.6 3.6 0 0 0-5.1-5.1l-6.7 6.7a5.4 5.4 0 0 0 7.6 7.6l5.5-5.5" />
  ),
  // A microphone: hold to talk.
  mic: () => (
    <path d="M12 3.5a2.6 2.6 0 0 1 2.6 2.6v5.3a2.6 2.6 0 0 1-5.2 0V6.1A2.6 2.6 0 0 1 12 3.5zM6.5 11a5.5 5.5 0 0 0 11 0M12 16.5v3.5M9 20h6" />
  ),
  // A waveform: always listening for her name.
  voice: () => <path d="M4.5 10.5v3M8 7.5v9M11.5 4.5v15M15 8v8M18.5 10.5v3" />,
  // A speech bubble with a plus.
  newchat: () => (
    <path d="M5 6.5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2h-5.5L8 19v-3.5H7a2 2 0 0 1-2-2zM12 7.3v5.4M9.3 10h5.4" />
  ),
  // A clock turning back: past chats.
  history: () => <path d="M4.6 12a7.4 7.4 0 1 0 2.2-5.3M4.6 4.4v3.3h3.3M12 8.3v3.9l2.7 1.7" />,
  // An arrow lifting off.
  send: () => <path d="M12 18.5V6M6.8 11.2L12 6l5.2 5.2" />,
  // A soft square.
  stop: () => <rect x="7" y="7" width="10" height="10" rx="2.6" fill="currentColor" stroke="none" />,
  close: () => <path d="M7.5 7.5l9 9M16.5 7.5l-9 9" />,
};

export const AgentIcon: Component<{ name: AgentIconName; size?: number }> = (p) => (
  <svg
    class="agent-icon"
    viewBox="0 0 24 24"
    width={p.size ?? 18}
    height={p.size ?? 18}
    fill="none"
    stroke="currentColor"
    stroke-width="1.6"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    {DRAW[p.name]()}
  </svg>
);
