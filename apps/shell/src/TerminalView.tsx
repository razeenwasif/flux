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
import { createEffect, onCleanup, onMount, type Component } from "solid-js";
import type { Terminal as XTerm } from "@xterm/xterm";
import { Channel, onTermExit, terminalKill, terminalResize, terminalSpawn, terminalWrite } from "./ipc";
import { registerTerminal, setActiveTerminal, unregisterTerminal } from "./terminals";
import { openTab } from "./store";
import LiquidBackground from "./LiquidBackground";

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

const TerminalView: Component<{ session: number; active?: boolean }> = (props) => {
  let host!: HTMLDivElement;
  let termRef: XTerm | undefined;
  let fitRef: { fit: () => void } | undefined;

  // Re-fit + re-focus when this terminal becomes the active tab again — it was
  // hidden (display:none) in the keep-alive layer (#73), so xterm needs to
  // re-measure now that it has a size. (onMount handles the first show.)
  createEffect(() => {
    if (props.active && termRef) {
      setActiveTerminal(props.session); // agent reads the active terminal's buffer
      termRef.focus();
      requestAnimationFrame(() => fitRef?.fit());
    }
  });

  onMount(async () => {
    // Lazy chunk: xterm core + addons + css, all off the base bundle.
    const [{ Terminal }, { FitAddon }, { WebLinksAddon }, { WebglAddon }] = await Promise.all([
      import("@xterm/xterm"),
      import("@xterm/addon-fit"),
      import("@xterm/addon-web-links"),
      import("@xterm/addon-webgl"),
      import("@xterm/xterm/css/xterm.css"),
    ]);

    // #17: clicking a link in the terminal opens a Flux browser tab (closing the
    // terminal↔browser loop) rather than the OS browser. Covers both auto-detected
    // URLs (WebLinksAddon) and explicit OSC 8 hyperlinks (the linkHandler option).
    // Only web URLs are taken; other schemes (file:, mailto:) are left alone.
    const openInFlux = (uri: string) => {
      if (/^https?:\/\//i.test(uri)) void openTab("browser", uri).catch(() => {});
    };

    const term: XTerm = new Terminal({
      linkHandler: { activate: (_e, uri) => openInFlux(uri) },
      // Broad monospace fallback: prefer a programming font, then any installed
      // Nerd/symbol font for prompt glyphs, then Unicode/emoji coverage, then
      // the platform monospace. (Bundling a Nerd Font for guaranteed icon
      // coverage is BACKLOG #76.)
      fontFamily:
        // Bundled CaskaydiaCove Nerd Font first (#76) — guarantees prompt/icon
        // glyphs without a system install; then installed Nerd/programming fonts.
        '"CaskaydiaCove NF", "JetBrains Mono", "FiraCode Nerd Font", "Hack Nerd Font", "Symbols Nerd Font", ' +
        '"DejaVu Sans Mono", "Noto Sans Mono", "Noto Color Emoji", "SF Mono", Menlo, ' +
        'Consolas, "Liberation Mono", monospace',
      fontSize: 13,
      // 1.0 so box-drawing / TUI frames (btop, vim, lazygit) connect seamlessly —
      // the previous 1.2 left vertical gaps between cells that broke the lines.
      lineHeight: 1.0,
      // xterm renders box-drawing, block, and powerline glyphs itself — fixes
      // the most common "special characters don't render" cases (├ │ └  )
      // even when the font lacks them.
      customGlyphs: true,
      cursorBlink: true,
      cursorStyle: "bar",
      allowProposedApi: true,
      macOptionIsMeta: true,
      scrollback: 10_000,
      allowTransparency: true,
      theme: { ...THEME, background: "#00000000" },
    });

    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new WebLinksAddon((_e, uri) => openInFlux(uri)));
    term.open(host);
    // GPU-accelerated rendering (like Windows Terminal / VS Code) — crisper glyphs
    // and far smoother scrolling for TUIs than the DOM fallback. Must load after
    // open(). If the GL context is lost or init fails, dispose it and fall back to
    // the DOM renderer rather than showing a blank pane.
    try {
      const webgl = new WebglAddon();
      webgl.onContextLoss(() => webgl.dispose());
      term.loadAddon(webgl);
    } catch {
      /* WebGL unavailable → DOM renderer (already active) */
    }
    fit.fit();
    termRef = term; // expose to the active-tab effect (keep-alive re-fit/focus)
    fitRef = fit;
    registerTerminal(props.session, term); // let the agent read this terminal's buffer

    // Surface shell exit / spawn failure in the terminal itself, so a broken
    // shell shows a message instead of a silent blank pane.
    const unExit = await onTermExit((session) => {
      if (session === props.session) term.write("\r\n\x1b[90m[process exited]\x1b[0m\r\n");
    });

    // Output: Rust PTY → channel (raw bytes) → xterm.
    const channel = new Channel<number[]>();
    channel.onmessage = (bytes) => term.write(new Uint8Array(bytes));
    try {
      await terminalSpawn(props.session, term.cols, term.rows, channel);
    } catch (e) {
      term.write(
        `\r\n\x1b[38;2;236;75;224m⚠ Flux: couldn't start the shell\x1b[0m\r\n` +
          `\x1b[90m${String(e)}\x1b[0m\r\n` +
          `\x1b[90mTip: set FLUX_SHELL to pick a shell (e.g. pwsh.exe, cmd.exe).\x1b[0m\r\n`,
      );
    }

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
      unExit();
      unregisterTerminal(props.session);
      void terminalKill(props.session);
      term.dispose();
    });
  });

  return (
    <div style={{ position: "relative", width: "100%", height: "100%", overflow: "hidden", "border-radius": "inherit", background: THEME.background }}>
      <div style={{ position: "absolute", inset: 0, "z-index": 0, "pointer-events": "none", opacity: 0.6 }}>
        <LiquidBackground active={() => props.active ?? true} />
      </div>
      <div ref={host} style={{ position: "relative", "z-index": 1, width: "100%", height: "100%", padding: "8px" }} />
    </div>
  );
};

export default TerminalView;
