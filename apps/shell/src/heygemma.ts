// "Hey Gemma" — always-on, fully-local voice conversation.
//
// How it works: one mic stream is VAD-segmented into utterances (speech bounded by
// silence). Each finished utterance is transcribed locally (Vosk, reusing the
// push-to-talk path). While *armed* we only act on an utterance that contains the
// wake word "gemma" — anything else is discarded immediately (never sent to the
// agent, never stored). After the wake word we enter a short *warm* window where
// follow-ups need no wake word, so you can keep talking. The injected handler runs
// the transcript through the same pipeline as typed input and returns the reply,
// which we speak.
//
// Privacy by construction:
//   • STT + TTS + the LLM are all local — no audio/text leaves the device.
//   • Audio lives only in transient buffers (GC'd); nothing is written to disk.
//   • Pre-wake utterances are dropped the moment they don't match the wake word.
//   • The mic is *gated shut* while Gemma is speaking, so it can't hear itself.
//   • Off by default; a visible indicator + a hard toggle are always present.

import { createSignal } from "solid-js";

import { voiceTranscribe } from "./ipc";
import { speak, stopSpeaking } from "./speak";

const ENABLED_KEY = "flux.voice.heygemma";

const [enabled, setEnabledSig] = createSignal(localStorage.getItem(ENABLED_KEY) === "1");
export const heyGemmaEnabled = enabled;
/** Mic stream is open (chrome shows the live indicator). */
export const [micLive, setMicLive] = createSignal(false);
/** We're actively capturing / handling a command (vs. just armed for the wake word). */
export const [listening, setListening] = createSignal(false);
/** Short human-readable status for the indicator tooltip. */
export const [voiceStatus, setVoiceStatus] = createSignal("");

// The wake word + a few near-misses Vosk tends to emit for "gemma".
const WAKE = /\b(?:hey\s+)?(?:gemma|gema|gemini|jemma|gamma)\b/i;
const THRESH = 0.014; // RMS speech threshold
const SILENCE_S = 0.8; // trailing silence that ends an utterance
const MIN_SPEECH_S = 0.32; // ignore shorter blips (coughs, clicks)
const MAX_UTTER_S = 12; // hard cap on one utterance
const WARM_MS = 9000; // follow-up window after a reply (no wake word needed)

let onCommand: ((t: string) => Promise<string>) | null = null;
/** AgentPanel injects how a transcript is handled (returns the text to speak). */
export function setVoiceHandler(fn: (t: string) => Promise<string>): void {
  onCommand = fn;
}

let stream: MediaStream | null = null;
let ctx: AudioContext | null = null;
let node: ScriptProcessorNode | null = null;
let rate = 48000;
let running = false;

// VAD/segmenter state
let speaking = false; // inside an utterance
let speechLen = 0; // samples of actual speech in the current utterance
let silenceLen = 0; // trailing silence samples
let utter: Float32Array[] = [];
let gateClosed = false; // dropped while we transcribe/think/speak (no self-hearing)
let warmUntil = 0; // timestamp: follow-ups accepted without the wake word

function resetUtter() {
  speaking = false;
  speechLen = 0;
  silenceLen = 0;
  utter = [];
}

function rms(frame: Float32Array): number {
  let s = 0;
  for (let i = 0; i < frame.length; i++) s += frame[i]! * frame[i]!;
  return Math.sqrt(s / frame.length);
}

function onAudio(e: AudioProcessingEvent) {
  if (gateClosed) return;
  const input = e.inputBuffer.getChannelData(0);
  const frame = new Float32Array(input); // copy (the buffer is reused)
  const loud = rms(frame) > THRESH;
  if (loud) {
    if (!speaking) { speaking = true; speechLen = 0; silenceLen = 0; utter = []; }
    utter.push(frame);
    speechLen += frame.length;
    silenceLen = 0;
  } else if (speaking) {
    utter.push(frame);
    silenceLen += frame.length;
  }
  const total = utter.reduce((n, c) => n + c.length, 0);
  const ended = speaking && (silenceLen > rate * SILENCE_S || total > rate * MAX_UTTER_S);
  if (ended) {
    const captured = utter;
    const speechSamples = speechLen;
    resetUtter();
    if (speechSamples >= rate * MIN_SPEECH_S) {
      gateClosed = true; // stop capturing until we've handled this one
      void handleUtterance(captured);
    }
  }
}

