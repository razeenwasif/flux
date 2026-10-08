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
const porcupine = vi.hoisted(() => ({ pushAudio: vi.fn(), startPorcupine: vi.fn(), stopPorcupine: vi.fn() }));
vi.mock("./porcupine", () => porcupine);
vi.mock("./speak", () => ({ speak: vi.fn(async () => {}), speaking: () => false, stopSpeaking: vi.fn() }));

type Deferred<T> = { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void };
function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** A mic stream whose one track records whether it was stopped. */
const fakeStream = () => {
  const track = { stop: vi.fn() };
  return { getTracks: () => [track], track };
};

/** Each getUserMedia call parks here until the test resolves it, the way a
 *  permission prompt or a slow device open would. */
let gum: Deferred<ReturnType<typeof fakeStream>>[];
/** AudioContexts created, i.e. captures actually wired up. */
let contexts: number;
let store: Map<string, string>;

/** Let every pending continuation run. */
const settle = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  vi.resetModules();
  porcupine.startPorcupine.mockReset();
  porcupine.stopPorcupine.mockReset();
  store = new Map();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
  });
  gum = [];
  contexts = 0;
  vi.stubGlobal("navigator", {
    mediaDevices: {
      getUserMedia: () => {
        const d = deferred<ReturnType<typeof fakeStream>>();
        gum.push(d);
        return d.promise;
      },
    },
  });
  vi.stubGlobal(
    "AudioContext",
    class {
      sampleRate = 48000;
      destination = {};
      constructor() {
        contexts++;
      }
      createMediaStreamSource() {
        return { connect: () => {} };
      }
      createScriptProcessor() {
        return { connect: () => {}, disconnect: () => {}, onaudioprocess: null };
      }
      close() {
        return Promise.resolve();
      }
    },
  );
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

describe("turning the mic on and off", () => {
  it("a stop while the mic is still opening wins", async () => {
    const hg = await load();
    const on = hg.setHeyGemmaEnabled(true);
    await hg.setHeyGemmaEnabled(false); // e.g. a double-click on the toggle
    const s = fakeStream();
    gum[0]!.resolve(s);
    // Cancelled by the later toggle, which is not a failure to report.
    expect(await on).toBe(true);
    expect(hg.micLive()).toBe(false);
    expect(hg.heyGemmaEnabled()).toBe(false);
    expect(s.track.stop).toHaveBeenCalled();
    expect(contexts, "nothing should be listening").toBe(0);
  });

  it("on, off, on inside the window ends live, enabled, with one capture", async () => {
    const hg = await load();
    const first = hg.setHeyGemmaEnabled(true);
    await hg.setHeyGemmaEnabled(false);
    const third = hg.setHeyGemmaEnabled(true);
    const [s1, s2] = [fakeStream(), fakeStream()];
    gum[0]!.resolve(s1);
    gum[1]!.resolve(s2);
    expect(await first).toBe(true);
    expect(await third).toBe(true);
    expect(hg.micLive()).toBe(true);
    expect(hg.heyGemmaEnabled()).toBe(true);
    expect(s1.track.stop).toHaveBeenCalled();
    expect(s2.track.stop).not.toHaveBeenCalled();
    expect(contexts).toBe(1);
  });

  it("two concurrent starts open one capture, not an unstoppable second one", async () => {
    const hg = await load();
    const a = hg.startConversation();
    const b = hg.startConversation();
    const [s1, s2] = [fakeStream(), fakeStream()];
    gum[0]!.resolve(s1);
    gum[1]!.resolve(s2);
    expect(await a).toBe(true);
    expect(await b).toBe(true);
    expect(contexts).toBe(1);
    expect(s2.track.stop).toHaveBeenCalled();
    hg.stopConversation();
    expect(s1.track.stop).toHaveBeenCalled();
  });

  it("a stop during the Porcupine load releases the worker and stays off", async () => {
    store.set("flux.voice.wake", "porcupine");
    const model = deferred<boolean>();
    porcupine.startPorcupine.mockImplementation(() => model.promise);
    const hg = await load();
    const start = hg.startConversation();
    gum[0]!.resolve(fakeStream());
    await settle();
    expect(porcupine.startPorcupine).toHaveBeenCalled();
    hg.stopConversation();
    model.resolve(true);
    expect(await start).toBe(false);
    expect(porcupine.stopPorcupine).toHaveBeenCalled();
    expect(hg.micLive()).toBe(false);
  });

  it("still reports a real microphone failure", async () => {
    const hg = await load();
    const on = hg.setHeyGemmaEnabled(true);
    gum[0]!.reject(Object.assign(new Error("denied"), { name: "NotAllowedError" }));
    expect(await on).toBe(false);
    expect(hg.heyGemmaEnabled()).toBe(false);
    expect(store.get("flux.voice.heygemma")).toBe("0");
  });
});
