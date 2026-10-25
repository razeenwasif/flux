/**
 * One line, read as a task (Flux Next "task capture"). Anywhere in the line:
 * `!1`–`!3` (priority), `#list`, `~45m` (how long). A date is read only at the
 * end: "Call Anna tomorrow at 3" gets one, "Meet the Friday team" keeps its
 * words. What was read comes back with where it sits in the line, so the
 * capture field can show it, and Esc can keep the words instead.
 */

export interface TaskMark {
  start: number;
  end: number;
  kind: "date" | "priority" | "list" | "duration";
}

export interface TaskLine {
  /** The words left once everything read is taken out. */
  title: string;
  /** `YYYY-MM-DD`, or "". */
  due: string;
  /** `HH:MM`, or "". */
  time: string;
  /** 0 for none, 1 (highest) to 3. */
  priority: number;
  list: string;
  minutes: number;
  marks: TaskMark[];
}

const pad2 = (n: number) => String(n).padStart(2, "0");
export const ymd = (d: Date) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const addDays = (d: Date, n: number) => {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  x.setDate(x.getDate() + n);
  return x;
};

const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const WEEKDAY = /^(sun|mon|tue|wed|thu|fri|sat)(?:day|s|sday|nesday|rsday|urday|r|rs|t)?$/;

/** A day: today, tomorrow, a weekday, next week, in 3 days, 30 Oct, Oct 30, 30/10, 2026-10-30. */
function parseDay(s: string, now: Date): Date | null {
  const today = addDays(now, 0);
  if (s === "today" || s === "tonight") return today;
  if (/^(tomorrow|tmrw?|tmr)$/.test(s)) return addDays(today, 1);
  if (s === "next week") return addDays(today, (8 - today.getDay()) % 7 || 7);
  let m = s.match(/^in (\d{1,3}) (day|days|week|weeks)$/);
  if (m) return addDays(today, Number(m[1]) * (m[2]!.startsWith("week") ? 7 : 1));
  m = s.match(/^(?:(this|next) )?([a-z]+)$/);
  // "In the sun" isn't Sunday: the bare abbreviation is too common a word.
  if (m && WEEKDAY.test(m[2]!) && !(m[2] === "sun" && !m[1])) {
    const i = WEEKDAYS.indexOf(m[2]!.slice(0, 3));
    // Today counts ("friday" said on a Friday); "next friday" is the one after the coming one.
    const ahead = (i - today.getDay() + 7) % 7;
    return addDays(today, m[1] === "next" ? (ahead || 7) + 7 : ahead);
  }
  m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) return valid(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  let day = 0;
  let month = -1;
  m = s.match(/^(\d{1,2})(?:st|nd|rd|th)? ([a-z]{3,9})$/) ?? null;
  if (m && MONTHS.includes(m[2]!.slice(0, 3)))
    [day, month] = [Number(m[1]), MONTHS.indexOf(m[2]!.slice(0, 3))];
  m = s.match(/^([a-z]{3,9}) (\d{1,2})(?:st|nd|rd|th)?$/);
  if (m && MONTHS.includes(m[1]!.slice(0, 3)))
    [day, month] = [Number(m[2]), MONTHS.indexOf(m[1]!.slice(0, 3))];
  // Day first, as written in Australia.
  m = s.match(/^(\d{1,2})\/(\d{1,2})$/);
  if (m) [day, month] = [Number(m[1]), Number(m[2]) - 1];
  if (month < 0) return null;
  // This year's, or next year's once this year's is past.
  const d = valid(today.getFullYear(), month, day);
  if (d && d < addDays(today, -1)) return valid(today.getFullYear() + 1, month, day);
  return d;
}

function valid(y: number, mo: number, d: number): Date | null {
  const x = new Date(y, mo, d);
  return x.getFullYear() === y && x.getMonth() === mo && x.getDate() === d ? x : null;
}

/** A time: 5pm, 5:30 pm, 17:00, noon, or "at 3" (a bare hour needs its "at"). */
function parseTime(s: string): string | null {
  if (s === "noon" || s === "at noon") return "12:00";
  let m = s.match(/^(?:at )?(\d{1,2})(?::(\d{2}))? ?(am|pm)$/);
  if (m) {
    let h = Number(m[1]);
    const mi = Number(m[2] ?? 0);
    if (h < 1 || h > 12 || mi > 59) return null;
    if (m[3] === "pm" && h < 12) h += 12;
    if (m[3] === "am" && h === 12) h = 0;
    return `${pad2(h)}:${pad2(mi)}`;
  }
  m = s.match(/^(?:at )?(\d{1,2}):(\d{2})$/);
  if (m) {
    const h = Number(m[1]);
    const mi = Number(m[2]);
    return h < 24 && mi < 60 ? `${pad2(h)}:${pad2(mi)}` : null;
  }
  m = s.match(/^at (\d{1,2})$/);
  if (m) {
    const h = Number(m[1]);
    if (h < 1 || h > 12) return null;
    // Waking hours: "at 3" is the afternoon, "at 9" the morning.
    return `${pad2(h <= 7 ? h + 12 : h)}:00`;
  }
  return null;
}

