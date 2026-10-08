/**
 * Stop has to stop. The audio element signals a deliberate stop the same way
 * it signals a broken clip (clearing `src` fires `error`), so the Web Audio
 * fallback used to replay the whole reply after Stop or a barge-in, with
 * `speaking` already false and nothing left to interrupt it.
 *
 * Runs in node, so the media APIs are fakes that follow the browser's rules
 * where it matters, and synthesis is a promise each test resolves.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ipc = vi.hoisted(() => ({ voiceSpeak: vi.fn(), elevenlabsSpeak: vi.fn(), fishaudioSpeak: vi.fn() }));
vi.mock("./ipc", () => ipc);

type Deferred<T> = { promise: Promise<T>; resolve: (v: T) => void };
function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((res) => (resolve = res));
  return { promise, resolve };
}

/** An HTMLAudioElement that plays until told otherwise. Like the media load
 *  algorithm, setting an empty `src` fails resource selection and fires `error`. */
class FakeAudio {
  static made: FakeAudio[] = [];
  preload = "";
  error: { code: number; message: string } | null = null;
  onended: (() => void) | null = null;
  onerror: (() => void) | null = null;
  private url: string;
  constructor(url: string) {
    this.url = url;
    FakeAudio.made.push(this);
  }
  get src() {
    return this.url;
  }
  set src(v: string) {
    this.url = v;
    if (v === "") {
      this.error = { code: 4, message: "" };
      setTimeout(() => this.onerror?.(), 0);
    }
  }
  play() {
    return Promise.resolve();
  }
  pause() {}
}

/** Web Audio contexts created, i.e. times the fallback started a replay. */
let contexts: number;
/** When set, the fallback's decode waits on it. */
let decoding: Deferred<unknown> | null;
const settle = () => new Promise((r) => setTimeout(r, 0));
const CLIP = btoa("RIFF....WAVEfmt ");

beforeEach(() => {
  vi.resetModules();
  FakeAudio.made = [];
  contexts = 0;
  decoding = null;
  for (const f of Object.values(ipc)) f.mockReset();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => (k === "flux.voice.tts" ? "piper" : null),
    setItem: () => {},
  });
  vi.stubGlobal("Audio", FakeAudio);
  vi.stubGlobal(
    "AudioContext",
    class {
      state = "running";
      destination = {};
      constructor() {
        contexts++;
      }
      resume() {
        return Promise.resolve();
      }
      decodeAudioData() {
        return decoding ? decoding.promise : Promise.resolve({});
      }
      createBufferSource() {
        const src = {
          buffer: null,
          onended: null as (() => void) | null,
          connect() {},
          // A short clip; on a closed context nothing renders, so it never ends.
          start: () => {
            if (this.state !== "closed") setTimeout(() => src.onended?.(), 0);
          },
          stop() {},
        };
        return src;
      }
      close() {
        this.state = "closed";
        return Promise.resolve();
      }
    },
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const load = async () => await import("./speak");

describe("stopping speech", () => {
  it("Stop mid-clip ends it, with no Web Audio replay", async () => {
    ipc.voiceSpeak.mockResolvedValue(CLIP);
    const sp = await load();
    const done = sp.speak("Transformers are a neural network architecture.");
    await settle();
    expect(FakeAudio.made).toHaveLength(1);
    expect(sp.speaking()).toBe(true);
    sp.stopSpeaking();
    await done;
    expect(contexts, "the clip was replayed through Web Audio").toBe(0);
    expect(sp.speaking()).toBe(false);
  });

  it("Stop during synthesis means the clip never plays", async () => {
    const synth = deferred<string>();
    ipc.voiceSpeak.mockImplementation(() => synth.promise);
    const sp = await load();
    const done = sp.speak("A long answer that takes a while to synthesise.");
    sp.stopSpeaking();
    synth.resolve(CLIP);
    await settle();
    expect(FakeAudio.made).toHaveLength(0);
    await done;
    expect(sp.speaking()).toBe(false);
  });

  it("a newer reply keeps the speaking flag, and the older clip never plays", async () => {
    const first = deferred<string>();
    const second = deferred<string>();
    ipc.voiceSpeak.mockImplementationOnce(() => first.promise).mockImplementationOnce(() => second.promise);
    const sp = await load();
    const a = sp.speak("The first reply.");
    const b = sp.speak("A reminder that fired meanwhile.");
    first.resolve(CLIP); // the older synthesis finishes late
    await settle();
    expect(FakeAudio.made).toHaveLength(0);
    await a;
    expect(sp.speaking(), "the older speak() cleared the newer one's flag").toBe(true);
    second.resolve(CLIP);
    await settle();
    expect(FakeAudio.made).toHaveLength(1);
    FakeAudio.made[0]!.onended?.();
    await b;
    expect(sp.speaking()).toBe(false);
  });

  it("Stop while the fallback is decoding settles instead of hanging", async () => {
    ipc.voiceSpeak.mockResolvedValue(CLIP);
    decoding = deferred<unknown>();
    const sp = await load();
    let finished = false;
    const done = sp.speak("Hello.").then(() => (finished = true));
    await settle();
    FakeAudio.made[0]!.onerror?.(); // the element can't play it: Web Audio takes over
    await settle();
    sp.stopSpeaking(); // closes the fallback's context mid-decode
    decoding.resolve({});
    await settle();
    await settle();
    expect(finished, "speak() never settled, so the voice loop stays deaf").toBe(true);
    await done;
    expect(sp.speaking()).toBe(false);
  });

  it("a real playback failure still falls back to Web Audio", async () => {
    ipc.voiceSpeak.mockResolvedValue(CLIP);
    const sp = await load();
    const done = sp.speak("Hello.");
    await settle();
    FakeAudio.made[0]!.onerror?.(); // e.g. a codec the element can't play
    await done;
    expect(contexts).toBe(1);
    expect(sp.speaking()).toBe(false);
  });
});
