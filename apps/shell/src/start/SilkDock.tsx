/**
 * Liquid Silk's home dock (design.ts) — Flux's tools in one frosted strip at
 * the bottom centre of the home page: the same toggles as the sidebar footer,
 * reached through the shell bridge (shellActions.ts). A dot under a tool marks
 * its panel as open.
 *
 * The user's web apps (apps.ts) aren't here: they run as native Mac apps, and
 * the app dock still offers them on every other page.
 */
import { For, type Component } from "solid-js";

import Icon, { type IconName } from "../Icon";
import { runShellAction, shellActionOpen, type ShellAction } from "../shellActions";

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
  </nav>
);

export default SilkDock;
