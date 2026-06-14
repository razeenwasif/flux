/* @refresh reload */
import { render } from "solid-js/web";
import App from "./App";

// Perf mark for the TTI budget (< 50 ms after webview ready, ADR 0001).
performance.mark("flux:shell:start");

render(() => <App />, document.getElementById("root")!);

performance.mark("flux:shell:interactive");
performance.measure("flux:tti", "flux:shell:start", "flux:shell:interactive");
