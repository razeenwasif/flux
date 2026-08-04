/**
 * TUI apps bar (#117) — a curated, editable strip of the user's terminal apps,
 * docked above the content card next to the native PagesBar. Clicking a chip
 * opens a new Terminal tab and auto-runs the app's command. The list is persisted
 * server-side (tui_apps_*); the ✎ button opens an editor to add/remove/reorder.
 */
import { For, Show, createSignal, onMount, type Component } from "solid-js";
import { Portal } from "solid-js/web";

import { tuiAppsDetect, tuiAppsList, tuiAppsSet, type TuiApp } from "./ipc";
import { openTerminalApp, openTuiPane } from "./store";
import { hideTip, showTip } from "./RailTip";

const newId = () =>
  globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
const blankApp = (): TuiApp => ({ id: newId(), name: "", icon: "▸", cmd: "", cwd: "" });

const TuiAppsBar: Component = () => {
  const [apps, setApps] = createSignal<TuiApp[]>([]);
  const [editing, setEditing] = createSignal(false);
  const [draft, setDraft] = createSignal<TuiApp[]>([]);
  const [detected, setDetected] = createSignal<string[]>([]);

  onMount(
    () =>
      void tuiAppsList()
        .then(setApps)
        .catch(() => {}),
  );

  // Click floats the app in a pane (it stays put while you browse); Ctrl/⌘- or
  // shift-click sends it to a full terminal tab instead.
  const launch = (a: TuiApp, e?: MouseEvent) => {
    if (e && (e.ctrlKey || e.metaKey || e.shiftKey)) {
      void openTerminalApp(a.cmd, a.cwd).catch(() => {});
      return;
    }
    openTuiPane({ name: a.name, icon: a.icon, cmd: a.cmd, cwd: a.cwd });
  };

  const openEditor = () => {
    setDraft(apps().map((a) => ({ ...a })));
    setDetected([]);
    setEditing(true);
  };
  const upd = (id: string, k: keyof TuiApp, v: string) =>
    setDraft((d) => d.map((a) => (a.id === id ? { ...a, [k]: v } : a)));
  const remove = (id: string) => setDraft((d) => d.filter((a) => a.id !== id));
  const add = () => setDraft((d) => [...d, blankApp()]);
  const move = (id: string, dir: -1 | 1) =>
    setDraft((d) => {
      const i = d.findIndex((a) => a.id === id);
      const j = i + dir;
      if (i < 0 || j < 0 || j >= d.length) return d;
      const n = [...d];
      [n[i], n[j]] = [n[j]!, n[i]!];
      return n;
    });
  const scan = async () => {
    const names = await tuiAppsDetect().catch(() => [] as string[]);
    const have = new Set(draft().map((a) => a.cmd));
    setDetected(names.filter((n) => !have.has(n)));
  };
  const addDetected = (name: string) => {
    setDraft((d) => [...d, { ...blankApp(), name: name.charAt(0).toUpperCase() + name.slice(1), cmd: name }]);
    setDetected((x) => x.filter((n) => n !== name));
  };
  const save = async () => {
    const clean = draft()
      .filter((a) => a.name.trim() && a.cmd.trim())
      .map((a) => ({
        ...a,
        name: a.name.trim(),
        cmd: a.cmd.trim(),
        cwd: a.cwd.trim(),
        icon: a.icon.trim() || "▸",
      }));
    await tuiAppsSet(clean).catch(() => {});
    setApps(clean);
    setEditing(false);
  };

  return (
    <>
      <div class="tui-bar">
        {/* Above the list, not after it. In the horizontal strip this sat at the
            right end; in a scrolling column that put it below every app, where
            you had to scroll to the bottom to find the way to edit the list. */}
        <Show when={apps().length > 0}>
          <button
            class="tui-edit"
            title="Edit terminal apps"
            onClick={openEditor}
            onMouseEnter={(e) => showTip(e.currentTarget, "Edit terminal apps")}
            onMouseLeave={hideTip}
            onFocus={(e) => showTip(e.currentTarget, "Edit terminal apps")}
            onBlur={hideTip}
          >
            ✎
          </button>
        </Show>
        <For
          each={apps()}
          fallback={
            <button
              class="tui-edit"
              title="Add your terminal apps"
              onClick={openEditor}
              onMouseEnter={(e) => showTip(e.currentTarget, "Add your terminal apps")}
              onMouseLeave={hideTip}
              onFocus={(e) => showTip(e.currentTarget, "Add your terminal apps")}
              onBlur={hideTip}
            >
              +
            </button>
          }
        >
          {(a) => {
            const tip = () =>
              `${a.name} — runs “${a.cmd}”${a.cwd ? ` in ${a.cwd}` : ""}. Ctrl/⌘ or Shift-click for a terminal tab.`;
            return (
              <button
                class="tui-chip"
                title={tip()}
                onClick={(e) => launch(a, e)}
                onMouseEnter={(e) => showTip(e.currentTarget, tip())}
                onMouseLeave={hideTip}
                onFocus={(e) => showTip(e.currentTarget, tip())}
                onBlur={hideTip}
              >
                <span class="tui-chip-ico">{a.icon}</span>
              </button>
            );
          }}
        </For>
      </div>

      <Show when={editing()}>
        <Portal>
          <div class="tui-modal-backdrop" onClick={() => setEditing(false)}>
            <div class="tui-modal" onClick={(e) => e.stopPropagation()}>
              <div class="tui-modal-title">Terminal apps</div>
              <div class="tui-modal-rows">
                <For
                  each={draft()}
                  fallback={<div class="tui-modal-empty">No apps yet — add one below.</div>}
                >
                  {(a) => (
                    <div class="tui-row">
                      <input
                        class="tui-in tui-in-ico"
                        value={a.icon}
                        maxLength={2}
                        title="Icon"
                        onInput={(e) => upd(a.id, "icon", e.currentTarget.value)}
                      />
                      <input
                        class="tui-in"
                        value={a.name}
                        placeholder="Name"
                        onInput={(e) => upd(a.id, "name", e.currentTarget.value)}
                      />
                      <input
                        class="tui-in tui-in-cmd"
                        value={a.cmd}
                        placeholder="command — e.g. onyx"
                        onInput={(e) => upd(a.id, "cmd", e.currentTarget.value)}
                      />
                      <input
                        class="tui-in"
                        value={a.cwd}
                        placeholder="working dir (optional)"
                        onInput={(e) => upd(a.id, "cwd", e.currentTarget.value)}
                      />
                      <button class="tui-row-btn" title="Move up" onClick={() => move(a.id, -1)}>
                        ↑
                      </button>
                      <button class="tui-row-btn" title="Move down" onClick={() => move(a.id, 1)}>
                        ↓
                      </button>
                      <button class="tui-row-btn danger" title="Remove" onClick={() => remove(a.id)}>
                        ✕
                      </button>
                    </div>
                  )}
                </For>
              </div>
              <Show when={detected().length}>
                <div class="tui-detected">
                  <span class="tui-detected-label">Found in your bin dirs:</span>
                  <For each={detected()}>
                    {(n) => (
                      <button class="tui-detected-chip" onClick={() => addDetected(n)}>
                        + {n}
                      </button>
                    )}
                  </For>
                </div>
              </Show>
              <div class="tui-modal-actions">
                <button class="tui-act" onClick={add}>
                  + Add app
                </button>
                <button
                  class="tui-act"
                  title="Scan ~/.cargo/bin, ~/.local/bin, go/bin"
                  onClick={() => void scan()}
                >
                  ⌕ Scan
                </button>
                <span style={{ flex: 1 }} />
                <button class="tui-act" onClick={() => setEditing(false)}>
                  Cancel
                </button>
                <button class="tui-act primary" onClick={() => void save()}>
                  Save
                </button>
              </div>
            </div>
          </div>
        </Portal>
      </Show>
    </>
  );
};

export default TuiAppsBar;
