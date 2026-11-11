/**
 * Full screen around the notch (⌥⌘F, notch.rs). The window covers the whole
 * screen with the menu bar and Dock hidden. The columns beside the notch run
 * to the top; the one it sits over (`.under-notch`, usually the page) starts
 * below it, and the strip either side of the notch carries the tab's title
 * on the left and the time on the right, as the menu bar's clock is hidden.
 * Loaded on the first ⌥⌘F: nothing here is needed to paint.
 */
import { invoke } from "@tauri-apps/api/core";
import { createEffect, createRoot } from "solid-js";

import "./notch.css";

type Geometry = { band: number; gap_x: number; gap_w: number };

let geom: Geometry | null = null;
let undo: (() => void) | null = null;

const clock = () => new Date().toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });

/** Mark the column the notch sits over and lay the strip out around it. */
function mark(shell: HTMLElement, band: HTMLElement) {
  const g = geom;
  const cols = [...shell.children].filter(
    (el): el is HTMLElement => el instanceof HTMLElement && el !== band,
  );
  cols.forEach((el) => el.classList.remove("under-notch"));
  if (!g || g.gap_w <= 0) {
    band.hidden = true;
    return;
  }
  const end = g.gap_x + g.gap_w;
  let under: DOMRect | null = null;
  for (const el of cols) {
    const cs = getComputedStyle(el);
    if (cs.position === "absolute" || cs.position === "fixed" || cs.display === "none") continue;
    const r = el.getBoundingClientRect();
    if (r.width > 0 && r.left < end && r.right > g.gap_x) {
      el.classList.add("under-notch");
      if (!under || r.width > under.width) under = r;
    }
  }
  if (!under) {
    band.hidden = true;
    return;
  }
  band.hidden = false;
  const [left, right] = band.children as unknown as [HTMLElement, HTMLElement];
  // Each half from the column's edge to the notch, with a little air beside it.
  left.style.left = `${under.left}px`;
  left.style.width = `${Math.max(0, g.gap_x - under.left - 14)}px`;
  right.style.left = `${end + 14}px`;
  right.style.width = `${Math.max(0, under.right - end - 14)}px`;
}

/** Around the notch, or back. `title` is the active tab's title. Resolves
 *  with whether it's on now. */
export async function toggleNotch(title: () => string): Promise<boolean> {
  const shell = document.querySelector<HTMLElement>(".shell");
  if (!shell) return false;
  if (undo) {
    undo();
    undo = null;
    geom = null;
    await invoke("window_notch", { on: false, keepMenuBar: false }).catch(() => {});
    return false;
  }
  // Settings → Appearance: keep the menu bar pinned, the window below it.
  let keepMenuBar = false;
  try {
    keepMenuBar = localStorage.getItem("flux.notch.menuBar") === "1";
  } catch {
    /* the default */
  }
  geom = await invoke<Geometry | null>("window_notch", { on: true, keepMenuBar }).catch(() => null);
  if (!geom) return false;

  shell.classList.add("notched");
  shell.style.setProperty("--notch-band", `${geom.band}px`);
  const band = document.createElement("div");
  band.className = "notch-band";
  band.setAttribute("aria-hidden", "true");
  band.innerHTML = '<span class="notch-left"></span><span class="notch-right"></span>';
  shell.append(band);
  const [left, right] = band.children as unknown as [HTMLElement, HTMLElement];

  const relayout = () => mark(shell, band);
  // The frame changes as the window grows to the screen, and columns open
  // and close: mark again whenever the window or the grid changes.
  const grid = new MutationObserver(relayout);
  grid.observe(shell, { attributes: true, attributeFilter: ["style", "class"] });
  addEventListener("resize", relayout);
  const settle = setTimeout(relayout, 250);
  relayout();

  right.textContent = clock();
  const tick = setInterval(() => (right.textContent = clock()), 15_000);
  const stopTitle = createRoot((dispose) => {
    createEffect(() => (left.textContent = title()));
    return dispose;
  });

  undo = () => {
    stopTitle();
    clearInterval(tick);
    clearTimeout(settle);
    grid.disconnect();
    removeEventListener("resize", relayout);
    band.remove();
    shell.classList.remove("notched");
    shell.style.removeProperty("--notch-band");
    shell.querySelectorAll(".under-notch").forEach((el) => el.classList.remove("under-notch"));
  };
  return true;
}
