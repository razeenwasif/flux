/**
 * The launcher's rules (Launcher.tsx draws them), kept pure so they're
 * tested rather than eyeballed.
 *
 * One list in a fixed order, Search, Tabs, History, Notes, Commands, each
 * capped (3, 4, 2, 2, commands taking the rest) at 14 rows in all. Results
 * that arrive late join their own section and the selection stays on the row
 * it was on, so nothing jumps under the pointer. `@tabs`, `@history`,
 * `@notes` and `>` narrow the list to one section, which then gets all 14.
 */

export type SectionKind = "search" | "tabs" | "history" | "notes" | "commands";
export type Scope = "all" | Exclude<SectionKind, "search">;

export const SECTION_ORDER: SectionKind[] = ["search", "tabs", "history", "notes", "commands"];
export const CAPS: Record<Exclude<SectionKind, "commands">, number> = {
  search: 3,
  tabs: 4,
  history: 2,
  notes: 2,
};
export const MAX_ROWS = 14;

/** What was typed: a scope prefix and the query after it. */
export function parseQuery(text: string): { scope: Scope; q: string } {
  const t = text.trimStart();
  if (t.startsWith(">")) return { scope: "commands", q: t.slice(1).trim() };
  const m = /^@(tabs|history|notes)(?:\s+|$)/i.exec(t);
  if (m) return { scope: m[1]!.toLowerCase() as Scope, q: t.slice(m[0].length).trim() };
  return { scope: "all", q: t.trim() };
}

export interface Section<T> {
  kind: SectionKind;
  rows: T[];
  /** How many there were before the cap ("4 of 23"). */
  total: number;
}

/** The sections to draw, in order and capped. Empty ones are left out. */
export function layout<T>(rows: Record<SectionKind, T[]>, scope: Scope): Section<T>[] {
  if (scope !== "all") {
    const list = rows[scope];
    return list.length ? [{ kind: scope, rows: list.slice(0, MAX_ROWS), total: list.length }] : [];
  }
  const out: Section<T>[] = [];
  let used = 0;
  for (const kind of SECTION_ORDER) {
    const list = rows[kind];
    if (!list.length) continue;
    const cap = kind === "commands" ? MAX_ROWS - used : CAPS[kind];
    const shown = list.slice(0, Math.max(0, Math.min(cap, MAX_ROWS - used)));
    if (!shown.length) continue;
    used += shown.length;
    out.push({ kind, rows: shown, total: list.length });
  }
  return out;
}

/** Where the selection goes when the rows change: the same row if it's still
 *  there, else the same position (clamped). */
export function keepSelection(prevKey: string | null, keys: string[], prevIndex: number): number {
  if (!keys.length) return 0;
  if (prevKey != null) {
    const at = keys.indexOf(prevKey);
    if (at >= 0) return at;
  }
  return Math.min(Math.max(prevIndex, 0), keys.length - 1);
}

const words = (q: string) => q.toLocaleLowerCase().split(/\s+/).filter(Boolean);

/** How well `fields` match every word of `q`: 0 for no match, higher for a
 *  match at the start of the first field, then at a word start. */
export function matchScore(q: string, ...fields: string[]): number {
  const ws = words(q);
  if (!ws.length) return 1;
  const hay = fields.join(" \u0000 ").toLocaleLowerCase();
  const first = (fields[0] ?? "").toLocaleLowerCase();
  let score = 0;
  for (const w of ws) {
    const at = hay.indexOf(w);
    if (at < 0) return 0;
    if (first.startsWith(w)) score += 4;
    else if (at === 0 || /[\s\W_]/.test(hay[at - 1]!)) score += 2;
    else score += 1;
  }
  return score;
}

/** `text` in runs, `hit` where it matches a word of `q`. */
export function highlight(text: string, q: string): { text: string; hit: boolean }[] {
  const ws = words(q).sort((a, b) => b.length - a.length);
  if (!ws.length || !text) return [{ text, hit: false }];
  const lower = text.toLocaleLowerCase();
  const mark = new Array<boolean>(text.length).fill(false);
  for (const w of ws) {
    for (let at = lower.indexOf(w); at >= 0; at = lower.indexOf(w, at + w.length)) {
      for (let i = at; i < at + w.length; i++) mark[i] = true;
    }
  }
  const runs: { text: string; hit: boolean }[] = [];
  for (let i = 0; i < text.length; i++) {
    const last = runs.at(-1);
    if (last && last.hit === mark[i]) last.text += text[i];
    else runs.push({ text: text[i]!, hit: mark[i]! });
  }
  return runs;
}

