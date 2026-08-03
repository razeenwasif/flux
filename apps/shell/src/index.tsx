/* @refresh reload */
import { render } from "solid-js/web";
import App from "./App";
import { watchPalette } from "./palette";

// Perf mark for the TTI budget (< 50 ms after webview ready, ADR 0001).
performance.mark("flux:shell:start");

// Canvas and WebGL surfaces read the theme's colours as numbers; this drops the
// cache when the theme changes so they repaint in the new palette.
render(() => {
  watchPalette();
  return <App />;
}, document.getElementById("root")!);

performance.mark("flux:shell:interactive");
performance.measure("flux:tti", "flux:shell:start", "flux:shell:interactive");