/** A whole date phrase: a day, a time, or both in either order. */
function parsePhrase(raw: string, now: Date): { due: string; time: string } | null {
  const s = raw.toLowerCase().replace(/^(?:on|by|due|before) /, "");
  const day = parseDay(s, now);
  if (day) return { due: ymd(day), time: "" };
  const time = parseTime(s);
  if (time) {
    // A time alone is today's, or tomorrow's once it has passed.
    const passed = time < `${pad2(now.getHours())}:${pad2(now.getMinutes())}`;
    return { due: ymd(addDays(now, passed ? 1 : 0)), time };
  }
  const words = s.split(" ");
  for (let i = 1; i < words.length; i++) {
    const a = words.slice(0, i).join(" ");
    const b = words.slice(i).join(" ");
    for (const [d, t] of [
      [a, b],
      [b.replace(/^on /, ""), a],
    ] as const) {
      const dd = parseDay(d, now);
      const tt = dd && parseTime(t);
      if (dd && tt) return { due: ymd(dd), time: tt };
    }
  }
  return null;
}

const TOKEN =
  /(^|\s)(?:!([1-3])|#(\p{L}[\p{L}\p{N}_-]*)|~(\d+(?:\.\d+)?)(m|min|mins|h|hr|hrs)?(?:(\d{1,2})m)?)(?=\s|$)/gu;

/** Read `text` as a task. `lists` are the lists that exist, for their spelling. */
export function parseTaskLine(text: string, now = new Date(), lists: string[] = []): TaskLine {
  const marks: TaskMark[] = [];
  let priority = 0;
  let list = "";
  let minutes = 0;
  for (const m of text.matchAll(TOKEN)) {
    const start = m.index! + m[1]!.length;
    const end = m.index! + m[0].length;
    if (m[2]) {
      priority = Number(m[2]);
      marks.push({ start, end, kind: "priority" });
    } else if (m[3]) {
      const name = m[3];
      list =
        lists.find((l) => l.toLowerCase() === name.toLowerCase()) ?? name[0]!.toUpperCase() + name.slice(1);
      marks.push({ start, end, kind: "list" });
    } else if (m[4]) {
      const n = Number(m[4]);
      const hours = m[5]?.startsWith("h");
      minutes = Math.round(hours ? n * 60 + Number(m[6] ?? 0) : n);
      marks.push({ start, end, kind: "duration" });
    }
  }
  // What's left, as words with where each sits.
  const taken = (i: number) => marks.some((k) => i >= k.start && i < k.end);
  const words: { w: string; start: number; end: number }[] = [];
  for (const m of text.matchAll(/\S+/g)) {
    if (!taken(m.index!)) words.push({ w: m[0], start: m.index!, end: m.index! + m[0].length });
  }
  // The longest run of closing words that reads as a date, leaving a title.
  let due = "";
  let time = "";
  for (let k = Math.min(5, words.length - 1); k >= 1; k--) {
    const tail = words.slice(words.length - k);
    const phrase = tail
      .map((x) => x.w)
      .join(" ")
      .replace(/[.,;]$/, "");
    const got = parsePhrase(phrase, now);
    if (got) {
      ({ due, time } = got);
      marks.push({ start: tail[0]!.start, end: tail[k - 1]!.end, kind: "date" });
      words.length -= k;
      break;
    }
  }
  marks.sort((a, b) => a.start - b.start);
  return {
    title: words.map((x) => x.w).join(" "),
    due,
    time,
    priority,
    list,
    minutes,
    marks,
  };
}

/** "Fri 24 Oct, 5:00 pm", "Today", "Tomorrow, 9:00 am". */
export function formatDue(due: string, time: string, now = new Date()): string {
  if (!due) return "";
  const today = ymd(now);
  const d = new Date(`${due}T${time || "00:00"}`);
  const day =
    due === today
      ? "Today"
      : due === ymd(addDays(now, 1))
        ? "Tomorrow"
        : d.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
  return time ? `${day}, ${d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}` : day;
}

/** "45 min", "1 h 30 min". */
export function formatMinutes(m: number): string {
  if (!m) return "";
  const h = Math.floor(m / 60);
  const r = m % 60;
  return h ? `${h} h${r ? ` ${r} min` : ""}` : `${r} min`;
}
