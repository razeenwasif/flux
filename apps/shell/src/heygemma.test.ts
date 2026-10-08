/**
 * "Hey Gemma" acts on what it hears without a confirmation step (music, search
 * tabs, memory, reminders), so the two things that decide WHETHER it acts are
 * pinned here: the wake match, and the mic's on/off state.
 *
 * The module reads localStorage at load and drives the mic through browser
 * APIs the suite (node) doesn't have, so those are stubbed and each test loads
 * a fresh copy, as clocks.test.ts does.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Transcription and the Porcupine worker are irrelevant here and would drag in
// the Tauri IPC surface.
vi.mock("./ipc", () => ({ sttWhisper: vi.fn(), voiceTranscribe: vi.fn(), wakeTranscribe: vi.fn() }));
vi.mock("./porcupine", () => ({ pushAudio: vi.fn(), startPorcupine: vi.fn(), stopPorcupine: vi.fn() }));
vi.mock("./speak", () => ({ speak: vi.fn(async () => {}), speaking: () => false, stopSpeaking: vi.fn() }));

beforeEach(() => {
  vi.resetModules();
  const store = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const load = async () => await import("./heygemma");

describe("wake word", () => {
  it("wakes on the wake word opening the utterance, as Vosk and Whisper write it", async () => {
    const { WAKE } = await load();
    for (const t of [
      "hey gemma",
      "gemma",
      "hey gems",
      "gem",
      "hey gemma play some jazz",
      "Hey, Gemma, play some jazz.",
      " Okay Gemma, skip this one",
      "Hi Gemma.",
      "jemma what time is it",
    ]) {
      expect(WAKE.test(t), t).toBe(true);
    }
  });

  it("ignores the word in passing, and fillers", async () => {
    const { WAKE } = await load();
    for (const t of [
      "i asked gemini to summarise it",
      "hmm i think we should remember that the deadline moved",
      "Hmm.",
      "the gamma distribution then play the recording",
      "tell jim the build is green",
    ]) {
      expect(WAKE.test(t), t).toBe(false);
    }
  });

  it("strips the greeting so the command's own intent matches", async () => {
    const { stripWake } = await load();
    expect(stripWake("Hey, Gemma, play some jazz.")).toBe("play some jazz.");
    expect(stripWake("gemma: remind me to stretch at 3pm")).toBe("remind me to stretch at 3pm");
    expect(stripWake("hey gemma")).toBe("");
    // Not addressed at the start: nothing to strip.
    expect(stripWake("play music by jim croce")).toBe("play music by jim croce");
  });
});
