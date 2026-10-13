/* @refresh reload */
import { render } from "solid-js/web";
import App from "./App";
import { bootMark } from "./ipc";
import { watchPalette } from "./palette";

// Canvas and WebGL surfaces read the theme's colours as numbers; this drops the
// cache when the theme changes so they repaint in the new palette.
render(() => {
  watchPalette();
  return <App />;
}, document.getElementById("root")!);

// Boot timing (ADR 0001's TTI budget), in flux.log on the same clock as Rust's
// marks (boot.rs): a task queued from the next frame's callback runs once that
// frame, the shell's first, has been painted.
requestAnimationFrame(() => setTimeout(() => bootMark("first_paint")));
