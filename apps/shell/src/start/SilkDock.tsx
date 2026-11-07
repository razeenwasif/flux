/**
 * Liquid Silk's home dock (design.ts) — the tools and the user's apps in one
 * frosted strip at the bottom centre of the home page.
 *
 * The tools are the same toggles as the sidebar footer, reached through the
 * shell bridge (shellActions.ts); the apps open exactly as from the app dock
 * (appOpen.ts), which Silk hides while home is showing so they aren't offered
 * twice. A dot under a tool marks its panel as open.
 */
import { For, type Component } from "solid-js";

import { FLUX_APPS } from "../apps";
import { AppIcon } from "../appIcon";
import { openFluxApp } from "../appOpen";
import Icon, { type IconName } from "../Icon";
import { runShellAction, shellActionOpen, type ShellAction } from "../shellActions";
import { openAppIds, openTimetable } from "../store";

const TOOLS: { action: ShellAction; icon: IconName; label: string; agent?: boolean }[] = [
  { action: "toggle-terminal", icon: "terminal", label: "Terminal" },
  { action: "toggle-editor", icon: "editor", label: "Editor" },
  { action: "toggle-agent", icon: "agent", label: "Flux Agent", agent: true },
  { action: "toggle-files", icon: "files", label: "Files" },
  { action: "toggle-notebook", icon: "notebook", label: "Notebook" },
];

const SilkDock: Component = () => (
  <nav class="silk-dock" aria-label="Dock">
    <For each={TOOLS}>
      {(t) => (
        <button
          class="silk-dock-btn"
          classList={{ on: shellActionOpen(t.action), agent: !!t.agent }}
          title={t.label}
          aria-label={t.label}
          aria-pressed={shellActionOpen(t.action)}
          onClick={() => runShellAction(t.action)}
        >
          <Icon name={t.icon} size={20} />
        </button>
      )}
    </For>
    <span class="silk-dock-sep" aria-hidden="true" />
    <button class="silk-dock-btn app" title="Timetable — your week at a glance" aria-label="Timetable" onClick={() => openTimetable()}>
      <Icon name="calendar" size={20} />
    </button>
    <For each={FLUX_APPS}>
      {(app) => (
        <button
          class="silk-dock-btn app"
          classList={{ on: openAppIds().includes(app.id) }}
          title={`${app.name} — ${app.tagline}`}
          aria-label={app.name}
          onClick={() => openFluxApp(app)}
        >
          <AppIcon app={app} size={22} />
        </button>
      )}
    </For>
  </nav>
);

export default SilkDock;
