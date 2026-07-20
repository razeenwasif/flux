/**
 * Chrome-style mobile chrome (ADR 0012) — the browsing UI for the Android build.
 * A persistent top bar (back / omnibox with lock + reload / tab-count / menu) in
 * its OWN grid row above the content card, plus a full-screen tab switcher. The
 * top bar must sit above the card, never over it: each tab's page is a native
 * WebView layered above all shell HTML, so chrome can't overlap it (the tab
 * switcher is an overlay, so it hides the WebView via App's overlay machinery).
 */
import { For, Show, createSignal, type Component } from "solid-js";

import {
  isStartUrl,
  searchResolve,
  webviewBack,
  webviewForward,
  webviewReload,
} from "./ipc";
import {
  activeId,
  activeTab,
  closeTab,
  faviconFor,
  focusTab,
  isLoading,
  openTab,
  tabs,
  tabThumb,
} from "./store";

const hostOf = (url: string): string => {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
};

const MobileChrome: Component<{
  go: (url: string) => void;
  onMenu: () => void;
  tabsOpen: () => boolean;
  setTabsOpen: (v: boolean) => void;
}> = (props) => {
  const [editing, setEditing] = createSignal(false);
  const [draft, setDraft] = createSignal("");
  let inputRef: HTMLInputElement | undefined;

  const cur = () => activeTab();
  const curUrl = () => {
    const t = cur();
    return t && t.kind === "browser" && !isStartUrl(t.url) ? t.url : "";
  };
  const displayText = () => {
    const u = curUrl();
    return u ? hostOf(u) || u : "";
  };

  const startEdit = () => {
    setDraft(curUrl());
    setEditing(true);
    queueMicrotask(() => {
      inputRef?.focus();
      inputRef?.select();
    });
  };

  const submit = async (e: SubmitEvent) => {
    e.preventDefault();
    const v = draft().trim();
    setEditing(false);
    if (!v) return;
    if (v.startsWith("flux://")) {
      props.go(v);
      return;
    }
    const r = await searchResolve(v);
    props.go(r.url);
  };

  const navActive = (fn: (id: number) => Promise<unknown>) => {
    const t = cur();
    if (t?.kind === "browser") void fn(t.id).catch(() => {});
  };

  const browserTabs = () => tabs().filter((t) => t.kind === "browser");

  return (
    <>
      <header class="mchrome-top">
        <button class="mchrome-icon" onClick={() => navActive(webviewBack)} aria-label="Back">
          ‹
        </button>
        <button class="mchrome-icon" onClick={() => navActive(webviewForward)} aria-label="Forward">
          ›
        </button>
        <form class="mchrome-omni" onSubmit={submit}>
          <Show
            when={editing()}
            fallback={
              <button type="button" class="mchrome-omni-view" onClick={startEdit}>
                <span class="mchrome-lock">{curUrl().startsWith("https") ? "🔒" : "🌐"}</span>
                <span class="mchrome-omni-text" classList={{ hint: !displayText() }}>
                  {displayText() || "Search or type URL"}
                </span>
              </button>
            }
          >
            <input
              ref={inputRef}
              class="mchrome-omni-input"
              value={draft()}
              onInput={(e) => setDraft(e.currentTarget.value)}
              onBlur={() => setEditing(false)}
              enterkeyhint="go"
              inputmode="url"
              autocapitalize="off"
              autocorrect="off"
              spellcheck={false}
              placeholder="Search or type URL"
            />
          </Show>
          <button
            type="button"
            class="mchrome-omni-reload"
            onClick={() => navActive(webviewReload)}
            aria-label="Reload"
          >
            ⟳
          </button>
        </form>
        <button class="mchrome-tabcount" onClick={() => props.setTabsOpen(true)} aria-label="Tabs">
          {browserTabs().length}
        </button>
        <button class="mchrome-icon" onClick={() => props.onMenu()} aria-label="Menu">
          ⋮
        </button>
        <Show when={isLoading()}>
          <div class="mchrome-progress" />
        </Show>
      </header>

      <Show when={props.tabsOpen()}>
        <div class="mchrome-switcher">
          <div class="mchrome-switcher-head">
            <span class="mchrome-switcher-count">{browserTabs().length} tabs</span>
            <button
              class="mchrome-switcher-new"
              onClick={() => {
                void openTab("browser");
                props.setTabsOpen(false);
              }}
              aria-label="New tab"
            >
              ＋
            </button>
            <button class="mchrome-switcher-done" onClick={() => props.setTabsOpen(false)}>
              Done
            </button>
          </div>
          <div class="mchrome-grid">
            <For each={browserTabs()}>
              {(t) => {
                const host = () => hostOf(t.url);
                const fav = () => faviconFor(host());
                const thumb = () => tabThumb(t.id);
                const initial = () => (host()[0] || "•").toUpperCase();
                return (
                  <div
                    class="mchrome-card"
                    classList={{ active: t.id === activeId() }}
                    onClick={() => {
                      void focusTab(t.id);
                      props.setTabsOpen(false);
                    }}
                  >
                    <div
                      class="mchrome-card-cover"
                      style={thumb() ? { "background-image": `url("${thumb()}")` } : undefined}
                    >
                      <button
                        class="mchrome-card-x"
                        onClick={(e) => {
                          e.stopPropagation();
                          void closeTab(t.id);
                        }}
                        aria-label="Close tab"
                      >
                        ×
                      </button>
                      <Show when={!thumb()}>
                        <span class="mchrome-card-cover-glyph">{initial()}</span>
                      </Show>
                    </div>
                    <div class="mchrome-card-foot">
                      <Show
                        when={fav()}
                        fallback={<span class="mchrome-card-glyph">{initial()}</span>}
                      >
                        <img class="mchrome-card-fav" src={fav()!} alt="" />
                      </Show>
                      <span class="mchrome-card-title">
                        {t.custom_title || t.title || host() || "New tab"}
                      </span>
                    </div>
                  </div>
                );
              }}
            </For>
          </div>
        </div>
      </Show>
    </>
  );
};

export default MobileChrome;
