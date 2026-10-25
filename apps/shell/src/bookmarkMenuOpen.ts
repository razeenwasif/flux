import { createSignal } from "solid-js";
/** The bookmark bar's folder menu is open. It rises over the content card, so
 *  it's in the store's overlay registry: the native page would cover it. */
export const [bookmarkMenuOpen, setBookmarkMenuOpen] = createSignal(false);