/** Whether `q` reads as an address rather than words to search for. */
export function looksLikeAddress(q: string): boolean {
  const t = q.trim();
  if (!t || /\s/.test(t)) return false;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(t) || /^(localhost|\d{1,3}(\.\d{1,3}){3})(:\d+)?(\/.*)?$/i.test(t))
    return true;
  return /^[\w-]+(\.[\w-]+)*\.[a-z]{2,}(:\d+)?([/?#].*)?$/i.test(t);
}

/** "3 d", "yesterday"… for a history row. */
export function ago(ms: number, now = Date.now()): string {
  const mins = Math.max(0, Math.floor((now - ms) / 60_000));
  if (mins < 60) return mins < 1 ? "just now" : `${mins} min`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} h`;
  const days = Math.round(hours / 24);
  if (days === 1) return "yesterday";
  if (days < 7) return `${days} d`;
  if (days < 14) return "last week";
  return days < 60 ? `${Math.round(days / 7)} wk` : `${Math.round(days / 30)} mo`;
}

// ─── The calculator ──────────────────────────────────────────────────────────

/** The answer to a sum typed into the launcher ("80 + 15%" → 92), or null
 *  when it isn't one. Needs an operator, so a bare number or year isn't a
 *  sum. `+`/`-` with a percent adds or takes that share of the left side;
 *  elsewhere a percent is a hundredth. */
export function calculate(input: string): number | null {
  const src = input
    .replace(/[×x]/g, "*")
    .replace(/÷/g, "/")
    .replace(/(\d),(?=\d{3}\b)/g, "$1")
    .trim();
  if (!/^[\d\s.+\-*/^%()]+$/.test(src) || !/\d/.test(src) || !/[+\-*/^%]/.test(src.replace(/^-/, ""))) {
    return null;
  }
  let i = 0;
  const peek = () => {
    while (src[i] === " ") i++;
    return src[i];
  };
  type Val = { v: number; pct: boolean };
  const primary = (): Val => {
    const c = peek();
    if (c === "(") {
      i++;
      const v = expr();
      if (peek() !== ")") throw new Error("unclosed");
      i++;
      return { v, pct: false };
    }
    const m = /^\d*\.?\d+(?:e[+-]?\d+)?/i.exec(src.slice(i));
    if (!m) throw new Error("number");
    i += m[0].length;
    return { v: Number(m[0]), pct: false };
  };
  const unary = (): Val => {
    if (peek() === "-") {
      i++;
      const r = unary();
      return { v: -r.v, pct: r.pct };
    }
    if (peek() === "+") {
      i++;
      return unary();
    }
    const p = primary();
    if (peek() === "%") {
      i++;
      return { v: p.v, pct: true };
    }
    return p;
  };
  const power = (): Val => {
    const base = unary();
    if (peek() === "^") {
      i++;
      const exp = power();
      return { v: Math.pow(num(base), num(exp)), pct: false };
    }
    return base;
  };
  const num = (x: Val) => (x.pct ? x.v / 100 : x.v);
  const term = (): Val => {
    let left = power();
    for (let c = peek(); c === "*" || c === "/"; c = peek()) {
      i++;
      const right = power();
      left = { v: c === "*" ? num(left) * num(right) : num(left) / num(right), pct: false };
    }
    return left;
  };
  const expr = (): number => {
    let left = num(term());
    for (let c = peek(); c === "+" || c === "-"; c = peek()) {
      i++;
      const right = term();
      const by = right.pct ? (left * right.v) / 100 : right.v;
      left = c === "+" ? left + by : left - by;
    }
    return left;
  };
  try {
    const v = expr();
    if (peek() !== undefined) return null;
    return Number.isFinite(v) ? v : null;
  } catch {
    return null;
  }
}

/** A calculator answer for display: grouped, at most ten decimals. */
export const formatNumber = (v: number): string =>
  new Intl.NumberFormat("en", { maximumFractionDigits: 10 }).format(v);
