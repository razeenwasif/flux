/**
 * Add a task from one typed line (taskLine.ts reads it): every place that
 * takes a to-do goes through here, so `!1 #uni ~45m friday 5pm` means the same
 * in the Tasks page, Notes mode, the calendar and the launcher.
 */
import { todoAdd, type Todo } from "./ipc";
import { parseTaskLine } from "./taskLine";

export interface AddOptions {
  /** Lists that exist, for their spelling. */
  lists?: string[];
  /** The list when the line names none. */
  list?: string;
  /** Keep the words as typed (Esc in the capture field). */
  plain?: boolean;
  source?: string;
  byAgent?: boolean;
}

export async function addTaskLine(raw: string, o: AddOptions = {}): Promise<Todo | null> {
  const text = raw.trim();
  if (!text) return null;
  if (o.plain) return todoAdd(text, undefined, o.list, { source: o.source, byAgent: o.byAgent });
  const t = parseTaskLine(text, new Date(), o.lists ?? []);
  return todoAdd(t.title || text, t.due || undefined, t.list || o.list, {
    time: t.time,
    priority: t.priority,
    minutes: t.minutes,
    source: o.source,
    byAgent: o.byAgent,
  });
}
