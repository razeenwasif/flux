/**
 * The Onyx shortcuts write into the vault with no approval card, so a false
 * positive is a junk note (or the previous answer filed under the wrong name),
 * not a Discard click. They have to fire on the documented instructions and on
 * nothing that merely mentions a lecture, a transcript or Onyx.
 */
import { describe, expect, it } from "vitest";

import { isCaptureRequest, isOnyxSave, savesLastAnswer } from "./onyxintent";

describe("page capture into Onyx", () => {
  it("fires on the documented instruction and its variants", () => {
    for (const t of [
      "capture this lecture to onyx/Optimization #ml as Week 3",
      "capture this lecture",
      "save this lecture to onyx",
      "add this lecture to onyx",
      "file this transcript",
      "capture today's lecture",
      "capture this week's lecture to onyx/Convex",
      "capture this page",
      "capture the article",
    ]) {
      expect(isCaptureRequest(t), t).toBe(true);
    }
  });

  it("does not fire on a mention", () => {
    for (const t of [
      "how do I capture a screenshot on mac",
      "explain the lecture on file systems",
      "how do I save this lecture to onyx?",
      "capture a screenshot",
      "add error handling to the lecture planner",
      "capture this lecture?",
    ]) {
      expect(isCaptureRequest(t), t).toBe(false);
    }
  });
});

describe("direct note save into Onyx", () => {
  it("fires on the documented instructions", () => {
    for (const t of [
      "save that to onyx",
      "save that to Onyx/00 - Optimization #ml as Duality",
      "save that #ml to onyx",
      "save this answer to onyx/Convex",
      "put that in onyx",
      "save to Onyx: gravity-wave detector notes",
      "add to onyx: the KKT conditions",
      "write to onyx: exam is on friday",
    ]) {
      expect(isOnyxSave(t), t).toBe(true);
    }
  });

  it("does not fire on a mention or a question", () => {
    for (const t of [
      "how do I add a template in onyx?",
      "what did I save to onyx yesterday",
      "save my progress then open onyx",
      "note: onyx is slow today",
      "add a button in onyx's settings page",
      "add dark mode to onyx parser",
      "save that to onyx?",
    ]) {
      expect(isOnyxSave(t), t).toBe(false);
    }
  });

  it("takes the last answer only in the explicit form", () => {
    expect(savesLastAnswer("save that to onyx")).toBe(true);
    expect(savesLastAnswer("save the last answer to onyx as Duality")).toBe(true);
    // A bare "that" elsewhere is dictation, not a pointer to the previous reply.
    expect(savesLastAnswer("write in onyx that my exam is friday")).toBe(false);
    expect(savesLastAnswer("save to onyx: remember that the exam moved")).toBe(false);
  });
});
