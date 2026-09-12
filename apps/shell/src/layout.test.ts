import { describe, expect, it } from "vitest";
import { fitLayout, LAYOUT_PRESETS, layoutPresetFor, parseLayout } from "./layout";

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
