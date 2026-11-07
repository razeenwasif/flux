/**
 * Dates in what you tell the agent about your calendar (#114): "lunch with Sam
 * friday at noon for 90 min", "what's on this week". Out of AgentPanel and loaded
 * when a message first looks like one, since the panel loads with the window.
 */

/** A real month name or abbreviation. A bare prefix ("dec…") read "2 decimals"
 *  as 2 December, which matters now that a parsed date alone admits an add. */
const MONTH =
  "jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?";

/** "march 5", "on sept. 3rd": the month in group 1, the day in group 2. */
export const MONTH_DAY = new RegExp(`\\b(?:on\\s+)?(${MONTH})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b`, "i");

/** "5 june", "the 5th of december": the day in group 1, the month in group 2. */
export const DAY_MONTH = new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?(${MONTH})\\b`, "i");

export const pad2c = (n: number) => String(n).padStart(2, "0");
export const isoOf = (d: Date) => `${d.getFullYear()}-${pad2c(d.getMonth() + 1)}-${pad2c(d.getDate())}`;
export const hmOf = (d: Date) => `${pad2c(d.getHours())}:${pad2c(d.getMinutes())}`;
export const WEEKDAYS_L = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
export const MONTHS_L = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
export const dayLabelOf = (iso: string) => {
  const d = new Date(`${iso}T00:00`);
  const t = isoOf(new Date());
  if (iso === t) return "Today";
  if (iso === isoOf(new Date(Date.now() + 864e5))) return "Tomorrow";
  return d.toLocaleDateString([], { weekday: "long", month: "short", day: "numeric" });
};

/** Parse a date/time/duration out of a scheduling phrase. Returns the matched
 *  date/start/end plus the remaining text (the event title); `dated` says
 *  whether the phrase named a day, before the today/tomorrow default. */
export const parseEventSpec = (
  input: string,
): { date: string; start: string; end: string; title: string; dated: boolean } => {
  let rest = input;
  const now = new Date();
  let date: Date | null = null;
  let start: string = "";
  let durMin = 60;
  const cut = (re: RegExp) => {
    const m = rest.match(re);
    if (m) {
      rest = (rest.slice(0, m.index) + rest.slice(m.index! + m[0].length)).replace(/\s{2,}/g, " ").trim();
    }
    return m;
  };

  // Duration — "for 90 min" / "for 2 hours".
  {
    const m = cut(/\bfor\s+(\d+(?:\.\d+)?)\s*(hours?|hrs?|h|minutes?|mins?|m)\b/i);
    if (m) {
      const n = Number(m[1]);
      durMin = /^h/i.test(m[2]!) ? Math.round(n * 60) : Math.round(n);
    }
  }

  // Date — today / tomorrow / weekday / "next week" / month-day.
  if (cut(/\btoday\b/i)) date = new Date(now);
  else if (cut(/\btomorrow\b/i)) date = new Date(now.getTime() + 864e5);
  else {
    const wd = cut(new RegExp(`\\b(next\\s+|this\\s+|on\\s+)?(${WEEKDAYS_L.join("|")})\\b`, "i"));
    if (wd) {
      const target = WEEKDAYS_L.indexOf(wd[2]!.toLowerCase());
      let delta = (target - now.getDay() + 7) % 7;
      if (/next/i.test(wd[1] ?? "")) delta += 7;
      date = new Date(now.getTime() + delta * 864e5);
    } else if (cut(/\bnext\s+week\b/i)) {
      date = new Date(now.getTime() + 7 * 864e5);
    } else {
      const mo = cut(MONTH_DAY) || cut(DAY_MONTH);
      if (mo) {
        const firstIsMonth = MONTHS_L.includes(mo[1]!.slice(0, 3).toLowerCase());
        const monIdx = MONTHS_L.indexOf((firstIsMonth ? mo[1]! : mo[2]!).slice(0, 3).toLowerCase());
        const dayNum = Number(firstIsMonth ? mo[2]! : mo[1]!);
        let y = now.getFullYear();
        if (new Date(y, monIdx, dayNum).getTime() < now.getTime() - 864e5) y += 1; // already passed → next year
        date = new Date(y, monIdx, dayNum);
      }
    }
  }

  // Time — "at 3[:30] pm" / "3pm" / "noon" / "midnight".
  if (cut(/\b(?:at\s+)?noon\b/i)) start = "12:00";
  else if (cut(/\b(?:at\s+)?midnight\b/i)) start = "00:00";
  else {
    const tm =
      cut(/\b(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i) || cut(/\bat\s+(\d{1,2})(?::(\d{2}))?\b/i);
    if (tm) {
      let h = Number(tm[1]);
      const mi = tm[2] ? Number(tm[2]) : 0;
      const ap = (tm[3] ?? "").toLowerCase();
      if (ap === "pm" && h < 12) h += 12;
      if (ap === "am" && h === 12) h = 0;
      start = `${pad2c(h)}:${pad2c(mi)}`;
    }
  }

  const dated = date !== null;
  if (!date) {
    // No explicit date: if a time was given and it's already past today, use tomorrow.
    date = new Date(now);
    if (start) {
      const [h, m] = start.split(":").map(Number);
      const cand = new Date(now);
      cand.setHours(h!, m!, 0, 0);
      if (cand.getTime() <= now.getTime()) date = new Date(now.getTime() + 864e5);
    }
  }
  let end = "";
  if (start) {
    const [h, m] = start.split(":").map(Number);
    const e = new Date(0);
    e.setHours(h!, (m ?? 0) + durMin, 0, 0);
    end = hmOf(e);
  }
  // Clean leftover connective words from the title.
  const title = rest
    .replace(/^(?:to|for|about|:|-|–)\s+/i, "")
    .replace(/\b(?:on|in|to)\s+(?:my\s+)?calendar\b/gi, "")
    .replace(/\s{2,}/g, " ")
    .trim();
  return { date: isoOf(date), start, end, title, dated };
};

export const calRange = (text: string): { lo: string; hi: string; label: string } => {
  const today = new Date();
  const t = isoOf(today);
  if (/\btomorrow\b/i.test(text)) {
    const d = isoOf(new Date(Date.now() + 864e5));
    return { lo: d, hi: d, label: "tomorrow" };
  }
  if (/\b(this\s+)?week\b|\bnext\s+7\b|\bcoming\s+up\b|\bupcoming\b/i.test(text))
    return { lo: t, hi: isoOf(new Date(Date.now() + 7 * 864e5)), label: "this week" };
  for (let i = 0; i < 7; i++) {
    if (new RegExp(`\\b${WEEKDAYS_L[i]}\\b`, "i").test(text)) {
      const delta = (i - today.getDay() + 7) % 7;
      const d = isoOf(new Date(Date.now() + delta * 864e5));
      return { lo: d, hi: d, label: dayLabelOf(d) };
    }
  }
  if (/\btoday\b|\bright now\b/i.test(text)) return { lo: t, hi: t, label: "today" };
  return { lo: t, hi: isoOf(new Date(Date.now() + 7 * 864e5)), label: "the next 7 days" };
};
