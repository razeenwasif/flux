import { For, Index, Show, createSignal, type Component } from "solid-js";
import { tuiAppsDetect, tuiAppsSet, type TuiApp } from "./ipc";
const blankApp = (): TuiApp => ({ id: crypto.randomUUID(), name: "", icon: "▸", cmd: "", cwd: "" });
const TerminalAppsEditor: Component<{
  apps: TuiApp[];
  onSaved: (apps: TuiApp[]) => void;
  onCancel: () => void;
  onBusy: (busy: boolean) => void;
}> = (props) => {
  const [draft, setDraft] = createSignal(props.apps.map((app) => ({ ...app })));
  const [detected, setDetected] = createSignal<string[]>([]);
  const [error, setError] = createSignal("");
  const [busy, setBusyRaw] = createSignal(false);
  const setBusy = (value: boolean) => {
    setBusyRaw(value);
    props.onBusy(value);
  };
  const [scanDone, setScanDone] = createSignal(false);
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
    setError("");
    setBusy(true);
    try {
      const names = await tuiAppsDetect();
      const have = new Set(draft().map((a) => a.cmd));
      setDetected(names.filter((n) => !have.has(n)));
      setScanDone(true);
    } catch (error) {
      setError(`Scan failed: ${String(error)}`);
    } finally {
      setBusy(false);
    }
  };
  const addDetected = (name: string) => {
    setDraft((d) => [...d, { ...blankApp(), name: name.charAt(0).toUpperCase() + name.slice(1), cmd: name }]);
    setDetected((x) => x.filter((n) => n !== name));
  };
  const save = async () => {
    setError("");
    if (draft().some((a) => !a.name.trim() || !a.cmd.trim())) {
      setError("Each app needs a name and command. Complete or remove the empty rows.");
      return;
    }
    const clean = draft()
      .filter((a) => a.name.trim() && a.cmd.trim())
      .map((a) => ({
        ...a,
        name: a.name.trim(),
        cmd: a.cmd.trim(),
        cwd: a.cwd.trim(),
        icon: a.icon.trim() || "▸",
      }));
    setBusy(true);
    try {
      await tuiAppsSet(clean);
      props.onSaved(clean);
    } catch (error) {
      setError(`Could not save apps: ${String(error)}. Your edits are still here; try again.`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <p class="launcher-muted">Each row contains an icon, name, command, and optional working directory.</p>
      <fieldset class="launcher-editor-fields" disabled={busy()}>
        <div class="tui-modal-rows">
          <Index each={draft()} fallback={<div class="tui-modal-empty">No apps yet — add one below.</div>}>
            {(a) => (
              <div class="tui-row">
                <input
                  class="tui-in tui-in-ico"
                  value={a().icon}
                  // Was 2, for a single emoji. An icon name is longer, and
                  // the field takes either — see IconOrGlyph.
                  maxLength={16}
                  title="Icon — a Flux icon name (e.g. lazygit) or any emoji"
                  aria-label="App icon"
                  placeholder="icon"
                  onInput={(e) => upd(a().id, "icon", e.currentTarget.value)}
                />
                <input
                  class="tui-in"
                  value={a().name}
                  aria-label="App name"
                  placeholder="Name"
                  onInput={(e) => upd(a().id, "name", e.currentTarget.value)}
                />
                <input
                  class="tui-in tui-in-cmd"
                  value={a().cmd}
                  aria-label="App command"
                  placeholder="command — e.g. onyx"
                  onInput={(e) => upd(a().id, "cmd", e.currentTarget.value)}
                />
                <input
                  class="tui-in"
                  value={a().cwd}
                  aria-label="Working directory"
                  placeholder="working dir (optional)"
                  onInput={(e) => upd(a().id, "cwd", e.currentTarget.value)}
                />
                <button
                  class="tui-row-btn"
                  aria-label={`Move ${a().name || "app"} up`}
                  disabled={draft()[0]?.id === a().id}
                  onClick={() => move(a().id, -1)}
                >
                  ↑
                </button>
                <button
                  class="tui-row-btn"
                  aria-label={`Move ${a().name || "app"} down`}
                  disabled={draft().at(-1)?.id === a().id}
                  onClick={() => move(a().id, 1)}
                >
                  ↓
                </button>
                <button
                  class="tui-row-btn danger"
                  aria-label={`Remove ${a().name || "app"}`}
                  onClick={() => remove(a().id)}
                >
                  ✕
                </button>
              </div>
            )}
          </Index>
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
          <button class="tui-act" title="Scan ~/.cargo/bin, ~/.local/bin, go/bin" onClick={() => void scan()}>
            ⌕ Scan
          </button>
          <span style={{ flex: 1 }} />
          <button class="tui-act" onClick={props.onCancel}>
            Cancel
          </button>
          <button class="tui-act primary" onClick={() => void save()}>
            {busy() ? "Saving…" : "Save apps"}
          </button>
        </div>
      </fieldset>
      <Show when={scanDone() && !detected().length}>
        <p class="launcher-muted" role="status">
          No additional apps found.
        </p>
      </Show>
      <Show when={error()}>
        <p class="launcher-error" role="alert">
          {error()}
        </p>
      </Show>
    </>
  );
};
export default TerminalAppsEditor;
