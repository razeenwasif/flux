/**
 * flux://speedtest — built-in network speed test (BACKLOG #108). Ookla-style
 * download / upload / latency + jitter against Cloudflare's public speedtest
 * backend. DOM-rendered (no webview). Streams phase progress while the test
 * runs; shows the four metrics on completion.
 */
import { Show, createSignal, onCleanup, onMount, type Component } from "solid-js";
import { netspeedRun, onNetspeedProgress, type SpeedResult } from "./ipc";
import { activeId, updateTabTitle } from "./store";
import type { UnlistenFn } from "@tauri-apps/api/event";

const PHASE_LABEL: Record<string, string> = {
  ping: "Measuring latency…",
  download: "Testing download…",
  upload: "Testing upload…",
  done: "Done",
};

const SpeedtestPage: Component = () => {
  const [running, setRunning] = createSignal(false);
  const [phase, setPhase] = createSignal<string>("");
  const [result, setResult] = createSignal<SpeedResult | null>(null);
  const [error, setError] = createSignal<string | null>(null);
  let unlisten: UnlistenFn | undefined;

  onMount(() => {
    const id = activeId();
    if (id != null) updateTabTitle(id, "Speed Test");
    void onNetspeedProgress(setPhase).then((u) => (unlisten = u));
    onCleanup(() => unlisten?.());
  });

  const run = async () => {
    if (running()) return;
    setRunning(true);
    setError(null);
    setResult(null);
    setPhase("ping");
    try {
      const r = await netspeedRun();
      if (r) setResult(r);
      else setError("No result — is the network reachable?");
    } catch (e) {
      setError(String(e));
    } finally {
      setRunning(false);
      setPhase("");
    }
  };

  const Metric = (props: { label: string; value: string; unit: string; accent?: boolean }) => (
    <div classList={{ "st-metric": true, accent: props.accent }}>
      <div class="st-metric-val">
        {props.value}
        <span class="st-metric-unit">{props.unit}</span>
      </div>
      <div class="st-metric-label">{props.label}</div>
    </div>
  );

  return (
    <div class="hist-page">
      <header class="hist-head">
        <div class="hist-title">⚡ Speed Test</div>
        <span class="res-mem">via speed.cloudflare.com</span>
      </header>

      <div class="hist-body st-body">
        <button classList={{ "st-run": true, running: running() }} disabled={running()} onClick={() => void run()}>
          {running() ? (PHASE_LABEL[phase()] ?? "Testing…") : result() ? "Test again" : "Start speed test"}
        </button>

        <Show when={running()}>
          <div class="st-phases">
            <span classList={{ "st-phase": true, active: phase() === "ping", done: phase() === "download" || phase() === "upload" || phase() === "done" }}>Latency</span>
            <span classList={{ "st-phase": true, active: phase() === "download", done: phase() === "upload" || phase() === "done" }}>Download</span>
            <span classList={{ "st-phase": true, active: phase() === "upload", done: phase() === "done" }}>Upload</span>
          </div>
        </Show>

        <Show when={error()}>
          <div class="st-error">{error()}</div>
        </Show>

        <Show when={result()}>
          {(r) => (
            <div class="st-results">
              <Metric label="Download" value={r().download_mbps.toFixed(1)} unit="Mbps" accent />
              <Metric label="Upload" value={r().upload_mbps.toFixed(1)} unit="Mbps" accent />
              <Metric label="Ping" value={r().ping_ms.toFixed(0)} unit="ms" />
              <Metric label="Jitter" value={r().jitter_ms.toFixed(0)} unit="ms" />
            </div>
          )}
        </Show>

        <Show when={!running() && !result() && !error()}>
          <div class="st-hint">Measures your real download/upload throughput and latency. Takes about 15 seconds.</div>
        </Show>
      </div>
    </div>
  );
};

export default SpeedtestPage;
