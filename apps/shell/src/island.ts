/**
 * What the notch island (NotchIsland.tsx) shows: everything running that it
 * can put in the lip under the notch, and the one that wins it.
 *
 * Sources:
 * - confirmations the shell raises (`islandToast`), for 1.8 s;
 * - media playing in a tab, from the tab plugin's `media` event (MediaWatch in
 *   the iOS plugin);
 * - Fairy, the calendar and the inbox, from Flux on your Mac over the phone
 *   link (macLink.ts).
 *
 * Who gets the lip, highest first: a confirmation, Fairy working, a meeting
 * starting soon, something playing, new mail. Anything else running shows as
 * a dot at the lip's right edge.
 */
import { addPluginListener } from "@tauri-apps/api/core";
import { createMemo, createRoot, createSignal } from "solid-js";

import { glance, fairyBusy, mailSeen } from "./macLink";
import { activeId, tabs } from "./store";

export type IslandKind = "toast" | "fairy" | "calendar" | "media" | "mail";

/** The carousel's pages, in order. */
export const PAGES = ["Quick", "Tabs", "Calendar", "Mail", "Playing", "Fairy"] as const;
export const PAGE = { quick: 0, tabs: 1, calendar: 2, mail: 3, playing: 4, fairy: 5 } as const;

export type Lip = {
  kind: IslandKind;
  text: string;
  /** Right-hand detail: a time, a count. */
  detail?: string;
  /** The page tapping it opens. */
  page: number;
};

export type Media = {
  id: number;
  has: boolean;
  playing: boolean;
  video: boolean;
  title: string;
  artist: string;
  art: string;
};

const [toast, setToast] = createSignal<string | null>(null);
let toastTimer: ReturnType<typeof setTimeout> | undefined;

/** A short confirmation in the lip ("Link copied"), gone after 1.8 s. */
export function islandToast(text: string): void {
  setToast(text);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => setToast(null), 1800);
}

const [mediaByTab, setMediaByTab] = createSignal<Record<number, Media>>({});
export { mediaByTab };

let listening = false;
/** Starts taking the plugin's `media` events. Called once the island mounts. */
export function watchMedia(): void {
  if (listening) return;
  listening = true;
  void addPluginListener<Media>("flux-webview", "media", (m) => {
    setMediaByTab((all) => {
      const next = { ...all };
      if (m.has) next[m.id] = m;
      else delete next[m.id];
      return next;
    });
  }).catch(() => {
    listening = false;
  });
}

/** Minutes from now until `HH:MM` today (negative once it's begun). */
export function minutesUntil(time: string, now = new Date()): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(time);
  if (!m) return Infinity;
  const at = new Date(now);
  at.setHours(+m[1]!, +m[2]!, 0, 0);
  return Math.round((at.getTime() - now.getTime()) / 60000);
}

/** `YYYY-MM-DD` for a date on this phone's clock. */
export function dayKey(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

const [clock, setClock] = createSignal(Date.now());
setInterval(() => setClock(Date.now()), 30_000);

/** How soon a meeting has to be to take the lip. */
export const SOON_MIN = 15;

const state = createRoot(() => {
  /** What's playing: the newest tab that is, else the newest that has media. */
  const media = createMemo<Media | null>(() => {
    const live = new Set(tabs().map((t) => t.id));
    const all = Object.values(mediaByTab()).filter((m) => live.has(m.id));
    return all.find((m) => m.playing) ?? all[all.length - 1] ?? null;
  });

  /** The next event today that hasn't ended, and how far off it is. */
  const nextEvent = createMemo(() => {
    clock();
    const g = glance();
    if (!g) return null;
    const now = new Date();
    const today = dayKey(now);
    for (const e of g.events) {
      if (e.date !== today || !e.time) continue;
      const until = minutesUntil(e.time, now);
      const ends = e.end ? minutesUntil(e.end, now) : until + 30;
      if (ends > 0) return { event: e, until };
    }
    return null;
  });

  const unreadNew = createMemo(() => {
    const g = glance();
    if (!g) return 0;
    const seen = mailSeen();
    return g.mail.messages.filter((m) => m.unread && m.date_ms > seen).length;
  });

  const candidates = createMemo<Lip[]>(() => {
    const out: Lip[] = [];
    const t = toast();
    if (t) out.push({ kind: "toast", text: t, page: PAGE.quick });
    const f = fairyBusy();
    if (f) out.push({ kind: "fairy", text: f, page: PAGE.fairy });
    const n = nextEvent();
    if (n && n.until <= SOON_MIN)
      out.push({
        kind: "calendar",
        text: n.event.summary,
        detail: n.until > 0 ? `${n.until} min` : "Now",
        page: PAGE.calendar,
      });
    const m = media();
    // Something playing in a tab you've left, or audio anywhere: a video in
    // the tab on screen is already in front of you.
    if (m?.playing && (m.id !== activeId() || !m.video))
      out.push({ kind: "media", text: m.title || "Playing", page: PAGE.playing });
    const u = unreadNew();
    if (u > 0) {
      const g = glance()!;
      const top = g.mail.messages.find((x) => x.unread);
      out.push({
        kind: "mail",
        text: top ? `${firstName(top.from)}: ${top.subject}` : "New mail",
        detail: String(g.mail.unread),
        page: PAGE.mail,
      });
    }
    return out;
  });

  const lip = createMemo<Lip | null>(() => candidates()[0] ?? null);
  const more = createMemo(() => candidates().length > 1);
  return { media, nextEvent, lip, more };
});

export const islandMedia = state.media;
export const islandNextEvent = state.nextEvent;
export const islandLip = state.lip;
export const islandMore = state.more;

/** "Ana Ruiz <ana@x>" → "Ana". */
export function firstName(from: string): string {
  const name = from.replace(/<[^>]*>/g, "").replace(/"/g, "").trim();
  return (name.split(/\s+/)[0] || from).slice(0, 24);
}
