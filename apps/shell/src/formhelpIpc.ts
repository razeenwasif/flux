/**
 * Form help settings (formhelp.rs): Settings' calls, kept out of the chrome's
 * entry chunk.
 */
import { invoke } from "@tauri-apps/api/core";

import type { FormHelpPrefs } from "./ipc";

export const formHelpSettings = () => invoke<FormHelpPrefs>("formhelp_settings", {});
/** Saves them; resolves to what was stored (the backend tidies the site list). */
export const formHelpSetSettings = (prefs: FormHelpPrefs) =>
  invoke<FormHelpPrefs>("formhelp_set_settings", { prefs });
