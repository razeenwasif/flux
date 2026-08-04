import { describe, expect, it } from "vitest";

import { looksAgentic } from "./agentintent";

describe("agentic intent detection", () => {
  it("fires on the request that started this — a folder of PDFs to work through", () => {
    expect(
      looksAgentic(
        "in /home/amaterasu/Courses/Optimization/material/slides/ you will find a few lecture " +
          "slides pdf. I want you to go through all of them and summarize them inside onyx 00 - Optimization",
      ),
    ).toBe(true);
  });

  it("fires on ordinary multi-step work", () => {
    for (const t of [
      "read src/kb.rs and fix the off-by-one in the ranking",
      "go through every file in ~/notes and index them",
      "list the files in /tmp/build then delete the old ones",
      "open ~/Downloads/paper.pdf and summarise it into my reading notebook",
      "run the tests and fix whatever fails",
    ]) {
      expect(looksAgentic(t), t).toBe(true);
    }
  });

  // The expensive failure: stealing a question and answering it with a plan.
  it("leaves questions to chat, even when they name a path", () => {
    for (const t of [
      "what's in /etc/hosts?",
      "how do I read a PDF in Rust",
      "can you explain what this folder is for",
      "is there a file called config.toml in the repo",
      "which of these files is the entry point",
      "why did the build fail",
      "what does this page say about duality",
    ]) {
      expect(looksAgentic(t), t).toBe(false);
    }
  });

  it("leaves plain chat alone", () => {
    for (const t of [
      "summarise this page",
      "thanks, that worked",
      "who wrote the Adam optimizer paper",
      "tell me about convex duality",
      "yes",
      "do it",
      "go on",
    ]) {
      expect(looksAgentic(t), t).toBe(false);
    }
  });

  it("does not steal a message the panel already routes", () => {
    for (const t of [
      "/task go through the slides and summarise them",
      "/note add a summary of the slides to my notebook",
      "/fix the failing tests in the core crate",
      "/run ls /home/me/slides",
    ]) {
      expect(looksAgentic(t), t).toBe(false);
    }
  });

  // Ordering matters: this is checked BEFORE note detection in the panel, so
  // anything it claims never reaches the note path.
  it("leaves a plain note write to the note detector", () => {
    for (const t of [
      "save this into my Convex Analysis notebook",
      "add a note about duality to my Optimization notebook",
      "write that down in my notes for later",
    ]) {
      expect(looksAgentic(t), t).toBe(false);
    }
  });

  it("claims a note request that first requires reading files", () => {
    // The note can't be drafted until the slides have been read, so this has to
    // go to the loop rather than to a one-shot note draft off the request text.
    expect(looksAgentic("save a summary of the slides in ~/Courses/Opt to my notebook")).toBe(true);
  });

  it("accepts a polite multi-step request despite the question opener", () => {
    // "can you …" reads as interrogative, but the multi-step framing says
    // otherwise — and this is how people actually phrase these.
    expect(looksAgentic("can you go through all of them and summarise each one into my notes")).toBe(true);
  });
});
