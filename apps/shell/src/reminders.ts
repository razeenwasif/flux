// Reminders / to-dos Gemma surfaces proactively ("Hey Razeen, just a reminder …").
// Persisted + scheduled by the Rust backend (survives restarts; fires via an OS
// notification + event even with the panel closed). This module is a thin wrapper
// plus the natural-language time parsing.

import { remindersAdd, remindersImport, remindersList, remindersRemove, type ReminderRow } from "./ipc";

export type Reminder = ReminderRow;

let seq = 0;

export async function addReminder(text: string, due: number | null): Promise<void> {
  await remindersAdd(`r${Date.now()}_${seq++}`, text.trim(), due, Date.now());
}
export async function removeReminder(id: string): Promise<void> { await remindersRemove(id); }

/** Pending (not-yet-fired) reminders, soonest first; undated to-dos last. */
export async function pendingReminders(): Promise<Reminder[]> {
  const rs = await remindersList();
  return rs.filter((r) => !r.fired).sort((a, b) => (a.due ?? Infinity) - (b.due ?? Infinity));
}

/** One-time migration of the old localStorage reminders into the backend. */
export async function migrateReminders(): Promise<void> {
  const raw = localStorage.getItem("flux.reminders");
  if (!raw) return;
  try {
    const items = JSON.parse(raw) as Reminder[];
    if (items.length) await remindersImport(items);
  } catch { /* ignore */ }
  localStorage.removeItem("flux.reminders");
}

/** A human time like "in 10 minutes" / "at 3pm" / "tomorrow at 9" → epoch ms,
 *  stripped from the text. Returns `due: null` for an undated to-do. `now` is
 *  injected so this stays pure/testable. */
export function parseWhen(input: string, now: number): { text: string; due: number | null } {
  let text = input.trim();
  const lower = text.toLowerCase();

  // "in N minutes/hours/seconds/days"
  const rel = lower.match(/\bin\s+(\d+)\s*(sec(?:ond)?s?|min(?:ute)?s?|hours?|hrs?|days?)\b/);
  if (rel) {
    const n = Number(rel[1]);
    const unit = rel[2]!;
    const ms = unit.startsWith("sec") ? n * 1e3 : unit.startsWith("min") ? n * 6e4 : unit.startsWith("h") ? n * 36e5 : n * 864e5;
    text = strip(text, rel[0]!);
    return { text, due: now + ms };
  }

  // "(today|tomorrow)? at H[:MM] (am|pm)?"
  const at = lower.match(/\b(?:(today|tomorrow)\s+)?at\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/);
  if (at) {
    const day = at[1];
    let h = Number(at[2]);
    const min = at[3] ? Number(at[3]) : 0;
    const ap = at[4];
    if (ap === "pm" && h < 12) h += 12;
    if (ap === "am" && h === 12) h = 0;
    const d = new Date(now);
    d.setHours(h, min, 0, 0);
    let due = d.getTime();
    if (day === "tomorrow") due += 864e5;
    else if (due <= now) due += 864e5; // already past today → tomorrow
    text = strip(text, at[0]!);
    return { text, due };
  }

  // bare "tomorrow" → 9am tomorrow
  if (/\btomorrow\b/.test(lower)) {
    const d = new Date(now + 864e5);
    d.setHours(9, 0, 0, 0);
    text = strip(text, "tomorrow");
    return { text, due: d.getTime() };
  }

  return { text, due: null };
}

function strip(text: string, phrase: string): string {
  const i = text.toLowerCase().indexOf(phrase.toLowerCase());
  const out = i < 0 ? text : (text.slice(0, i) + text.slice(i + phrase.length));
  return out.replace(/\s{2,}/g, " ").replace(/^[\s,–-]+|[\s,–-]+$/g, "").trim();
}

/** "in 5 min" / "tomorrow at 9am" / "" (no time). */
export function whenLabel(due: number | null): string {
  if (due == null) return "";
  const d = new Date(due);
  const today = new Date(due);
  const time = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  return `${today.toLocaleDateString([], { weekday: "short" })} ${time}`;
}
