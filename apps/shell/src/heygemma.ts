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

import { sttWhisper, voiceTranscribe, wakeTranscribe } from "./ipc";
import { pushAudio as pushPorcupine, startPorcupine, stopPorcupine } from "./porcupine";
import { micConstraints, micDeviceId, setMicDeviceId } from "./mic";
import { speak, speaking as ttsSpeaking, stopSpeaking } from "./speak";

const ENABLED_KEY = "flux.voice.heygemma";
// Recognition engine for the command utterance: "vosk" (fast) or "whisper" (more
// accurate, ~1–3 s). Wake detection always uses the fast Vosk pass.
const STT_KEY = "flux.voice.stt";
export const sttEngine = (): string => localStorage.getItem(STT_KEY) || "vosk";
export const setSttEngine = (e: string) => localStorage.setItem(STT_KEY, e);
// Wake-word engine: "vosk" (grammar spotting, zero setup), "whisper" (most
// accurate, slower — runs whisper on each utterance), or "porcupine".
const WAKE_KEY = "flux.voice.wake";
export const wakeEngine = (): string => localStorage.getItem(WAKE_KEY) || "vosk";
export const setWakeEngine = (e: string) => localStorage.setItem(WAKE_KEY, e);

const [enabled, setEnabledSig] = createSignal(localStorage.getItem(ENABLED_KEY) === "1");
export const heyGemmaEnabled = enabled;
/** Mic stream is open (chrome shows the live indicator). */
export const [micLive, setMicLive] = createSignal(false);
/** We're actively capturing / handling a command (vs. just armed for the wake word). */
export const [listening, setListening] = createSignal(false);
/** Short human-readable status for the indicator tooltip. */
export const [voiceStatus, setVoiceStatus] = createSignal("");

// The wake word + a few near-misses Vosk tends to emit for "gemma".
const WAKE = /\b(?:hey\s+)?(?:gemma|gems?|gema|jemma|gamma|gemini|hmm|a\s+german|jim)\b/i;
const SILENCE_S = 0.8; // trailing silence that ends an utterance (longer = less cut-off)
const MIN_SPEECH_S = 0.2; // ignore shorter blips (coughs, clicks)
const MAX_UTTER_S = 12; // hard cap on one utterance
const WARM_MS = 9000; // follow-up window after a reply (no wake word needed)
// Adaptive VAD: the speech threshold tracks the ambient noise floor instead of a
// fixed value, so it works across mics/gains (a fixed bar missed quiet mics).
const NOISE_MULT = 1.5; // speech = this many × the ambient floor … (lower = more sensitive)
const MIN_ABS = 0.003; // … but never less sensitive than this absolute floor
const PREROLL = 8; // frames kept before onset so the start of "hey" isn't clipped
// Barge-in: while Gemma is speaking, clearly-louder sustained speech stops her.
// Higher bar than normal VAD so residual TTS (echo-cancelled) doesn't self-trigger.
const BARGE_MULT = 4; // barge speech = this many × the ambient floor …
const BARGE_ABS = 0.018; // … or at least this absolute level
const BARGE_S = 0.22; // sustained for this long before cutting her off
let bargeLen = 0;

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
let porcupineOn = false; // dedicated wake-word model is running (vs. Vosk scan)
let noiseFloor = 0.01; // adaptive ambient RMS
let recent: Float32Array[] = []; // pre-roll ring (frames before speech onset)

function resetUtter() {
  speaking = false;
  speechLen = 0;
  silenceLen = 0;
  utter = [];
  recent = [];
}

function rms(frame: Float32Array): number {
  let s = 0;
  for (let i = 0; i < frame.length; i++) s += frame[i]! * frame[i]!;
  return Math.sqrt(s / frame.length);
}

