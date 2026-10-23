/**
 * The Indexer orb (#196, in place of the music bubble): ask your Onyx notes a
 * question, typed or spoken, and read back the answer you already wrote. A port
 * of desktop-buddies/Indexer (SiriBubble). The ranking lives in indexer.rs; when
 * it isn't sure, a System 1 decision model (Laya) picks among the closest cards,
 * and the card says whether it did, or couldn't.
 *
 * Drag the orb to park it; it stays where the music bubble was parked. Clicking
 * it opens the panel, which hides the page while it's open: native tab webviews
 * sit above all chrome HTML, so the panel registers in `pageOverlayActive` like
 * every other overlay.
 */
import {
  For,
  Show,
  createEffect,
  createMemo,
  createSignal,
  lazy,
  on,
  onCleanup,
  onMount,
  Suspense,
  type Component,
} from "solid-js";

import {
  indexerDecide,
  indexerReindex,
  indexerSearch,
  indexerStatus,
  indexerWarm,
  openNote,
  type IndexerMatch,
  type IndexerPick,
  type IndexerResults,
  type IndexerScope,
  type IndexerStatus,
} from "./indexer";
import { design } from "./design";
// Velvet Paper's sheet: loaded on first open, so Classic (and boot) never pay for it.
const IndexerSheet = lazy(() => import("./IndexerSheet"));
import { indexerPanelOpen, setIndexerPanelOpen } from "./indexerOpen";
import { pdfViewerUrl, voiceTranscribe } from "./ipc";
import { openTab } from "./store";
import { micConstraints } from "./mic";

type Pos = { x: number; y: number };
type Busy = "listening" | "transcribing" | "searching" | "deciding" | null;

const POS_KEY = "flux.indexer.pos";
/** Where the music bubble was parked: the orb takes over its spot. */
const OLD_POS_KEY = "flux.music.pos";
const PAD = 12;
const ORB = 56;
const PANEL_W = 420;
const GAP = 10;

/** Speech louder than this (RMS of a 4096-sample block) counts as talking. */
const SPEECH_RMS = 0.02;
/** This much quiet after speech ends the question. */
const TRAILING_SILENCE_MS = 1200;
/** Give up if nothing is said for this long, and stop any question at the cap. */
const NO_SPEECH_MS = 6000;
const MAX_LISTEN_MS = 15000;

const pct = (x: number) => `${Math.round(x * 100)}%`;

/** The wave between the orb's dark top and silver bottom: one period every 100
 *  units, wide enough to sway across the sphere without showing an end. */
const WAVE = "M -100 52 Q -75 40 -50 52 T 0 52 T 50 52 T 100 52 T 150 52 T 200 52";

/** The orb, after the macOS Siri icon: a glass sphere, graphite above and silver
 *  below, split by a wave of iridescent light, with a glossy floor and a faintly
 *  prismatic rim. The wave sways, and swells with the mic level (theme.css). */
