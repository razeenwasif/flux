/**
 * Notes & to-do — the tabs pane's Notes mode (Velvet Paper; see tabMode.ts).
 *
 * Notes are Markdown files, one per note, in the vault's "Flux Notes" folder
 * (mdnotes.rs), so the Indexer and any Markdown editor see them. A note opens
 * read, with its tasks tickable; Edit gives the plain Markdown, saved as you
 * type. The to-do list is Flux's own task list, the one the calendar pane and
 * the new tab's Tasks card show.
 */
import { For, Show, createSignal, onCleanup, onMount, type Component, type JSX } from "solid-js";

import { askConfirm } from "./ask";
import Icon from "./Icon";
import {
  mdNoteCreate,
  mdNoteDelete,
  mdNoteRead,
  mdNoteRename,
  mdNotesHome,
  mdNotesList,
  mdNoteWrite,
  todoAdd,
  todoRemove,
  todosList,
  todoToggle,
  type MdNote,
  type MdNotesHome,
  type Todo,
} from "./ipc";
import { parseBlocks, toggleTask, type Inline } from "./mdlite";
import { parseQuickEvent } from "./quickEvent";
import { openTab } from "./store";

const ago = (ms: number): string => {
  if (!ms) return "";
  const mins = Math.round((Date.now() - ms) / 60_000);
  if (mins < 1) return "now";
  if (mins < 60) return `${mins}m`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h`;
  const days = Math.round(hrs / 24);
  return days < 7
    ? `${days}d`
    : new Date(ms).toLocaleDateString(undefined, { day: "numeric", month: "short" });
};
const errText = (e: unknown) => String(e).replace(/^Error:\s*/, "");

const InlineView: Component<{ inl: Inline[] }> = (p) => (
  <For each={p.inl}>
    {(x): JSX.Element => {
      switch (x.t) {
        case "b":
          return <strong>{x.v}</strong>;
        case "i":
          return <em>{x.v}</em>;
        case "code":
          return <code>{x.v}</code>;
        case "link":
          return (
            <a
              href={x.href}
              onClick={(e) => {
                e.preventDefault();
                void openTab("browser", x.href);
              }}
            >
              {x.v}
            </a>
          );
        default:
          return <>{x.v}</>;
      }
    }}
  </For>
);

/** A note, read: Markdown as type, with its tasks tickable. */
const MdView: Component<{ src: string; onToggle: (line: number) => void }> = (p) => (
  <div class="md">
    <For each={parseBlocks(p.src)} fallback={<p class="md-empty">Empty. Edit to write.</p>}>
      {(b): JSX.Element => {
        switch (b.t) {
          case "h":
            return (
              <div class={`md-h md-h${b.level}`}>
                <InlineView inl={b.inl} />
              </div>
            );
          case "p":
            return (
              <p>
                <InlineView inl={b.inl} />
              </p>
            );
          case "li":
            return (
              <div class="md-li" style={{ "--d": String(b.depth) }}>
                <span class="md-mark">{b.marker}</span>
                <span>
                  <InlineView inl={b.inl} />
                </span>
              </div>
            );
          case "task":
            return (
              <label class="md-task" classList={{ done: b.done }} style={{ "--d": String(b.depth) }}>
                <input type="checkbox" checked={b.done} onChange={() => p.onToggle(b.line)} />
                <span>
                  <InlineView inl={b.inl} />
                </span>
              </label>
            );
          case "quote":
            return (
              <blockquote>
                <InlineView inl={b.inl} />
              </blockquote>
            );
          case "code":
            return <pre>{b.text}</pre>;
          default:
            return <hr />;
        }
      }}
    </For>
  </div>
);

const NotesList: Component = () => {
  const [notes, setNotes] = createSignal<MdNote[]>([]);
  const [home, setHome] = createSignal<MdNotesHome | null>(null);
  const [open, setOpen] = createSignal<string | null>(null);
  const [text, setText] = createSignal("");
  const [editing, setEditing] = createSignal(false);
  const [err, setErr] = createSignal("");

  const refresh = () =>
    void mdNotesList()
      .then(setNotes)
      .catch((e) => setErr(errText(e)));
  onMount(() => {
    refresh();
    void mdNotesHome()
      .then(setHome)
      .catch(() => {});
  });

  // Saved as you type, a moment after you stop; and on the way out.
  let timer: number | undefined;
  let pending: { name: string; text: string } | null = null;
  const flush = () => {
    clearTimeout(timer);
    const p = pending;
    pending = null;
    if (!p) return;
    void mdNoteWrite(p.name, p.text)
      .then((meta) => setNotes((ns) => [meta, ...ns.filter((n) => n.name !== meta.name)]))
      .catch((e) => setErr(errText(e)));
  };
  const change = (v: string) => {
    const name = open();
    if (!name) return;
    setText(v);
    pending = { name, text: v };
    clearTimeout(timer);
    timer = window.setTimeout(flush, 600);
  };
  onCleanup(flush);

  const openNote = (name: string) => {
    flush();
    setErr("");
    void mdNoteRead(name)
      .then((t) => {
        setText(t);
        setOpen(name);
        // A note with nothing past its heading opens ready to write.
        setEditing(!t.replace(/^#.*$/m, "").trim());
      })
      .catch((e) => setErr(errText(e)));
  };
  const close = () => {
    flush();
    setOpen(null);
    refresh();
  };
  const create = () => {
    const stamp = new Date().toLocaleDateString(undefined, { day: "numeric", month: "short" });
    void mdNoteCreate(`Note ${stamp}`)
      .then((n) => {
        setNotes((ns) => [n, ...ns]);
        openNote(n.name);
      })
      .catch((e) => setErr(errText(e)));
  };
  const rename = (to: string) => {
    const from = open();
    if (!from || !to.trim() || to.trim() === from) return;
    flush();
    void mdNoteRename(from, to)
      .then((n) => {
        setOpen(n.name);
        setNotes((ns) => [n, ...ns.filter((x) => x.name !== from)]);
      })
      .catch((e) => setErr(errText(e)));
  };
  const remove = async () => {
    const name = open();
    if (!name) return;
    const ok = await askConfirm({
      title: `Move “${name}” to the Trash?`,
      hint: "It's a Markdown file, so you can take it back out of the Trash.",
      confirm: "Move to Trash",
    });
    if (!ok) return;
    pending = null;
    void mdNoteDelete(name)
      .then(() => {
        setOpen(null);
        refresh();
      })
      .catch((e) => setErr(errText(e)));
  };

  return (
    <div class="notes">
      <Show
        when={open()}
        fallback={
          <>
            <button class="notes-new" onClick={create}>
              ＋ New note
            </button>
            <div class="notes-list">
              <For each={notes()} fallback={<p class="mode-empty">No notes yet.</p>}>
                {(n) => (
                  <button class="notes-row" onClick={() => openNote(n.name)}>
                    <span class="notes-row-top">
                      <span class="notes-row-name">{n.name}</span>
                      <span class="notes-row-when">{ago(n.modified_ms)}</span>
                    </span>
                    <Show when={n.preview}>
                      <span class="notes-row-snip">{n.preview}</span>
                    </Show>
                  </button>
                )}
              </For>
            </div>
          </>
        }
      >
        {(name) => (
          <>
            <div class="notes-head">
              <button class="mode-btn" title="All notes" onClick={close}>
                ‹
              </button>
              <input
                class="notes-title"
                aria-label="Note name"
                value={name()}
                spellcheck={false}
                onKeyDown={(e) => {
                  if (e.key === "Enter") e.currentTarget.blur();
                  if (e.key === "Escape") {
                    e.currentTarget.value = name();
                    e.currentTarget.blur();
                  }
                }}
                onBlur={(e) => rename(e.currentTarget.value)}
              />
              <button
                classList={{ "mode-btn": true, on: editing() }}
                title={editing() ? "Read" : "Edit the Markdown"}
                aria-pressed={editing()}
                onClick={() => {
                  if (editing()) flush();
                  setEditing(!editing());
                }}
              >
                {editing() ? "✓" : "✎"}
              </button>
              <button class="mode-btn" title="Move to the Trash" onClick={() => void remove()}>
                <Icon name="trash" />
              </button>
            </div>
            <Show
              when={editing()}
              fallback={<MdView src={text()} onToggle={(line) => change(toggleTask(text(), line))} />}
            >
              <textarea
                class="notes-edit"
                aria-label={`${name()} (Markdown)`}
                value={text()}
                placeholder={"# Heading\n\nWrite in Markdown.\n- [ ] a task"}
                spellcheck={true}
                ref={(el) => queueMicrotask(() => el.focus())}
                onInput={(e) => change(e.currentTarget.value)}
              />
            </Show>
          </>
        )}
      </Show>
      <Show when={err()}>
        <p class="mode-note" role="alert">
          {err()}
        </p>
      </Show>
      <Show when={home()}>
        {(h) => (
          <p class="notes-where" title={h().path}>
            {h().in_vault ? "Markdown in your vault · Flux Notes" : "Markdown files in Flux's data folder"}
          </p>
        )}
      </Show>
    </div>
  );
};

const TodoList: Component = () => {
  const [todos, setTodos] = createSignal<Todo[]>([]);
  const [draft, setDraft] = createSignal("");
  const [showDone, setShowDone] = createSignal(false);
  const load = () =>
    void todosList()
      .then(setTodos)
      .catch(() => {});
  onMount(load);
  const open = () => todos().filter((t) => !t.done);
  const done = () => todos().filter((t) => t.done);
  const add = (e: Event) => {
    e.preventDefault();
    const raw = draft().trim();
    if (!raw) return;
    // "submit the lab report friday": a day in the text becomes the due date.
    const p = parseQuickEvent(raw, "");
    void todoAdd(p?.title ?? raw, p?.date || undefined)
      .then(() => {
        setDraft("");
        load();
      })
      .catch(() => {});
  };
  const today = new Date().toLocaleDateString("sv-SE");
  const Row: Component<{ t: Todo }> = (p) => (
    <div class="md-task todo-row" classList={{ done: p.t.done }}>
      <input
        type="checkbox"
        checked={p.t.done}
        aria-label={p.t.title}
        onChange={() =>
          void todoToggle(p.t.id)
            .then(load)
            .catch(() => {})
        }
      />
      <span class="todo-title">{p.t.title}</span>
      <Show when={p.t.due && !p.t.done}>
        <span classList={{ "todo-due": true, late: p.t.due! < today }}>
          {p.t.due === today
            ? "today"
            : new Date(`${p.t.due}T00:00`).toLocaleDateString(undefined, {
                weekday: "short",
                day: "numeric",
              })}
        </span>
      </Show>
      <button
        class="todo-x"
        title="Remove"
        onClick={() =>
          void todoRemove(p.t.id)
            .then(load)
            .catch(() => {})
        }
      >
        ✕
      </button>
    </div>
  );
  return (
    <div class="todos">
      <form class="mode-add" onSubmit={add}>
        <span aria-hidden="true">＋</span>
        <input
          aria-label="Add a to-do"
          placeholder={'To-do… "lab report fri"'}
          value={draft()}
          onInput={(e) => setDraft(e.currentTarget.value)}
        />
      </form>
      <div class="todos-list">
        <For each={open()} fallback={<p class="mode-empty">Nothing to do.</p>}>
          {(t) => <Row t={t} />}
        </For>
      </div>
      <Show when={done().length > 0}>
        <button class="todos-done" aria-expanded={showDone()} onClick={() => setShowDone(!showDone())}>
          {showDone() ? "▾" : "▸"} Done {done().length}
        </button>
        <Show when={showDone()}>
          <For each={done()}>{(t) => <Row t={t} />}</For>
        </Show>
      </Show>
    </div>
  );
};

const TabNotes: Component = () => {
  const [tab, setTab] = createSignal<"notes" | "todo">("notes");
  return (
    <div class="mode-notes">
      <div class="mail-filter" role="tablist" aria-label="Notes or to-do">
        <button
          role="tab"
          aria-selected={tab() === "notes"}
          classList={{ on: tab() === "notes" }}
          onClick={() => setTab("notes")}
        >
          Notes
        </button>
        <button
          role="tab"
          aria-selected={tab() === "todo"}
          classList={{ on: tab() === "todo" }}
          onClick={() => setTab("todo")}
        >
          To-do
        </button>
      </div>
      <Show when={tab() === "notes"} fallback={<TodoList />}>
        <NotesList />
      </Show>
    </div>
  );
};

export default TabNotes;
