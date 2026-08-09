/**
 * The nvim column (#174) — a permanent editor pinned beside the page.
 *
 * Boots `nvim` in a real PTY at startup and keeps it there for the life of the
 * window, so the editor is always a glance away rather than a tab switch. The
 * PTY's default cwd for a non-tab session is already the user's home
 * (`terminal.rs` falls back to `home_dir()`), which is exactly where this wants
 * to start — so the boot command is just the editor, with no `cd` to get wrong.
 *
 * Why this can sit next to a page at all: a tab's page is a **native webview**,
 * an OS layer above all HTML, so nothing DOM can be drawn over it. But Flux's
 * terminal is xterm.js — plain DOM — and this column is a *sibling* of the
 * content card, not an overlay. Shrinking the card is the whole trick: the card's
 * ResizeObserver re-tiles the native webview to the smaller rect (`tiling.ts`),
 * the same mechanism the bookmark bar already relies on.
 *
 * Quitting the editor relaunches it — the column is an nvim column, so `:q`
 * should hand back a fresh one rather than a dead pane. A spawn that dies
 * *immediately* is treated as a failure instead (nvim missing from PATH, say),
 * because respawning that would be an infinite loop rather than a feature.
 */
import { type Component, Show, createSignal, createEffect, onCleanup, lazy, Suspense } from "solid-js";

import { BOOT_CMD, bootCommand, exitAction, sessionFor, setEditorSession, socketPath } from "./editorboot";
import { onTermExit } from "./ipc";
import { setPendingCommand } from "./terminals";

const TerminalView = lazy(() => import("./TerminalView"));

const EditorColumn: Component = () => {
  // Each relaunch gets a *new* session id rather than reusing the old one: the
  // previous PTY is still being torn down as the next spawns, and reusing the id
  // would race the kill against the spawn on the Rust side.
  const [generation, setGeneration] = createSignal(0);
  const [failed, setFailed] = createSignal<string | null>(null);
  const session = () => sessionFor(generation());

  // Whether the caret is actually in this column. Not hardcoded true: `active`
  // is also what makes a terminal the agent's "read the terminal" target, and a
  // pane that is *always* on screen would otherwise permanently outrank the
  // terminal column for that — the agent would read nvim instead of the shell
  // the user just ran something in.
  const [focused, setFocused] = createSignal(false);
  // Whether the *next* mount should take the caret. False at startup (a column
  // that boots with the window must not swallow the first thing typed into the
  // URL bar); true for a relaunch the user triggered from inside the column,
  // where losing the caret to a `:q` would be the surprise.
  const [grabCaret, setGrabCaret] = createSignal(false);

  // When this generation's PTY came up, so an instant exit can be told apart
  // from the user quitting a session they'd actually been using.
  let spawnedAt = Date.now();

  const boot = (gen: number) => {
    // Queue before the view mounts — TerminalView consumes this the moment its
    // PTY is live, which closes the race against the shell being ready.
    //
    // Booted with `--listen` so the agent can read the live buffer over RPC
    // (#179). The socket path is a pure function of the session on both sides,
    // so no handshake is needed — and computing it rather than fetching it is
    // what keeps this synchronous, since an `await` here would race the mount
    // and usually lose, booting an editor the agent can't read.
    const session = sessionFor(gen);
    setPendingCommand(session, bootCommand(socketPath(session)));
  };
  boot(0);

  const relaunch = (takeCaret: boolean) => {
    setFailed(null);
    const next = generation() + 1;
    boot(next);
    spawnedAt = Date.now();
    setGrabCaret(takeCaret);
    setGeneration(next);
  };

  // Publish which session is live, so the agent can reach this editor — and
  // clear it on unmount, so a closed column reads as "you don't have one open"
  // rather than as a silent RPC timeout against a dead socket.
  createEffect(() => setEditorSession(session()));
  onCleanup(() => setEditorSession(null));

  createEffect(() => {
    const mine = session();
    let disposed = false;
    const sub = onTermExit((exited) => {
      // Only this generation's exit counts. A relaunch has already moved
      // `session()` on, so the dying PTY's own exit event can't retrigger one.
      if (disposed || exited !== mine) return;
      if (exitAction(Date.now() - spawnedAt) === "fail") {
        setFailed(`\`${BOOT_CMD}\` exited immediately — is it on the terminal shell's PATH?`);
        return;
      }
      // Quitting from inside the column should hand the caret straight back to
      // the fresh editor; a process that died while the user was elsewhere
      // should not pull focus across the window.
      relaunch(focused());
    });
    onCleanup(() => {
      disposed = true;
      void sub.then((un) => un()).catch(() => {});
    });
  });

  return (
    <section
      class="editor-col"
      aria-label="Editor"
      onFocusIn={() => setFocused(true)}
      onFocusOut={() => setFocused(false)}
    >
      <Show
        when={!failed()}
        fallback={
          <div class="editor-col-dead">
            <p class="editor-col-msg">{failed()}</p>
            <button class="editor-col-retry" onClick={() => relaunch(true)}>
              Retry
            </button>
          </div>
        }
      >
        {/* `keyed` on the session id is what makes a relaunch a real remount:
            TerminalView's onCleanup kills the old PTY, and the fresh instance
            spawns the next one. Keying on anything coarser would reuse the
            component and leave the dead session attached. */}
        <Show when={session()} keyed>
          {(s) => (
            <div class="editor-col-surface">
              <Suspense>
                {/* background=false: a second WebGL2 context for the liquid
                    backdrop is not worth it for a pane that is always on screen
                    (the same rule the split panes follow). persist="off" so a
                    broker never reattaches a session that is already in nvim. */}
                <TerminalView
                  session={s}
                  active={focused()}
                  visible
                  background={false}
                  persist="off"
                  autoFocus={grabCaret()}
                />
              </Suspense>
            </div>
          )}
        </Show>
      </Show>
    </section>
  );
};

export default EditorColumn;
