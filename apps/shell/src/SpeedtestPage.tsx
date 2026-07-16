/**
 * flux://speedtest — built-in network speed test (BACKLOG #108). Ookla-style
 * dial gauges for download / upload (log-scaled, 0–1000 Mbps) plus ping + jitter,
 * against Cloudflare's public speedtest backend. The download dial animates live
 * from streamed interim throughput; upload + ping fill in on completion.
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

// Log map so 0–1000 Mbps spreads nicely around the dial (100 ≈ ⅔ of the arc).
const fracOf = (v: number) => (v <= 0 ? 0 : Math.min(1, Math.log10(v + 1) / Math.log10(1001)));

const Gauge: Component<{ value: number; label: string; color: string; active: boolean }> = (props) => {
  const R = 54;
  const C = 2 * Math.PI * R;
  const TRACK = 0.75 * C; // 270° gauge
  const len = () => fracOf(props.value) * TRACK;
  return (
    <div classList={{ "st-gauge": true, active: props.active }}>
      <svg viewBox="0 0 120 120" class="st-gauge-svg">
        <circle
          cx="60"
          cy="60"
          r={R}
          class="st-gauge-track"
          stroke-dasharray={`${TRACK} ${C}`}
          transform="rotate(135 60 60)"
        />
        <circle
          cx="60"
          cy="60"
          r={R}
          class="st-gauge-fill"
          stroke={props.color}
          stroke-dasharray={`${len().toFixed(2)} ${C}`}
          transform="rotate(135 60 60)"
        />
        <text x="60" y="58" class="st-gauge-num">
          {props.value >= 100 ? props.value.toFixed(0) : props.value.toFixed(1)}
        </text>
        <text x="60" y="74" class="st-gauge-unit">
          Mbps
        </text>
      </svg>
      <div class="st-gauge-label">{props.label}</div>
    </div>
  );
};

const SpeedtestPage: Component = () => {
  const [running, setRunning] = createSignal(false);
  const [phase, setPhase] = createSignal("");
  const [liveDown, setLiveDown] = createSignal(0);
  const [result, setResult] = createSignal<SpeedResult | null>(null);
  const [error, setError] = createSignal<string | null>(null);
  let unlisten: UnlistenFn | undefined;

  onMount(() => {
    const id = activeId();
    if (id != null) updateTabTitle(id, "Speed Test");
    void onNetspeedProgress((p) => {
      setPhase(p.phase);
      if (p.phase === "download" && p.mbps > 0) setLiveDown(p.mbps);
    }).then((u) => (unlisten = u));
    onCleanup(() => unlisten?.());
  });

  const run = async () => {
    if (running()) return;
    setRunning(true);
    setError(null);
    setResult(null);
    setLiveDown(0);
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

  const downValue = () => result()?.download_mbps ?? liveDown();
  const upValue = () => result()?.upload_mbps ?? 0;

  return (
    <div class="hist-page">
      <header class="hist-head">
        <div class="hist-title">⚡ Speed Test</div>
        <span class="res-mem">via speed.cloudflare.com</span>
      </header>

      <div class="hist-body st-body">
        <div class="st-gauges">
          <Gauge
            value={downValue()}
            label="↓ Download"
            color="var(--flux-teal)"
            active={phase() === "download"}
          />
          <Gauge value={upValue()} label="↑ Upload" color="#9a7bff" active={phase() === "upload"} />
        </div>

        <div class="st-stats">
          <div class="st-stat">
            <span class="st-stat-val">{result() ? result()!.ping_ms.toFixed(0) : "—"}</span>
            <span class="st-stat-lbl">Ping (ms)</span>
          </div>
          <div class="st-stat">
            <span class="st-stat-val">{result() ? result()!.jitter_ms.toFixed(0) : "—"}</span>
            <span class="st-stat-lbl">Jitter (ms)</span>
          </div>
        </div>

        <button
          classList={{ "st-run": true, running: running() }}
          disabled={running()}
          onClick={() => void run()}
        >
          {running() ? (PHASE_LABEL[phase()] ?? "Testing…") : result() ? "Test again" : "Start speed test"}
        </button>

        <Show when={error()}>
          <div class="st-error">{error()}</div>
        </Show>
        <Show when={!running() && !result() && !error()}>
          <div class="st-hint">
            Measures your real download/upload throughput and latency. Takes about 15 seconds.
          </div>
        </Show>
      </div>
    </div>
  );
};

export default SpeedtestPage;
