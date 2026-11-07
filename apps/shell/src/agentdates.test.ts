import { describe, expect, it } from "vitest";

import { calRange, dayLabelOf, isoOf, parseEventSpec } from "./agentdates";

const inDays = (n: number) => isoOf(new Date(Date.now() + n * 864e5));

describe("parseEventSpec", () => {
  it("reads a day, a time and a length, and leaves the title", () => {
    const spec = parseEventSpec("dentist tomorrow at 3pm for 90 min");
    expect(spec).toMatchObject({ date: inDays(1), start: "15:00", end: "16:30", dated: true });
    expect(spec.title).toBe("dentist");
  });

  it("defaults to today when no day is named, and tomorrow once that time has passed", () => {
    const spec = parseEventSpec("standup at 10am");
    const passed = new Date().getHours() >= 10;
    expect(spec).toMatchObject({ date: inDays(passed ? 1 : 0), start: "10:00", dated: false });
  });
});

describe("calRange", () => {
  it("reads tomorrow, a week, and the default", () => {
    expect(calRange("what's on tomorrow")).toEqual({ lo: inDays(1), hi: inDays(1), label: "tomorrow" });
    expect(calRange("this week").label).toBe("this week");
    expect(calRange("anything?")).toMatchObject({ lo: inDays(0), hi: inDays(7), label: "the next 7 days" });
  });

  it("labels today and tomorrow by name", () => {
    expect(dayLabelOf(inDays(0))).toBe("Today");
    expect(dayLabelOf(inDays(1))).toBe("Tomorrow");
  });
});
