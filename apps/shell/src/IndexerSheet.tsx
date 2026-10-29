/**
 * The Indexer's panel in the Velvet Paper design (design.ts): a paper sheet over
 * the page card instead of Classic's box beside the orb, laid out like the
 * design board — a header with the scope and Reindex, the big question field, the
 * Tuning card (every match placed by its score, and a draggable minimum match),
 * the answer card, and the sources and model the answers came from.
 *
 * It owns no state. IndexerBubble does the asking, listening, paging and
 * opening, and hands all of it in, so the two layouts can never disagree about
 * what the Indexer is doing — only about how it looks.
 */
import { For, Show, createMemo, createSignal, onCleanup, onMount, type Component } from "solid-js";

import AnswerText from "./AnswerText";
import type { IndexerMatch, IndexerResults, IndexerScope, IndexerStatus } from "./indexer";

export type IndexerSheetProps = {
  query: () => string;
  setQuery: (q: string) => void;
  ask: (q: string) => void;
  inputRef: (el: HTMLInputElement) => void;
  scope: () => IndexerScope;
  setScope: (s: IndexerScope) => void;
  status: () => IndexerStatus | null;
  /** Read another folder of PDFs, or stop reading one added before. They
   *  come from the orb, so this lazy sheet imports no IPC of its own. */
  addFolder: (path: string) => Promise<void>;
  removeFolder: (path: string) => Promise<void>;
  reindex: () => void;
  /** The line under the header: listening / searching / indexing progress. */
  statusText: () => string;
  note: () => string | null;
  listening: () => boolean;
  listen: () => void;
  close: () => void;
  results: () => IndexerResults | null;
  /** Result indices in display order (a decisive System 1 pick goes first). */
  order: () => number[];
  page: () => number;
  setPage: (p: number) => void;
  /** Page by one, skipping matches under the minimum. */
  stepPage: (dir: 1 | -1) => void;
  /** The minimum match (.50 = none); `floorOn` when it's above that. */
  floor: () => number;
  setFloor: (v: number) => void;
  floorOn: () => boolean;
  /** Display positions whose match clears the minimum, in display order. */
  shown: () => number[];
  current: () => IndexerMatch | undefined;
  /** System 1 chose the card on screen, decisively. */
  pickedHere: () => boolean;
  verdict: () => { kind: string; text: string } | null;
  copied: () => boolean;
  copy: (text: string) => void;
  open: (m: IndexerMatch) => void;
};

/** `.91` — the board writes scores the way the scale labels them. */
const score = (x: number) => Math.max(0, Math.min(0.99, x)).toFixed(2).replace(/^0/, "");
const short = (s: string, n = 26) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);
/** Where a score sits on the .50–1.0 axis; anything weaker rests at the left end. */
const at = (x: number) => Math.max(0, Math.min(1, (x - 0.5) / 0.5));

