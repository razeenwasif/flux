/**
 * The phone link: Flux on this iPhone reading from Flux on your Mac over
 * Tailscale, for the notch island's Calendar, Mail and Fairy pages (Gmail over
 * IMAP and Google Calendar's ICS feed are set up on the Mac; Fairy runs there).
 *
 * The Mac side is `phonelink.rs`: an HTTPS server on the Mac's Tailscale
 * address only, with its own certificate. Pairing hands the phone that
 * certificate's fingerprint and a one-time code (a `flux-browser://pair?…`
 * link the Mac copies, which reaches the phone by Universal Clipboard or
 * AirDrop); the phone trades the code for a key. The iOS plugin keeps the key
 * in the Keychain and makes every request itself, pinned to that fingerprint,
 * so neither ever passes through this page.
 */
import { addPluginListener, invoke } from "@tauri-apps/api/core";
import { createSignal } from "solid-js";

export type GlanceEvent = {
  summary: string;
  /** `YYYY-MM-DD` */
  date: string;
  /** `HH:MM`, "" for all day. */
  time: string;
  end: string;
  location: string;
  calendar: string;
  /** A meeting link found in the event (Meet, Zoom, Teams), or "". */
  join: string;
};

export type GlanceMail = {
  from: string;
  subject: string;
  date_ms: number;
  unread: boolean;
  /** Opens this message in Gmail on the web. */
  link: string;
};

export type Glance = {
  /** The Mac's clock when it answered, epoch ms. */
  at: number;
  calendar: { connected: boolean };
  /** This week's events (Monday to Sunday), by start. */
  events: GlanceEvent[];
  mail: { connected: boolean; unread: number; messages: GlanceMail[] };
  fairy: { installed: boolean; name: string };
};

export type LinkState = "unpaired" | "connecting" | "linked" | "offline";

const [state, setState] = createSignal<LinkState>("unpaired");
const [macName, setMacName] = createSignal("");
const [glance, setGlance] = createSignal<Glance | null>(null);
const [problem, setProblem] = createSignal("");
export { state as linkState, macName, glance, problem as linkProblem };

/** What Fairy is doing for the island ("Reading the page"), or null. */
const [fairyBusy, setFairyBusy] = createSignal<string | null>(null);
export { fairyBusy };

const SEEN_KEY = "flux.island.mailSeen";
const [mailSeen, setMailSeen] = createSignal<number>(
  (() => {
    try {
      return Number(localStorage.getItem(SEEN_KEY)) || 0;
    } catch {
      return 0;
    }
  })(),
);
export { mailSeen };
/** The Mail page was looked at: what's there now is no longer new. */
export function markMailSeen(): void {
  const newest = Math.max(0, ...(glance()?.mail.messages.map((m) => m.date_ms) ?? []));
  if (newest <= mailSeen()) return;
  setMailSeen(newest);
  try {
    localStorage.setItem(SEEN_KEY, String(newest));
  } catch {
    /* private mode: it's just forgotten at quit */
  }
}

type Reply = { status: number; body: string };

async function request(method: "GET" | "POST", path: string, body?: unknown): Promise<unknown> {
  const r = await invoke<Reply>("plugin:flux-webview|link_request", {
    method,
    path,
    body: body === undefined ? null : JSON.stringify(body),
  });
  if (r.status === 401) {
    setState("unpaired");
    throw new Error("This phone isn't paired any more.");
  }
  const json = r.body ? (JSON.parse(r.body) as unknown) : null;
  if (r.status !== 200) {
    const msg = (json as { error?: string } | null)?.error;
    throw new Error(msg || `The Mac answered ${r.status}.`);
  }
  return json;
}

let timer: ReturnType<typeof setInterval> | undefined;
let inflight = false;

/** Fetches the calendar and inbox from the Mac. */
export async function refreshGlance(): Promise<void> {
  if (inflight || state() === "unpaired") return;
  inflight = true;
  try {
    const g = (await request("GET", "/v1/glance")) as Glance;
    setGlance(g);
    setState("linked");
    setProblem("");
  } catch (e) {
    if (state() !== "unpaired") {
      setState("offline");
      setProblem(e instanceof Error ? e.message : String(e));
    }
  } finally {
    inflight = false;
  }
}

/** Reads the saved pairing (if any) and starts polling: every 2 minutes, and
 *  when the app comes back to the front. */
export async function startLink(): Promise<void> {
  // A pairing link opened on the phone itself (AirDrop, Messages, the
  // camera) is paired natively; this hears how it went.
  void addPluginListener<{ name?: string; error?: string }>("flux-webview", "linked", (e) => {
    if (e.error) {
      setProblem(e.error);
      return;
    }
    setMacName(e.name ?? "");
    setState("connecting");
    void refreshGlance();
  }).catch(() => {});
  try {
    const s = await invoke<{ paired: boolean; name: string }>("plugin:flux-webview|link_status");
    setMacName(s.name);
    setState(s.paired ? "connecting" : "unpaired");
  } catch {
    setState("unpaired");
    return;
  }
  if (timer) return;
  void refreshGlance();
  timer = setInterval(() => void refreshGlance(), 120_000);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") void refreshGlance();
  });
}

/** Pairs with a Mac from its `flux-browser://pair?…` link. */
export async function pairWith(link: string): Promise<void> {
  setProblem("");
  setState("connecting");
  try {
    const s = await invoke<{ name: string }>("plugin:flux-webview|link_pair", { link });
    setMacName(s.name);
    setState("linked");
    await refreshGlance();
    if (!timer) void startLink();
  } catch (e) {
    setState("unpaired");
    setProblem(e instanceof Error ? e.message : String(e));
    throw e;
  }
}

/** Pairs from a link on the clipboard (copied on the Mac, so it arrives by
 *  Universal Clipboard). iOS asks before letting Flux read it. */
export async function pairFromClipboard(): Promise<void> {
  const text = (await navigator.clipboard.readText().catch(() => "")).trim();
  if (!text.startsWith("flux-browser://pair?")) {
    setProblem("There's no pairing link on the clipboard. On your Mac, open Flux's Settings › Phone link and copy one.");
    throw new Error("no link");
  }
  await pairWith(text);
}

export async function forgetMac(): Promise<void> {
  await invoke("plugin:flux-webview|link_forget").catch(() => {});
  setGlance(null);
  setMacName("");
  setState("unpaired");
}

export type FairyAnswer = { answer: string; sources: string[] };

/** Asks Fairy on the Mac about the page on screen. While she works, the
 *  island's lip says so. */
export async function askFairy(
  question: string,
  page: { url: string; title: string; text: string },
): Promise<FairyAnswer> {
  setFairyBusy("Fairy is reading");
  try {
    return (await request("POST", "/v1/fairy", { question, page })) as FairyAnswer;
  } finally {
    setFairyBusy(null);
  }
}
