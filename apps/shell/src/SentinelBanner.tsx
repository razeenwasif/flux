/**
 * Sentinel phishing/impersonation warning (ADR 0013, Pillar 1). A chrome-layer
 * strip above the content card — the page can't draw over it (native-webview
 * overlay constraint), so it's un-spoofable. Advisory, never a hard block: it
 * explains the resemblance and offers a safe exit, but the user can dismiss.
 * High confidence is loud (red); Low is an amber heads-up.
 */
import { For, type Component } from "solid-js";

import type { PhishVerdict } from "./ipc";

const SentinelBanner: Component<{
  verdict: PhishVerdict;
  onLeave: () => void;
  onDismiss: () => void;
}> = (props) => {
  const high = () => props.verdict.confidence === "High";
  return (
    <div class="sentinel-banner" classList={{ high: high() }} role="alert">
      <span class="sentinel-ico">{high() ? "⚠" : "⚠"}</span>
      <div class="sentinel-body">
        <div class="sentinel-title">
          {high() ? "This site may be impersonating " : "This site resembles "}
          <b>{props.verdict.resembles}</b>
        </div>
        <div class="sentinel-reasons">
          <For each={props.verdict.reasons}>{(r) => <span>{r}</span>}</For>
        </div>
      </div>
      <div class="sentinel-actions">
        <button class="sentinel-leave" onClick={() => props.onLeave()}>
          Leave site
        </button>
        <button class="sentinel-dismiss" onClick={() => props.onDismiss()} aria-label="Dismiss">
          {high() ? "Ignore" : "×"}
        </button>
      </div>
    </div>
  );
};

export default SentinelBanner;
