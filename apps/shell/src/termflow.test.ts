import { expect, it, vi } from "vitest";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn().mockResolvedValue(undefined) }));
import { invoke } from "@tauri-apps/api/core";
import { ACK_EVERY, createAcker, termBytes, terminalAck } from "./termflow";

it("acks a full batch at once, and an idle prompt's echoes in one step", () => {
  const acks: number[] = [];
  const ack = createAcker((n) => acks.push(n));
  // A flood: each 64 KiB batch from the core is reported as soon as it's written.
  ack(64 * 1024);
  expect(acks).toEqual([64 * 1024]);
  // Typing: one echoed byte at a time costs no IPC until a step's worth is in.
  for (let i = 0; i < ACK_EVERY - 1; i++) ack(1);
  expect(acks).toEqual([64 * 1024]);
  ack(1);
  expect(acks).toEqual([64 * 1024, ACK_EVERY]);
});

it("never sits on as much as a step, so a core waiting at its cap always hears back", () => {
  // The core waits only with ~1 MiB outstanding. If the view could hold that
  // much written-but-unreported, both sides would wait on each other.
  let written = 0;
  let acked = 0;
  const ack = createAcker((n) => (acked += n));
  let seed = 3;
  for (let i = 0; i < 10_000; i++) {
    seed = (seed * 48_271) % 2_147_483_647;
    const n = seed % 70_000;
    written += n;
    ack(n);
    expect(written - acked).toBeLessThan(ACK_EVERY);
  }
  expect(acked).toBeGreaterThan(0);
});

it("reads raw channel payloads without copying, and number arrays by copy", () => {
  const raw = new Uint8Array([27, 91, 72, 104, 105]).buffer;
  const view = termBytes(raw);
  expect(Array.from(view)).toEqual([27, 91, 72, 104, 105]);
  expect(view.buffer).toBe(raw);
  // The preview mock and an older core send a plain array.
  expect(Array.from(termBytes([104, 105]))).toEqual([104, 105]);
});

it("sends acks to the core's terminal_ack", async () => {
  vi.mocked(invoke).mockClear();
  await terminalAck(7, 32_768);
  expect(invoke).toHaveBeenCalledWith("terminal_ack", { session: 7, bytes: 32_768 });
});
