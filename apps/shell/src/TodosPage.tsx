/**
 * flux://tasks — your to-dos (Flux Next "task capture"; the store is todos.rs).
 *
 * One line becomes a task: taskLine.ts reads `!1`–`!3`, `#list` and `~45m`
 * anywhere and a date only at the end, the field shows what it read, and Esc
 * keeps the words as typed. Tasks group by day (List) or by list (Board).
 * Completing one shows a five-second ⌘Z undo, said to screen readers too.
 * The process monitor that used to live here is flux://activity.
 */
import { For, Show, createMemo, createSignal, onCleanup, onMount, type Component } from "solid-js";

import { TASKS_URL, todoRemove, todoSetProfile, todosList, todoToggle, type Todo } from "./ipc";
import { visibleInterval } from "./poll";
import { titleInternalTab } from "./store";
import { addTaskLine } from "./taskAdd";
import { formatDue, formatMinutes, parseTaskLine, ymd, type TaskMark } from "./taskLine";
import "./TodosPage.css";

type View = "list" | "board";
const VIEW_KEY = "flux.tasks.view";
const readView = (): View => {
  try {
    return localStorage.getItem(VIEW_KEY) === "board" ? "board" : "list";
  } catch {
    return "list";
  }
};

const addDays = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
/** By day, then flagged first, then by time. */
const order = (a: Todo, b: Todo) =>
  (a.due || "9999").localeCompare(b.due || "9999") ||
  (a.priority || 9) - (b.priority || 9) ||
  (a.time || "99").localeCompare(b.time || "99");

