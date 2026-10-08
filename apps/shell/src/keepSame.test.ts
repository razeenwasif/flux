import { describe, expect, it } from "vitest";

import { keepSame } from "./keepSame";

type Row = { id: number; name: string; enabled: boolean };

/** What a poll returns: equal content, fresh objects (as IPC deserializes). */
const refetch = (rows: Row[]): Row[] => rows.map((r) => ({ ...r }));

describe("keepSame", () => {
  it("keeps the previous object for every unchanged row", () => {
    const shown: Row[] = [
      { id: 1, name: "dark mode", enabled: true },
      { id: 2, name: "hide banner", enabled: false },
    ];
    const next = keepSame(shown, refetch(shown));
    // Same identity is what stops <For> from remounting the row being edited.
    expect(next[0]).toBe(shown[0]);
    expect(next[1]).toBe(shown[1]);
  });

  it("replaces only the rows whose content changed", () => {
    const shown: Row[] = [
      { id: 1, name: "dark mode", enabled: true },
      { id: 2, name: "hide banner", enabled: false },
    ];
    const polled = refetch(shown);
    polled[1]!.enabled = true;
    const next = keepSame(shown, polled);
    expect(next[0]).toBe(shown[0]);
    expect(next[1]).toBe(polled[1]);
    expect(next[1]!.enabled).toBe(true);
  });

  it("follows the new list for order, additions and removals, matching rows by id", () => {
    const shown: Row[] = [
      { id: 1, name: "a", enabled: true },
      { id: 2, name: "b", enabled: true },
      { id: 3, name: "c", enabled: true },
    ];
    const added = { id: 4, name: "d", enabled: true };
    const next = keepSame(shown, [...refetch([shown[2]!, shown[0]!]), added]);
    expect(next).toEqual([shown[2], shown[0], added]);
    expect(next[0]).toBe(shown[2]);
    expect(next[1]).toBe(shown[0]);
    expect(next[2]).toBe(added);
  });

  it("takes everything from the poll when nothing was shown yet", () => {
    const polled: Row[] = [{ id: 1, name: "a", enabled: false }];
    expect(keepSame([], polled)[0]).toBe(polled[0]);
  });
});
