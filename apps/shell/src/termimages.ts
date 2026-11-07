/**
 * Inline images in the terminal (Sixel and iTerm's protocol). Its own chunk, loaded
 * when a program first needs it (`mayHoldImage`, termdraw.ts): most terminals never
 * show an image.
 */
import type { Terminal } from "@xterm/xterm";

/** Whether this webview will run WebAssembly, which the image addon decodes with.
 *  An older one may not honour the `wasm-unsafe-eval` in Flux's content security
 *  policy, and if the addon is loaded there it stops the terminal at its first
 *  image, so it has to stay out. */
export function canRunWasm(): boolean {
  try {
    // The smallest module there is: the magic number and version.
    new WebAssembly.Module(Uint8Array.of(0, 0x61, 0x73, 0x6d, 1, 0, 0, 0));
    return true;
  } catch {
    return false;
  }
}

export async function addImages(term: Terminal): Promise<void> {
  if (!canRunWasm()) return;
  const { ImageAddon } = await import("@xterm/addon-image");
  // Held for scrollback, in unpacked pixels; the addon's default is 128 MB per
  // terminal. A 4K image still fits.
  term.loadAddon(new ImageAddon({ storageLimit: 64 }));
}