const IndexerSheet: Component<IndexerSheetProps> = (p) => {
  // Cover the page card: the sheet replaces the page while it's open (the page
  // webview is hidden for any overlay, see pageOverlayActive).
  const [box, setBox] = createSignal({ left: 0, top: 0, width: 0, height: 0 });
  const measure = () => {
    const r = document.getElementById("flux-web-area")?.getBoundingClientRect();
    if (r && r.width > 0) setBox({ left: r.left, top: r.top, width: r.width, height: r.height });
    else setBox({ left: 16, top: 16, width: window.innerWidth - 32, height: window.innerHeight - 32 });
  };
  onMount(() => {
    measure();
    window.addEventListener("resize", measure);
    onCleanup(() => window.removeEventListener("resize", measure));
  });

  /** Every match as a station on the scale, in score order so the label rows
   *  alternate cleanly — neighbours never share a row, so labels can't collide. */
  const stations = createMemo(() => {
    const r = p.results();
    if (!r) return [];
    const ord = p.order();
    const list = ord.map((mi, pos) => ({ m: r.matches[mi]!, pos }));
    return list
      .slice()
      .sort((a, b) => a.m.confidence - b.m.confidence)
      .map((s, i) => ({ ...s, x: at(s.m.confidence), row: i % 2 }));
  });
  const below = (c: number) => p.floorOn() && c < p.floor();

  // ── the minimum-match handle ──────────────────────────────────────────────
  let scaleEl: HTMLDivElement | undefined;
  /** Pointer x on the scale → a score on the .50–1.0 axis. */
  const scoreAt = (clientX: number) => {
    const r = scaleEl?.getBoundingClientRect();
    if (!r || r.width <= 0) return p.floor();
    return 0.5 + 0.5 * Math.max(0, Math.min(1, (clientX - r.left) / r.width));
  };
  const drag = (e: PointerEvent) => {
    e.preventDefault();
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    el.focus();
    p.setFloor(scoreAt(e.clientX));
    const move = (ev: PointerEvent) => p.setFloor(scoreAt(ev.clientX));
    const up = () => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      el.removeEventListener("pointercancel", up);
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
  };
  const floorKey = (e: KeyboardEvent) => {
    const step = e.shiftKey ? 0.05 : 0.01;
    const to =
      e.key === "ArrowRight" || e.key === "ArrowUp"
        ? p.floor() + step
        : e.key === "ArrowLeft" || e.key === "ArrowDown"
          ? p.floor() - step
          : e.key === "Home"
            ? 0.5
            : e.key === "End"
              ? 0.95
              : null;
    if (to == null) return;
    // The sheet pages through matches with ←/→; on the handle they move it.
    e.preventDefault();
    e.stopPropagation();
    p.setFloor(to);
  };
  const floorText = () => (p.floorOn() ? `Minimum match ${score(p.floor())}` : "No minimum match");
  /** "3 of 5 above .70" once there are matches and a minimum. */
  const countText = () => {
    const n = p.order().length;
    if (!n) return "";
    if (!p.floorOn()) return `${n} match${n === 1 ? "" : "es"}`;
    return `${p.shown().length} of ${n} above ${score(p.floor())}`;
  };
  /** Where the card on screen sits among the matches that clear the minimum. */
  const pagerText = () => {
    const list = p.shown();
    const i = list.indexOf(p.page());
    return i >= 0 ? `${i + 1} of ${list.length}` : `under ${score(p.floor())}`;
  };

  const cardLegend = () => {
    const m = p.current();
    if (!m) return "Answer";
    if (p.pickedHere()) return `Laya pick · ${score(m.confidence)}`;
    return p.page() === 0
      ? `Best match · ${score(m.confidence)}`
      : `Match ${p.page() + 1} · ${score(m.confidence)}`;
  };

  /** The vault first, then each folder of PDFs (indexer.rs `sources`, `shelves`). */
  const sources = () => {
    const s = p.status();
    if (!s) return [];
    const out: { name: string; path: string; count: number; added?: boolean }[] = [];
    if (s.sources[0] || s.notes) out.push({ name: "Notes", path: s.sources[0] ?? "", count: s.notes });
    for (const f of s.shelves)
      out.push({ name: f.path.split(/[\\/]/).pop() || f.path, path: f.path, count: f.books, added: f.added });
    return out;
  };
  // Another folder of PDFs (a course's lecture slides), typed as a path: Flux
  // has no folder picker, and the vault is set the same way.
  const [folder, setFolder] = createSignal("");
  const [folderError, setFolderError] = createSignal("");
  const addFolder = async (e: SubmitEvent) => {
    e.preventDefault();
    const path = folder().trim();
    if (!path) return;
    try {
      await p.addFolder(path);
      setFolder("");
      setFolderError("");
    } catch (err) {
      setFolderError(String(err));
    }
  };
  const removeFolder = async (path: string) => {
    try {
      await p.removeFolder(path);
    } catch (err) {
      setFolderError(String(err));
    }
  };
  const tilde = (path: string) => path.replace(/^\/Users\/[^/]+/, "~").replace(/^\/home\/[^/]+/, "~");

  return (
    <section
      class="idx-sheet"
      role="dialog"
      aria-label="Indexer"
      style={{
        left: `${box().left}px`,
        top: `${box().top}px`,
        width: `${box().width}px`,
        height: `${box().height}px`,
      }}
    >
      <div class="idx-sheet-inner">
        <header class="idx-sheet-head">
          <span class="idx-sheet-title">
            <span class="idx-sheet-name">Indexer</span>
            <span class="idx-sheet-sub">Ask your notes and books</span>
          </span>
          <div class="idx-sheet-scope" role="radiogroup" aria-label="Search in">
            <For
              each={
                [
                  ["all", "All"],
                  ["notes", "Notes"],
                  ["books", "Books"],
                ] as const
              }
            >
              {([v, label]) => (
                <button
                  role="radio"
                  aria-checked={p.scope() === v}
                  classList={{ on: p.scope() === v }}
                  onClick={() => p.setScope(v)}
                >
                  {label}
                </button>
              )}
            </For>
          </div>
          <button
            class="idx-sheet-reindex"
            title="Reindex: read new and changed notes and books (also happens each time this opens)"
            disabled={!!p.status()?.building}
            onClick={() => p.reindex()}
          >
            <svg
              width="15"
              height="15"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="1.8"
              stroke-linecap="round"
              stroke-linejoin="round"
              aria-hidden="true"
            >
              <path d="M20 11a8 8 0 1 0-2.3 5.7" />
              <path d="M20 4v7h-7" />
            </svg>
            Reindex
          </button>
          <button class="idx-sheet-close" title="Close (Esc)" aria-label="Close" onClick={() => p.close()}>
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              aria-hidden="true"
            >
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        </header>

        <form
          class="idx-sheet-ask"
          onSubmit={(e) => {
            e.preventDefault();
            p.ask(p.query());
          }}
        >
          <svg
            width="20"
            height="20"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="1.8"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
          >
            <path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z" />
          </svg>
          <input
            ref={p.inputRef}
            class="idx-sheet-input"
            aria-label="Question"
            placeholder="Ask your notes…"
            value={p.query()}
            spellcheck={false}
            onInput={(e) => p.setQuery(e.currentTarget.value)}
            onKeyDown={(e) => {
              // Chrome shortcuts must not fire while typing; Escape still closes.
              if (e.key !== "Escape") e.stopPropagation();
            }}
          />
          <Show when={p.results()?.matches.length}>
            {(n) => (
              <span class="idx-sheet-count">
                {n()} passage{n() === 1 ? "" : "s"}
              </span>
            )}
          </Show>
          <button
            type="button"
            classList={{ "idx-sheet-mic": true, on: p.listening() }}
            title={p.listening() ? "Stop and ask" : "Ask out loud"}
            aria-label={p.listening() ? "Stop listening" : "Ask out loud"}
            onClick={() => p.listen()}
          >
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="1.8"
              stroke-linecap="round"
              stroke-linejoin="round"
              aria-hidden="true"
            >
              <rect x="9" y="3" width="6" height="11" rx="3" />
              <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
            </svg>
          </button>
        </form>

        <div class="idx-sheet-status">{p.statusText()}</div>
        <Show when={p.status()?.notice}>
          <div class="idx-sheet-status">{p.status()?.notice}</div>
        </Show>
        <Show when={p.note()}>
          <div class="idx-sheet-note">{p.note()}</div>
        </Show>

        <section class="idx-sheet-card idx-sheet-tuning" data-legend="Tuning" aria-label="Tuning">
          <div class="idx-sheet-tuning-head">
            <span class="idx-sheet-tuning-count">{countText()}</span>
            <span class="idx-sheet-tuning-floor">{floorText()}</span>
          </div>
          <div class="idx-sheet-axis" aria-hidden="true">
            <span>.50</span>
            <span>.60</span>
            <span>.70</span>
            <span>.80</span>
            <span>.90</span>
            <span>1.0</span>
          </div>
          <div classList={{ "idx-sheet-scale": true, empty: !stations().length }} ref={scaleEl}>
            <span class="idx-sheet-track" aria-hidden="true" />
            <span class="idx-sheet-ticks" aria-hidden="true" />
            <span
              classList={{ "idx-sheet-floor-shade": true, on: p.floorOn() }}
              style={{ width: `${(at(p.floor()) * 100).toFixed(2)}%` }}
              aria-hidden="true"
            />
            <For each={stations()}>
              {(s) => {
                const on = () => s.pos === p.page();
                return (
                  <>
                    <span
                      classList={{ "idx-sheet-dot": true, on: on(), dim: below(s.m.confidence) }}
                      style={{ left: `${(s.x * 100).toFixed(2)}%` }}
                      aria-hidden="true"
                    />
                    <button
                      classList={{
                        "idx-sheet-station": true,
                        on: on(),
                        low: s.row === 1,
                        dim: below(s.m.confidence),
                      }}
                      style={{ left: `${(s.x * 100).toFixed(2)}%` }}
                      title={s.m.question}
                      aria-pressed={on()}
                      onClick={() => p.setPage(s.pos)}
                    >
                      {short(s.m.question)} · {score(s.m.confidence)}
                    </button>
                  </>
                );
              }}
            </For>
            <Show when={stations().find((s) => s.pos === p.page())}>
              {(s) => (
                <span
                  class="idx-sheet-needle"
                  style={{ left: `${(s().x * 100).toFixed(2)}%` }}
                  aria-hidden="true"
                />
              )}
            </Show>
            <span
              classList={{ "idx-sheet-floor": true, on: p.floorOn() }}
              style={{ left: `${(at(p.floor()) * 100).toFixed(2)}%` }}
              role="slider"
              tabindex="0"
              aria-label="Minimum match"
              aria-valuemin={50}
              aria-valuemax={95}
              aria-valuenow={Math.round(p.floor() * 100)}
              aria-valuetext={floorText()}
              title="Drag to hide weaker matches (←/→, Shift for bigger steps)"
              onPointerDown={drag}
              onKeyDown={floorKey}
            />
          </div>
          <Show when={!stations().length}>
            <p class="idx-sheet-tuning-hint">
              Ask something and every match lands here by how closely it fits. Drag the handle to set a
              minimum: weaker matches are dimmed and skipped when you page.
            </p>
          </Show>
        </section>

        <div class="idx-sheet-row">
          <Show
            when={p.results()}
            fallback={
              <article class="idx-sheet-card idx-sheet-answer" data-legend="Answer">
                <p class="idx-sheet-empty">
                  Ask a question, typed or spoken, to read back what you already wrote.
                </p>
              </article>
            }
          >
            {(r) => (
              <Show
                when={
                  p.floorOn() && r().matches.length > 0 && p.shown().length === 0 ? undefined : p.current()
                }
                fallback={
                  <article class="idx-sheet-card idx-sheet-answer" data-legend="Answer">
                    <p class="idx-sheet-empty">
                      {!r().matches.length
                        ? "Nothing in your notes or books matches that."
                        : p.floorOn() && p.shown().length === 0
                          ? `No match reaches ${score(p.floor())}. Lower the minimum in Tuning to see the closest ones.`
                          : ""}
                    </p>
                  </article>
                }
              >
                {(m) => (
                  <article class="idx-sheet-card idx-sheet-answer" data-legend={cardLegend()}>
                    <Show when={p.verdict()}>
                      {(v) => (
                        <div classList={{ "idx-sheet-verdict": true, [v().kind]: true }}>{v().text}</div>
                      )}
                    </Show>
                    <span class="idx-sheet-source" title={m().path}>
                      {m().source}
                    </span>
                    <h2 class="idx-sheet-q">{m().question}</h2>
                    {/* The points are an interview card's "I built…" lines; on any
                        other note they're its first sentences again. */}
                    <Show when={m().key_points.length && /interview/i.test(m().path)}>
                      <ul class="idx-sheet-points">
                        <For each={m().key_points}>{(k) => <li>{k}</li>}</For>
                      </ul>
                    </Show>
                    <AnswerText class="idx-sheet-answer-text" text={m().answer} book={m().book} />
                    <footer class="idx-sheet-foot">
                      <button class="idx-sheet-primary" onClick={() => p.open(m())}>
                        {m().book ? `Open p. ${m().page ?? 1}` : "Open note"}
                      </button>
                      <button class="idx-sheet-btn" onClick={() => p.copy(m().answer)}>
                        {p.copied() ? "Copied" : "Copy"}
                      </button>
                      <Show when={p.shown().length > 1 || (p.order().length > 1 && !p.floorOn())}>
                        <div class="idx-sheet-pager">
                          <button
                            title="Previous match (←)"
                            aria-label="Previous match"
                            onClick={() => p.stepPage(-1)}
                          >
                            ‹
                          </button>
                          <span>{pagerText()}</span>
                          <button
                            title="Next match (→)"
                            aria-label="Next match"
                            onClick={() => p.stepPage(1)}
                          >
                            ›
                          </button>
                        </div>
                      </Show>
                    </footer>
                  </article>
                )}
              </Show>
            )}
          </Show>

          <div class="idx-sheet-side">
            <Show when={sources().length > 0}>
              <section class="idx-sheet-card" data-legend="Sources">
                <For each={sources()}>
                  {(s) => (
                    <div class="idx-sheet-source-row">
                      <span class="idx-sheet-led" aria-hidden="true" />
                      <span class="idx-sheet-source-name">
                        <span>{s.name}</span>
                        <Show when={s.path}>
                          <span class="idx-sheet-source-path" title={s.path}>
                            {tilde(s.path)}
                          </span>
                        </Show>
                      </span>
                      <span class="idx-sheet-source-count">{s.count.toLocaleString()}</span>
                      <Show when={s.added}>
                        <button
                          class="idx-sheet-source-x"
                          title={`Stop reading ${tilde(s.path)}`}
                          aria-label={`Stop reading ${tilde(s.path)}`}
                          onClick={() => void removeFolder(s.path)}
                        >
                          ×
                        </button>
                      </Show>
                    </div>
                  )}
                </For>
                <form class="idx-sheet-add" onSubmit={(e) => void addFolder(e)}>
                  <input
                    value={folder()}
                    onInput={(e) => setFolder(e.currentTarget.value)}
                    placeholder="Add a folder of PDFs"
                    title="Its full path, or one starting with ~/ (~/Courses, say)"
                    aria-label="Add a folder of PDFs"
                    spellcheck={false}
                  />
                  <button type="submit" disabled={!folder().trim()}>
                    Add
                  </button>
                </form>
                <Show when={folderError()}>
                  <div class="idx-sheet-add-error">{folderError()}</div>
                </Show>
              </section>
            </Show>
            <Show when={p.status()}>
              {(s) => (
                <section class="idx-sheet-card idx-sheet-model" data-legend="Running locally">
                  <span>
                    <b>{s().embed_model}</b>
                    {s().semantic ? " · embeddings" : " · not pulled — keyword matching"}
                  </span>
                  <span>
                    <b>Laya</b> · System 1 tie-break
                  </span>
                  <span>Nothing leaves this computer</span>
                </section>
              )}
            </Show>
          </div>
        </div>
      </div>
    </section>
  );
};

export default IndexerSheet;