const OrbArt: Component = () => (
  <svg class="idx-orb-art" viewBox="0 0 100 100" aria-hidden="true">
    <defs>
      <radialGradient id="idx-top" cx="50%" cy="18%" r="80%">
        <stop offset="0" stop-color="#4d5058" />
        <stop offset="0.55" stop-color="#2b2d33" />
        <stop offset="1" stop-color="#1b1c20" />
      </radialGradient>
      <linearGradient id="idx-floor" x1="0" y1="0.35" x2="0" y2="1">
        <stop offset="0" stop-color="#9aa0a9" />
        <stop offset="0.5" stop-color="#cdd1d7" />
        <stop offset="1" stop-color="#f7f8fa" />
      </linearGradient>
      <linearGradient id="idx-iris" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="100" y2="0">
        <stop offset="0.05" stop-color="#ff7a2f" stop-opacity="0.2" />
        <stop offset="0.28" stop-color="#ff9a45" />
        <stop offset="0.45" stop-color="#ffe7b0" />
        <stop offset="0.58" stop-color="#ffffff" />
        <stop offset="0.76" stop-color="#8ccfff" />
        <stop offset="0.95" stop-color="#4f7dff" stop-opacity="0.2" />
      </linearGradient>
      <radialGradient id="idx-gloss" cx="50%" cy="100%" r="55%">
        <stop offset="0" stop-color="#ffffff" stop-opacity="0.95" />
        <stop offset="1" stop-color="#ffffff" stop-opacity="0" />
      </radialGradient>
      <radialGradient id="idx-shade" cx="50%" cy="42%" r="58%">
        <stop offset="0.74" stop-color="#000000" stop-opacity="0" />
        <stop offset="1" stop-color="#000000" stop-opacity="0.3" />
      </radialGradient>
      <linearGradient id="idx-rim" x1="0" y1="0" x2="1" y2="0">
        <stop offset="0" stop-color="#ffb070" stop-opacity="0.8" />
        <stop offset="0.35" stop-color="#ffffff" stop-opacity="0.18" />
        <stop offset="0.65" stop-color="#ffffff" stop-opacity="0.18" />
        <stop offset="1" stop-color="#7fb8ff" stop-opacity="0.8" />
      </linearGradient>
      <clipPath id="idx-clip">
        <circle cx="50" cy="50" r="50" />
      </clipPath>
      <filter id="idx-soft" x="-20%" y="-50%" width="140%" height="200%">
        <feGaussianBlur stdDeviation="1.8" />
      </filter>
      <filter id="idx-haze" x="-50%" y="-100%" width="200%" height="300%">
        <feGaussianBlur stdDeviation="5" />
      </filter>
    </defs>
    <g clip-path="url(#idx-clip)">
      <rect width="100" height="100" fill="url(#idx-top)" />
      <g class="idx-wave">
        <path d={`${WAVE} L 200 110 L -100 110 Z`} fill="url(#idx-floor)" />
        <path
          class="idx-band"
          d={WAVE}
          fill="none"
          stroke="url(#idx-iris)"
          stroke-width="6"
          filter="url(#idx-soft)"
        />
        <path d={WAVE} fill="none" stroke="url(#idx-iris)" stroke-width="1.1" />
      </g>
      <ellipse cx="50" cy="98" rx="38" ry="24" fill="url(#idx-gloss)" />
      <ellipse cx="50" cy="16" rx="26" ry="9" fill="#ffffff" opacity="0.06" filter="url(#idx-haze)" />
      <circle cx="50" cy="50" r="50" fill="url(#idx-shade)" />
    </g>
    <circle cx="50" cy="50" r="49.3" fill="none" stroke="url(#idx-rim)" stroke-width="1.4" />
  </svg>
);

