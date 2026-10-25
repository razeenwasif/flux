/**
 * Time and focus calls (sitetime.rs, focus.rs): off the boot path, with the
 * focus store (focusStore.ts) and the pages that use them.
 */
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

import type { FocusStatus, TimeReport, TodayStrip } from "./ipc";
/** Minutes east of UTC, so Rust's "today" is the one on this Mac's clock. */
const tz = () => -new Date().getTimezoneOffset();
export const focusStatus = () => invoke<FocusStatus>("focus_status", { tzOffsetMin: tz() });
/** Start a session; `blocks` empty means the sites chosen last time. */
export const focusStart = (name: string, minutes: number, blocks: string[]) =>
  invoke<FocusStatus>("focus_start", { name, minutes, blocks, tzOffsetMin: tz() });
export const focusPause = (paused: boolean) =>
  invoke<FocusStatus>("focus_pause", { paused, tzOffsetMin: tz() });
export const focusEnd = () => invoke<FocusStatus>("focus_end", { tzOffsetMin: tz() });
export const focusAllow = (site: string, minutes = 5) =>
  invoke<FocusStatus>("focus_allow", { site, minutes, tzOffsetMin: tz() });
export const focusSet = (sites?: string[], goalMinutes?: number) =>
  invoke<FocusStatus>("focus_set", {
    sites: sites ?? null,
    goalMinutes: goalMinutes ?? null,
    tzOffsetMin: tz(),
  });
/** A session started, paused, ended or let a site through. */
export const onFocusChanged = (cb: () => void) => listen<null>("flux://focus", () => cb());
/** A focus session stopped `tab` from loading `url` (on `site`). */
export const onFocusBlocked = (cb: (tab: number, url: string, site: string) => void) =>
  listen<[number, string, string]>("flux://focus-blocked", (e) => cb(...e.payload));
export const timeReport = (week: boolean) => invoke<TimeReport>("time_report", { week, tzOffsetMin: tz() });
export const timeForget = () => invoke<void>("time_forget");
/** The new tab's strip; `today` is this Mac's YYYY-MM-DD, for tasks due. */
export const todayStrip = (today: string) => invoke<TodayStrip>("today_strip", { tzOffsetMin: tz(), today });
