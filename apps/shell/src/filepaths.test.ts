import { describe, expect, it } from "vitest";

import { crumbs, toFileUrl } from "./filepaths";

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

describe("crumbs", () => {
  const paths = (p: string) => crumbs(p).map((c) => c.path);

  it("roots a UNC path at its share, never at a drive-relative `\\`", () => {
    // Every WSL "Linux" place and network share is one of these.
    expect(crumbs("\\\\wsl.localhost\\Ubuntu\\home\\me")).toEqual([
      { name: "Ubuntu", path: "\\\\wsl.localhost\\Ubuntu" },
      { name: "home", path: "\\\\wsl.localhost\\Ubuntu\\home" },
      { name: "me", path: "\\\\wsl.localhost\\Ubuntu\\home\\me" },
    ]);
    for (const p of paths("\\\\server\\share\\a\\b")) expect(p.startsWith("\\\\server\\share")).toBe(true);
  });

  it("gives a share root or a bare server a single crumb", () => {
    expect(paths("\\\\wsl.localhost\\Ubuntu\\")).toEqual(["\\\\wsl.localhost\\Ubuntu"]);
    expect(crumbs("\\\\wsl.localhost\\")).toEqual([{ name: "wsl.localhost", path: "\\\\wsl.localhost\\" }]);
  });

  it("leaves drive and Unix paths as they were", () => {
    expect(paths("C:\\Users\\me")).toEqual(["C:\\", "C:\\Users", "C:\\Users\\me"]);
    expect(paths("/home/me/src")).toEqual(["/", "/home", "/home/me", "/home/me/src"]);
  });
});