function onAudio(e: AudioProcessingEvent) {
  const input = e.inputBuffer.getChannelData(0);
  const frame = new Float32Array(input); // copy (the buffer is reused)
  // Barge-in: while Gemma speaks, don't segment her own voice — instead watch for
  // the user talking over her, and cut her off if they do.
  if (ttsSpeaking()) {
    if (rms(frame) > Math.max(BARGE_ABS, noiseFloor * BARGE_MULT)) {
      bargeLen += frame.length;
      if (bargeLen > rate * BARGE_S) { bargeLen = 0; warmUntil = Date.now() + WARM_MS; stopSpeaking(); }
    } else {
      bargeLen = Math.max(0, bargeLen - frame.length);
    }
    return;
  }
  bargeLen = 0;
  if (gateClosed) return;
  if (porcupineOn) pushPorcupine(frame, rate); // dedicated wake model listens continuously
  const level = rms(frame);
  if (!speaking) {
    noiseFloor = noiseFloor * 0.97 + level * 0.03; // slowly track ambient
    recent.push(frame);
    if (recent.length > PREROLL) recent.shift();
  }
  const loud = level > Math.max(MIN_ABS, noiseFloor * NOISE_MULT);
  if (loud) {
    if (!speaking) {
      speaking = true; speechLen = 0; silenceLen = 0;
      utter = recent.slice(); // prepend pre-roll so the onset isn't clipped
      recent = [];
    }
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

/** Accurate command transcription: whisper if selected (fallback to Vosk), else Vosk. */
async function transcribeCommand(b64: string, voskText: string): Promise<string> {
  if (sttEngine() === "whisper") {
    try { const t = (await sttWhisper(b64, rate)).trim(); if (t) return t; } catch { /* fall through to Vosk */ }
  }
  if (voskText) return voskText;
  try { return (await voiceTranscribe(b64, rate)).trim(); } catch { return ""; }
}
function stripWake(text: string): string {
  const m = WAKE.exec(text);
  return m ? text.slice(m.index + m[0].length).replace(/^[,.:;\s]+/, "").trim() : text.trim();
}

// Porcupine fired: open the warm window so the next captured utterance is the
// command, and (if the user pauses rather than speaking it in one breath) ack.
function onPorcupineWake() {
  if (gateClosed) return; // ignore during our own speech / handling
  warmUntil = Date.now() + WARM_MS;
  setListening(true);
  setVoiceStatus("listening…");
  window.setTimeout(() => {
    if (gateClosed || speaking || Date.now() >= warmUntil) return; // one-breath command in progress
    gateClosed = true;
    void speak("Mm-hm?").finally(() => {
      resetUtter();
      window.setTimeout(() => { gateClosed = false; }, 250);
    });
  }, 500);
}

async function handleUtterance(chunks: Float32Array[]) {
  try {
    const b64 = toI16B64(chunks);
    const warm = Date.now() < warmUntil;

    // Wake detection (skipped in the warm follow-up window, and entirely when
    // Porcupine owns wake). Uses the grammar-restricted Vosk pass — it only
    // recognizes the wake phrase, so random speech rarely false-triggers.
    if (!warm) {
      if (porcupineOn) return; // Porcupine handles wake; a non-warm utterance isn't a command
      let detected = "";
      if (wakeEngine() === "whisper") {
        // Most accurate, slower — transcribe each utterance with whisper.
        try { detected = (await sttWhisper(b64, rate)).trim(); } catch { detected = ""; }
      }
      // Vosk grammar pass + full-model fallback. Also runs when whisper is selected
      // but returned nothing (not installed / blank on a short clip), so the wake
      // word never silently dies.
      if (!WAKE.test(detected)) {
        try { detected = (await wakeTranscribe(b64, rate)).trim(); } catch { /* keep */ }
      }
      if (!WAKE.test(detected)) {
        try { detected = (await voiceTranscribe(b64, rate)).trim(); } catch { /* keep */ }
      }
      if (!WAKE.test(detected)) return; // not addressed to Gemma → drop, nothing sent anywhere
    }

    setListening(true);
    setVoiceStatus("thinking…");
    // Command always comes from an accurate full transcription (Vosk or whisper);
    // strip any leading wake word so "hey gemma, play jazz" → "play jazz".
    const full = await transcribeCommand(b64, "");
    const command = warm ? full.trim() : stripWake(full);
    if (!command) {
      if (!warm) {
        setVoiceStatus("listening…");
        await speak("Mm-hm?"); // wake word alone → acknowledge, then wait for the command
      }
      warmUntil = Date.now() + WARM_MS; // the next utterance is the command
      return;
    }

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

/** Map a getUserMedia failure to a short, actionable reason. */
function micErrorText(e: unknown): string {
  const name = (e as { name?: string })?.name || "";
  if (name === "NotAllowedError" || name === "SecurityError") return "mic permission denied — allow it in Windows/site settings";
  if (name === "NotFoundError" || name === "OverconstrainedError") return "no microphone found";
  if (name === "NotReadableError") return "mic is busy — another app may be using it";
  return "couldn't start the microphone";
}

export async function startConversation(): Promise<boolean> {
  if (running) return true;
  if (!navigator.mediaDevices?.getUserMedia) {
    setVoiceStatus("no microphone access");
    return false;
  }
  try {
    // Honors the chosen mic + noise-suppression setting (Settings → Integrations);
    // echo cancellation on so barge-in doesn't hear Gemma's own voice.
    stream = await navigator.mediaDevices.getUserMedia(micConstraints({ echo: true }));
  } catch (e) {
    // A selected mic that's since been unplugged/changed fails the exact-deviceId
    // constraint — drop the dead selection and retry with the default device before
    // giving up (this is the usual "clicking does nothing" cause).
    if (micDeviceId()) {
      setMicDeviceId("");
      try {
        stream = await navigator.mediaDevices.getUserMedia(micConstraints({ echo: true }));
      } catch (e2) {
        setVoiceStatus(micErrorText(e2));
        return false;
      }
    } else {
      setVoiceStatus(micErrorText(e));
      return false;
    }
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
  // Dedicated wake model (if selected + configured); otherwise the Vosk scan runs.
  porcupineOn = wakeEngine() === "porcupine" ? await startPorcupine(onPorcupineWake) : false;
  setMicLive(true);
  setVoiceStatus("say “hey Gemma”");
  return true;
}

export function stopConversation(): void {
  running = false;
  stopSpeaking();
  if (porcupineOn) { porcupineOn = false; void stopPorcupine(); }
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
export async function setHeyGemmaEnabled(on: boolean): Promise<boolean> {
  localStorage.setItem(ENABLED_KEY, on ? "1" : "0");
  setEnabledSig(on);
  if (on) {
    const ok = await startConversation();
    if (!ok) { setEnabledSig(false); localStorage.setItem(ENABLED_KEY, "0"); }
    return ok;
  }
  stopConversation();
  return true;
}
