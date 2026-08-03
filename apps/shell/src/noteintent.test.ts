/**
 * Where "write this down" ends and "what did I write" begins.
 *
 * The asymmetry is deliberate and worth stating: a false positive costs one
 * click on Discard, because the approval card still stands between the model
 * and your files. A false negative costs the feature entirely — which is what
 * shipped, and how a request to write into a Scribe notebook silently became an
 * ordinary chat reply.
 */
import { describe, expect, it } from "vitest";

import { looksLikeNoteWrite } from "./noteintent";

describe("note write intent", () => {
  it("catches how people actually ask", () => {
    for (const p of [
      "add this to my notes",
      "write a summary of this page into my Convex notebook",
      "save this to Scribe",
      "put the key results in my calculus notebook",
      "append a proof sketch to my duality note",
      "jot this down in my notes",
      "can you write a new note about Slater's condition",
      "create a page in my Convex Analysis notebook with the KKT conditions",
      "I want you to save this into my Onyx vault",
    ]) {
      expect(looksLikeNoteWrite(p), p).toBe(true);
    }
  });

  it("leaves questions about your notes alone", () => {
    // These are the common case by a wide margin, and several contain both a
    // write verb and a target — which is exactly why the opener is checked.
    for (const p of [
      "what did I write about duality",
      "what's in my Convex notebook",
      "did I save anything about KKT conditions",
      "show me the note I wrote on Slater",
      "summarise my notes on convex optimisation",
      "find the page where I recorded the bound",
      "tell me what my notebook says about strong duality",
      "which notebook has my optimisation notes",
      "read my notes back to me",
      "remind me what I put in my notes yesterday",
    ]) {
      expect(looksLikeNoteWrite(p), p).toBe(false);
    }
  });

  it("ignores requests that aren't about notes at all", () => {
    for (const p of [
      "write a python script that sorts a list",
      "save this page for offline",
      "what is the Lagrangian dual",
      "add 2 and 2",
      "",
      "   ",
    ]) {
      expect(looksLikeNoteWrite(p), p).toBe(false);
    }
  });

  it("leaves slash commands to their own handlers", () => {
    // `/note` is matched before this runs; anything else starting with `/` is a
    // different command and must not be hijacked.
    expect(looksLikeNoteWrite("/note add this to my notes")).toBe(false);
    expect(looksLikeNoteWrite("/task write my notes up properly")).toBe(false);
  });

  it("wants the verb before the target", () => {
    // Prose *about* a notebook shouldn't trip it just because a verb appears
    // somewhere later in the sentence.
    expect(looksLikeNoteWrite("my notebook, which I made last term, is a mess")).toBe(false);
  });
});
