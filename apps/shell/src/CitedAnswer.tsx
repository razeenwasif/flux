/**
 * An answer about the page, with its citations (cite.rs, flux-agent cited.rs).
 * Marks the model wrote as [P12] show as numbered chips (1, 2, 3 in order of
 * first citation) that scroll the page to the passage and highlight it. A
 * table comes with each claim's label, checked in Rust (they only go down), a
 * sort and Copy CSV. Under it: Make tasks and Save as note.
 * Its own chunk, loaded with the first cited answer.
 */
import { For, Show, createMemo, createSignal, type Component, type JSX } from "solid-js";
import "./CitedAnswer.css";
import {
  agentCiteShow,
  agentTasksFrom,
  onyxNewNote,
  todoAdd,
  type CitedAnswer as Answer,
  type Claim,
} from "./ipc";
import { activeId, focusTab } from "./store";

export interface Cited {
  answer: Answer;
  tab: number;
  url: string;
  title: string;
  question: string;
}

const MARK = /\[(P\d+(?:\s*,\s*P\d+)*)\]/gi;
const ids = (inner: string) => inner.split(",").map((s) => Number(s.trim().slice(1)));
const CLAIM: Record<Claim, string> = {
  supported: "Supported",
  inferred: "Inferred",
  unverified: "Unverified",
  contradicted: "Contradicted",
};

/** Text with its [P12] marks taken out, for notes, tasks and speech. */
export const unmarked = (text: string) => text.replace(MARK, "").replace(/ +([.,;:])/g, "$1");