const TodosPage: Component = () => {
  const [todos, setTodos] = createSignal<Todo[]>([]);
  const [line, setLine] = createSignal("");
  const [plain, setPlain] = createSignal(false);
  const [view, setView] = createSignal<View>(readView());
  const [showDone, setShowDone] = createSignal(false);
  const [now, setNow] = createSignal(new Date());
  // The last completion, for its undo.
  const [undo, setUndo] = createSignal<{ id: number; title: string } | null>(null);
  const [said, setSaid] = createSignal("");
  let undoTimer: number | undefined;
  let input!: HTMLInputElement;
  let mirror!: HTMLDivElement;

  const load = () =>
    void todosList()
      .then(setTodos)
      .catch(() => {});
  onMount(() => {
    titleInternalTab(TASKS_URL, "Tasks");
    load();
    input?.focus();
  });
  // Other surfaces add tasks too (Notes mode, the launcher, Make tasks).
  visibleInterval(() => {
    setNow(new Date());
    load();
  }, 10_000);

  const lists = createMemo(() => {
    const names = new Set<string>();
    for (const t of todos()) if (t.profile) names.add(t.profile);
    return [...names].sort();
  });
  const parsed = createMemo(() => (plain() ? null : parseTaskLine(line(), now(), lists())));
  const read = () => parsed()?.marks.length ?? 0;

  const add = async (e: Event) => {
    e.preventDefault();
    if (!line().trim()) return;
    await addTaskLine(line(), { plain: plain(), lists: lists() }).catch(() => null);
    setLine("");
    setPlain(false);
    load();
  };

  // The line, with what was read marked behind the field's own text.
  const marked = () => {
    const text = line();
    const out: (string | { t: string; kind: TaskMark["kind"] })[] = [];
    let at = 0;
    for (const m of parsed()?.marks ?? []) {
      out.push(text.slice(at, m.start), { t: text.slice(m.start, m.end), kind: m.kind });
      at = m.end;
    }
    out.push(text.slice(at));
    return out;
  };
  const syncScroll = () => {
    if (mirror) mirror.style.transform = `translateX(${-input.scrollLeft}px)`;
  };

  const today = () => ymd(now());
  const tomorrow = () => ymd(addDays(now(), 1));
  const open = () => todos().filter((t) => !t.done);
  const groups = createMemo(() => {
    const o = open();
    const t = today();
    const tm = tomorrow();
    return {
      overdue: o.filter((x) => x.due && x.due < t).sort(order),
      today: o.filter((x) => x.due === t).sort(order),
      tomorrow: o.filter((x) => x.due === tm).sort(order),
      upcoming: o.filter((x) => x.due && x.due > tm).sort(order),
      anytime: o.filter((x) => !x.due),
    };
  });
  const done = () =>
    todos()
      .filter((t) => t.done)
      .sort((a, b) => (b.updated_ms ?? 0) - (a.updated_ms ?? 0));

  const complete = async (t: Todo) => {
    await todoToggle(t.id).catch(() => {});
    load();
    if (t.done) return; // un-completing needs no undo
    clearTimeout(undoTimer);
    setUndo({ id: t.id, title: t.title });
    setSaid(`Completed ${t.title}. Press Command Z to undo.`);
    undoTimer = window.setTimeout(() => setUndo(null), 5000);
  };
  const undoIt = async () => {
    const u = undo();
    if (!u) return;
    clearTimeout(undoTimer);
    setUndo(null);
    await todoToggle(u.id).catch(() => {});
    setSaid(`${u.title} is back on your list.`);
    load();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key.toLowerCase() === "z" && (e.metaKey || e.ctrlKey) && !e.shiftKey && undo()) {
      // The field's own undo comes first while you're typing in it.
      if (document.activeElement === input && line()) return;
      e.preventDefault();
      void undoIt();
    }
  };
  window.addEventListener("keydown", onKey);
  onCleanup(() => {
    window.removeEventListener("keydown", onKey);
    clearTimeout(undoTimer);
  });

  const setViewKept = (v: View) => {
    setView(v);
    try {
      localStorage.setItem(VIEW_KEY, v);
    } catch {
      /* a convenience */
    }
  };

  /** How a task's day reads in its group: the time today and tomorrow, the day later on. */
  const when = (t: Todo) => {
    if (!t.due) return "";
    const time = t.time
      ? new Date(`${t.due}T${t.time}`).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })
      : "";
    if (t.due === today()) return time;
    const day = new Date(`${t.due}T00:00`).toLocaleDateString(undefined, {
      weekday: "short",
      ...(t.due === tomorrow() ? {} : { day: "numeric", month: "short" }),
    });
    return time ? `${day} ${time}` : day;
  };

  const [dragging, setDragging] = createSignal<number | null>(null);
  const Row: Component<{ t: Todo; drag?: boolean }> = (p) => (
    <li
      class="td-row"
      classList={{ done: p.t.done, late: !p.t.done && !!p.t.due && p.t.due < today() }}
      draggable={p.drag ? "true" : undefined}
      onDragStart={() => p.drag && setDragging(p.t.id)}
      onDragEnd={() => setDragging(null)}
    >
      <button
        class="td-check"
        role="checkbox"
        aria-checked={p.t.done}
        aria-label={`${p.t.done ? "Not done" : "Complete"}: ${p.t.title}`}
        onClick={() => void complete(p.t)}
      >
        <svg viewBox="0 0 16 16" aria-hidden="true">
          <path d="M4 8.5l2.5 2.5L12 5.5" />
        </svg>
      </button>
      <div class="td-main">
        <div class="td-title">
          <Show when={(p.t.priority ?? 0) > 0}>
            <span
              class={`td-flag p${p.t.priority}`}
              title={`Priority ${p.t.priority}`}
              aria-label={`Priority ${p.t.priority}`}
            >
              ⚑
            </span>
          </Show>
          {p.t.title}
        </div>
        <div class="td-meta">
          <Show when={p.t.profile}>
            <span class="td-list">{p.t.profile}</span>
          </Show>
          <Show when={p.t.minutes}>
            <span class="td-chip">{formatMinutes(p.t.minutes!)}</span>
          </Show>
          <Show when={p.t.source}>
            <span class="td-chip td-source">
              <span class="td-favicon">{p.t.source![0]!.toUpperCase()}</span>
              {p.t.source}
            </span>
          </Show>
          <Show when={p.t.by_agent}>
            <span class="td-chip td-agent">✦ Created by an agent</span>
          </Show>
        </div>
      </div>
      <Show when={!p.t.done && when(p.t)}>
        <span class="td-when">{when(p.t)}</span>
      </Show>
      <button
        class="td-x"
        aria-label={`Delete: ${p.t.title}`}
        title="Delete"
        onClick={() =>
          void todoRemove(p.t.id)
            .then(load)
            .catch(() => {})
        }
      >
        ✕
      </button>
    </li>
  );

  const Group: Component<{ name: string; items: Todo[]; tone?: string }> = (p) => (
    <Show when={p.items.length}>
      <section class="td-group" aria-label={`${p.name}, ${p.items.length}`}>
        <h2 classList={{ [p.tone ?? ""]: !!p.tone }}>
          {p.name} <span class="td-count">{p.items.length}</span>
        </h2>
        <ul>
          <For each={p.items}>{(t) => <Row t={t} />}</For>
        </ul>
      </section>
    </Show>
  );

  // Board: a column per list; a card dropped on another column moves to that list.
  const columns = createMemo(() => {
    const names = [...lists(), ""];
    return names
      .map((name) => ({
        name,
        items: open()
          .filter((t) => (t.profile ?? "") === name)
          .sort(order),
      }))
      .filter((c) => c.name || c.items.length);
  });
  const drop = async (name: string) => {
    const id = dragging();
    setDragging(null);
    if (id == null) return;
    await todoSetProfile(id, name).catch(() => {});
    load();
  };

  const headline = () => {
    const g = groups();
    const d = now().toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" });
    return [
      d,
      g.today.length ? `${g.today.length} due today` : "",
      g.overdue.length ? `${g.overdue.length} overdue` : "",
    ]
      .filter(Boolean)
      .join(" · ");
  };

  return (
    <div class="td-page">
      <header class="td-head">
        <div>
          <h1>Tasks</h1>
          <p class="td-sub">{headline()}</p>
        </div>
        <div class="td-views" role="radiogroup" aria-label="View">
          <button
            role="radio"
            aria-checked={view() === "list"}
            classList={{ on: view() === "list" }}
            onClick={() => setViewKept("list")}
          >
            List
          </button>
          <button
            role="radio"
            aria-checked={view() === "board"}
            classList={{ on: view() === "board" }}
            onClick={() => setViewKept("board")}
          >
            Board
          </button>
        </div>
      </header>

      <form class="td-capture" onSubmit={(e) => void add(e)}>
        <span class="td-plus" aria-hidden="true">
          +
        </span>
        <div class="td-field">
          <div class="td-mirror" ref={mirror} aria-hidden="true">
            <For each={marked()}>
              {(part) =>
                typeof part === "string" ? part : <mark class={`td-mark ${part.kind}`}>{part.t}</mark>
              }
            </For>
          </div>
          <input
            ref={input}
            aria-label="New task"
            placeholder="New task… “Submit the lab report friday 5pm !1 #uni ~45m”"
            value={line()}
            onInput={(e) => {
              setLine(e.currentTarget.value);
              if (!e.currentTarget.value) setPlain(false);
              syncScroll();
            }}
            onScroll={syncScroll}
            onKeyDown={(e) => {
              if (e.key === "Escape" && read()) {
                e.preventDefault();
                setPlain(true);
              }
            }}
          />
        </div>
        <span class="td-hint">
          <kbd>Return</kbd> to add
        </span>
      </form>
      <div class="td-read" aria-live="polite">
        <Show
          when={parsed() && read()}
          fallback={
            <Show when={plain() && line()}>
              <span class="td-read-label">Kept as you typed it</span>
            </Show>
          }
        >
          <span class="td-read-label">Read as</span>
          <Show when={parsed()!.due}>
            <span class="td-chip date">{formatDue(parsed()!.due, parsed()!.time, now())}</span>
          </Show>
          <Show when={parsed()!.priority}>
            <span class="td-chip priority">Priority {parsed()!.priority}</span>
          </Show>
          <Show when={parsed()!.list}>
            <span class="td-chip list">{parsed()!.list}</span>
          </Show>
          <Show when={parsed()!.minutes}>
            <span class="td-chip duration">{formatMinutes(parsed()!.minutes)}</span>
          </Show>
          <span class="td-esc">
            <kbd>Esc</kbd> keeps your words
          </span>
        </Show>
      </div>

      <Show
        when={view() === "list"}
        fallback={
          <div class="td-board">
            <For each={columns()}>
              {(c) => (
                <section
                  class="td-col"
                  classList={{ over: dragging() != null }}
                  aria-label={c.name || "No list"}
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={() => void drop(c.name)}
                >
                  <h2>
                    {c.name || "No list"} <span class="td-count">{c.items.length}</span>
                  </h2>
                  <ul>
                    <For each={c.items}>{(t) => <Row t={t} drag />}</For>
                  </ul>
                </section>
              )}
            </For>
          </div>
        }
      >
        <div class="td-cols">
          <div>
            <Group name="Overdue" items={groups().overdue} tone="late" />
            <Group name="Today" items={groups().today} />
            <Group name="Tomorrow" items={groups().tomorrow} />
          </div>
          <div>
            <Group name="Upcoming" items={groups().upcoming} />
            <Group name="Anytime" items={groups().anytime} />
            <Show when={done().length}>
              <section class="td-group td-done">
                <button
                  class="td-done-head"
                  aria-expanded={showDone()}
                  onClick={() => setShowDone(!showDone())}
                >
                  <span aria-hidden="true">{showDone() ? "▾" : "▸"}</span> Completed{" "}
                  <span class="td-count">{done().length}</span>
                  <span class="td-last">{done()[0]?.title}</span>
                </button>
                <Show when={showDone()}>
                  <ul>
                    <For each={done()}>{(t) => <Row t={t} />}</For>
                  </ul>
                </Show>
              </section>
            </Show>
          </div>
        </div>
        <Show when={!open().length && !done().length}>
          <p class="td-empty">
            Nothing yet. Type a task above: a date at the end, !1–!3, #list and ~45m anywhere.
          </p>
        </Show>
      </Show>

      <Show when={undo()}>
        {(u) => (
          <div class="td-toast" role="status">
            <span aria-hidden="true">✓</span> Completed ‘{u().title}’
            <button onClick={() => void undoIt()}>
              Undo <kbd>⌘Z</kbd>
            </button>
          </div>
        )}
      </Show>
      <div class="td-sr" aria-live="assertive">
        {said()}
      </div>
    </div>
  );
};

export default TodosPage;
