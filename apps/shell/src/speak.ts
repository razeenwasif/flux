// Gemma's voice (TTS). Two fully-local engines, no cloud either way:
//   • "system" — the webview's built-in speechSynthesis (OS voices). Zero deps.
//   • "piper"  — local neural TTS via the backend `voice_speak` (Piper subprocess),
//                falling back to the system voice if Piper isn't installed.
// Privacy: nothing here touches the network; text is synthesized on-device.

import { elevenlabsSpeak, voiceSpeak } from "./ipc";

export type TtsEngine = "system" | "piper" | "elevenlabs";
const ENGINE_KEY = "flux.voice.tts";
export const ttsEngine = (): TtsEngine => (localStorage.getItem(ENGINE_KEY) as TtsEngine) || "system";
export const setTtsEngine = (e: TtsEngine) => localStorage.setItem(ENGINE_KEY, e);

// ElevenLabs voice + model (not secret — the API key lives in the OS keyring).
const EL_VOICE_KEY = "flux.voice.el.voice";
const EL_MODEL_KEY = "flux.voice.el.model";
export const elVoiceId = (): string => localStorage.getItem(EL_VOICE_KEY) || "";
export const setElVoiceId = (id: string) => localStorage.setItem(EL_VOICE_KEY, id);
export const elModel = (): string => localStorage.getItem(EL_MODEL_KEY) || "eleven_turbo_v2_5";
export const setElModel = (m: string) => localStorage.setItem(EL_MODEL_KEY, m);

// Which speechSynthesis voice to use ("" = auto-pick a female English voice so it
// matches Gemma). The Settings dropdown stores an exact voice name here.
const VOICE_KEY = "flux.voice.name";
export const preferredVoice = (): string => localStorage.getItem(VOICE_KEY) || "";
export const setPreferredVoice = (name: string) => localStorage.setItem(VOICE_KEY, name);

let cachedVoices: SpeechSynthesisVoice[] = [];
/** Available OS voices (populates asynchronously on some platforms). */
export function loadVoices(): SpeechSynthesisVoice[] {
  try { cachedVoices = window.speechSynthesis?.getVoices() ?? []; } catch { /* no synth */ }
  return cachedVoices;
}
try { window.speechSynthesis?.addEventListener?.("voiceschanged", () => loadVoices()); } catch { /* ignore */ }
loadVoices();

// Names that signal a female voice across Windows / macOS / Linux / Chromium.
const FEMALE = /aria|jenny|zira|hazel|natasha|sonia|libby|michelle|clara|amy|emma|eva|ava|samantha|susan|fiona|google us english|female|woman/i;
/** Pick Gemma's voice: the user's choice if set, else a natural female English one. */
function pickVoice(): SpeechSynthesisVoice | null {
  const voices = cachedVoices.length ? cachedVoices : loadVoices();
  if (!voices.length) return null;
  const want = preferredVoice();
  if (want) {
    const exact = voices.find((v) => v.name === want);
    if (exact) return exact;
  }
  const en = voices.filter((v) => /^en(-|\b)/i.test(v.lang));
  const pool = en.length ? en : voices;
  const female = pool.filter((v) => FEMALE.test(v.name));
  const natural = female.filter((v) => /natural|neural|online|premium/i.test(v.name));
  return natural[0] || female[0] || pool[0] || null;
}

let current: HTMLAudioElement | null = null;
let currentUrl: string | null = null;

/** Strip emoji / markdown so the voice reads clean prose, not "asterisk asterisk". */
export function cleanForSpeech(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " code block ")
    .replace(/[*_`#>]+/g, "")
    .replace(/\[(.*?)\]\(.*?\)/g, "$1")
    .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function stopSpeaking(): void {
  try { window.speechSynthesis?.cancel(); } catch { /* no synth */ }
  if (current) { try { current.pause(); } catch { /* ignore */ } current.src = ""; current = null; }
  if (currentUrl) { URL.revokeObjectURL(currentUrl); currentUrl = null; }
}

function speakSystem(text: string): Promise<void> {
  return new Promise((resolve) => {
    try {
      const u = new SpeechSynthesisUtterance(text);
      const v = pickVoice();
      if (v) { u.voice = v; u.lang = v.lang; }
      u.rate = 1.02;
      u.pitch = 1.05; // a touch brighter — reads as a warmer female voice
      u.onend = () => resolve();
      u.onerror = () => resolve();
      window.speechSynthesis.speak(u);
    } catch { resolve(); }
  });
}

function audioError(a: HTMLAudioElement, fallback: string): Error {
  const media = a.error;
  const detail = media ? `code=${media.code}${media.message ? ` ${media.message}` : ""}` : fallback;
  return new Error(`audio playback failed (${detail})`);
}

function audioUrlFromB64(b64: string, mime: string): string {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
  return URL.createObjectURL(new Blob([bytes], { type: mime }));
}

function playAudioB64(b64: string, mime: string, rejectOnError = false): Promise<void> {
  return new Promise((resolve, reject) => {
    if (currentUrl) { URL.revokeObjectURL(currentUrl); currentUrl = null; }
    const url = audioUrlFromB64(b64, mime);
    currentUrl = url;
    const a = new Audio(url);
    a.preload = "auto";
    current = a;
    const cleanup = () => {
      if (current === a) current = null;
      if (currentUrl === url) { URL.revokeObjectURL(url); currentUrl = null; }
    };
    const done = () => { cleanup(); resolve(); };
    const fail = (err: unknown) => {
      cleanup();
      if (rejectOnError) {
        reject(err instanceof Error ? err : audioError(a, String(err || "unknown")));
      } else {
        console.warn("[flux] TTS audio playback failed", err);
        resolve();
      }
    };
    a.onended = done;
    a.onerror = () => fail(audioError(a, "media error"));
    void a.play().catch(fail);
  });
}

/** Preview ElevenLabs directly and surface configuration/API errors to Settings. */
export async function previewElevenLabs(text: string): Promise<void> {
  const t = cleanForSpeech(text);
  if (!t) return;
  stopSpeaking();
  const b64 = await elevenlabsSpeak(t, elVoiceId(), elModel());
  await playAudioB64(b64, "audio/mpeg", true);
}

/** Speak `text`, resolving when the audio finishes. Honours the engine setting. */
export async function speak(text: string): Promise<void> {
  const t = cleanForSpeech(text);
  if (!t) return;
  stopSpeaking();
  const engine = ttsEngine();
  if (engine === "piper") {
    try {
      const b64 = await voiceSpeak(t);
      await playAudioB64(b64, "audio/wav");
      return;
    } catch { /* Piper missing/failed → fall back to the OS voice */ }
  } else if (engine === "elevenlabs") {
    try {
      const b64 = await elevenlabsSpeak(t, elVoiceId(), elModel());
      await playAudioB64(b64, "audio/mpeg");
      return;
    } catch { /* no key / network / quota → fall back to the OS voice */ }
  }
  await speakSystem(t);
}
