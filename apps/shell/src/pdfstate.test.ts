import { afterEach, describe, expect, it, vi } from "vitest";

import {
  DEFAULT_SCALE,
  emptyState,
  keyFor,
  loadDocState,
  parseState,
  pruneUnsavedPdfs,
  saveDocState,
  saveNotes,
  savePosition,
  stashUnsavedPdf,
  takeUnsavedPdf,
  viewerSrc,
} from "./pdfstate";

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

describe("viewer src", () => {
  // What `pdfViewerUrl` (ipc.ts) produces.
  const viewerUrl = (src: string) => `flux://pdf?src=${encodeURIComponent(src)}`;

  it("hands back exactly the src the viewer was opened with", () => {
    for (const src of [
      // A presigned link: decoding twice turned the token's %2B into "+", a 403.
      "https://bucket.s3.amazonaws.com/notes.pdf?X-Amz-Security-Token=IQo%2BAbC%2Fxyz%3D%3D&X-Amz-Signature=ab",
      "https://example.org/Week%201.pdf",
      "/Users/me/Q3 50%2B growth.pdf",
      "/Users/me/100% done.pdf",
      "/Users/me/what?#1.pdf",
      "C:\\Users\\me\\a.pdf",
    ]) {
      expect(viewerSrc(viewerUrl(src))).toBe(src);
    }
    expect(viewerSrc("flux://pdf")).toBe("");
  });

  it("decodes a file:// src to the path it names", () => {
    // Files → "Open in browser" sends a percent-encoded file URL, and pdf_fetch only undoes %20.
    expect(viewerSrc(viewerUrl("file:///Users/me/Bob%E2%80%99s%20R%C3%A9sum%C3%A9.pdf"))).toBe(
      "file:///Users/me/Bob’s Résumé.pdf",
    );
    expect(viewerSrc(viewerUrl("file:///Users/me/%231%20report.pdf"))).toBe("file:///Users/me/#1 report.pdf");
  });
});

describe("stored state", () => {
  const stored = new Map<string, string>();
  afterEach(() => {
    stored.clear();
    vi.unstubAllGlobals();
  });
  const stubStorage = () =>
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => stored.get(k) ?? null,
      setItem: (k: string, v: string) => void stored.set(k, v),
      removeItem: (k: string) => void stored.delete(k),
    });

  it("stays under the key it had before the src stopped being double-decoded", () => {
    stubStorage();
    const note = { id: 1, page: 3, label: "Lemma 2", ms: 5 };
    // Saved by the old viewer, which keyed by the twice-decoded src.
    stored.set(keyFor("https://example.org/Week 1.pdf"), JSON.stringify({ page: 3, bookmarks: [note] }));
    expect(loadDocState("https://example.org/Week%201.pdf").bookmarks).toEqual([note]);

    saveDocState("https://example.org/Week%201.pdf", { ...emptyState(), page: 7 });
    expect(JSON.parse(stored.get(keyFor("https://example.org/Week 1.pdf"))!).page).toBe(7);
    // A file:// src arrives decoded already (see viewerSrc) and is keyed as is.
    saveDocState("file:///Users/me/50%2B.pdf", { ...emptyState(), page: 2 });
    expect(stored.has(keyFor("file:///Users/me/50%2B.pdf"))).toBe(true);
  });

  it("lets two viewers of one file write without erasing each other's notes", () => {
    // Split view: A adds a comment; B, which loaded before it, then turns a page.
    stubStorage();
    const src = "/Users/me/paper.pdf";
    const c1 = { id: 1, page: 2, text: "check eq. 3", ms: 1 };
    saveNotes(src, [], [c1]);
    savePosition(src, 9, 1.5);
    expect(loadDocState(src)).toEqual({ page: 9, scale: 1.5, bookmarks: [], comments: [c1] });
    // …and a notes write keeps the position.
    const b1 = { id: 2, page: 4, label: "Page 4", ms: 2 };
    saveNotes(src, [b1], [c1]);
    expect(loadDocState(src)).toEqual({ page: 9, scale: 1.5, bookmarks: [b1], comments: [c1] });
  });
});

describe("unsaved edits", () => {
  const edits = (src: string) => ({
    src,
    bytes: new Uint8Array([1]),
    original: new Uint8Array([2]),
    annots: [{ id: 1 }],
  });

  it("hands a tab its edits back once, and only for the same document", () => {
    stashUnsavedPdf(1, edits("/a.pdf"));
    expect(takeUnsavedPdf(1, "/b.pdf")).toBeUndefined(); // the tab has opened another file since
    stashUnsavedPdf(1, edits("/a.pdf"));
    expect(takeUnsavedPdf(1, "/a.pdf")?.annots).toEqual([{ id: 1 }]);
    expect(takeUnsavedPdf(1, "/a.pdf")).toBeUndefined();
  });

  it("drops the edits of a tab that closed or moved on", () => {
    stashUnsavedPdf(1, edits("/a.pdf")); // still showing it
    stashUnsavedPdf(2, edits("/b.pdf")); // closed
    stashUnsavedPdf(3, edits("/c.pdf")); // navigated to a web page
    const shown = new Map([
      [1, "/a.pdf"],
      [3, ""],
    ]);
    pruneUnsavedPdfs((id) => shown.get(id) ?? "");
    expect(takeUnsavedPdf(2, "/b.pdf")).toBeUndefined();
    expect(takeUnsavedPdf(3, "/c.pdf")).toBeUndefined();
    expect(takeUnsavedPdf(1, "/a.pdf")).toBeDefined();
  });
});
