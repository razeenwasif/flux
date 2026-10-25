/**
 * Just enough Markdown for the tabs pane's notes: headings, paragraphs, lists,
 * task lists, quotes, fenced code, rules, and inline bold, italic, code and
 * links. It parses to plain data the view renders as elements, so a note can
 * never inject markup; links are http(s) only.
 */

export type Inline =
  | { t: "text"; v: string }
  | { t: "b"; v: string }
  | { t: "i"; v: string }
  | { t: "code"; v: string }
  | { t: "link"; v: string; href: string };

export type Block =
  | { t: "h"; level: 1 | 2 | 3; inl: Inline[] }
  | { t: "p"; inl: Inline[] }
  | { t: "li"; inl: Inline[]; depth: number; marker: string }
  | { t: "task"; inl: Inline[]; depth: number; done: boolean; line: number }
  | { t: "quote"; inl: Inline[] }
  | { t: "code"; text: string }
  | { t: "hr" };

const INLINE =
  /(`[^`]+`)|(\*\*[^*]+\*\*|__[^_]+__)|(\*[^*\s][^*]*\*|_[^_\s][^_]*_)|(\[[^\]]+\]\(https?:\/\/[^)\s]+\))/g;

export function parseInline(src: string): Inline[] {
  const out: Inline[] = [];
  let last = 0;
  for (const m of src.matchAll(INLINE)) {
    const at = m.index ?? 0;
    if (at > last) out.push({ t: "text", v: src.slice(last, at) });
    const tok = m[0];
    if (m[1]) out.push({ t: "code", v: tok.slice(1, -1) });
    else if (m[2]) out.push({ t: "b", v: tok.slice(2, -2) });
    else if (m[3]) out.push({ t: "i", v: tok.slice(1, -1) });
    else {
      const close = tok.indexOf("](");
      out.push({ t: "link", v: tok.slice(1, close), href: tok.slice(close + 2, -1) });
    }
    last = at + tok.length;
  }
  if (last < src.length) out.push({ t: "text", v: src.slice(last) });
  return out;
}

const TASK = /^(\s*)[-*+]\s+\[([ xX])\]\s?(.*)$/;
const ITEM = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;

/** The note as blocks. A task keeps its source line, so ticking it in the view
 *  can flip exactly that line (`toggleTask`). */
export function parseBlocks(src: string): Block[] {
  const lines = src.replace(/\r\n?/g, "\n").split("\n");
  const out: Block[] = [];
  let i = 0;
  // YAML frontmatter is the file's, not the reader's.
  if (lines[0]?.trim() === "---") {
    const end = lines.findIndex((l, k) => k > 0 && l.trim() === "---");
    if (end > 0) i = end + 1;
  }
  let para: string[] = [];
  const flush = () => {
    if (para.length) out.push({ t: "p", inl: parseInline(para.join(" ")) });
    para = [];
  };
  for (; i < lines.length; i++) {
    const line = lines[i]!;
    const trimmed = line.trim();
    if (trimmed.startsWith("```")) {
      flush();
      const body: string[] = [];
      for (i++; i < lines.length && !lines[i]!.trim().startsWith("```"); i++) body.push(lines[i]!);
      out.push({ t: "code", text: body.join("\n") });
      continue;
    }
    if (!trimmed) {
      flush();
      continue;
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(trimmed);
    if (h) {
      flush();
      out.push({ t: "h", level: Math.min(3, h[1]!.length) as 1 | 2 | 3, inl: parseInline(h[2]!) });
      continue;
    }
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
      flush();
      out.push({ t: "hr" });
      continue;
    }
    const task = TASK.exec(line);
    if (task) {
      flush();
      out.push({
        t: "task",
        inl: parseInline(task[3]!),
        depth: Math.floor(task[1]!.replace(/\t/g, "  ").length / 2),
        done: task[2] !== " ",
        line: i,
      });
      continue;
    }
    const item = ITEM.exec(line);
    if (item) {
      flush();
      out.push({
        t: "li",
        inl: parseInline(item[3]!),
        depth: Math.floor(item[1]!.replace(/\t/g, "  ").length / 2),
        marker: /\d/.test(item[2]!) ? item[2]! : "•",
      });
      continue;
    }
    if (trimmed.startsWith(">")) {
      flush();
      out.push({ t: "quote", inl: parseInline(trimmed.replace(/^>\s?/, "")) });
      continue;
    }
    para.push(trimmed);
  }
  flush();
  return out;
}

/** Tick or untick the task on source line `line`. Anything else is left alone. */
export function toggleTask(src: string, line: number): string {
  const lines = src.split("\n");
  const l = lines[line];
  if (l == null || !TASK.test(l.replace(/\r$/, ""))) return src;
  lines[line] = l.replace(/\[([ xX])\]/, (_, c: string) => (c === " " ? "[x]" : "[ ]"));
  return lines.join("\n");
}
