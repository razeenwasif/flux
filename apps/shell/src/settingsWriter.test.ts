import { describe, expect, it, vi } from "vitest";
import { settingsWriter } from "./settingsWriter";

describe("settings writes", () => {
  it("keeps the acknowledged value on failure and retries the same intent", async () => {
    const writer = settingsWriter();
    const save = vi
      .fn()
      .mockRejectedValueOnce(new Error("secret backend details"))
      .mockResolvedValueOnce(undefined);
    const commit = vi.fn();
    await writer.run("search engine", save, commit);
    expect(commit).not.toHaveBeenCalled();
    expect(writer.error()).toContain("Could not save search engine");
    expect(writer.error()).not.toContain("secret");
    await writer.retry();
    expect(commit).toHaveBeenCalledOnce();
    expect(writer.error()).toBe("");
  });
  it("prevents a second write from racing an unacknowledged first write", async () => {
    const writer = settingsWriter();
    let finish!: () => void;
    const first = writer.run(
      "privacy",
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const second = vi.fn();
    await writer.run("privacy", second);
    expect(second).not.toHaveBeenCalled();
    expect(writer.pending()).toBe(true);
    finish();
    await first;
    expect(writer.pending()).toBe(false);
  });
});
