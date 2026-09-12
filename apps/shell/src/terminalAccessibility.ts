import { createSignal } from "solid-js";

// xterm exposes its viewport and live output only in screen-reader mode.
// Keep this optional for high-throughput TUIs and apply it to existing sessions.
const KEY = "flux.terminal.screen-reader";
const [terminalScreenReader, setTerminalScreenReaderSignal] = createSignal(localStorage.getItem(KEY) === "1");
export { terminalScreenReader };
export function setTerminalScreenReader(value: boolean): void {
  localStorage.setItem(KEY, value ? "1" : "0");
  setTerminalScreenReaderSignal(value);
}
