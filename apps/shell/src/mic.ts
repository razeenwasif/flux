// Shared microphone settings for the voice paths (always-on + push-to-talk).
// Lets you pick the input device and toggle noise suppression — the two most
// common causes of poor recognition. autoGainControl stays on (normalizes level);
// echoCancellation is on where barge-in needs it.

export const micDeviceId = (): string => localStorage.getItem("flux.voice.mic") || "";
export const setMicDeviceId = (id: string) => localStorage.setItem("flux.voice.mic", id);

// Default OFF: browser noise suppression is tuned for human listening and tends to
// degrade whisper/Vosk. Turn it on only if you're in a noisy room and it helps.
export const noiseSuppress = (): boolean => localStorage.getItem("flux.voice.ns") === "1";
export const setNoiseSuppress = (on: boolean) => localStorage.setItem("flux.voice.ns", on ? "1" : "0");

/** Build getUserMedia constraints honoring the chosen device + processing. */
export function micConstraints(opts?: { echo?: boolean }): MediaStreamConstraints {
  const audio: MediaTrackConstraints = {
    echoCancellation: opts?.echo ?? true,
    noiseSuppression: noiseSuppress(),
    autoGainControl: true,
  };
  const id = micDeviceId();
  if (id) audio.deviceId = { exact: id };
  return { audio };
}

/** Available audio-input devices (labels populate only after mic permission). */
export async function micDevices(): Promise<{ id: string; label: string }[]> {
  try {
    const ds = await navigator.mediaDevices.enumerateDevices();
    return ds
      .filter((d) => d.kind === "audioinput" && d.deviceId)
      .map((d, i) => ({ id: d.deviceId, label: d.label || `Microphone ${i + 1}` }));
  } catch {
    return [];
  }
}
