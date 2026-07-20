/**
 * Mobile navigation drawer (ADR 0012) — replaces the desktop Arc sidebar on the
 * phone, which was mostly empty there (tabs live in MobileChrome's switcher, the
 * omnibox in its top bar). This is the Chrome-style ⋮ menu: a grid of Flux
 * destinations + a new-tab action. Opened by the ⋮ button, closed by a tap.
 */
import { For, type Component } from "solid-js";

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
  VAULT_URL,
  WHITEBOARD_URL,
} from "./ipc";
import { openTab } from "./store";

const DESTINATIONS: { icon: string; label: string; url: string }[] = [
  { icon: "✦", label: "Notebook", url: NOTEBOOK_URL },
  { icon: "🧭", label: "Trail", url: TRAIL_URL },
  { icon: "🎨", label: "Whiteboard", url: WHITEBOARD_URL },
  { icon: "🕘", label: "History", url: HISTORY_URL },
  { icon: "🔖", label: "Bookmarks", url: BOOKMARKS_URL },
  { icon: "📚", label: "Saved", url: ARCHIVE_URL },
  { icon: "📰", label: "Feeds", url: FEEDS_URL },
  { icon: "🗃", label: "Sessions", url: SESSIONS_URL },
  { icon: "🗂️", label: "Tasks", url: TASKS_URL },
  { icon: "📊", label: "Resources", url: RESOURCES_URL },
  { icon: "⚡", label: "Speed test", url: SPEEDTEST_URL },
  { icon: "✦", label: "Omni", url: OMNI_URL },
  { icon: "🧩", label: "Apps", url: APPS_URL },
  { icon: "🔑", label: "Passwords", url: VAULT_URL },
  { icon: "🔄", label: "Sync", url: SYNC_URL },
  { icon: "⚙", label: "Settings", url: SETTINGS_URL },
];

const MobileMenu: Component<{ onNavigate: (url: string) => void; onClose: () => void }> = (props) => {
  const go = (url: string) => {
    props.onNavigate(url);
    props.onClose();
  };
  return (
    <nav class="mobile-menu">
      <div class="mmenu-head">
        <span class="mmenu-brand">Flux</span>
        <button
          class="mmenu-newtab"
          onClick={() => {
            void openTab("browser");
            props.onClose();
          }}
        >
          ＋ New tab
        </button>
      </div>
      <div class="mmenu-grid">
        <For each={DESTINATIONS}>
          {(d) => (
            <button class="mmenu-card" onClick={() => go(d.url)}>
              <span class="mmenu-ico">{d.icon}</span>
              <span class="mmenu-label">{d.label}</span>
            </button>
          )}
        </For>
      </div>
    </nav>
  );
};

export default MobileMenu;
