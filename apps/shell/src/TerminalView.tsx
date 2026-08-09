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
import { createEffect, createSignal, onCleanup, onMount, Show, type Component } from "solid-js";
import type { Terminal as XTerm, IMarker, IDecoration } from "@xterm/xterm";
import {
  agentChat,
  agentShellPlan,
  Channel,
  onTermExit,
  terminalKill,
  terminalResize,
  terminalSpawn,
  terminalWrite,
  termPersist,
  type TermPersist,
} from "./ipc";
import { registerTerminal, setActiveTerminal, takePendingCommand, unregisterTerminal } from "./terminals";
import { openTab } from "./store";
import { speak, stopSpeaking } from "./speak";
import LiquidBackground from "./LiquidBackground";
import { hex, palette as pal, rgba } from "./palette";

/**
 * The terminal's 16 colours, derived from the active theme.
 *
 * Built from the palette rather than hardcoded, so a theme change carries into
 * the terminal — but **only the Flux-flavoured slots**. `red`, `green` and
 * `yellow` are what programs *mean* by them: a compiler error is red because
 * red means error, and repainting it rose because the theme is rose would make
 * `cargo` output unreadable. Those stay fixed; the accents follow the theme.
 */
const termTheme = () => {
  const p = pal();
  return {
    background: hex(p.bg),
    foreground: "#eef0fb",
    cursor: hex(p.accent),
    cursorAccent: hex(p.bg),
    selectionBackground: rgba(p.ai, 0.35),
    black: "#1a1640",
    // Semantic ANSI colours — fixed on purpose (see above).
    red: "#ff6b8a",
    green: "#7cf5b0",
    yellow: "#f5d76e",
    blue: hex(p.ai),
    magenta: hex(p.hot),
    cyan: hex(p.accent),
    white: "#c9cde8",
    brightBlack: "#6a6f96",
    brightRed: "#ff9fb0",
    brightGreen: "#9affc9",
    brightYellow: "#ffe9a3",
    brightBlue: hex(p.ai2),
    brightMagenta: hex(p.hot),
    brightCyan: hex(p.accent),
    brightWhite: "#eef0fb",
  };
};

