import { describe, expect, it, vi } from "vitest";

import { texToNodes } from "./mathblock";

// Just enough of the DOM for `mathNode`, which builds an element per equation.
vi.stubGlobal("document", { createElement: (tag: string) => ({ tagName: tag.toUpperCase(), dataset: {} }) });

/** Text stays text; an equation reads as I(tex) inline or D(tex) display. */
const show = (text: string) =>
  texToNodes(text).map((p) =>
    typeof p === "string" ? p : `${p.dataset.display ? "D" : "I"}(${p.dataset.tex})`,
  );

/** Type `text` one key at a time the way the editor sees it (ScribeDoc's
 *  onInput), returning what the first conversion made — or null if none did. */
const typed = (text: string) => {
  for (let i = 1; i <= text.length; i++) {
    const sofar = text.slice(0, i);
    if (!/\$[^$\n]+\$/.test(sofar)) continue;
    const parts = show(sofar);
    if (parts.some((p) => /^[DI]\(/.test(p))) return parts;
  }
  return null;
};

describe("typed maths", () => {
  it("waits for the closing $$ of display maths", () => {
    // One key early, "$$x^2$" used to become "$" + inline x^2, and the last "$"
    // then landed as a stray dollar after it.
    expect(show("$$x^2$")).toEqual(["$$x^2$"]);
    expect(typed("$$x^2$$")).toEqual(["D(x^2)"]);
  });

  it("leaves prices alone", () => {
    expect(typed("Tickets cost between $10 and $20.")).toBeNull();
    expect(typed("costs $5 or $6")).toBeNull();
    expect(show("$20,000 and $30,000")).toEqual(["$20,000 and $30,000"]);
  });

  it("still converts real maths", () => {
    expect(show("$x$ and $y$")).toEqual(["I(x)", " and ", "I(y)"]);
    expect(show("a $$\\int x$$ b")).toEqual(["a ", "D(\\int x)", " b"]);
    expect(typed("so $a^2+b^2$ holds")).toEqual(["so ", "I(a^2+b^2)"]);
  });
});
