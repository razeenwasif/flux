/**
 * The auto-archive sweep's hand-off to the tab store.
 *
 * closeTab decides whether to turn the closing tab into a start tab from the
 * live tab list, so closes started together each see "no start tab" and every
 * archived tab became a blank "New Tab" instead of closing. The store's
 * closeTabs runs them one at a time; the sweep has to go through it.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const tabList = [
  { id: 1, url: "https://a.example/1", title: "A1", workspace: 1 },
  { id: 2, url: "https://a.example/2", title: "A2", workspace: 1 },
  { id: 3, url: "https://a.example/3", title: "A3", workspace: 1 },
  { id: 4, url: "https://b.example/", title: "B", workspace: 1 },
  { id: 5, url: "https://c.example/", title: "", workspace: 1 },
];

const store = vi.hoisted(() => ({
  activeWorkspaceName: vi.fn(() => "Research"),
  archiveBranchRecord: vi.fn(() => "branch-1"),
  archiveTabRecord: vi.fn(),
  closeTab: vi.fn(() => Promise.resolve()),
  closeTabs: vi.fn((ids: number[]) => Promise.resolve(ids.length)),
  staleTabIds: vi.fn((): number[] => []),
  tabs: vi.fn((): unknown[] => []),
  updateBranchSummary: vi.fn(),
}));
const ipc = vi.hoisted(() => ({
  agentChat: vi.fn((_prompt: string) => Promise.resolve("A thread")),
  agentChatTabs: vi.fn((_prompt: string, _tabIds: number[]) => Promise.resolve("A thread")),
  traceBranches: vi.fn(() => Promise.resolve([[1, 2, 3], [4], [5]])),
}));
vi.mock("./store", () => store);
vi.mock("./ipc", () => ipc);

import { runStaleSweep } from "./staleSweep";

beforeEach(() => {
  vi.clearAllMocks();
  store.tabs.mockReturnValue(tabList);
  store.staleTabIds.mockReturnValue(tabList.map((t) => t.id));
});

describe("runStaleSweep", () => {
  it("archives a branch and the singles, then closes them all in one sequential pass", async () => {
    await runStaleSweep(Date.now());

    expect(store.archiveBranchRecord).toHaveBeenCalledTimes(1);
    expect(store.archiveTabRecord).toHaveBeenCalledTimes(2);
    expect(store.closeTab).not.toHaveBeenCalled();
    expect(store.closeTabs).toHaveBeenCalledTimes(1);
    expect(store.closeTabs).toHaveBeenCalledWith([1, 2, 3, 4, 5]);
  });

  it("names the branch from its titles alone, never from the page the user is on", async () => {
    // agent_chat re-snapshots the ACTIVE tab and appends its text to the prompt;
    // agent_chat_tabs with no ids is a page-free chat.
    await runStaleSweep(Date.now());

    expect(ipc.agentChat).not.toHaveBeenCalled();
    expect(ipc.agentChatTabs).toHaveBeenCalledTimes(1);
    const [prompt, tabIds] = ipc.agentChatTabs.mock.calls[0]!;
    expect(tabIds).toEqual([]);
    expect(prompt).toContain("- A1\n- A2\n- A3");
    await vi.waitFor(() => expect(store.updateBranchSummary).toHaveBeenCalledWith("branch-1", "A thread"));
  });

  it("closes nothing when no tab is stale", async () => {
    store.staleTabIds.mockReturnValue([]);
    await runStaleSweep(Date.now());
    expect(store.closeTab).not.toHaveBeenCalled();
    expect(store.closeTabs).not.toHaveBeenCalled();
  });
});