const IndexerBubble: Component = () => {
  // ── where the orb sits ─────────────────────────────────────────────────────
  const clampTo = (p: Pos): Pos => ({
    x: Math.max(PAD, Math.min(window.innerWidth - ORB - PAD, p.x)),
    y: Math.max(PAD, Math.min(window.innerHeight - ORB - PAD, p.y)),
  });
  const [pos, setPos] = createSignal<Pos>(
    (() => {
      for (const key of [POS_KEY, OLD_POS_KEY]) {
        try {
          const raw = localStorage.getItem(key);
          if (raw) {
            const p = JSON.parse(raw) as Pos;
            if (Number.isFinite(p.x) && Number.isFinite(p.y)) return clampTo(p);
          }
        } catch {
          /* unreadable — try the next, then the default corner */
        }
      }
      return { x: window.innerWidth - ORB - PAD, y: window.innerHeight - ORB - PAD };
    })(),
  );
  const [dragging, setDragging] = createSignal(false);

  const onOrbDown = (e: PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const from = pos();
    const sx = e.clientX;
    const sy = e.clientY;
    let moved = false;
    const move = (me: PointerEvent) => {
      // A few pixels of slop, so a click on the orb isn't read as a drag.
      if (!moved && Math.hypot(me.clientX - sx, me.clientY - sy) < 3) return;
      moved = true;
      setDragging(true);
      setPos(clampTo({ x: from.x + (me.clientX - sx), y: from.y + (me.clientY - sy) }));
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      setDragging(false);
      if (!moved) {
        setIndexerPanelOpen(!indexerPanelOpen());
        return;
      }
      try {
        localStorage.setItem(POS_KEY, JSON.stringify(pos()));
      } catch {
        /* private mode / quota — it just won't survive a restart */
      }
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  onMount(() => {
    const onResize = () => setPos((p) => clampTo(p));
    window.addEventListener("resize", onResize);
    onCleanup(() => window.removeEventListener("resize", onResize));
  });

  /** The panel opens beside the orb, toward whichever side has room. */
  const panelStyle = () => {
    const p = pos();
    const w = Math.min(PANEL_W, window.innerWidth - 2 * PAD);
    const h = Math.min(580, window.innerHeight - 2 * PAD);
    const right = p.x + ORB / 2 > window.innerWidth / 2;
    const below = p.y + ORB / 2 < window.innerHeight / 2;
    const x = right ? p.x + ORB - w : p.x;
    const y = below ? p.y + ORB + GAP : p.y - GAP - h;
    return {
      left: `${Math.max(PAD, Math.min(window.innerWidth - w - PAD, x))}px`,
      top: `${Math.max(PAD, Math.min(window.innerHeight - h - PAD, y))}px`,
      width: `${w}px`,
      "max-height": `${h}px`,
    };
  };

  // ── the index ──────────────────────────────────────────────────────────────
  const [status, setStatus] = createSignal<IndexerStatus | null>(null);
  const [note, setNote] = createSignal<string | null>(null);
  let statusT: number | undefined;
  let disposed = false;
  const refreshStatus = async (start: boolean) => {
    clearTimeout(statusT);
    try {
      // `indexer_reindex` only re-reads notes that changed, so opening the panel
      // is a fine moment to pick up what was written since.
      const s = await (start ? indexerReindex() : indexerStatus());
      if (disposed) return;
      setStatus(s);
      if (s.building && indexerPanelOpen())
        statusT = window.setTimeout(() => void refreshStatus(false), 1000);
    } catch (e) {
      setStatus(null);
      setNote(String(e));
    }
  };

  const statusLine = () => {
    const s = status();
    if (!s) return "";
    if (s.building) {
      if (!s.files_todo) return "Checking your notes and books for changes…";
      const at = s.current ? ` · ${s.current}` : "";
      return `Indexing ${s.files_done.toLocaleString()} of ${s.files_todo.toLocaleString()} files${at}`;
    }
    if (s.error) return s.error;
    if (!s.cards) return "Nothing indexed yet.";
    const count = (x: number, one: string) => `${x.toLocaleString()} ${one}${x === 1 ? "" : "s"}`;
    const from = [s.notes ? count(s.notes, "note") : "", s.books ? count(s.books, "book") : ""]
      .filter(Boolean)
      .join(" and ");
    const what = `${count(s.cards, "card")} from ${from}`;
    if (!s.semantic) return `${what} · keyword matching (pull ${s.embed_model} in Ollama for meaning)`;
    return s.pending ? `${what} · ${s.pending} waiting for ${s.embed_model}` : `${what} · ${s.embed_model}`;
  };

  // ── asking ─────────────────────────────────────────────────────────────────
  const [query, setQuery] = createSignal("");
  const SCOPE_KEY = "flux.indexer.scope";
  const [scope, setScopeRaw] = createSignal<IndexerScope>(
    (() => {
      try {
        const v = localStorage.getItem(SCOPE_KEY);
        return v === "notes" || v === "books" ? v : "all";
      } catch {
        return "all";
      }
    })(),
  );
  const [busy, setBusy] = createSignal<Busy>(null);
  const [results, setResults] = createSignal<IndexerResults | null>(null);
  /** Result indices in display order: Laya's decisive pick moves to the front. */
  const [order, setOrder] = createSignal<number[]>([]);
  const [page, setPage] = createSignal(0);
  const [pick, setPick] = createSignal<IndexerPick | null>(null);
  const [pickError, setPickError] = createSignal<string | null>(null);
  /** Bumped per question: an answer that lands after a newer question is stale. */
  let asked = 0;

  const current = createMemo<IndexerMatch | undefined>(() => {
    const i = order()[page()];
    return i == null ? undefined : results()?.matches[i];
  });
  /** Laya chose the card on screen, decisively. */
  const pickedHere = () => {
    const p = pick();
    return !!p && p.decisive && order()[page()] === p.index;
  };

  const ask = async (text: string) => {
    const q = text.trim();
    if (!q) return;
    const me = ++asked;
    setNote(null);
    setPick(null);
    setPickError(null);
    setBusy("searching");
    let res: IndexerResults;
    try {
      res = await indexerSearch(q, 5, scope());
    } catch (e) {
      if (me === asked) {
        setBusy(null);
        setNote(String(e));
      }
      return;
    }
    if (me !== asked) return;
    setResults(res);
    setOrder(res.matches.map((_, i) => i));
    setPage(0);
    if (!res.ambiguous || res.matches.length < 2) {
      setBusy(null);
      return;
    }
    // Not clearly one card: the System 1 model picks among the closest few.
    setBusy("deciding");
    try {
      const p = await indexerDecide(
        q,
        res.matches.map((m) => m.label),
      );
      if (me !== asked) return;
      setPick(p);
      if (p.decisive && p.index > 0) {
        setOrder([p.index, ...res.matches.map((_, i) => i).filter((i) => i !== p.index)]);
      }
    } catch (e) {
      if (me === asked) setPickError(String(e));
    } finally {
      if (me === asked) setBusy(null);
    }
  };

  const setScope = (s: IndexerScope) => {
    setScopeRaw(s);
    try {
      localStorage.setItem(SCOPE_KEY, s);
    } catch {
      /* private mode — it just won't stick */
    }
    if (query().trim()) void ask(query());
  };

  /** A book opens in Flux's PDF viewer at the passage's page; a note in the text
   *  editor. */
  const openMatch = (m: IndexerMatch) => {
    if (m.book) {
      setIndexerPanelOpen(false);
      void openTab("browser", `${pdfViewerUrl(m.path)}&page=${m.page ?? 1}`);
      return;
    }
    void openNote(m.path).catch((e) => setNote(String(e)));
  };

  const verdict = () => {
    const m = current();
    const r = results();
    if (!m || !r) return null;
    if (pickedHere())
      return { kind: "picked", text: `System 1 pick · ${pct(pick()!.probabilities[pick()!.index] ?? 0)}` };
    if (busy() === "deciding") return { kind: "deciding", text: "Not clear-cut — asking System 1…" };
    if (r.ambiguous && page() === 0) {
      if (pickError())
        return { kind: "unsure", text: `Uncertain match · System 1 unavailable (${pickError()})` };
      if (pick()) return { kind: "unsure", text: "Uncertain — System 1 couldn't separate the closest notes" };
    }
    if (m.confidence < 0.25) return { kind: "unsure", text: "No close match in your notes" };
    return null;
  };

  // ── listening ──────────────────────────────────────────────────────────────
  const [level, setLevel] = createSignal(0);
  let stopListening: ((send: boolean) => void) | null = null;

  const b64FromBytes = (bytes: Uint8Array) => {
    let s = "";
    const CH = 0x8000;
    for (let i = 0; i < bytes.length; i += CH) s += String.fromCharCode(...bytes.subarray(i, i + CH));
    return btoa(s);
  };

  /** Record one question: until a pause after speech, or the cap. Like the
   *  original, it ends itself, so asking is one click. */
  const listen = async () => {
    if (stopListening) {
      stopListening(true);
      return;
    }
    if (busy()) return;
    setNote(null);
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia(micConstraints({ echo: false }));
    } catch {
      setNote("Microphone access was denied.");
      return;
    }
    const ctx = new AudioContext();
    const rate = ctx.sampleRate;
    const src = ctx.createMediaStreamSource(stream);
    const node = ctx.createScriptProcessor(4096, 1, 1);
    const chunks: Float32Array[] = [];
    const started = performance.now();
    let spokeAt = 0;
    let lastLoud = 0;
    setBusy("listening");

    const finish = (send: boolean) => {
      if (!stopListening) return;
      stopListening = null;
      node.onaudioprocess = null;
      try {
        node.disconnect();
        src.disconnect();
      } catch {
        /* already gone */
      }
      stream.getTracks().forEach((t) => t.stop());
      void ctx.close();
      setLevel(0);
      setBusy(null);
      if (send && spokeAt) void transcribe(chunks, rate);
      else if (send) setNote("Didn't catch anything — try again, or type the question.");
    };
    stopListening = finish;
    node.onaudioprocess = (e) => {
      const data = e.inputBuffer.getChannelData(0);
      chunks.push(new Float32Array(data));
      let sum = 0;
      for (let i = 0; i < data.length; i++) sum += data[i]! * data[i]!;
      const rms = Math.sqrt(sum / data.length);
      setLevel(Math.min(1, rms * 12));
      const now = performance.now();
      if (rms > SPEECH_RMS) {
        lastLoud = now;
        if (!spokeAt) spokeAt = now;
      }
      if (spokeAt && now - lastLoud > TRAILING_SILENCE_MS) finish(true);
      else if (!spokeAt && now - started > NO_SPEECH_MS) finish(true);
      else if (now - started > MAX_LISTEN_MS) finish(true);
    };
    src.connect(node);
    node.connect(ctx.destination); // writes silence; needed for the callback to run
  };

  const transcribe = async (chunks: Float32Array[], rate: number) => {
    const len = chunks.reduce((n, c) => n + c.length, 0);
    const i16 = new Int16Array(len);
    let o = 0;
    for (const c of chunks) {
      for (let i = 0; i < c.length; i++) {
        const s = Math.max(-1, Math.min(1, c[i]!));
        i16[o++] = s < 0 ? s * 0x8000 : s * 0x7fff;
      }
    }
    setBusy("transcribing");
    let text = "";
    try {
      text = (await voiceTranscribe(b64FromBytes(new Uint8Array(i16.buffer)), rate)).trim();
    } catch (e) {
      setNote(String(e));
    } finally {
      setBusy(null);
    }
    if (!text) return;
    setQuery(text);
    void ask(text);
  };

  // ── open / close ───────────────────────────────────────────────────────────
  let input: HTMLInputElement | undefined;
  createEffect(
    on(indexerPanelOpen, (open) => {
      if (!open) {
        stopListening?.(false);
        clearTimeout(statusT);
        return;
      }
      void refreshStatus(true);
      // A cold System 1 load takes ~20 s; start it while the question is asked.
      void indexerWarm().catch(() => {});
      queueMicrotask(() => input?.focus());
    }),
  );

  const onKey = (e: KeyboardEvent) => {
    if (!indexerPanelOpen()) return;
    if (e.key === "Escape") {
      e.preventDefault();
      if (stopListening) stopListening(false);
      else setIndexerPanelOpen(false);
      return;
    }
    const typing = document.activeElement === input;
    const n = order().length;
    if (!typing && n > 1 && e.key === "ArrowRight") setPage((p) => (p + 1) % n);
    if (!typing && n > 1 && e.key === "ArrowLeft") setPage((p) => (p - 1 + n) % n);
  };
  onMount(() => {
    window.addEventListener("keydown", onKey);
    onCleanup(() => window.removeEventListener("keydown", onKey));
  });
  onCleanup(() => {
    disposed = true;
    asked++;
    clearTimeout(statusT);
    stopListening?.(false);
    setIndexerPanelOpen(false);
  });

  const [copied, setCopied] = createSignal(false);
  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    } catch (e) {
      setNote(String(e));
    }
  };

  const busyLine = () =>
    busy() === "listening"
      ? "Listening… pause when you're done"
      : busy() === "transcribing"
        ? "Transcribing…"
        : busy() === "searching"
          ? "Searching…"
          : statusLine();

  return (
    <>
      {/* Velvet Paper (design.ts) has no orb: "Ask your notes" in the right-hand
          column opens the panel, which App keeps mounted for that design. */}
      <Show when={design() !== "velvet-paper"}>
        <button
          classList={{
            "idx-orb": true,
            dragging: dragging(),
            open: indexerPanelOpen(),
            listening: busy() === "listening",
            thinking: busy() === "transcribing" || busy() === "searching" || busy() === "deciding",
          }}
          style={{ left: `${pos().x}px`, top: `${pos().y}px`, "--lvl": level().toFixed(3) }}
          title="Indexer — ask your notes (drag to move)"
          aria-label="Indexer: ask your notes"
          aria-expanded={indexerPanelOpen()}
          onPointerDown={onOrbDown}
          onKeyDown={(e) => {
            if (e.key !== "Enter" && e.key !== " ") return;
            e.preventDefault();
            setIndexerPanelOpen(!indexerPanelOpen());
          }}
        >
          <OrbArt />
        </button>
      </Show>

      <Show when={indexerPanelOpen() && design() === "velvet-paper"}>
        <Suspense>
          <IndexerSheet
            query={query}
            setQuery={setQuery}
            ask={(q) => void ask(q)}
            inputRef={(el) => (input = el)}
            scope={scope}
            setScope={setScope}
            status={status}
            reindex={() => void refreshStatus(true)}
            statusText={busyLine}
            note={note}
            listening={() => busy() === "listening"}
            listen={() => void listen()}
            close={() => setIndexerPanelOpen(false)}
            results={results}
            order={order}
            page={page}
            setPage={setPage}
            current={current}
            pickedHere={pickedHere}
            verdict={verdict}
            copied={copied}
            copy={(t) => void copy(t)}
            open={openMatch}
          />
        </Suspense>
      </Show>
      <Show when={indexerPanelOpen() && design() !== "velvet-paper"}>
        <section class="idx-panel glass" style={panelStyle()} role="dialog" aria-label="Indexer">
          <form
            class="idx-ask"
            onSubmit={(e) => {
              e.preventDefault();
              void ask(query());
            }}
          >
            <input
              ref={input}
              class="idx-input"
              placeholder="Ask your notes…"
              value={query()}
              spellcheck={false}
              onInput={(e) => setQuery(e.currentTarget.value)}
              onKeyDown={(e) => {
                // Chrome shortcuts must not fire while typing; Escape still closes.
                if (e.key !== "Escape") e.stopPropagation();
              }}
            />
            <button
              type="button"
              classList={{ "idx-mic": true, on: busy() === "listening" }}
              title={busy() === "listening" ? "Stop and ask" : "Ask out loud"}
              aria-label={busy() === "listening" ? "Stop listening" : "Ask out loud"}
              onClick={() => void listen()}
            >
              🎙
            </button>
            <button
              type="button"
              class="idx-close"
              title="Close (Esc)"
              onClick={() => setIndexerPanelOpen(false)}
            >
              ✕
            </button>
          </form>

          <div class="idx-tools">
            <div class="idx-scope" role="radiogroup" aria-label="Search in">
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
                    aria-checked={scope() === v}
                    classList={{ on: scope() === v }}
                    onClick={() => setScope(v)}
                  >
                    {label}
                  </button>
                )}
              </For>
            </div>
            <button
              class="idx-reindex"
              title="Reindex: read new and changed notes and books (also happens each time this opens)"
              aria-label="Reindex"
              disabled={!!status()?.building}
              onClick={() => void refreshStatus(true)}
            >
              ↻
            </button>
          </div>
          <div class="idx-status">{busyLine()}</div>
          <Show when={status()?.notice}>
            <div class="idx-status">{status()?.notice}</div>
          </Show>
          <Show when={note()}>
            <div class="idx-note">{note()}</div>
          </Show>

          <Show when={results()}>
            {(r) => (
              <Show
                when={current()}
                fallback={
                  <div class="idx-empty">
                    {r().matches.length ? "" : "Nothing in your notes or books matches that."}
                  </div>
                }
              >
                {(m) => (
                  <article class="idx-card">
                    <Show when={verdict()}>
                      {(v) => <div classList={{ "idx-verdict": true, [v().kind]: true }}>{v().text}</div>}
                    </Show>
                    <header class="idx-head">
                      <h3 class="idx-q">{m().question}</h3>
                      <div class="idx-meta">
                        <span class="idx-badge" title="Hybrid match: meaning and keywords">
                          {pct(m().confidence)}
                        </span>
                        <span class="idx-source" title={m().path}>
                          {m().source}
                        </span>
                      </div>
                    </header>
                    <Show when={m().key_points.length}>
                      <ul class="idx-points">
                        <For each={m().key_points}>{(k) => <li>{k}</li>}</For>
                      </ul>
                    </Show>
                    <div class="idx-answer">{m().answer}</div>
                    <footer class="idx-foot">
                      <Show when={order().length > 1}>
                        <div class="idx-pager">
                          <button
                            title="Previous match (←)"
                            onClick={() => setPage((p) => (p - 1 + order().length) % order().length)}
                          >
                            ‹
                          </button>
                          <span>
                            {page() + 1} of {order().length}
                          </span>
                          <button
                            title="Next match (→)"
                            onClick={() => setPage((p) => (p + 1) % order().length)}
                          >
                            ›
                          </button>
                        </div>
                      </Show>
                      <button class="idx-act" onClick={() => void copy(m().answer)}>
                        {copied() ? "Copied" : "Copy"}
                      </button>
                      <button class="idx-act" onClick={() => openMatch(m())}>
                        {m().book ? `Open p. ${m().page ?? 1}` : "Open note"}
                      </button>
                    </footer>
                  </article>
                )}
              </Show>
            )}
          </Show>
        </section>
      </Show>
    </>
  );
};

export default IndexerBubble;
