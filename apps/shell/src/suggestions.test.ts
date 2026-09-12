import { expect, it, vi } from "vitest";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn().mockResolvedValue([]), Channel: class {} }));
import { invoke } from "@tauri-apps/api/core";
import { searchSuggest } from "./ipc";

it("does not cross IPC when suggestions are disabled or no tab is active", async () => {
  vi.mocked(invoke).mockClear();
  expect(await searchSuggest("private thought", { enabled: false, tabId: 1 })).toEqual([]);
  expect(await searchSuggest("private thought", { enabled: true, tabId: null })).toEqual([]);
  expect(invoke).not.toHaveBeenCalled();
});

it("passes consent and tab context for the backend privacy check", async () => {
  vi.mocked(invoke).mockClear();
  await searchSuggest("rust traits", { enabled: true, tabId: 12 });
  expect(invoke).toHaveBeenCalledWith("search_suggest", { query: "rust traits", enabled: true, tabId: 12 });
});
