/**
 * flux://settings — the real Settings page (BACKLOG #78). Consolidates the
 * toggles that were scattered across the footer ⚙ popover and the Shields popover
 * into one organized, full-width page: Appearance, Search, Privacy & security,
 * Navigation, Memory, and Data. All state lives in the store (persisted to
 * localStorage) or behind flux-core commands — this page is just a tidy front end
 * over what already existed, plus the privacy controls that had no home here.
 */
import { For, Show, createSignal, onCleanup, onMount, type Component, type JSX } from "solid-js";
import {
  ARCHIVE_URL,
  BOOKMARKS_URL,
  cookiesClearAll,
  HISTORY_URL,
  httpsSetEnabled,
  httpsStatus,
  memStatus,
  PERMISSIONS_URL,
  permissionsSetBlock,
  permissionsStatus,
  RESOURCES_URL,
  searchDefault,
  searchEngines,
  searchSetDefault,
  SESSIONS_URL,
  shieldsSetEnabled,
  shieldsStatus,
  SYNC_URL,
  TASKS_URL,
  trackingSetLevel,
  trackingStatus,
  type MemInfo,
  type SearchEngine,
} from "./ipc";
import {
  aiAnswersOn,
  bookmarkBarOpen,
  darkMode,
  hibernateEnabled,
  hibernateMins,
  memEvict,
  mouseGestures,
  omniAutoAnswer,
  searchSuggestOn,
  setAiAnswersOn,
  setBookmarkBarOpen,
  setDarkMode,
  setHibernateEnabled,
  setHibernateMins,
  setMemEvict,
  setMouseGestures,
  setOmniAutoAnswer,
  setSearchSuggestOn,
  setVimHints,
  vimHints,
  activeId,
  updateTabTitle,
} from "./store";

const TRACKING_LABELS = ["Off", "Basic", "Balanced", "Strict"];

const Section: Component<{ title: string; sub?: string; children: JSX.Element }> = (props) => (
  <section class="set-section">
    <div class="set-section-head">
      <h2>{props.title}</h2>
      <Show when={props.sub}><span class="set-section-sub">{props.sub}</span></Show>
    </div>
    <div class="set-card">{props.children}</div>
  </section>
);

const Row: Component<{ label: string; hint?: string; children: JSX.Element }> = (props) => (
  <div class="set-row">
    <div class="set-row-text">
      <span class="set-row-label">{props.label}</span>
      <Show when={props.hint}><span class="set-row-hint">{props.hint}</span></Show>
    </div>
    <div class="set-row-control">{props.children}</div>
  </div>
);

const Toggle: Component<{ on: boolean; onClick: () => void }> = (props) => (
  <button classList={{ "shields-toggle": true, on: props.on }} onClick={() => props.onClick()}>
    {props.on ? "On" : "Off"}
  </button>
);

