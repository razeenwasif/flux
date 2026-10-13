// Terminal output flow control (terminal.rs `Flow`). A module of its own rather
// than ipc.ts: only the lazily loaded TerminalView uses it, and ipc.ts is in the
// entry chunk.
//
// The core sends PTY output as raw bytes in batches, and stops reading the PTY
// once about a megabyte is sent but not yet written by xterm. The view tells it
// what xterm has written, from xterm's write callback, so a flood (`cat` of a
// big log, `yes`) runs at the speed the terminal can draw instead of queueing
// evals and memory in the webview until it drains.
import { invoke } from "@tauri-apps/api/core";

/** Written bytes gathered before one ack. Batching keeps an idle prompt from
 *  costing an IPC round trip per echoed keystroke; it must stay well under the
 *  core's cap (`UNACKED_MAX`, 1 MiB), or the core could wait on bytes the view
 *  has written but not yet reported. */
export const ACK_EVERY = 32 * 1024;

/** Tell the core xterm has written `bytes` more of `session`'s output. */
export const terminalAck = (session: number, bytes: number) =>
  invoke<void>("terminal_ack", { session, bytes });

/** One output message as bytes. Raw channel payloads arrive as an ArrayBuffer;
 *  a plain number array (the preview mock, an older core) is copied instead. */
export const termBytes = (msg: ArrayBuffer | ArrayLike<number>): Uint8Array =>
  msg instanceof ArrayBuffer ? new Uint8Array(msg) : Uint8Array.from(msg);

/** Count bytes as xterm writes them and report them in `every`-sized steps.
 *  The remainder is never flushed on its own, and needn't be: the core only
 *  waits when far more than `every` is outstanding, and that much written
 *  always crosses a step. */
export const createAcker = (ack: (bytes: number) => void, every = ACK_EVERY) => {
  let pending = 0;
  return (written: number) => {
    pending += written;
    if (pending >= every) {
      ack(pending);
      pending = 0;
    }
  };
};
