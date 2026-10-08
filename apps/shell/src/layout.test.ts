import { describe, expect, it } from "vitest";
import {
  EDITOR_MIN_PX,
  editorRatioAt,
  fitLayout,
  LAYOUT_PRESETS,
  layoutPresetFor,
  parseLayout,
} from "./layout";

const widths = { sidebar: 252, stack: 430, panel: 300, bars: 54, dock: 340, connect: 212 };
const all = {
  sidebar: true,
  agent: true,
  terminal: true,
  panel: true,
  bars: true,
  dock: true,
  connect: true,
  editor: true,
};
describe("reading space", () => {
  it("reserves the editor's share before allocating auxiliary columns", () => {
    const fit = fitLayout(1440, 560, 0.5, all, widths);
    expect(fit.editor).toBe(true);
    expect(fit.terminal).toBe(false);
    expect(fit.agent).toBe(false);
    const page = (1440 - widths.sidebar - (fit.bars ? widths.bars : 0) - 24) * 0.5 - 8;
    expect(page).toBeGreaterThanOrEqual(560);
  });
  it("gives split pages priority and restores panels when widened without changing intent", () => {
    const want = { ...all, editor: false };
    expect(fitLayout(1100, 960, 0.5, want, widths).sidebar).toBe(false);
    expect(fitLayout(1100, 960, 0.5, want, widths).terminal).toBe(false);
    expect(fitLayout(2800, 960, 0.5, want, widths)).toEqual(want);
    expect(want).toEqual({ ...all, editor: false });
  });
  it("charges the shared agent/terminal stack only once", () => {
    const fit = fitLayout(1300, 560, 0.5, { ...all, editor: false }, widths);
    expect(fit.agent && fit.terminal).toBe(true);
  });
  it("keeps the reserved page width across editor ratios and window sizes", () => {
    for (const width of [800, 1100, 1440, 1920, 2560]) {
      for (const ratio of [0.2, 0.5, 0.9]) {
        for (const minimum of [560, 960]) {
          if (width < minimum + 72 + 24) continue;
          const fit = fitLayout(width, minimum, ratio, all, widths);
          const fixed =
            (fit.sidebar ? widths.sidebar : 72) +
            (fit.agent || fit.terminal ? widths.stack : 0) +
            (fit.panel ? widths.panel : 0) +
            (fit.bars ? widths.bars : 0) +
            (fit.dock ? widths.dock : 0) +
            (fit.connect ? widths.connect : 0);
          const content = width - fixed - 24;
          const page = fit.editor ? content * (1 - ratio) - 8 : content;
          expect(page).toBeGreaterThanOrEqual(minimum - 0.01);
        }
      }
    }
  });
});
describe("editor seam", () => {
  // The page/editor row: the window minus every shell column fitLayout kept, and
  // ContentArea's 12px inset on each side.
  const rowFor = (width: number, fit: ReturnType<typeof fitLayout>) => ({
    left: (fit.sidebar ? widths.sidebar : 72) + 12,
    width:
      width -
      (fit.sidebar ? widths.sidebar : 72) -
      (fit.agent || fit.terminal ? widths.stack : 0) -
      (fit.panel ? widths.panel : 0) -
      (fit.bars ? widths.bars : 0) -
      (fit.dock ? widths.dock : 0) -
      (fit.connect ? widths.connect : 0) -
      24,
  });
  const wants = [all, { ...all, agent: false, terminal: false, panel: false, dock: false, connect: false }];

  it("can't drag the page below the width fitLayout reserves for it", () => {
    // The bug: the seam kept only 220px of page, so a drag past the page minimum
    // made fitLayout drop the editor column (and the seam with it) mid-gesture,
    // and the persisted ratio kept it hidden on every launch.
    for (const want of wants) {
      for (const width of [1100, 1440, 1920, 2560]) {
        for (const minimum of [560, 720, 960]) {
          const fit = fitLayout(width, minimum, 0.5, want, widths);
          if (!fit.editor) continue;
          const row = rowFor(width, fit);
          for (let x = row.left - 40; x <= row.left + row.width + 40; x += 4) {
            const ratio = editorRatioAt(row, x, minimum);
            expect(
              fitLayout(width, minimum, ratio, want, widths).editor,
              `${width}px ≥${minimum} x=${x}`,
            ).toBe(true);
            expect(row.width * (1 - ratio) - 8).toBeGreaterThanOrEqual(minimum - 0.01);
          }
        }
      }
    }
  });

  it("keeps the editor half usable too", () => {
    for (const rowWidth of [300, 900, 1600]) {
      const row = { left: 100, width: rowWidth };
      const min = Math.min(EDITOR_MIN_PX, rowWidth / 3);
      for (const x of [-1000, 100, 400, 1000, 5000]) {
        expect(editorRatioAt(row, x, 560) * rowWidth).toBeGreaterThanOrEqual(min - 0.01);
      }
    }
  });
});
describe("saved layouts", () => {
  it("round trips custom panels and rejects partial or corrupt saved state", () => {
    const custom = { ...LAYOUT_PRESETS.research.state, panelA: 42, editor: true };
    expect(parseLayout(JSON.stringify(custom))).toEqual(custom);
    expect(layoutPresetFor(custom)).toBe("custom");
    for (const value of [
      null,
      "{",
      "{}",
      JSON.stringify({ ...custom, editor: "false" }),
      JSON.stringify({ ...custom, panelA: -1 }),
    ]) {
      expect(parseLayout(value)).toBeNull();
    }
  });
});
