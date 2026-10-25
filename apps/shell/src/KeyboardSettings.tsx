/**
 * Settings → Keyboard (Flux Next "keys"): every command in keys.rs with its
 * keys, and a recorder to change them. Click a shortcut, press the new one:
 * a chord another command has asks first ("Use here"); the system's and the
 * fixed ones can't be taken. The menu bar and every page follow at once.
 */
import { For, Show, createMemo, createSignal, onCleanup, onMount, type Component } from "solid-js";

import { askConfirm } from "./ask";
import type { KeyCommand } from "./bindings.gen";
import { keyLabel, keyParts, keysReset, keysSet } from "./keyLabel";
import { applyKeys, chordOf, keysInfo, setKeyRecording } from "./keys";
import "./KeyboardSettings.css";

/** Groups shown closed until you open them or search. */
const FOLDED = new Set(["Go to a tab", "Flux pages"]);

const same = (a: string[], b: string[]) => a.length === b.length && a.every((k, i) => k === b[i]);

/** What a chord needs to be a shortcut (keys.rs canonical()). */
const usable = (chord: string) => {
  const parts = chord.split("+");
  const key = parts.at(-1)!;
  const fkey = /^F([1-9]|1[0-2])$/.test(key);
  return key !== "Escape" && (fkey || parts.some((m) => m === "Ctrl" || m === "Alt" || m === "Cmd"));
};

type Clash = { chord: string; owner: string; free: boolean };

const Caps: Component<{ chord: string; hot?: boolean }> = (props) => (
  <span class="kb-chord">
    <For each={keyParts(props.chord)}>{(k) => <kbd classList={{ hot: props.hot }}>{k}</kbd>}</For>
  </span>
);

