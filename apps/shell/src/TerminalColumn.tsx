// Right-side vertical terminal column (ADR 0002/0003, splits #75), extracted
// from App.tsx. The always-available dev terminal; the first pane is the
// persistent PANE_SESSION, and #75 adds resizable side-by-side / stacked PTY
// panes, each its own shell. (Extra panes are session-local — they reset if the
// column is hidden.)
import { type Component, For, Show, createSignal, lazy, Suspense } from "solid-js";
import { PANE_SESSION } from "./ipc";

/** Reserved session-id range for the column's *extra* split panes (#75). Tab ids
 *  start at 1 and climb slowly; PANE_SESSION is 0 — so a high base never collides. */
const COL_PANE_BASE = 0xf000_0000;

const TerminalView = lazy(() => import("./TerminalView"));

const TerminalColumn: Component = () => {
  const [panes, setPanes] = createSignal<number[]>([PANE_SESSION]);
  // Per-pane flex-grow weights, parallel to `panes` — dragging a seam shifts
  // weight between the two neighbours so splits are resizable (#75).
  const [sizes, setSizes] = createSignal<number[]>([1]);
  const [active, setActive] = createSignal(PANE_SESSION);
  const [dir, setDir] = createSignal<"row" | "col">(
    localStorage.getItem("flux.term.split") === "row" ? "row" : "col",
  );
  let paneSeq = COL_PANE_BASE;
  let panesEl!: HTMLDivElement;

  const split = () => {
    const id = ++paneSeq;
    const i = panes().indexOf(active());
    const at = i < 0 ? panes().length : i + 1; // insert after the focused pane
    setPanes((p) => {
      const n = [...p];
      n.splice(at, 0, id);
      return n;
    });
    setSizes((s) => {
      const n = [...s];
      n.splice(at, 0, 1);
      return n;
    });
    setActive(id);
  };
  const closePane = (id: number) => {
    const p = panes();
    if (p.length <= 1) return; // keep at least one pane alive
    const i = p.indexOf(id);
    const next = p.filter((x) => x !== id);
    setPanes(next);
    setSizes((s) => s.filter((_, k) => k !== i));
    if (active() === id) setActive(next[Math.min(i, next.length - 1)]!);
    // TerminalView's onCleanup kills that pane's PTY on unmount.
  };
  const toggleDir = () =>
    setDir((d) => {
      const n = d === "row" ? "col" : "row";
      localStorage.setItem("flux.term.split", n);
      return n;
    });

  // Drag the seam before pane `idx`, redistributing weight between panes idx-1/idx.
  const startResize = (e: PointerEvent, idx: number) => {
    e.preventDefault();
    e.stopPropagation();
    const horizontal = dir() === "row";
    const total = horizontal ? panesEl.clientWidth : panesEl.clientHeight;
    if (total <= 0) return;
    const MIN = 60; // px — smallest a pane can shrink to
    const startPos = horizontal ? e.clientX : e.clientY;
    const s0 = sizes();
    const a = s0[idx - 1] ?? 1,
      b = s0[idx] ?? 1,
      pair = a + b;
    const totalGrow = s0.reduce((n, v) => n + v, 0) || 1;
    const pairPx = (pair / totalGrow) * total;
    const aPx0 = (a / totalGrow) * total;
    document.body.classList.add("busy"); // drop glass blur while dragging
    const move = (ev: PointerEvent) => {
      const pos = horizontal ? ev.clientX : ev.clientY;
      const aPx = Math.max(MIN, Math.min(pairPx - MIN, aPx0 + (pos - startPos)));
      const ratio = aPx / pairPx;
      setSizes((s) => {
        const n = [...s];
        n[idx - 1] = pair * ratio;
        n[idx] = pair * (1 - ratio);
        return n;
      });
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      document.body.classList.remove("busy");
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  return (
    <section class="terminal-col">
      <div
        ref={panesEl}
        class="term-col-panes"
        style={{ "flex-direction": dir() === "row" ? "row" : "column" }}
      >
        <For each={panes()}>
          {(s, i) => (
            <>
              <Show when={i() > 0}>
                <div
                  classList={{ "term-seam": true, vert: dir() === "row" }}
                  title="Drag to resize"
                  onPointerDown={(e) => startResize(e, i())}
                />
              </Show>
              <div
                classList={{ "term-pane": true, active: panes().length > 1 && active() === s }}
                style={{ "flex-grow": String(sizes()[i()] ?? 1), "flex-basis": "0", "flex-shrink": "1" }}
                onPointerDown={() => setActive(s)}
              >
                <div class="terminal-surface">
                  <Suspense>
                    <TerminalView session={s} active={active() === s} background={panes().length === 1} />
                  </Suspense>
                </div>
              </div>
            </>
          )}
        </For>
      </div>
      <div class="term-col-bar">
        <button class="term-col-btn" title="Split terminal" onClick={split}>
          ⊞
        </button>
        <button
          class="term-col-btn"
          title={dir() === "row" ? "Stack panes vertically" : "Place panes side by side"}
          onClick={toggleDir}
        >
          {dir() === "row" ? "▭" : "▯"}
        </button>
        <Show when={panes().length > 1}>
          <button class="term-col-btn danger" title="Close focused pane" onClick={() => closePane(active())}>
            ✕
          </button>
        </Show>
      </div>
    </section>
  );
};

export default TerminalColumn;