const SettingsPage: Component<{ onNavigate: (url: string) => void }> = (props) => {
  // Search engines.
  const [engines, setEngines] = createSignal<SearchEngine[]>([]);
  const [defaultEngine, setDefaultEngine] = createSignal("");
  // Privacy state (lives in flux-core; loaded on mount).
  const [shieldsOn, setShieldsOn] = createSignal(true);
  const [blocked, setBlocked] = createSignal(0);
  const [httpsOn, setHttpsOn] = createSignal(false);
  const [tracking, setTracking] = createSignal(2);
  const [blockPerms, setBlockPerms] = createSignal(false);
  const [cookieFlash, setCookieFlash] = createSignal("");
  const [mem, setMem] = createSignal<MemInfo | null>(null);

  onMount(() => {
    const id = activeId();
    if (id != null) updateTabTitle(id, "Settings");
    void searchEngines().then(setEngines).catch(() => {});
    void searchDefault().then(setDefaultEngine).catch(() => {});
    void shieldsStatus().then((s) => { setShieldsOn(s.enabled); setBlocked(s.blocked); }).catch(() => {});
    void httpsStatus().then((s) => setHttpsOn(s.enabled)).catch(() => {});
    void trackingStatus().then(setTracking).catch(() => {});
    void permissionsStatus().then(setBlockPerms).catch(() => {});
    const pollMem = () => void memStatus().then(setMem).catch(() => {});
    pollMem();
    const t = window.setInterval(pollMem, 3000);
    onCleanup(() => window.clearInterval(t));
  });

  const pickEngine = (id: string) => { setDefaultEngine(id); void searchSetDefault(id).catch(() => {}); };
  const toggleShields = () => { const v = !shieldsOn(); setShieldsOn(v); void shieldsSetEnabled(v).catch(() => {}); };
  const toggleHttps = () => { const v = !httpsOn(); setHttpsOn(v); void httpsSetEnabled(v).catch(() => {}); };
  const setTrack = (lvl: number) => { setTracking(lvl); void trackingSetLevel(lvl).catch(() => {}); };
  const toggleBlockPerms = () => { const v = !blockPerms(); setBlockPerms(v); void permissionsSetBlock(v).catch(() => {}); };
  const clearCookies = () => {
    void cookiesClearAll().then(() => { setCookieFlash("✓ cleared"); window.setTimeout(() => setCookieFlash(""), 2000); }).catch(() => {});
  };

  return (
    <div class="hist-page set-page">
      <header class="hist-head">
        <div class="hist-title">⚙ Settings</div>
      </header>
      <div class="set-body">
        <Section title="Appearance">
          <Row label="Dark mode (websites)" hint="Ask sites to render dark (prefers-color-scheme).">
            <Toggle on={darkMode()} onClick={() => setDarkMode(!darkMode())} />
          </Row>
          <Row label="Bookmark bar" hint="A chip row docked under the page for one-click bookmarks.">
            <Toggle on={bookmarkBarOpen()} onClick={() => setBookmarkBarOpen(!bookmarkBarOpen())} />
          </Row>
        </Section>

        <Section title="Search">
          <Row label="Default engine" hint="Used for omnibox searches.">
            <select class="shields-select" value={defaultEngine()} onChange={(e) => pickEngine(e.currentTarget.value)}>
              <For each={engines()}>{(en) => <option value={en.id}>{en.name}</option>}</For>
              <Show when={engines().length === 0}><option value="">(loads in the app)</option></Show>
            </select>
          </Row>
          <Row label="Search suggestions" hint="Send keystrokes to the engine for live suggestions. History stays local either way.">
            <Toggle on={searchSuggestOn()} onClick={() => setSearchSuggestOn(!searchSuggestOn())} />
          </Row>
          <Row label="AI answers for searches" hint="The local Gemma drafts a quick answer in the agent panel. On-device.">
            <Toggle on={aiAnswersOn()} onClick={() => setAiAnswersOn(!aiAnswersOn())} />
          </Row>
          <Row label="Omni answer on search" hint="Stream a grounded answer card from your Omni index each search. Runs the local LLM.">
            <Toggle on={omniAutoAnswer()} onClick={() => setOmniAutoAnswer(!omniAutoAnswer())} />
          </Row>
        </Section>

        <Section title="Privacy & security">
          <Row label="Shields (content blocker)" hint={`Block ads + trackers at the request level. ${blocked().toLocaleString()} blocked this session.`}>
            <Toggle on={shieldsOn()} onClick={toggleShields} />
          </Row>
          <Row label="HTTPS-only" hint="Upgrade http:// to https://; per-site exceptions are remembered.">
            <Toggle on={httpsOn()} onClick={toggleHttps} />
          </Row>
          <Row label="Tracking prevention" hint="How aggressively to block known tracking scripts.">
            <select class="shields-select" value={String(tracking())} onChange={(e) => setTrack(Number(e.currentTarget.value))}>
              <For each={TRACKING_LABELS}>{(lbl, i) => <option value={String(i())}>{lbl}</option>}</For>
            </select>
          </Row>
          <Row label="Block camera / mic / location" hint="Auto-deny these permission prompts globally.">
            <Toggle on={blockPerms()} onClick={toggleBlockPerms} />
          </Row>
          <Row label="Per-site permissions" hint="Manage camera/mic/location/notifications/clipboard per site.">
            <button class="set-link-btn" onClick={() => props.onNavigate(PERMISSIONS_URL)}>Manage…</button>
          </Row>
          <Row label="Cookies" hint="Clear every cookie in the store.">
            <button class="set-link-btn" onClick={clearCookies}>{cookieFlash() || "Clear all"}</button>
          </Row>
        </Section>

        <Section title="Navigation">
          <Row label="Vim link hints (f)" hint="Press f to label links, type the label to click. Also j/k, gg/G.">
            <Toggle on={vimHints()} onClick={() => setVimHints(!vimHints())} />
          </Row>
          <Row label="Mouse gestures" hint="Hold right-drag: left=back, right=forward, down=reload, up=top.">
            <Toggle on={mouseGestures()} onClick={() => setMouseGestures(!mouseGestures())} />
          </Row>
        </Section>

        <Section title="Memory">
          <Row label="Sleep inactive tabs" hint="Unload a background tab's memory; it reloads when you return.">
            <Toggle on={hibernateEnabled()} onClick={() => setHibernateEnabled(!hibernateEnabled())} />
          </Row>
          <Show when={hibernateEnabled()}>
            <Row label="Sleep after" hint="Idle time before a background tab is unloaded.">
              <select class="shields-select" value={String(hibernateMins())} onChange={(e) => setHibernateMins(Number(e.currentTarget.value))}>
                <option value="5">5 min</option>
                <option value="15">15 min</option>
                <option value="30">30 min</option>
                <option value="60">1 hour</option>
              </select>
            </Row>
          </Show>
          <Row label="Sleep under memory pressure" hint="When free RAM runs low, sleep the least-recently-used tabs early.">
            <Toggle on={memEvict()} onClick={() => setMemEvict(!memEvict())} />
          </Row>
          <Show when={mem()}>
            <div class="set-mem-stat">
              Flux {mem()!.process_mb} MB · {(mem()!.available_mb / 1024).toFixed(1)} GB free ({mem()!.available_pct}%)
              <button class="set-link-btn" onClick={() => props.onNavigate(RESOURCES_URL)}>Resource monitor</button>
              <button class="set-link-btn" onClick={() => props.onNavigate(TASKS_URL)}>Task manager</button>
            </div>
          </Show>
        </Section>

        <Section title="Data">
          <div class="set-link-row">
            <button class="set-link-btn" onClick={() => props.onNavigate(SYNC_URL)}>🔄 Sync</button>
            <button class="set-link-btn" onClick={() => props.onNavigate(SESSIONS_URL)}>🗃 Sessions</button>
            <button class="set-link-btn" onClick={() => props.onNavigate(HISTORY_URL)}>🕘 History</button>
            <button class="set-link-btn" onClick={() => props.onNavigate(BOOKMARKS_URL)}>🔖 Bookmarks</button>
            <button class="set-link-btn" onClick={() => props.onNavigate(ARCHIVE_URL)}>📚 Archive</button>
          </div>
        </Section>
      </div>
    </div>
  );
};

export default SettingsPage;
