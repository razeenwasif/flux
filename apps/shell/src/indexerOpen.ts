import { createSignal } from "solid-js";
/** The Indexer orb's question panel is open (it covers the page, see pageOverlayActive). */
export const [indexerPanelOpen, setIndexerPanelOpen] = createSignal(false);