const CitedAnswer: Component<{ text: string; cited?: Cited }> = (props) => {
  // Passage → its number: order of first citation, as Rust lists them once done.
  const numbers = createMemo(() => {
    const m = new Map<number, number>();
    const c = props.cited;
    if (c) c.answer.cites.forEach((p, i) => m.set(p.p, i + 1));
    else
      for (const x of props.text.matchAll(MARK))
        for (const p of ids(x[1]!)) if (!m.has(p)) m.set(p, m.size + 1);
    return m;
  });
  const passage = (p: number) => props.cited?.answer.cites.find((x) => x.p === p);
  const [note, setNote] = createSignal("");

  const show = async (p: number) => {
    const c = props.cited;
    const found = passage(p);
    const n = numbers().get(p);
    if (!c || !found || !n) return;
    try {
      if (activeId() !== c.tab) await focusTab(c.tab);
      const r = await agentCiteShow(c.tab, c.url, found.text, n);
      setNote(
        r === "shown"
          ? ""
          : r === "moved"
            ? "That tab has moved on from the page this answer is about."
            : r === "not_found"
              ? "That passage isn't on the page any more."
              : `${n}: “${found.text}”`,
      );
    } catch (e) {
      setNote(String(e));
    }
  };

  const chip = (p: number): JSX.Element => {
    const n = numbers().get(p);
    // Once done, a mark for a passage that doesn't exist is no citation.
    if (!n || (props.cited && !passage(p))) return null;
    return (
      <button
        class="ca-chip"
        disabled={!props.cited}
        title={passage(p) ? `${n}: ${passage(p)!.text.slice(0, 240)}` : undefined}
        onClick={() => void show(p)}
      >
        {n}
      </button>
    );
  };

  /** The prose, its marks as chips. */
  const prose = (text: string): JSX.Element[] => {
    const out: JSX.Element[] = [];
    let at = 0;
    for (const x of text.matchAll(MARK)) {
      out.push(text.slice(at, x.index));
      for (const p of ids(x[1]!)) out.push(chip(p));
      at = x.index! + x[0].length;
    }
    out.push(text.slice(at));
    return out;
  };

  // The table, sortable by any column.
  const [sortBy, setSortBy] = createSignal<{ col: number; dir: 1 | -1 } | null>(null);
  const rows = createMemo(() => {
    const t = props.cited?.answer.table;
    if (!t) return [];
    const s = sortBy();
    const rs = [...t.rows];
    if (s)
      rs.sort(
        (a, b) =>
          s.dir * (a.cells[s.col] ?? "").localeCompare(b.cells[s.col] ?? "", undefined, { numeric: true }),
      );
    return rs;
  });
  const sortOn = (col: number) =>
    setSortBy((s) => (s?.col === col ? { col, dir: s.dir === 1 ? -1 : 1 } : { col, dir: 1 }));
  const source = (cites: number[], claim: Claim) =>
    [
      ...cites
        .map((p) => numbers().get(p))
        .filter(Boolean)
        .map((n) => `[${n}]`),
      CLAIM[claim],
    ].join(" ");

  const csv = () => {
    const t = props.cited!.answer.table!;
    const q = (s: string) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
    return [[...t.head, "Source"], ...rows().map((r) => [...r.cells, source(r.cites, r.claim)])]
      .map((r) => r.map(q).join(","))
      .join("\n");
  };
  const [copied, setCopied] = createSignal(false);
  const copyCsv = async () => {
    await navigator.clipboard.writeText(csv());
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  /** The answer as Markdown, with its sources: for a note. */
  const markdown = () => {
    const c = props.cited!;
    const n = numbers();
    const text = c.answer.prose.replace(MARK, (_, inner: string) =>
      ids(inner)
        .map((p) => (n.get(p) ? `[${n.get(p)}]` : ""))
        .join(""),
    );
    const parts = [`# ${c.question.trim()}`, text];
    const t = c.answer.table;
    if (t) {
      const line = (cells: string[]) => `| ${cells.map((s) => s.replace(/\|/g, "\\|")).join(" | ")} |`;
      parts.push(
        [
          line([...t.head, "Source"]),
          line([...t.head, "Source"].map(() => "---")),
          ...rows().map((r) => line([...r.cells, source(r.cites, r.claim)])),
        ].join("\n"),
      );
    }
    if (c.answer.cites.length) {
      parts.push(
        `## Sources\n\nFrom [${c.title || c.url}](${c.url})\n\n` +
          c.answer.cites.map((p, i) => `${i + 1}. “${p.text.replace(/\s+/g, " ")}”`).join("\n"),
      );
    }
    return parts.join("\n\n") + "\n";
  };
  const saveNote = async () => {
    const c = props.cited!;
    try {
      const path = await onyxNewNote(c.question.trim().slice(0, 80) || "Answer", markdown(), "Flux Notes");
      setNote(path ? `Saved to your notes: ${path.split("/").pop()}` : "Saved to your notes.");
    } catch (e) {
      setNote(`Couldn't save the note: ${String(e)}`);
    }
  };

  // Make tasks: the model proposes, you pick, then they're added.
  const [tasks, setTasks] = createSignal<{ text: string; on: boolean }[] | null>(null);
  const [working, setWorking] = createSignal(false);
  const makeTasks = async () => {
    const c = props.cited!;
    setWorking(true);
    try {
      const t = c.answer.table;
      const table = t ? "\n" + t.rows.map((r) => r.cells.join(" — ")).join("\n") : "";
      const list = await agentTasksFrom(`${c.question}\n\n${unmarked(c.answer.prose)}${table}`);
      if (list.length) setTasks(list.map((text) => ({ text, on: true })));
      else setNote("Nothing in this answer to make a task of.");
    } catch (e) {
      setNote(String(e));
    } finally {
      setWorking(false);
    }
  };
  const addTasks = async () => {
    const pick = (tasks() ?? []).filter((t) => t.on);
    let added = 0;
    for (const t of pick) if (await todoAdd(t.text).catch(() => null)) added++;
    setTasks(null);
    setNote(`Added ${added} task${added === 1 ? "" : "s"} to your list.`);
  };

  return (
    <div class="ca">
      <div class="ca-prose">{prose(props.cited ? props.cited.answer.prose : props.text)}</div>
      <Show when={props.cited?.answer.table}>
        {(t) => (
          <div class="ca-card">
            <span class="ca-legend">Compared</span>
            <div class="ca-table-head">
              <span>
                {t().rows.length} row{t().rows.length === 1 ? "" : "s"}
                {sortBy() ? ` · sorted by ${t().head[sortBy()!.col]}` : ""}
              </span>
              <button class="ca-btn" onClick={() => void copyCsv()}>
                {copied() ? "Copied" : "Copy CSV"}
              </button>
            </div>
            <div class="ca-table-wrap">
              <table class="ca-table">
                <thead>
                  <tr>
                    <For each={t().head}>
                      {(h, i) => (
                        <th>
                          <button onClick={() => sortOn(i())}>
                            {h}
                            {sortBy()?.col === i() ? (sortBy()!.dir === 1 ? " ↑" : " ↓") : ""}
                          </button>
                        </th>
                      )}
                    </For>
                    <th>Source</th>
                  </tr>
                </thead>
                <tbody>
                  <For each={rows()}>
                    {(r) => (
                      <tr>
                        <For each={r.cells}>{(c) => <td>{c}</td>}</For>
                        <td class="ca-source">
                          <For each={r.cites}>{(p) => chip(p)}</For>
                          <Show when={!r.cites.length}>
                            <span class="ca-none">–</span>
                          </Show>
                          <span class={`ca-claim ${r.claim}`}>{CLAIM[r.claim]}</span>
                        </td>
                      </tr>
                    )}
                  </For>
                </tbody>
              </table>
            </div>
            <div class="ca-key">
              <span>Claims:</span>
              <span class="ca-claim supported">Supported</span>
              <span class="ca-claim inferred">Inferred</span>
              <span class="ca-claim unverified">Unverified</span>
              <span class="ca-key-what">on the page · follows from it · not on it</span>
            </div>
          </div>
        )}
      </Show>
      <Show when={props.cited}>
        {(c) => (
          <div class="ca-actions">
            <button class="ca-btn" disabled={working() || !!tasks()} onClick={() => void makeTasks()}>
              {working() ? "Making tasks…" : "Make tasks"}
            </button>
            <button class="ca-btn" onClick={() => void saveNote()}>
              Save as note
            </button>
            <span class="ca-count">
              {c().answer.cites.length
                ? `${c().answer.cites.length} source${c().answer.cites.length === 1 ? "" : "s"} on this page`
                : "Nothing cited from the page"}
            </span>
          </div>
        )}
      </Show>
      <Show when={tasks()}>
        {(list) => (
          <div class="ca-tasks">
            <For each={list()}>
              {(t, i) => (
                <label>
                  <input
                    type="checkbox"
                    checked={t.on}
                    onChange={(e) =>
                      setTasks((l) =>
                        l!.map((x, j) => (j === i() ? { ...x, on: e.currentTarget.checked } : x)),
                      )
                    }
                  />
                  {t.text}
                </label>
              )}
            </For>
            <div class="ca-actions">
              <button
                class="agent-approve-yes"
                disabled={!list().some((t) => t.on)}
                onClick={() => void addTasks()}
              >
                Add {list().filter((t) => t.on).length} to my tasks
              </button>
              <button class="agent-approve-no" onClick={() => setTasks(null)}>
                Cancel
              </button>
            </div>
          </div>
        )}
      </Show>
      <Show when={note()}>
        <div class="ca-note">{note()}</div>
      </Show>
    </div>
  );
};

export default CitedAnswer;
