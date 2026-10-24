import { describe, expect, it } from "vitest";

import { parseQuickEvent } from "./quickEvent";

// Sunday 25 October 2026, mid-morning.
const NOW = new Date(2026, 9, 25, 10, 30);
const BASE = "2026-10-25";

describe("quick add", () => {
  it("takes the time and the day out of the text, wherever they are", () => {
    expect(parseQuickEvent("lab tue 3pm", BASE, NOW)).toEqual({
      title: "lab",
      date: "2026-10-27",
      start: "15:00",
    });
    expect(parseQuickEvent("3pm lab on tuesday", BASE, NOW)).toEqual({
      title: "lab",
      date: "2026-10-27",
      start: "15:00",
    });
    expect(parseQuickEvent("dentist tomorrow 9:30am", BASE, NOW)).toEqual({
      title: "dentist",
      date: "2026-10-26",
      start: "09:30",
    });
    expect(parseQuickEvent("standup 10:00", BASE, NOW)).toEqual({
      title: "standup",
      date: BASE,
      start: "10:00",
    });
  });

  it("keeps the picked day when none is named, and has no time when none is given", () => {
    expect(parseQuickEvent("Assignment 2 due", "2026-10-29", NOW)).toEqual({
      title: "Assignment 2 due",
      date: "2026-10-29",
      start: "",
    });
  });

  it("reads 12am and 12pm the way a clock does", () => {
    expect(parseQuickEvent("launch 12pm", BASE, NOW)?.start).toBe("12:00");
    expect(parseQuickEvent("deploy 12am", BASE, NOW)?.start).toBe("00:00");
  });

  it("means next week by today's own weekday", () => {
    expect(parseQuickEvent("brunch sunday", BASE, NOW)?.date).toBe("2026-11-01");
  });

  it("gives nothing back for a line that's only a time", () => {
    expect(parseQuickEvent("3pm", BASE, NOW)).toBeNull();
  });
});
