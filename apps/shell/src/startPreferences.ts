export const WIDGETS: { key: string; label: string }[] = [
  { key: "recent", label: "Open tabs" },
  { key: "shortcuts", label: "Shortcuts" },
  { key: "topsites", label: "Top sites" },
  { key: "headlines", label: "Headlines" },
  { key: "briefing", label: "Daily briefing" },
  { key: "scratchpad", label: "Scratchpad" },
  { key: "calendar", label: "Calendar & clocks" },
  { key: "tasks", label: "Tasks" },
  { key: "clocks", label: "Timers & alarms" },
  { key: "calc", label: "Calculator" },
  { key: "convert", label: "Unit converter" },
  { key: "map", label: "Maps" },
  { key: "omni", label: "Omni index" },
  { key: "actions", label: "Quick actions" },
];

const keys = WIDGETS.map((widget) => widget.key);
export const FOCUSED_HIDDEN = keys.filter((key) => !["recent", "shortcuts", "scratchpad"].includes(key));
function savedKeys(raw: string | null): string[] | null {
  if (raw === null) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (!Array.isArray(value)) return null;
    return [...new Set(value.filter((key): key is string => typeof key === "string" && keys.includes(key)))];
  } catch {
    return null;
  }
}
export const readHidden = (raw: string | null): string[] => savedKeys(raw) ?? [...FOCUSED_HIDDEN];
export function readOrder(raw: string | null): string[] {
  const saved = savedKeys(raw) ?? [];
  return [...saved, ...keys.filter((key) => !saved.includes(key))];
}
