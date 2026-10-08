/**
 * Natural-language reminder times. A phrase parseWhen misses doesn't fail
 * loudly: the reminder is stored as an undated to-do and never fires, so these
 * pin the phrasings people actually type.
 */
import { describe, expect, it, vi } from "vitest";

// Only the pure parser is under test; keep the Tauri IPC surface out of it.
vi.mock("./ipc", () => ({
  remindersAdd: vi.fn(),
  remindersImport: vi.fn(),
  remindersList: vi.fn(),
  remindersRemove: vi.fn(),
}));

import { parseWhen } from "./reminders";

const NOW = Date.UTC(2026, 5, 10, 12, 0);
const MIN = 60_000;
const HOUR = 60 * MIN;

describe("parseWhen: relative times", () => {
  it.each([
    ["remind me in a couple of hours to stretch", 2 * HOUR, "remind me to stretch"],
    ["remind me in a couple hours to stretch", 2 * HOUR, "remind me to stretch"],
    ["in a few minutes check the oven", 3 * MIN, "check the oven"],
    ["in a half hour call back", HOUR / 2, "call back"],
    ["in an hour call back", HOUR, "call back"],
    ["in a minute call back", MIN, "call back"],
    ["in a day water the plants", 24 * HOUR, "water the plants"],
    ["in one minute call back", MIN, "call back"],
    ["in two days water the plants", 48 * HOUR, "water the plants"],
    ["in 10 minutes call back", 10 * MIN, "call back"],
    ["in 1.5 hours call back", 1.5 * HOUR, "call back"],
  ])("%s", (input, offset, text) => {
    expect(parseWhen(input, NOW)).toEqual({ text, due: NOW + offset });
  });

  it("leaves text with no time in it as an undated to-do", () => {
    expect(parseWhen("buy milk in a while", NOW)).toEqual({ text: "buy milk in a while", due: null });
  });
});
