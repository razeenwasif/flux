/**
 * Extension manager (BACKLOG #95). Lists installed mini-extensions, shows each
 * one's granted permissions, toggles enable/disable, installs from a folder
 * (must hold flux.extension.json), and removes. Backed by the #92 registry
 * commands; the extensions themselves run via the #93 injector + #94 broker.
 */
import { For, Show, createSignal, onMount, type Component } from "solid-js";
import { extInstall, extList, extRemove, extSetEnabled, type InstalledExt } from "./ipc";

const Extensions: Component = () => {
  const [exts, setExts] = createSignal<InstalledExt[]>([]);
  const [path, setPath] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);

  const refresh = () => void extList().then(setExts).catch(() => {});
  onMount(refresh);

  const install = async () => {
    const dir = path().trim();
    if (!dir) return;
    setBusy(true);
    setError(null);
    try {
      await extInstall(dir);
      setPath("");
      refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const toggle = (e: InstalledExt) => void extSetEnabled(e.manifest.id, !e.enabled).then(refresh);
  const remove = (e: InstalledExt) => void extRemove(e.manifest.id).then(refresh);

  return (
    <div style={{ "min-width": "300px" }}>
      <div class="sidebar-section" style={{ padding: "4px 8px" }}>Extensions</div>

      <Show
        when={exts().length > 0}
        fallback={
          <div class="start-empty" style={{ padding: "4px 10px 8px" }}>
            No extensions installed. Point Flux at a folder containing a
            <code>flux.extension.json</code> below — try
            <code>examples/extensions/hello</code>.
          </div>
        }
      >
        <For each={exts()}>
          {(e) => (
            <div class="ext-row">
              <div class="ext-head">
                <span class="ext-name" title={e.manifest.id}>
                  {e.manifest.name} <span class="ext-ver">v{e.manifest.version}</span>
                </span>
                <span style={{ display: "flex", gap: "6px" }}>
                  <button classList={{ "shields-toggle": true, on: e.enabled }} onClick={() => toggle(e)}>
                    {e.enabled ? "On" : "Off"}
                  </button>
                  <button class="ext-remove" title="Remove" onClick={() => remove(e)}>✕</button>
                </span>
              </div>
              <Show when={e.manifest.permissions.length > 0}>
                <div class="ext-perms">
                  <For each={e.manifest.permissions}>{(p) => <span class="ext-chip">{p}</span>}</For>
                </div>
              </Show>
            </div>
          )}
        </For>
      </Show>

      <div class="shields-sep" />
      <div class="ext-install">
        <input
          class="ext-path"
          placeholder="/path/to/extension/folder"
          value={path()}
          onInput={(ev) => setPath(ev.currentTarget.value)}
          onKeyDown={(ev) => ev.key === "Enter" && void install()}
        />
        <button class="shields-update" disabled={busy() || !path().trim()} onClick={() => void install()}>
          {busy() ? "Installing…" : "Install"}
        </button>
      </div>
      <Show when={error()}>
        <div class="ext-error">{error()}</div>
      </Show>
    </div>
  );
};

export default Extensions;