const KeyboardSettings: Component = () => {
  let search!: HTMLInputElement;
  const [query, setQuery] = createSignal("");
  const [recording, setRecording] = createSignal<string | null>(null);
  const [pressed, setPressed] = createSignal<string | null>(null);
  const [clash, setClash] = createSignal<Clash | null>(null);
  const [note, setNote] = createSignal("");

  const commands = () => keysInfo()?.commands ?? [];
  /** Group → the ids that match the search, in the registry's order. Strings,
   *  so a rebind updates rows in place: focus and open groups stay put. */
  const groups = createMemo(() => {
    const terms = query().toLocaleLowerCase().split(/\s+/).filter(Boolean);
    const out = new Map<string, string[]>();
    for (const c of commands()) {
      const text = `${c.group} ${c.title} ${c.detail} ${c.keys.map(keyLabel).join(" ")}`.toLocaleLowerCase();
      if (!terms.every((t) => text.includes(t))) continue;
      out.set(c.group, [...(out.get(c.group) ?? []), c.id]);
    }
    return out;
  });
  const names = createMemo(() => [...groups().keys()]);
  const byId = (id: string) => commands().find((c) => c.id === id);
  const changed = (c: KeyCommand) => !c.fixed && !same(c.keys, c.defaults);
  const anyChanged = () => commands().some(changed);

  const stop = () => {
    window.removeEventListener("keydown", onKey, true);
    setRecording(null);
    setPressed(null);
    setClash(null);
    setKeyRecording(false);
  };
  const save = (id: string, chord: string | null) => {
    const title = commands().find((c) => c.id === id)?.title ?? id;
    stop();
    keysSet(id, chord)
      .then((k) => {
        applyKeys(k);
        setNote(chord ? `${title} is ${keyLabel(chord)} now.` : `${title} has no shortcut now.`);
      })
      .catch((e) => setNote(String(e).replace(/^Error:\s*/, "")));
  };
  const onKey = (e: KeyboardEvent) => {
    const id = recording();
    if (!id) return;
    e.preventDefault();
    e.stopPropagation();
    const bare = !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey;
    if (e.key === "Escape" && bare) return stop();
    if ((e.key === "Backspace" || e.key === "Delete") && bare) return save(id, null);
    const chord = chordOf(e);
    if (!chord) return; // a modifier alone: wait for the key
    setPressed(chord);
    setClash(null);
    if (!usable(chord)) return setNote("Hold ⌘, ⌃ or ⌥ with the key, or use an F-key.");
    setNote("");
    const reserved = keysInfo()?.reserved.find((r) => r.chord === chord);
    if (reserved) return setClash({ chord, owner: reserved.owner, free: false });
    const other = commands().find((c) => c.id !== id && c.keys.includes(chord));
    if (other) return setClash({ chord, owner: other.title, free: !other.fixed });
    save(id, chord);
  };
  const record = (id: string) => {
    stop();
    setNote("");
    setRecording(id);
    setKeyRecording(true);
    window.addEventListener("keydown", onKey, true);
  };
  const reset = (c: KeyCommand) =>
    void keysReset(c.id)
      .then((k) => {
        applyKeys(k);
        setNote(`${c.title} is back to ${c.defaults.length ? keyLabel(c.defaults[0]!) : "no shortcut"}.`);
      })
      .catch(() => {});
  const resetAll = async () => {
    const ok = await askConfirm({
      title: "Put every shortcut back?",
      hint: "Every command gets the keys Flux came with.",
      confirm: "Reset",
    });
    if (!ok) return;
    stop();
    void keysReset(null)
      .then((k) => {
        applyKeys(k);
        setNote("Every shortcut is back to the default.");
      })
      .catch(() => {});
  };

  // "/" finds a command, as the field says, unless you're typing somewhere.
  const onSlash = (e: KeyboardEvent) => {
    const t = e.target as HTMLElement | null;
    if (e.key !== "/" || recording() || t?.closest("input, textarea, select, [contenteditable]")) return;
    e.preventDefault();
    search.focus();
  };
  onMount(() => window.addEventListener("keydown", onSlash));
  onCleanup(() => {
    window.removeEventListener("keydown", onSlash);
    stop();
  });

  const Item: Component<{ c: KeyCommand }> = (p) => {
    const on = () => recording() === p.c.id;
    return (
      <div class="kb-item" classList={{ recording: on() }}>
        <div class="set-row kb-row">
          <div class="set-row-text">
            <span class="set-row-label">
              {p.c.title}
              <Show when={p.c.fixed}>
                <span class="kb-fixed">Fixed</span>
              </Show>
            </span>
            <span class="set-row-hint">{p.c.fixed ?? p.c.detail}</span>
          </div>
          <div class="kb-control">
            <Show
              when={on()}
              fallback={
                <>
                  <Show when={changed(p.c)}>
                    <button
                      type="button"
                      class="kb-undo"
                      title="Back to the default"
                      aria-label={`Put ${p.c.title} back to its default shortcut`}
                      onClick={() => reset(p.c)}
                    >
                      ↺
                    </button>
                  </Show>
                  <button
                    type="button"
                    class="kb-keys"
                    disabled={!!p.c.fixed}
                    aria-label={
                      p.c.fixed
                        ? `${p.c.title}: ${p.c.keys.map(keyLabel).join(" or ")}, can't be changed`
                        : p.c.keys.length
                          ? `${p.c.title}: ${p.c.keys.map(keyLabel).join(" or ")}. Change`
                          : `Add a shortcut for ${p.c.title}`
                    }
                    onClick={() => record(p.c.id)}
                  >
                    <Show when={p.c.keys.length} fallback={<span class="kb-none">Add shortcut</span>}>
                      <For each={p.c.keys.slice(0, 2)}>
                        {(k, i) => (
                          <>
                            <Show when={i() > 0}>
                              <span class="kb-or">or</span>
                            </Show>
                            <Caps chord={k} />
                          </>
                        )}
                      </For>
                    </Show>
                  </button>
                </>
              }
            >
              <div class="kb-rec" role="status" aria-label={`Recording a shortcut for ${p.c.title}`}>
                <span class="kb-dot" aria-hidden="true" />
                <span class="kb-press">Press keys…</span>
                <Show when={pressed()}>{(k) => <Caps chord={k()} hot />}</Show>
              </div>
            </Show>
          </div>
        </div>
        <Show when={on()}>
          <Show
            when={clash()}
            fallback={
              <p class="kb-tip">
                <Show when={note()} fallback="Esc cancels · ⌫ takes the shortcut off">
                  {note()}
                </Show>
              </p>
            }
          >
            {(x) => (
              <div class="kb-clash" role="alert">
                <span class="kb-clash-text">
                  <strong>{keyLabel(x().chord)}</strong>{" "}
                  {x().free ? `is used by ${x().owner}` : `is ${x().owner}, which can't be changed`}
                </span>
                <Show when={x().free}>
                  <button type="button" class="kb-btn primary" onClick={() => save(p.c.id, x().chord)}>
                    Use here
                  </button>
                </Show>
                <button type="button" class="kb-btn" onClick={stop}>
                  Cancel
                </button>
              </div>
            )}
          </Show>
        </Show>
      </div>
    );
  };

  return (
    <div class="kb">
      <div class="kb-head">
        <label class="kb-search">
          <span class="kb-sr">Search commands</span>
          <input
            ref={search}
            type="search"
            placeholder="Search commands"
            value={query()}
            onInput={(e) => setQuery(e.currentTarget.value)}
          />
          <kbd aria-hidden="true">/</kbd>
        </label>
        <button type="button" class="kb-btn" disabled={!anyChanged()} onClick={() => void resetAll()}>
          Reset to defaults
        </button>
      </div>
      <Show when={!recording() && note()}>
        <p class="kb-note" role="status">
          {note()}
        </p>
      </Show>
      <Show when={keysInfo()} fallback={<p class="kb-note">Loading the commands…</p>}>
        <For each={names()} fallback={<p class="kb-note">No command matches “{query()}”.</p>}>
          {(name) => {
            const ids = () => groups().get(name) ?? [];
            const keyed = () => ids().filter((id) => byId(id)?.keys.length).length;
            return (
              <details class="kb-group" open={!!query() || !FOLDED.has(name)}>
                <summary>
                  <span class="kb-group-title">{name}</span>
                  <span class="kb-group-count">
                    {ids().length} command{ids().length === 1 ? "" : "s"}
                    {keyed() ? ` · ${keyed()} with ${keyed() === 1 ? "a key" : "keys"}` : ""}
                  </span>
                </summary>
                <For each={ids()}>{(id) => <Show when={byId(id)}>{(c) => <Item c={c()} />}</Show>}</For>
              </details>
            );
          }}
        </For>
        <p class="kb-foot">Fixed shortcuts belong to macOS or WebKit and can't be changed here.</p>
      </Show>
    </div>
  );
};

export default KeyboardSettings;
