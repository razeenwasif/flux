import { describe, expect, it } from "vitest";

import { blockedMessage } from "./framecheck";

describe("blocked-pane message", () => {
  it("names the header, because that's the thing to change", () => {
    const m = blockedMessage("codevisualizer-app.web.app", "X-Frame-Options: SAMEORIGIN");
    expect(m).toContain("codevisualizer-app.web.app");
    expect(m).toContain("X-Frame-Options: SAMEORIGIN");
  });

  it("offers somewhere that works, so it isn't a dead end", () => {
    expect(blockedMessage("x.example", "X-Frame-Options: DENY")).toMatch(/side panel/i);
  });

  it("reads cleanly when the reason is unknown", () => {
    // `frame_policy` reports an empty reason when it couldn't reach the site;
    // the message must not end up with a stray empty bracket.
    const m = blockedMessage("x.example", "");
    expect(m).not.toContain("()");
    expect(m).toContain("x.example");
  });
});
