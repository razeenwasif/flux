/**
 * Pages bar — one icon per Flux native page, in the vertical launcher column
 * (BarsColumn). Clicking one opens that page in a NEW tab.
 *
 * Icons only (#154): seventeen labels at 12px is a wall of text you read past
 * rather than scan, and the names cost the column three times its width for
 * information you need only while you're learning it. `RailTip` gives them back
 * on hover and on keyboard focus.
 */
import { For, type Component } from "solid-js";
import { openTab } from "./store";
import { hideTip, showTip } from "./RailTip";
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
  SCRIBE_URL,
  VAULT_URL,
} from "./ipc";

const PAGES: { icon: string; label: string; url: string }[] = [
  { icon: "✦", label: "Notebook", url: NOTEBOOK_URL },
  { icon: "🧭", label: "Trail", url: TRAIL_URL },
  { icon: "🎨", label: "Whiteboard", url: WHITEBOARD_URL },
  { icon: "✍️", label: "Scribe", url: SCRIBE_URL },
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
          onMouseEnter={(e) => showTip(e.currentTarget, p.label)}
          onMouseLeave={hideTip}
          // Keyboard tabbing through the rail gets the same labels the mouse
          // does — otherwise the column is unusable without a pointer.
          onFocus={(e) => showTip(e.currentTarget, p.label)}
          onBlur={hideTip}
        >
          <span class="pages-chip-ico">{p.icon}</span>
        </button>
      )}
    </For>
  </div>
);

export default PagesBar;
