import { For, Show, createMemo, createSignal, onMount, type Component } from "solid-js";
import Modal from "./Modal";
import { IconOrGlyph } from "./Icon";
import { PAGES } from "./launcherCatalog";
import { matchesLauncher } from "./launcherPreferences";
import {
  appsError,
  appsLoading,
  favorites,
  loadTerminalApps,
  setTerminalApps,
  terminalApps,
  toggleFavorite,
} from "./launcherData";
import { setLauncherOpen } from "./launcherOpen";
import { openTab, openTerminalApp, openTuiPane } from "./store";
import { isMobile } from "./platform";
import TerminalAppsEditor from "./TerminalAppsEditor";

type Entry = {
  id: string;
  name: string;
  icon: string;
  kind: "Pages" | "Terminal";
  detail: string;
  url?: string;
  cmd?: string;
  cwd?: string;
};
const Launcher: Component = () => {
  const [query, setQuery] = createSignal("");
  const [filter, setFilter] = createSignal("All");
  const [editing, setEditing] = createSignal(false);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal("");
  const [fullTab, setFullTab] = createSignal(false);
  let results!: HTMLDivElement;
  onMount(() => {
    if (!isMobile) void loadTerminalApps();
  });
  const entries = createMemo<Entry[]>(() => [
    ...PAGES.map((p): Entry => ({
      id: `page:${p.url}`,
      name: p.label,
      icon: p.icon,
      kind: "Pages",
      detail: "Open in a new tab",
      url: p.url,
    })),
    ...(isMobile
      ? []
      : terminalApps().map((a): Entry => ({
          id: `terminal:${a.id}`,
          name: a.name,
          icon: a.icon,
          kind: "Terminal",
          detail: a.cmd + (a.cwd ? ` · ${a.cwd}` : ""),
          cmd: a.cmd,
          cwd: a.cwd,
        }))),
  ]);
  const visible = createMemo(() =>
    entries().filter(
      (entry) =>
        (filter() === "All" ||
          filter() === entry.kind ||
          (filter() === "Favorites" && favorites().includes(entry.id))) &&
        matchesLauncher(query(), entry.name, entry.kind, entry.detail),
    ),
  );
  const close = () => {
    if (!busy()) setLauncherOpen(false);
  };
  const launch = async (entry: Entry) => {
    if (busy()) return;
    setBusy(true);
    setError("");
    try {
      if (entry.url) await openTab("browser", entry.url);
      else if (fullTab()) await openTerminalApp(entry.cmd!, entry.cwd ?? "");
      else openTuiPane({ name: entry.name, icon: entry.icon, cmd: entry.cmd!, cwd: entry.cwd ?? "" });
      setLauncherOpen(false);
    } catch (error) {
      setError(`Could not open ${entry.name}: ${String(error)}`);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      label={editing() ? "Edit terminal apps" : "Launcher"}
      backdropClass="launcher-backdrop"
      class="launcher-dialog"
      onClose={close}
    >
      <header class="launcher-heading">
        <div>
          <h2>{editing() ? "Terminal apps" : "Launcher"}</h2>
          <p>
            {editing()
              ? "Choose the commands you want within reach."
              : "Your pages and terminal apps, in one place."}
          </p>
        </div>
        <button class="tui-act" disabled={busy()} onClick={close} aria-label="Close launcher">
          ✕
        </button>
      </header>
      <Show
        when={editing()}
        fallback={
          <>
            <input
              ref={(input) =>
                requestAnimationFrame(() => {
                  if (input.isConnected) input.focus();
                })
              }
              class="launcher-search"
              data-autofocus
              aria-label="Search pages and terminal apps"
              placeholder="Search pages and terminal apps…"
              value={query()}
              onInput={(e) => setQuery(e.currentTarget.value)}
              onKeyDown={(e) => {
                if (e.key === "ArrowDown") {
                  e.preventDefault();
                  results.querySelector<HTMLButtonElement>(".launcher-launch")?.focus();
                }
                if (e.key === "Enter" && visible()[0]) {
                  e.preventDefault();
                  void launch(visible()[0]!);
                }
              }}
            />
            <div class="launcher-filters" role="group" aria-label="Launcher categories">
              <For
                each={isMobile ? ["All", "Favorites", "Pages"] : ["All", "Favorites", "Pages", "Terminal"]}
              >
                {(name) => (
                  <button class="tui-act" aria-pressed={filter() === name} onClick={() => setFilter(name)}>
                    {name}
                  </button>
                )}
              </For>
            </div>
            <div
              class="launcher-results"
              ref={results}
              onKeyDown={(e) => {
                if (
                  !e.target ||
                  !(e.target as HTMLElement).classList.contains("launcher-launch") ||
                  !["ArrowDown", "ArrowUp"].includes(e.key)
                )
                  return;
                const buttons = [...results.querySelectorAll<HTMLButtonElement>(".launcher-launch")];
                const index = buttons.indexOf(e.target as HTMLButtonElement);
                e.preventDefault();
                buttons[
                  (index + (e.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length
                ]?.focus();
              }}
            >
              <For
                each={visible()}
                fallback={
                  <p class="launcher-empty">
                    {filter() === "Favorites" && !query()
                      ? "No favorites yet. Use the star beside any item to keep it here."
                      : "No matches. Try another name or category."}
                  </p>
                }
              >
                {(entry) => (
                  <div class="launcher-row">
                    <button class="launcher-launch" disabled={busy()} onClick={() => void launch(entry)}>
                      <IconOrGlyph icon={entry.icon} size={20} />
                      <span>
                        <strong>{entry.name}</strong>
                        <small>{entry.detail}</small>
                      </span>
                      <span class="launcher-kind">{entry.kind === "Pages" ? "Page" : "Terminal"}</span>
                    </button>
                    <button
                      class="launcher-star"
                      aria-label={`${favorites().includes(entry.id) ? "Unfavorite" : "Favorite"} ${entry.name}`}
                      aria-pressed={favorites().includes(entry.id)}
                      disabled={!favorites().includes(entry.id) && favorites().length >= 6}
                      title={
                        favorites().length >= 6 && !favorites().includes(entry.id)
                          ? "Remove a favorite to add another (limit 6)"
                          : undefined
                      }
                      onClick={() => {
                        try {
                          toggleFavorite(entry.id);
                          setError("");
                        } catch {
                          setError("Could not save favorites. Please try again.");
                        }
                      }}
                    >
                      {favorites().includes(entry.id) ? "★" : "☆"}
                    </button>
                  </div>
                )}
              </For>
            </div>
            <Show when={appsLoading()}>
              <p role="status">Loading terminal apps…</p>
            </Show>
            <Show when={appsError()}>
              <p class="launcher-error" role="alert">
                {appsError()}{" "}
                <button class="tui-act" onClick={() => void loadTerminalApps()}>
                  Retry
                </button>
              </p>
            </Show>
            <footer class="launcher-footer">
              <span class="launcher-muted" role="status">
                {visible().length} {visible().length === 1 ? "result" : "results"} · {favorites().length}/6
                favorites
              </span>
              <Show when={!isMobile}>
                <label class="launcher-mode">
                  <input
                    type="checkbox"
                    checked={fullTab()}
                    onChange={(e) => setFullTab(e.currentTarget.checked)}
                  />{" "}
                  Terminal apps in a full tab
                </label>
                <button
                  class="tui-act"
                  disabled={appsLoading() || !!appsError() || busy()}
                  onClick={() => setEditing(true)}
                >
                  Edit terminal apps
                </button>
              </Show>
            </footer>
          </>
        }
      >
        <TerminalAppsEditor
          apps={terminalApps()}
          onBusy={setBusy}
          onCancel={() => setEditing(false)}
          onSaved={(apps) => {
            setTerminalApps(apps);
            setEditing(false);
          }}
        />
      </Show>
      <Show when={error()}>
        <p class="launcher-error" role="alert">
          {error()}
        </p>
      </Show>
    </Modal>
  );
};
export default Launcher;
