/** Compact launcher rail. All destinations remain searchable in Launcher. */
import { For, createMemo, onMount, type Component } from "solid-js";
import { IconOrGlyph } from "./Icon";
import { openTab, openTuiPane } from "./store";
import { hideTip, showTip } from "./RailTip";
import { PAGES } from "./launcherCatalog";
import { favorites, loadTerminalApps, terminalApps } from "./launcherData";
import { setLauncherOpen } from "./launcherOpen";
const PagesBar: Component = () => {
  onMount(() => void loadTerminalApps());
  const entries = createMemo(() =>
    favorites().flatMap((id) => {
      const page = PAGES.find((p) => `page:${p.url}` === id);
      if (page)
        return [
          {
            name: page.label,
            icon: page.icon as string,
            launch: () => {
              void openTab("browser", page.url).catch(() => setLauncherOpen(true));
            },
          },
        ];
      const app = terminalApps().find((a) => `terminal:${a.id}` === id);
      return app ? [{ name: app.name, icon: app.icon, launch: () => openTuiPane({ ...app }) }] : [];
    }),
  );
  return (
    <div class="pages-bar launcher-rail">
      <button
        class="pages-chip"
        aria-label="Open launcher"
        title="Open launcher"
        onClick={() => {
          hideTip();
          setLauncherOpen(true);
        }}
      >
        ⌕
      </button>
      <div class="launcher-rail-sep" />
      <For each={entries()}>
        {(entry) => (
          <button
            class="pages-chip"
            title={`Open ${entry.name}`}
            aria-label={`Open ${entry.name}`}
            onClick={() => {
              hideTip();
              entry.launch();
            }}
            onMouseEnter={(e) => showTip(e.currentTarget, entry.name)}
            onMouseLeave={hideTip}
            onFocus={(e) => showTip(e.currentTarget, entry.name)}
            onBlur={hideTip}
          >
            <IconOrGlyph icon={entry.icon} size={17} />
          </button>
        )}
      </For>
    </div>
  );
};
export default PagesBar;
