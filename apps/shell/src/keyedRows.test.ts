import { describe, expect, it } from "vitest";
import { createRoot } from "solid-js";
import { createStore, unwrap } from "solid-js/store";
import { mergeByPid } from "./keyedRows";

type Row = { pid: number; name: string; cpu: number };

describe("mergeByPid", () => {
  it("keeps each running process's object, updating only what changed", () => {
    createRoot(() => {
      const [rows, set] = createStore<Row[]>([
        { pid: 1, name: "a", cpu: 1 },
        { pid: 2, name: "b", cpu: 2 },
        { pid: 3, name: "c", cpu: 3 },
      ]);
      const [, two, three] = [rows[0], rows[1], rows[2]];
      // 1 exits, 2's CPU moves, 4 starts, and the order changes.
      mergeByPid(rows, set, [
        { pid: 3, name: "c", cpu: 3 },
        { pid: 2, name: "b", cpu: 20 },
        { pid: 4, name: "d", cpu: 4 },
      ]);
      expect(unwrap(rows)).toEqual([
        { pid: 3, name: "c", cpu: 3 },
        { pid: 2, name: "b", cpu: 20 },
        { pid: 4, name: "d", cpu: 4 },
      ]);
      expect(rows[0]).toBe(three);
      expect(rows[1]).toBe(two);
    });
  });

  it("shrinks and empties", () => {
    createRoot(() => {
      const [rows, set] = createStore<Row[]>([
        { pid: 1, name: "a", cpu: 1 },
        { pid: 2, name: "b", cpu: 2 },
      ]);
      mergeByPid(rows, set, [{ pid: 2, name: "b", cpu: 2 }]);
      expect(rows.length).toBe(1);
      mergeByPid(rows, set, []);
      expect(rows.length).toBe(0);
    });
  });

  it("updates a reused pid's name in place, so a copy is what holds the old one", () => {
    createRoot(() => {
      const [rows, set] = createStore<Row[]>([{ pid: 7, name: "editor", cpu: 0 }]);
      const shown = { ...rows[0]! };
      mergeByPid(rows, set, [{ pid: 7, name: "intruder", cpu: 0 }]);
      expect(rows[0]!.name).toBe("intruder");
      expect(shown.name).toBe("editor");
    });
  });
});
