import { describe, expect, it, vi } from "vitest";

import { parseDoc, wordHits } from "./ScribeDoc";

// Importing a Solid component registers its delegated events on
// `window.document`, which Node doesn't have.
vi.hoisted(() => {
  const document = { addEventListener: () => {} };
  vi.stubGlobal("document", document);
  vi.stubGlobal("window", { document });
});

describe("parseDoc", () => {
  it("opens a page the agent wrote", () => {
    // `Page::document` (an approved "new page" note) stores `{"html": …}` with
    // no `v`. Reading that as blank meant the first keystroke saved the blank
    // over the note.
    const html = "<h1>Limits</h1><p>Squeeze theorem.</p>";
    expect(parseDoc(JSON.stringify({ html }))).toEqual({ v: 2, html, objects: [] });
  });

  it("round-trips what the editor writes", () => {
    const doc = {
      v: 2 as const,
      html: "<p>a</p>",
      objects: [{ id: "ink-1", src: "data:image/png;base64,AA", x: 48, y: 64, w: 320, h: 200 }],
    };
    expect(parseDoc(JSON.stringify(doc))).toEqual(doc);
  });

  it("keeps a malformed field out of the editor", () => {
    expect(parseDoc(JSON.stringify({ v: 2, html: "<p>x</p>", objects: "nope" })).objects).toEqual([]);
    expect(parseDoc(JSON.stringify({ v: 2, html: 7 })).html).toBe("");
  });

  it("reads nothing into empty or unreadable content", () => {
    for (const raw of ["", "{}", "null", "not json", "42", JSON.stringify({ title: "x" })]) {
      expect(parseDoc(raw), raw).toEqual({ v: 2, html: "", objects: [] });
    }
  });

  it("still upgrades a pre-document stroke array", () => {
    const legacy = [{ t: "text", color: "#fff", size: 18, at: { x: 0, y: 10 }, text: "a\nb" }];
    expect(parseDoc(JSON.stringify(legacy))).toEqual({ v: 2, html: "<p>a<br>b</p>", objects: [] });
  });
});

describe("where a proofread fix applies", () => {
  it("only matches whole words", () => {
    // A raw first match turned "units" into "unit's" for an its → it's fix, and
    // "therefore" into "theirfore" for there → their.
    expect(wordHits("All units are SI.", "its")).toEqual([]);
    expect(wordHits("the function and its derivative", "its")).toEqual([17]);
    expect(wordHits("therefore there is", "there")).toEqual([10]);
    expect(wordHits("Calculus: a apple", "a")).toEqual([10]);
  });

  it("knows letters beyond ASCII", () => {
    expect(wordHits("café", "caf")).toEqual([]);
    expect(wordHits("Gödel numbering", "numbering")).toEqual([6]);
  });

  it("needs no boundary at an edge that is punctuation", () => {
    expect(wordHits("e.g. this", "e.g.")).toEqual([0]);
    expect(wordHits("a ,b", " ,")).toEqual([1]);
  });

  it("reports every copy, so a repeated word can be refused", () => {
    expect(wordHits("its tail and its bone", "its")).toEqual([0, 13]);
    expect(wordHits("its its its", "its", 2)).toEqual([0, 4]);
    expect(wordHits("anything", "")).toEqual([]);
  });
});
