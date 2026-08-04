import { describe, expect, it } from "vitest";

import { DEFAULT_SCALE, emptyState, keyFor, parseState } from "./pdfstate";

describe("pdf reading state", () => {
  it("keys documents by source, stably and distinctly", () => {
    expect(keyFor("/home/me/paper.pdf")).toBe(keyFor("/home/me/paper.pdf"));
    expect(keyFor("/home/me/paper.pdf")).not.toBe(keyFor("/home/me/other.pdf"));
    expect(keyFor("x")).toMatch(/^flux\.pdf\./);
  });

  it("round-trips a real state", () => {
    const s = {
      page: 42,
      scale: 1.6,
      bookmarks: [{ id: 1, page: 7, label: "Proof of Lemma 3", ms: 100 }],
      comments: [{ id: 2, page: 9, text: "check this against Rudin", ms: 200 }],
    };
    expect(parseState(JSON.stringify(s))).toEqual(s);
  });

  // Everything below is the reason this module exists as a separate unit: the
  // input is localStorage, which anything can have written.
  it("falls back to defaults on junk rather than throwing", () => {
    for (const junk of [null, "", "not json", "[]", '"a string"', "null", "123"]) {
      expect(() => parseState(junk)).not.toThrow();
    }
    expect(parseState("not json")).toEqual(emptyState());
    // A bare array is an object, but has none of the fields.
    expect(parseState("[]").page).toBe(1);
  });

  it("clamps a stored scale into the viewer's own zoom range", () => {
    // A 400x page is a canvas allocation big enough to hang the tab.
    expect(parseState('{"scale":400}').scale).toBe(4);
    expect(parseState('{"scale":0.001}').scale).toBe(0.4);
    expect(parseState('{"scale":"big"}').scale).toBe(DEFAULT_SCALE);
    expect(parseState('{"scale":null}').scale).toBe(DEFAULT_SCALE);
  });

  it("never yields a page below 1, and rounds fractional pages", () => {
    expect(parseState('{"page":0}').page).toBe(1);
    expect(parseState('{"page":-5}').page).toBe(1);
    expect(parseState('{"page":3.7}').page).toBe(4);
    expect(parseState('{"page":"7"}').page).toBe(1);
  });

  it("drops malformed entries instead of the whole list", () => {
    const raw = JSON.stringify({
      bookmarks: [{ id: 1, page: 2, label: "keep", ms: 0 }, { id: 2, page: 3 }, null, "nope", 7],
      comments: [
        { id: 9, page: 1, text: "keep me", ms: 0 },
        { id: 8, page: 1 },
      ],
    });
    const s = parseState(raw);
    expect(s.bookmarks.map((b) => b.label)).toEqual(["keep"]);
    expect(s.comments.map((c) => c.text)).toEqual(["keep me"]);
  });

  it("defaults a missing id/ms rather than dropping an otherwise good note", () => {
    const s = parseState(JSON.stringify({ bookmarks: [{ page: 4, label: "no id" }] }));
    expect(s.bookmarks).toEqual([{ id: 0, page: 4, label: "no id", ms: 0 }]);
  });
});
