/**
 * Pages bar — a quick-access strip docked *above* the content card (mirroring the
 * bookmark bar below it) with one chip per Flux native page. Clicking a chip opens
 * that page in a NEW tab. A sibling of the card (not an overlay), so the card
 * shrinks and the native tab webview relayout follows — same trick as the
 * bookmark bar. Horizontal + horizontally scrollable so it never wraps.
 */
import { For, type Component } from "solid-js";
import { openTab } from "./store";
import {
  APPS_URL,
  ARCHIVE_URL,
  BOOKMARKS_URL,
  FEEDS_URL,
  HISTORY_URL,
  NOTEBOOK_URL,
  OMNI_URL,
  RESOURCES_URL,
  SESSIONS_URL,
  SETTINGS_URL,
  SPEEDTEST_URL,
  SYNC_URL,
  TASKS_URL,
  TRAIL_URL,
  WHITEBOARD_URL,
  VAULT_URL,
} from "./ipc";

const PAGES: { icon: string; label: string; url: string }[] = [
  { icon: "✦", label: "Notebook", url: NOTEBOOK_URL },
  { icon: "🧭", label: "Trail", url: TRAIL_URL },
  { icon: "🎨", label: "Whiteboard", url: WHITEBOARD_URL },
  { icon: "🗃", label: "Sessions", url: SESSIONS_URL },
  { icon: "📚", label: "Saved pages", url: ARCHIVE_URL },
  { icon: "📰", label: "Feeds", url: FEEDS_URL },
  { icon: "🕘", label: "History", url: HISTORY_URL },
  { icon: "🔖", label: "Bookmarks", url: BOOKMARKS_URL },
  { icon: "🗂️", label: "Task manager", url: TASKS_URL },
  { icon: "📊", label: "Resources", url: RESOURCES_URL },
  { icon: "⚡", label: "Speed test", url: SPEEDTEST_URL },
  { icon: "✦", label: "Omni", url: OMNI_URL },
  { icon: "🧩", label: "Apps", url: APPS_URL },
  { icon: "🔑", label: "Passwords", url: VAULT_URL },
  { icon: "🔄", label: "Sync", url: SYNC_URL },
  { icon: "⚙", label: "Settings", url: SETTINGS_URL },
];

const PagesBar: Component = () => (
  <div class="pages-bar">
    <For each={PAGES}>
      {(p) => (
        <button
          class="pages-chip"
          title={`Open ${p.label} in a new tab`}
          onClick={() => void openTab("browser", p.url)}
        >
          <span class="pages-chip-ico">{p.icon}</span>
          <span class="pages-chip-label">{p.label}</span>
        </button>
      )}
    </For>
  </div>
);

export default PagesBar;
