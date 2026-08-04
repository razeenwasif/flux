import { describe, expect, it } from "vitest";

import { isAbsolutePath, joinPath, resolveAgentPath } from "./agentpaths";

const SLIDES = "/home/amaterasu/Courses/Optimization/material/slides";

describe("agent path resolution", () => {
  it("resolves the bare filename a listing used to produce", () => {
    // The reported bug: `list` returned basenames, so the next step was
    // `read 01-course-overview-and-intro.pdf` and the read failed.
    expect(resolveAgentPath("01-course-overview-and-intro.pdf", SLIDES)).toBe(
      `${SLIDES}/01-course-overview-and-intro.pdf`,
    );
  });

  it("leaves an absolute path exactly as it is", () => {
    for (const p of [
      "/etc/hosts",
      "~/notes/thing.md",
      "C:\\Users\\Razeen\\file.pdf",
      "\\\\server\\share\\x.pdf",
      `${SLIDES}/02-LP-modelling.pdf`,
    ]) {
      expect(resolveAgentPath(p, SLIDES), p).toBe(p);
      expect(isAbsolutePath(p), p).toBe(true);
    }
  });

  it("returns a bare name untouched when no directory has been listed", () => {
    // Guessing would turn "not found" into "read the wrong file".
    expect(resolveAgentPath("lecture.pdf", "")).toBe("lecture.pdf");
  });

  it("strips the quotes the model likes to add", () => {
    expect(resolveAgentPath('"lecture one.pdf"', SLIDES)).toBe(`${SLIDES}/lecture one.pdf`);
    expect(resolveAgentPath("'/etc/hosts'", SLIDES)).toBe("/etc/hosts");
  });

  it("never doubles a separator", () => {
    expect(joinPath(`${SLIDES}/`, "a.pdf")).toBe(`${SLIDES}/a.pdf`);
    expect(joinPath(SLIDES, "sub/")).toBe(`${SLIDES}/sub`);
    expect(joinPath(`${SLIDES}//`, "a.pdf")).toBe(`${SLIDES}/a.pdf`);
  });

  it("keeps the separator style of the directory", () => {
    expect(joinPath("C:\\Users\\Razeen", "a.pdf")).toBe("C:\\Users\\Razeen\\a.pdf");
    // A WSL path is POSIX even though the app is running on Windows.
    expect(joinPath("/home/me", "a.pdf")).toBe("/home/me/a.pdf");
  });

  it("treats an empty input as empty rather than as the directory", () => {
    expect(resolveAgentPath("", SLIDES)).toBe("");
    expect(resolveAgentPath("   ", SLIDES)).toBe("");
  });
});
