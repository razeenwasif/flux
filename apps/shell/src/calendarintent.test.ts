/**
 * Calendar detection runs ahead of chat on every message, so a false positive
 * swaps an answer for a schedule readout, and the add path writes an event
 * without asking.
 */
import { describe, expect, it } from "vitest";

import { DAY_MONTH, MONTH_DAY, looksLikeCalendarQuery } from "./calendarintent";

describe("calendar query detection", () => {
  it("catches questions about the user's own time", () => {
    for (const t of [
      "what's on my calendar today",
      "whats on my calendar friday",
      "am I free friday",
      "am i busy tomorrow",
      "are we free on saturday",
      "how busy am I tomorrow",
      "free tomorrow?",
      "do I have any meetings today",
      "do I have any free time tomorrow",
      "what meetings do I have tomorrow",
      "when is my next meeting",
      "any appointments this week",
      "show my calendar",
      "show the calendar",
      "what's on the agenda",
    ]) {
      expect(looksLikeCalendarQuery(t), t).toBe(true);
    }
  });

  it("leaves 'free', 'busy' and 'events' in ordinary chat alone", () => {
    for (const t of [
      "Is this software free?",
      "Explain free will",
      "Is it free on iOS?",
      "free shipping on amazon",
      "what does free mean in rust",
      "list the free variables",
      "busy beaver function",
      "is the gym busy at 6",
      "what are javascript events",
      "how do I schedule a cron job",
    ]) {
      expect(looksLikeCalendarQuery(t), t).toBe(false);
    }
  });
});

describe("month-day parsing", () => {
  it("reads real month names", () => {
    expect("book a haircut on march 5".match(MONTH_DAY)?.slice(1, 3)).toEqual(["march", "5"]);
    expect("review on sept. 3rd".match(MONTH_DAY)?.slice(1, 3)).toEqual(["sept", "3"]);
    expect("dinner 5 june".match(DAY_MONTH)?.slice(1, 3)).toEqual(["5", "june"]);
    expect("exam on the 5th of december".match(DAY_MONTH)?.slice(1, 3)).toEqual(["5", "december"]);
  });

  it("does not read a word that merely starts like a month as a date", () => {
    // A parsed date alone now admits a calendar add, so these would be events.
    for (const t of [
      "add 2 decimals to the price",
      "create 5 junk files",
      "add marks 5 to the student",
      "add octets 4 to the header",
      "buy 3 mayonnaise jars",
    ]) {
      expect(MONTH_DAY.test(t) || DAY_MONTH.test(t), t).toBe(false);
    }
  });
});
