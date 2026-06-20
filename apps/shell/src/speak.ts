// Gemma's voice (TTS). Two fully-local engines, no cloud either way:
//   • "system" — the webview's built-in speechSynthesis (OS voices). Zero deps.
//   • "piper"  — local neural TTS via the backend `voice_speak` (Piper subprocess),
//                falling back to the system voice if Piper isn't installed.
// Privacy: nothing here touches the network; text is synthesized on-device.

import { voiceSpeak } from "./ipc";

export type TtsEngine = "system" | "piper";
const ENGINE_KEY = "flux.voice.tts";
export const ttsEngine = (): TtsEngine => (localStorage.getItem(ENGINE_KEY) as TtsEngine) || "system";
export const setTtsEngine = (e: TtsEngine) => localStorage.setItem(ENGINE_KEY, e);

let current: HTMLAudioElement | null = null;

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
}

function speakSystem(text: string): Promise<void> {
  return new Promise((resolve) => {
    try {
      const u = new SpeechSynthesisUtterance(text);
      u.rate = 1.02;
      u.onend = () => resolve();
      u.onerror = () => resolve();
      window.speechSynthesis.speak(u);
    } catch { resolve(); }
  });
}

function playWavB64(b64: string): Promise<void> {
  return new Promise((resolve) => {
    const a = new Audio(`data:audio/wav;base64,${b64}`);
    current = a;
    const done = () => { if (current === a) current = null; resolve(); };
    a.onended = done;
    a.onerror = done;
    void a.play().catch(done);
  });
}

/** Speak `text`, resolving when the audio finishes. Honours the engine setting. */
export async function speak(text: string): Promise<void> {
  const t = cleanForSpeech(text);
  if (!t) return;
  stopSpeaking();
  if (ttsEngine() === "piper") {
    try {
      const b64 = await voiceSpeak(t);
      await playWavB64(b64);
      return;
    } catch { /* Piper missing/failed → fall back to the OS voice */ }
  }
  await speakSystem(t);
}
