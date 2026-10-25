import { describe, expect, it } from "vitest";
import { formatMinutes, parseTaskLine } from "./taskLine";

// Thursday 22 October 2026, 10 am.
const NOW = new Date(2026, 9, 22, 10, 0);
const read = (s: string) => parseTaskLine(s, NOW, ["Uni", "Personal", "Flux"]);

describe("one line as a task", () => {
  it("reads the board's example", () => {
    const line = "Submit COMP2310 lab report friday 5pm !1 #uni ~45m";
    const t = read(line);
    expect(t).toMatchObject({
      title: "Submit COMP2310 lab report",
      due: "2026-10-23",
      time: "17:00",
      priority: 1,
      list: "Uni",
      minutes: 45,
    });
    // Each piece read, where it sits in the line, for the capture field to show.
    expect(t.marks.map((m) => [m.kind, line.slice(m.start, m.end)])).toEqual([
      ["date", "friday 5pm"],
      ["priority", "!1"],
      ["list", "#uni"],
      ["duration", "~45m"],
    ]);
  });

  it("reads a date only at the end", () => {
    expect(read("Meet the Friday team")).toMatchObject({ title: "Meet the Friday team", due: "" });
    expect(read("Call Anna tomorrow at 3")).toMatchObject({
      title: "Call Anna",
      due: "2026-10-23",
      time: "15:00",
    });
    expect(read("Dentist on tuesday 9:30am")).toMatchObject({
      title: "Dentist",
      due: "2026-10-27",
      time: "09:30",
    });
    expect(read("Hand in the essay by friday")).toMatchObject({
      title: "Hand in the essay",
      due: "2026-10-23",
    });
    expect(read("Write report next friday")).toMatchObject({ title: "Write report", due: "2026-10-30" });
    expect(read("Plan sprint next week").due).toBe("2026-10-26");
    expect(read("Book flights in 3 days").due).toBe("2026-10-25");
  });

  it("leaves the words alone when they aren't a date", () => {
    expect(read("Read chapter 9")).toMatchObject({ title: "Read chapter 9", due: "" });
    expect(read("Hang the washing in the sun")).toMatchObject({ due: "" });
    // A date needs something to be the date of.
    expect(read("tomorrow")).toMatchObject({ title: "tomorrow", due: "" });
    // "#212" is an issue number, not a list; "!4" isn't a priority.
    expect(read("Reply to Flux issue #212 !4")).toMatchObject({
      title: "Reply to Flux issue #212 !4",
      list: "",
      priority: 0,
    });
  });

  it("reads times and dates the way they're written here", () => {
    // A bare hour needs its "at": the afternoon up to 7, the morning from 8.
    expect(read("Gym at 7").time).toBe("19:00");
    expect(read("Standup at 9")).toMatchObject({ time: "09:00", due: "2026-10-23" }); // 9 am has passed
    expect(read("Call mum 5pm")).toMatchObject({ time: "17:00", due: "2026-10-22" });
    expect(read("Pay rent 1 nov").due).toBe("2026-11-01");
    expect(read("Pay rent 1/11").due).toBe("2026-11-01"); // day first
    expect(read("Pay rent nov 1st").due).toBe("2026-11-01");
    expect(read("Renew licence 10 jan").due).toBe("2027-01-10"); // this year's has passed
    expect(read("Lodge it 2026-12-01").due).toBe("2026-12-01");
  });

  it("reads lists, priorities and durations anywhere", () => {
    expect(read("!2 #personal Groceries ~1h30m")).toMatchObject({
      title: "Groceries",
      priority: 2,
      list: "Personal",
      minutes: 90,
    });
    // A list that doesn't exist yet is named as typed, capitalised.
    expect(read("Draft the talk #conference ~1.5h")).toMatchObject({ list: "Conference", minutes: 90 });
    expect(formatMinutes(45)).toBe("45 min");
    expect(formatMinutes(90)).toBe("1 h 30 min");
    expect(formatMinutes(120)).toBe("2 h");
  });
});
