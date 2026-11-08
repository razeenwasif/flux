/**
 * Opening a Tor tab (tor.rs): private, through a Tor running on this machine.
 * When none is, it says how to start one rather than opening a tab that can't
 * connect. Its own chunk: nothing here is needed until you ask for one.
 */
import { invoke } from "@tauri-apps/api/core";

import { tabCreate } from "./ipc";
import { focusTab, refreshTabs } from "./store";

/** Tor's own page saying whether this tab is on Tor: where a new Tor tab starts. */
const CHECK = "https://check.torproject.org/";

export async function openTorTab(say: (text: string) => void, url = CHECK): Promise<boolean> {
  // The port of a Tor running here (9050 or 9150), or null.
  const port = await invoke<number | null>("tor_status").catch(() => null);
  if (port == null) {
    say("Tor isn't running. Start it with `brew services start tor`, or open Tor Browser.");
    return false;
  }
  const tab = await tabCreate("browser", url, true, undefined, false, true);
  await refreshTabs();
  await focusTab(tab.id);
  return true;
}
