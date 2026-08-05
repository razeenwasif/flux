import { describe, expect, it } from "vitest";

import { parseSummarise, summariseRequest } from "./agentsteps";

describe("summarise step", () => {
  it("parses the form the planner prompt teaches", () => {
    expect(parseSummarise("summarise /home/me/slides/01-intro.pdf into my Optimization notebook")).toEqual({
      path: "/home/me/slides/01-intro.pdf",
      dest: "my Optimization notebook",
    });
    // Both spellings, since the model will use either.
    expect(parseSummarize()).toEqual({ path: "/a/b.pdf", dest: "onyx 00 - Optimization" });
    function parseSummarize() {
      return parseSummarise("Summarize /a/b.pdf into onyx 00 - Optimization");
    }
  });

  it("splits on the LAST 'into', so a path containing it survives", () => {
    // "~/Courses/Intro to Optimization/" contains " into " only if you split
    // carelessly — but a destination legitimately can too.
    expect(parseSummarise("summarise /docs/into the woods.pdf into my reading notes")).toEqual({
      path: "/docs/into the woods.pdf",
      dest: "my reading notes",
    });
  });

  it("strips the quotes a model likes to add", () => {
    expect(parseSummarise('summarise "/a/b c.pdf" into "my notebook"')).toEqual({
      path: "/a/b c.pdf",
      dest: "my notebook",
    });
  });

  it("rejects anything that isn't this step", () => {
    for (const s of [
      "read /a/b.pdf",
      "summarise this page",
      "summarise /a/b.pdf",
      "note add a summary to my notebook",
      "",
      "summarise  into  ",
    ]) {
      expect(parseSummarise(s), s).toBeNull();
    }
  });

  it("asks for an append so a folder becomes one note, not many", () => {
    // The whole point of doing this per document: the second and later
    // summaries have to land in the note the first one created.
    const req = summariseRequest("01-intro.pdf", "onyx 00 - Optimization");
    expect(req).toContain("01-intro.pdf");
    expect(req).toContain("onyx 00 - Optimization");
    expect(req.toUpperCase()).toContain("APPEND");
    // And it must not invite a summary of everything read so far.
    expect(req).toMatch(/only this one document/i);
  });
});
