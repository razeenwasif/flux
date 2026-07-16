// Porcupine wake-word detection (dedicated model) for "Hey Gemma".
//
// Runs the Porcupine Web SDK in the renderer, fed 16 kHz / 512-sample frames from
// the same mic pipeline as the rest of the voice loop — so detection stays local
// (no audio leaves the device) and we keep one mic stream. The SDK is dynamically
// imported, so its WASM only loads when the user actually enables Porcupine.
//
// Config (access key in the OS keyring; .ppn keyword + .pv model file paths) comes
// from the backend `porcupine_config`. The user generates a custom "Hey Gemma"
// .ppn on the Picovoice console (free) and downloads porcupine_params.pv.

import type { PorcupineWorker } from "@picovoice/porcupine-web";

import { porcupineConfig } from "./ipc";

const PPN_KEY = "flux.voice.porcupine.ppn";
const PV_KEY = "flux.voice.porcupine.pv";
export const porcupinePpnPath = (): string => localStorage.getItem(PPN_KEY) || "";
export const setPorcupinePpnPath = (p: string) => localStorage.setItem(PPN_KEY, p);
export const porcupinePvPath = (): string => localStorage.getItem(PV_KEY) || "";
export const setPorcupinePvPath = (p: string) => localStorage.setItem(PV_KEY, p);

let worker: PorcupineWorker | null = null;
let resid = new Float32Array(0);

/** Start detection; returns false (and stays off) if it isn't configured/usable. */
export async function startPorcupine(onWake: () => void): Promise<boolean> {
  if (worker) return true;
  let cfg: { accessKey: string; keywordB64: string; modelB64: string };
  try {
    cfg = await porcupineConfig(porcupinePpnPath(), porcupinePvPath());
  } catch {
    return false; // no key / missing files → caller falls back to Vosk wake
  }
  try {
    const { PorcupineWorker } = await import("@picovoice/porcupine-web");
    worker = await PorcupineWorker.create(
      cfg.accessKey,
      { base64: cfg.keywordB64, label: "Hey Gemma" },
      () => onWake(),
      { base64: cfg.modelB64 },
    );
  } catch {
    worker = null;
    return false;
  }
  resid = new Float32Array(0);
  return true;
}

/** Nearest-neighbour downsample to 16 kHz (fine for wake detection). */
function downsampleTo16k(frame: Float32Array, inRate: number): Float32Array {
  if (inRate === 16_000) return frame;
  const ratio = inRate / 16_000;
  const outLen = Math.floor(frame.length / ratio);
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) out[i] = frame[Math.floor(i * ratio)]!;
  return out;
}

/** Feed one mic frame; chunks into 512-sample Int16 frames for Porcupine. */
export function pushAudio(frame: Float32Array, inRate: number): void {
  const w = worker;
  if (!w) return;
  const fl = w.frameLength; // 512
  const ds = downsampleTo16k(frame, inRate);
  const merged = new Float32Array(resid.length + ds.length);
  merged.set(resid);
  merged.set(ds, resid.length);
  let off = 0;
  while (merged.length - off >= fl) {
    const i16 = new Int16Array(fl);
    for (let i = 0; i < fl; i++) {
      const s = Math.max(-1, Math.min(1, merged[off + i]!));
      i16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    w.process(i16);
    off += fl;
  }
  resid = merged.slice(off);
}

export async function stopPorcupine(): Promise<void> {
  const w = worker;
  worker = null;
  resid = new Float32Array(0);
  if (w) {
    try {
      await w.release();
    } catch {
      /* ignore */
    }
    try {
      w.terminate();
    } catch {
      /* ignore */
    }
  }
}

export function porcupineRunning(): boolean {
  return !!worker;
}
