/**
 * TerminalView — a live PTY rendered with xterm.js (ADR 0003).
 *
 * xterm and its addons are **dynamically imported** so none of this is in the
 * base chrome bundle (it loads only when a terminal first opens, protecting the
 * chrome TTI / JS budget from ADR 0001). Bytes stream from the Rust PTY over a
 * Tauri Channel; keystrokes go back via terminal_write.
 *
 * One instance per session: a Terminal tab passes its TabId; the vertical
 * column passes PANE_SESSION (0).
 */
import { onCleanup, onMount, type Component } from "solid-js";
import type { Terminal as XTerm } from "@xterm/xterm";
import { Channel, terminalKill, terminalResize, terminalSpawn, terminalWrite } from "./ipc";

/** Velvet-matched 16-color palette + teal cursor (theme.css alignment). */
const THEME = {
  background: "#0b0a1d",
  foreground: "#eef0fb",
  cursor: "#2ff3ff",
  cursorAccent: "#0b0a1d",
  selectionBackground: "rgba(123, 97, 255, 0.35)",
  black: "#1a1640",
  red: "#ec4be0",
  green: "#7CF5B0",
  yellow: "#F5D76E",
  blue: "#7b61ff",
  magenta: "#ec4be0",
  cyan: "#2ff3ff",
  white: "#c9cde8",
  brightBlack: "#6a6f96",
  brightRed: "#ff79f0",
  brightGreen: "#9affc9",
  brightYellow: "#ffe9a3",
  brightBlue: "#9d8df1",
  brightMagenta: "#ff79f0",
  brightCyan: "#7df9ff",
  brightWhite: "#eef0fb",
} as const;

const TerminalView: Component<{ session: number }> = (props) => {
  let host!: HTMLDivElement;

  onMount(async () => {
    // Lazy chunk: xterm core + addons + css, all off the base bundle.
    const [{ Terminal }, { FitAddon }, { WebLinksAddon }] = await Promise.all([
      import("@xterm/xterm"),
      import("@xterm/addon-fit"),
      import("@xterm/addon-web-links"),
      import("@xterm/xterm/css/xterm.css"),
    ]);

    const term: XTerm = new Terminal({
      // Broad monospace fallback: prefer a programming font, then any installed
      // Nerd/symbol font for prompt glyphs, then Unicode/emoji coverage, then
      // the platform monospace. (Bundling a Nerd Font for guaranteed icon
      // coverage is BACKLOG #76.)
      fontFamily:
        '"JetBrains Mono", "FiraCode Nerd Font", "Hack Nerd Font", "Symbols Nerd Font", ' +
        '"DejaVu Sans Mono", "Noto Sans Mono", "Noto Color Emoji", "SF Mono", Menlo, ' +
        'Consolas, "Liberation Mono", monospace',
      fontSize: 13,
      lineHeight: 1.2,
      // xterm renders box-drawing, block, and powerline glyphs itself — fixes
      // the most common "special characters don't render" cases (├ │ └  )
      // even when the font lacks them.
      customGlyphs: true,
      cursorBlink: true,
      cursorStyle: "bar",
      allowProposedApi: true,
      macOptionIsMeta: true,
      scrollback: 10_000,
      theme: THEME,
    });

    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new WebLinksAddon());
    term.open(host);
    fit.fit();

    // Output: Rust PTY → channel (raw bytes) → xterm.
    const channel = new Channel<number[]>();
    channel.onmessage = (bytes) => term.write(new Uint8Array(bytes));
    await terminalSpawn(props.session, term.cols, term.rows, channel);

    // Input: typed/pasted text → bytes → PTY stdin.
    const enc = new TextEncoder();
    const inputSub = term.onData((data) => void terminalWrite(props.session, enc.encode(data)));

    // Keep the PTY's window size in sync with the rendered grid.
    const ro = new ResizeObserver(() => {
      fit.fit();
      void terminalResize(props.session, term.cols, term.rows);
    });
    ro.observe(host);
    term.focus();

    onCleanup(() => {
      ro.disconnect();
      inputSub.dispose();
      void terminalKill(props.session);
      term.dispose();
    });
  });

  return <div ref={host} style={{ width: "100%", height: "100%", padding: "8px" }} />;
};

export default TerminalView;