function toI16B64(chunks: Float32Array[]): string {
  const len = chunks.reduce((n, c) => n + c.length, 0);
  const i16 = new Int16Array(len);
  let o = 0;
  for (const c of chunks) {
    for (let i = 0; i < c.length; i++) {
      const s = Math.max(-1, Math.min(1, c[i]!));
      i16[o++] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
  }
  const bytes = new Uint8Array(i16.buffer);
  let str = "";
  const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) str += String.fromCharCode(...bytes.subarray(i, i + CH));
  return btoa(str);
}

async function handleUtterance(chunks: Float32Array[]) {
  try {
    let text = "";
    try {
      text = (await voiceTranscribe(toI16B64(chunks), rate)).trim();
    } catch {
      text = "";
    }
    if (!text) return;

    const warm = Date.now() < warmUntil;
    const wake = WAKE.exec(text);
    let command = "";
    if (warm) {
      command = text; // follow-up: no wake word needed
    } else if (wake) {
      // Strip the wake word; whatever follows on the same breath is the command.
      command = text.slice(wake.index + wake[0].length).replace(/^[,.:;\s]+/, "").trim();
      if (!command) {
        setListening(true);
        setVoiceStatus("listening…");
        await speak("Mm-hm?"); // acknowledge, then wait for the command utterance
        warmUntil = Date.now() + WARM_MS; // the next utterance is the command
        return;
      }
    } else {
      return; // not addressed to Gemma → drop, nothing sent anywhere
    }

    setListening(true);
    setVoiceStatus("thinking…");
    const reply = onCommand ? await onCommand(command) : "";
    if (reply) {
      setVoiceStatus("speaking…");
      await speak(reply);
    }
    warmUntil = Date.now() + WARM_MS; // stay warm for a follow-up
  } finally {
    // Small cooldown so the tail of our own TTS doesn't re-trigger capture.
    setListening(false);
    setVoiceStatus(running ? "say “hey Gemma”" : "");
    resetUtter();
    setTimeout(() => { gateClosed = false; }, 250);
  }
}

export async function startConversation(): Promise<boolean> {
  if (running) return true;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
  } catch {
    setVoiceStatus("mic denied");
    return false;
  }
  ctx = new AudioContext();
  rate = ctx.sampleRate;
  const src = ctx.createMediaStreamSource(stream);
  node = ctx.createScriptProcessor(4096, 1, 1);
  node.onaudioprocess = onAudio;
  src.connect(node);
  node.connect(ctx.destination);
  running = true;
  gateClosed = false;
  warmUntil = 0;
  resetUtter();
  setMicLive(true);
  setVoiceStatus("say “hey Gemma”");
  return true;
}

export function stopConversation(): void {
  running = false;
  stopSpeaking();
  try { node?.disconnect(); } catch { /* ignore */ }
  stream?.getTracks().forEach((t) => t.stop());
  void ctx?.close();
  node = null;
  ctx = null;
  stream = null;
  resetUtter();
  setMicLive(false);
  setListening(false);
  setVoiceStatus("");
}

/** Toggle the feature (persisted). Starts/stops the mic loop. */
export async function setHeyGemmaEnabled(on: boolean): Promise<void> {
  localStorage.setItem(ENABLED_KEY, on ? "1" : "0");
  setEnabledSig(on);
  if (on) {
    const ok = await startConversation();
    if (!ok) { setEnabledSig(false); localStorage.setItem(ENABLED_KEY, "0"); }
  } else {
    stopConversation();
  }
}
