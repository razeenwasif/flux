import { afterEach, expect, it, vi } from "vitest";
import { latestQuery } from "./latestQuery";

afterEach(() => vi.useRealTimers());

it("only delivers the current response even when older requests finish later", async () => {
  vi.useFakeTimers();
  const pending = new Map<string, (value: string) => void>();
  const receive = vi.fn();
  const query = latestQuery(
    (q) => new Promise<string>((resolve) => pending.set(q, resolve)),
    receive,
    vi.fn(),
  );
  query.search("old");
  await vi.advanceTimersByTimeAsync(120);
  query.search("new");
  await vi.advanceTimersByTimeAsync(120);
  pending.get("new")!("new result");
  await Promise.resolve();
  pending.get("old")!("old result");
  await Promise.resolve();
  expect(receive.mock.calls).toEqual([["new result"]]);
});

it("clearing cancels queued work and invalidates an in-flight result", async () => {
  vi.useFakeTimers();
  let resolve!: (value: string) => void;
  const run = vi.fn(
    () =>
      new Promise<string>((r) => {
        resolve = r;
      }),
  );
  const receive = vi.fn();
  const query = latestQuery(run, receive, vi.fn());
  query.search("queued");
  query.search("");
  await vi.advanceTimersByTimeAsync(120);
  expect(run).not.toHaveBeenCalled();
  query.search("running");
  await vi.advanceTimersByTimeAsync(120);
  query.cancel();
  resolve("obsolete");
  await Promise.resolve();
  expect(receive).not.toHaveBeenCalled();
});

it("reports current errors but ignores failures from a cancelled query", async () => {
  vi.useFakeTimers();
  const failures: ((error: Error) => void)[] = [];
  const fail = vi.fn();
  const query = latestQuery(() => new Promise<string>((_, reject) => failures.push(reject)), vi.fn(), fail);
  query.search("old");
  await vi.advanceTimersByTimeAsync(120);
  query.search("new");
  await vi.advanceTimersByTimeAsync(120);
  failures[0]!(new Error("old"));
  failures[1]!(new Error("new"));
  await Promise.resolve();
  expect(fail).toHaveBeenCalledTimes(1);
  expect(fail.mock.calls[0]![0].message).toBe("new");
});
