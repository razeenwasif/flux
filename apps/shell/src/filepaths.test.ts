import { describe, expect, it } from "vitest";

import { toFileUrl } from "./filepaths";

/** The path a file:// URL actually names, the way a browser resolves it. */
const pathOf = (url: string) => decodeURIComponent(new URL(url).pathname);

describe("toFileUrl", () => {
  it("escapes the URL delimiters a file name may contain", () => {
    // `#` and `?` used to survive encodeURI and cut the path short.
    expect(toFileUrl("/Users/me/C# notes.md")).toBe("file:///Users/me/C%23%20notes.md");
    for (const p of ["/Users/me/C# notes.md", "/Users/me/what?.html", "/Users/me/#1 report.pdf"]) {
      const url = new URL(toFileUrl(p));
      expect(url.hash).toBe("");
      expect(url.search).toBe("");
      expect(pathOf(toFileUrl(p))).toBe(p);
    }
  });

  it("round-trips spaces, percent signs and non-ASCII names", () => {
    for (const p of ["/x/a b.pdf", "/x/100% done.pdf", "/x/Bob’s Résumé.pdf", "/x/50%2B growth.pdf"]) {
      expect(pathOf(toFileUrl(p))).toBe(p);
    }
  });

  it("keeps Windows drive paths in their file:///C:/ form", () => {
    expect(toFileUrl("C:\\Users\\me\\a b.pdf")).toBe("file:///C:/Users/me/a%20b.pdf");
  });
});
