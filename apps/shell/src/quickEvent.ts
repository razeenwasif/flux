/**
 * The tabs pane's Calendar mode adds an event from one line of text.
 */
const pad2 = (n: number) => String(n).padStart(2, "0");
const ymd = (d: Date) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

/**
 * Quick add: "lab tue 3pm", "dentist tomorrow 9:30am", "standup 10:00".
 * A time and a day are taken out of the text wherever they are; what's left is
 * the title. No day means the day picked in the grid.
 */
export const parseQuickEvent = (
  text: string,
  base: string,
  now = new Date(),
): { title: string; date: string; start: string } | null => {
  let rest = ` ${text} `;
  let date = base;
  let start = "";
  const tm =
    rest.match(/\s(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)(?=\s)/i) ??
    rest.match(/\s(?:at\s+)?(\d{1,2}):(\d{2})(?=\s)/);
  if (tm) {
    let h = Number(tm[1]);
    const mi = tm[2] ? Number(tm[2]) : 0;
    const ap = tm[3]?.toLowerCase();
    if (ap === "pm" && h < 12) h += 12;
    if (ap === "am" && h === 12) h = 0;
    if (h < 24 && mi < 60) {
      start = `${pad2(h)}:${pad2(mi)}`;
      rest = rest.replace(tm[0], " ");
    }
  }
  const dm = rest.match(
    /\s(?:on\s+)?(today|tonight|tomorrow|tmrw?|(?:mon|tue|wed|thu|fri|sat|sun)[a-z]*)(?=\s)/i,
  );
  if (dm) {
    const w = dm[1]!.toLowerCase();
    const d = new Date(now);
    if (w.startsWith("tom") || w.startsWith("tmr")) d.setDate(d.getDate() + 1);
    else if (w !== "today" && w !== "tonight") {
      const i = WEEKDAYS.indexOf(w.slice(0, 3));
      if (i < 0) return null;
      d.setDate(d.getDate() + ((i - d.getDay() + 7) % 7 || 7));
    }
    date = ymd(d);
    rest = rest.replace(dm[0], " ");
  }
  const title = rest.replace(/\s+/g, " ").trim();
  return title ? { title, date, start } : null;
};
