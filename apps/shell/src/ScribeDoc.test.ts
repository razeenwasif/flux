import { describe, expect, it, vi } from "vitest";

import { parseDoc } from "./ScribeDoc";

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