const TerminalView: Component<{
  session: number;
  /** The focused tab: takes the caret and becomes the agent's read target. */
  active?: boolean;
  /** On screen at all. A tiled terminal is visible without being active, and
   *  still has to re-fit when it appears. Defaults to `active`. */
  visible?: boolean;
  background?: boolean;
  /** Override the session's persistence mode. The editor column pins this to
   *  "off": a reattached broker session would already be running its program,
   *  and the queued start command would then be typed *into* that program
   *  instead of a shell. Defaults to the user's global `termPersist()`. */
  persist?: TermPersist;
  /** Take the caret on mount. True for a terminal the user just opened; the
   *  editor column sets it false, because a pane that mounts at *startup* would
   *  otherwise swallow the first thing typed into the URL bar. */
  autoFocus?: boolean;
}> = (props) => {
  let host!: HTMLDivElement;
  let termRef: XTerm | undefined;
  let fitRef: { fit: () => void } | undefined;

  // Transient status line for shell-integration actions (#16: jump/copy feedback).
  const [hint, setHint] = createSignal<string | null>(null);
  let hintTimer: number | undefined;
  const flash = (msg: string) => {
    setHint(msg);
    clearTimeout(hintTimer);
    hintTimer = window.setTimeout(() => setHint(null), 1600);
  };

  // Agent-aware terminal (#121): when a command exits non-zero, offer explain/fix.
  const [failedExit, setFailedExit] = createSignal<number | null>(null);
  const [aiBusy, setAiBusy] = createSignal(false);
  const [aiText, setAiText] = createSignal<string | null>(null);
  let explainRef: (() => void) | undefined;
  let fixRef: (() => void) | undefined;

  // Re-fit whenever this terminal becomes *visible* — it was hidden
  // (display:none) in the keep-alive layer (#73), so xterm has to re-measure now
  // that it has a size. Separate from focus: a terminal tiled beside another tab
  // is on screen without being the active tab, and must fit without stealing the
  // caret. (onMount handles the first show.)
  createEffect(() => {
    if ((props.visible ?? props.active) && termRef) {
      requestAnimationFrame(() => fitRef?.fit());
    }
  });
  createEffect(() => {
    if (props.active && termRef) {
      setActiveTerminal(props.session); // agent reads the active terminal's buffer
      termRef.focus();
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
      theme: { ...termTheme(), background: "#00000000" },
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
    // Readable by the agent, but only *the* read target if it mounted active —
    // a pane that appears without the user asking must not hijack that (#178).
    registerTerminal(props.session, term, props.active ?? true);

    // ── Shell integration (#16): OSC 133 prompt marks ───────────────────────
    // When the shell sources Flux's integration snippet it emits OSC 133 around
    // each prompt/command: `A` = prompt start, `B` = command input start,
    // `C` = output start, `D;<exit>` = command finished. We capture them to:
    //   · paint a per-command status bar in the gutter (running / exit 0 / fail)
    //   · jump between prompts (Ctrl+Shift+↑/↓)
    //   · copy the last command's output (Ctrl+Shift+E)
    // No-op if the shell emits nothing (integration not sourced).
    type Cmd = { marker: IMarker; deco: IDecoration | undefined; exit?: number };
    let cmds: Cmd[] = [];
    const live = (): Cmd[] => {
      cmds = cmds.filter((c) => !c.marker.isDisposed && c.marker.line >= 0);
      return cmds;
    };
    const barColor = (exit?: number) =>
      exit === undefined ? "rgba(123, 97, 255, 0.5)" : exit === 0 ? "#7CF5B0" : "#ec4be0";
    const paint = (c: Cmd) => {
      const el = c.deco?.element;
      if (!el) return;
      // Set visual props only — leave xterm's inline position (top/left) intact.
      el.style.width = "3px";
      el.style.height = "100%";
      el.style.marginLeft = "-6px";
      el.style.borderRadius = "2px";
      el.style.background = barColor(c.exit);
      el.title = c.exit === undefined ? "running…" : c.exit === 0 ? "exit 0" : `exit ${c.exit}`;
    };
    const oscSub = term.parser.registerOscHandler(133, (data) => {
      const [kind, arg] = data.split(";");
      if (kind === "A") {
        const marker = term.registerMarker(0);
        if (marker) {
          const deco = term.registerDecoration({ marker, x: 0, width: 1, layer: "top" });
          const cmd: Cmd = { marker, deco };
          deco?.onRender(() => paint(cmd));
          live().push(cmd);
        }
      } else if (kind === "D") {
        // Emitted just before the next prompt → belongs to the current prompt's command.
        const code = arg !== undefined ? Number.parseInt(arg, 10) : 0;
        const list = live();
        const last = list[list.length - 1];
        if (last) {
          last.exit = Number.isNaN(code) ? undefined : code;
          paint(last);
        }
        // Drive the explain/fix affordance off the just-finished command's status.
        setFailedExit(Number.isNaN(code) ? null : code);
      }
      return true; // 133 is ours — don't pass to the default handler
    });

    // The last command's block (its prompt line + output), for the agent (#121).
    const lastBlock = (): string => {
      const list = live();
      if (list.length < 2) return "";
      const prev = list[list.length - 2]!.marker.line;
      const cur = list[list.length - 1]!.marker.line;
      if (prev < 0 || cur < 0) return "";
      const buf = term.buffer.active;
      const lines: string[] = [];
      for (let i = prev; i < cur; i++) lines.push(buf.getLine(i)?.translateToString(true) ?? "");
      while (lines.length && !lines[lines.length - 1]!.trim()) lines.pop();
      return lines.join("\n").slice(0, 4000);
    };
    // Explain the failure (chat) — shown in an overlay.
    explainRef = () => {
      const block = lastBlock();
      if (!block) {
        flash("Nothing to explain yet");
        return;
      }
      setAiText(null);
      setAiBusy(true);
      void agentChat(
        `A shell command just failed in my terminal. Explain briefly why, and how to fix it. Command and output:\n\n${block}`,
      )
        .then((r) => {
          const t = r.trim() || "(no response)";
          setAiText(t);
          void speak(t);
        })
        .catch((e) => setAiText(`Couldn't reach the agent: ${e}`))
        .finally(() => setAiBusy(false));
    };
    // Propose a corrected command and type it at the prompt (review + Enter to run).
    fixRef = () => {
      const block = lastBlock();
      if (!block) {
        flash("Nothing to fix yet");
        return;
      }
      setAiBusy(true);
      void agentShellPlan(
        `Fix this failing shell command. Reply with ONLY the corrected command.\n\n${block}`,
      )
        .then((cmd) => {
          if (cmd && cmd.trim()) {
            // Ctrl-U clears the current line first, then type the fix (no Enter).
            void terminalWrite(
              props.session,
              new TextEncoder().encode(String.fromCharCode(0x15) + cmd.trim()),
            );
            flash("✓ Fix typed — review & press Enter");
          } else {
            flash("No fix suggested");
          }
        })
        .catch((e) => flash(String(e)))
        .finally(() => setAiBusy(false));
    };

    const jumpPrompt = (dir: -1 | 1) => {
      const lines = live()
        .map((c) => c.marker.line)
        .filter((l) => l >= 0)
        .sort((a, b) => a - b);
      if (!lines.length) {
        flash("No prompts marked — is shell integration on?");
        return;
      }
      const top = term.buffer.active.viewportY;
      let target: number | undefined;
      if (dir < 0) {
        for (let i = lines.length - 1; i >= 0; i--)
          if (lines[i]! < top) {
            target = lines[i];
            break;
          }
      } else {
        for (const l of lines)
          if (l > top) {
            target = l;
            break;
          }
      }
      if (target === undefined) {
        flash(dir < 0 ? "Top" : "Bottom");
        return;
      }
      term.scrollToLine(target);
      flash(dir < 0 ? "↑ prompt" : "↓ prompt");
    };

    const copyLastOutput = async () => {
      const list = live();
      if (list.length < 2) {
        flash("No completed command yet");
        return;
      }
      const prev = list[list.length - 2]!.marker.line;
      const cur = list[list.length - 1]!.marker.line;
      if (prev < 0 || cur < 0) {
        flash("Output scrolled out of buffer");
        return;
      }
      const buf = term.buffer.active;
      const lines: string[] = [];
      for (let i = prev + 1; i < cur; i++) lines.push(buf.getLine(i)?.translateToString(true) ?? "");
      while (lines.length && !lines[lines.length - 1]!.trim()) lines.pop();
      const text = lines.join("\n");
      if (!text) {
        flash("Last command produced no output");
        return;
      }
      try {
        await navigator.clipboard.writeText(text);
        flash(`Copied ${lines.length} line${lines.length === 1 ? "" : "s"}`);
      } catch {
        flash("Copy failed");
      }
    };

    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== "keydown" || !e.ctrlKey || !e.shiftKey || e.altKey || e.metaKey) return true;
      const k = e.key.toLowerCase();
      if (e.key === "ArrowUp") {
        e.preventDefault();
        jumpPrompt(-1);
        return false;
      }
      if (e.key === "ArrowDown") {
        e.preventDefault();
        jumpPrompt(1);
        return false;
      }
      if (k === "e") {
        e.preventDefault();
        void copyLastOutput();
        return false;
      }
      return true;
    });

    // Surface shell exit / spawn failure in the terminal itself, so a broken
    // shell shows a message instead of a silent blank pane.
    const unExit = await onTermExit((session) => {
      if (session === props.session) term.write("\r\n\x1b[90m[process exited]\x1b[0m\r\n");
    });

    // Output: Rust PTY → channel (raw bytes) → xterm.
    const channel = new Channel<number[]>();
    channel.onmessage = (bytes) => term.write(new Uint8Array(bytes));
    try {
      await terminalSpawn(props.session, term.cols, term.rows, channel, props.persist ?? termPersist());
      // TUI app launcher (#117): run the queued command now the PTY is live.
      const initCmd = takePendingCommand(props.session);
      if (initCmd) void terminalWrite(props.session, new TextEncoder().encode(initCmd + "\r"));
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
    if (props.autoFocus ?? true) term.focus();

    onCleanup(() => {
      ro.disconnect();
      inputSub.dispose();
      oscSub.dispose();
      clearTimeout(hintTimer);
      unExit();
      unregisterTerminal(props.session);
      void terminalKill(props.session);
      term.dispose();
    });
  });

  return (
    <div
      style={{
        position: "relative",
        width: "100%",
        height: "100%",
        overflow: "hidden",
        "border-radius": "inherit",
        background: "var(--velvet-800)",
      }}
    >
      {/* The WebGL shader backdrop is decorative; skip it when the column is split
          (props.background=false) so split panes don't each hold a WebGL2 context —
          too many contexts white-out other GPU-composited glass surfaces (#75). */}
      <Show when={props.background ?? true}>
        <div style={{ position: "absolute", inset: 0, "z-index": 0, "pointer-events": "none", opacity: 0.6 }}>
          <LiquidBackground active={() => props.active ?? true} />
        </div>
      </Show>
      <div
        ref={host}
        style={{ position: "relative", "z-index": 1, width: "100%", height: "100%", padding: "8px" }}
      />

      {/* #121: a command just failed → offer to explain / fix it with the agent. */}
      <Show when={(failedExit() ?? 0) !== 0 && !aiText() && !aiBusy()}>
        <div class="term-fail">
          <span class="term-fail-x">⚠ exit {failedExit()}</span>
          <button class="term-fail-btn" onClick={() => explainRef?.()}>
            ✦ Explain
          </button>
          <button class="term-fail-btn" onClick={() => fixRef?.()}>
            ⚙ Fix
          </button>
          <button class="term-fail-dismiss" title="Dismiss" onClick={() => setFailedExit(null)}>
            ✕
          </button>
        </div>
      </Show>

      {/* Explanation overlay (the agent's answer about the failure). */}
      <Show when={aiBusy() || aiText()}>
        <div class="term-ai">
          <div class="term-ai-head">
            <span>✦ Gemma</span>
            <button
              class="term-ai-close"
              onClick={() => {
                stopSpeaking();
                setAiText(null);
                setAiBusy(false);
              }}
            >
              ✕
            </button>
          </div>
          <Show when={!aiBusy()} fallback={<div class="term-ai-body">Looking at the error…</div>}>
            <div class="term-ai-body">{aiText()}</div>
          </Show>
        </div>
      </Show>

      {/* #16: transient feedback for prompt jump / copy-output */}
      <Show when={hint()}>
        {(h) => (
          <div
            style={{
              position: "absolute",
              bottom: "10px",
              right: "12px",
              "z-index": 2,
              padding: "4px 10px",
              "border-radius": "8px",
              "font-size": "12px",
              "font-family": "system-ui, sans-serif",
              color: "#eef0fb",
              background: "rgba(26, 22, 64, 0.92)",
              border: "1px solid rgba(123, 97, 255, 0.4)",
              "pointer-events": "none",
              "box-shadow": "0 4px 16px rgba(0,0,0,0.4)",
            }}
          >
            {h()}
          </div>
        )}
      </Show>
    </div>
  );
};

export default TerminalView;
