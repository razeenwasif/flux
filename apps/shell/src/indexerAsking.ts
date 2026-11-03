/**
 * One question to the Indexer, typed or spoken (#196): what the orb's panel and
 * the floating answer card (IndexerHud) both do. Rank, let System 1 pick when
 * it isn't clear-cut, and say how sure the card on screen is. Each caller has
 * its own instance and draws it its own way.
 */
import { createMemo, createSignal } from "solid-js";
import {
  indexerDecide,
  indexerSearch,
  type IndexerMatch,
  type IndexerPick,
  type IndexerResults,
  type IndexerScope,
} from "./indexer";
import { voiceTranscribe } from "./ipc";
import { micConstraints } from "./mic";

export type Busy = "listening" | "transcribing" | "searching" | "deciding" | null;

/** Speech louder than this (RMS of a 4096-sample block) counts as talking. */
const SPEECH_RMS = 0.02;
/** This much quiet after speech ends the question. */
const TRAILING_SILENCE_MS = 1200;
/** Give up if nothing is said for this long, and stop any question at the cap. */
const NO_SPEECH_MS = 6000;
const MAX_LISTEN_MS = 15000;

export const pct = (x: number) => `${Math.round(x * 100)}%`;

const SCOPE_KEY = "flux.indexer.scope";
export const readScope = (): IndexerScope => {
  try {
    const v = localStorage.getItem(SCOPE_KEY);
    return v === "notes" || v === "books" ? v : "all";
  } catch {
    return "all";
  }
};
export const saveScope = (s: IndexerScope) => {
  try {
    localStorage.setItem(SCOPE_KEY, s);
  } catch {
    /* private mode — it just won't stick */
  }
};

const b64FromBytes = (bytes: Uint8Array) => {
  let s = "";
  const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) s += String.fromCharCode(...bytes.subarray(i, i + CH));
  return btoa(s);
};

export function createAsking(scope: () => IndexerScope) {
  const [query, setQuery] = createSignal("");
  const [busy, setBusy] = createSignal<Busy>(null);
  const [note, setNote] = createSignal<string | null>(null);
  const [results, setResults] = createSignal<IndexerResults | null>(null);
  /** Result indices in display order: Laya's decisive pick moves to the front. */
  const [order, setOrder] = createSignal<number[]>([]);
  const [page, setPage] = createSignal(0);
  const [pick, setPick] = createSignal<IndexerPick | null>(null);
  const [pickError, setPickError] = createSignal<string | null>(null);
  const [level, setLevel] = createSignal(0);
  /** Bumped per question: an answer that lands after a newer question is stale. */
  let asked = 0;
  let stopListening: ((send: boolean) => void) | null = null;

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
      // Ten, the most the Indexer gives: with notes, textbooks and a course's
      // slides all on one topic, five left the slides just off the end.
      res = await indexerSearch(q, 10, scope());
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

  /** Record one question: until a pause after speech, or the cap. Like the
   *  original, it ends itself, so asking is one click. Called while it's
   *  listening, it stops and asks. */
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

  /** Drop what's being said without asking. False when nothing was. */
  const cancelListening = () => {
    if (!stopListening) return false;
    stopListening(false);
    return true;
  };

  /** How sure the card on screen is, when that needs saying. */
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

  /** The owner is gone: nothing in flight may land, and the mic goes off. */
  const dispose = () => {
    asked++;
    cancelListening();
  };

  return {
    query,
    setQuery,
    busy,
    note,
    setNote,
    results,
    order,
    page,
    setPage,
    level,
    current,
    pickedHere,
    ask,
    listen,
    cancelListening,
    verdict,
    dispose,
  };
}
