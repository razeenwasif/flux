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
  elevenlabsHasKey,
  elevenlabsSetKey,
  elevenlabsVoices,
  HISTORY_URL,
  httpsAllowSite,
  httpsSetEnabled,
  httpsStatus,
  leanSetSite,
  leanStatus,
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
  shieldsSetSite,
  shieldsStatus,
  SYNC_URL,
  TASKS_URL,
  trackingSetLevel,
  trackingStatus,
  type MemInfo,
  type SearchEngine,
} from "./ipc";
import { heyGemmaEnabled, setHeyGemmaEnabled } from "./heygemma";
import { elVoiceId, loadVoices, preferredVoice, setElVoiceId, setPreferredVoice, setTtsEngine, speak, stopSpeaking, ttsEngine, type TtsEngine } from "./speak";
import {
  aiAnswersOn,
  audiopulseDir,
  setAudiopulseDir,
  bookmarkBarOpen,
  darkMode,
  hibernateEnabled,
  hibernateMins,
  liquidBg,
  memEvict,
  mouseGestures,
  omniAutoAnswer,
  pagesBarOpen,
  searchSuggestOn,
  setAiAnswersOn,
  setBookmarkBarOpen,
  setDarkMode,
  setHibernateEnabled,
  setHibernateMins,
  setLiquidBg,
  setMemEvict,
  setMouseGestures,
  setOmniAutoAnswer,
  setPagesBarOpen,
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

function parseElevenLabsVoiceId(input: string): string {
  const raw = input.trim();
  if (!raw) return "";
  const direct = raw.match(/^[A-Za-z0-9_-]{10,}$/)?.[0];
  if (direct) return direct;
  const fromParam = raw.match(/[?&]voice(?:_id|Id)?=([A-Za-z0-9_-]{10,})/i)?.[1];
  if (fromParam) return fromParam;
  const fromPath = raw.match(/\/voices?\/([A-Za-z0-9_-]{10,})(?:[/?#]|$)/i)?.[1];
  if (fromPath) return fromPath;
  const ids = raw.match(/[A-Za-z0-9_-]{16,}/g);
  return ids?.at(-1) ?? raw;
}

const SettingsPage: Component<{ onNavigate: (url: string) => void }> = (props) => {
  // Gemma's voice (TTS engine) + "Hey Gemma" always-on listening.
  const [ttsEngineSel, setTtsEngineSel] = createSignal<TtsEngine>(ttsEngine());
  const pickTts = (e: TtsEngine) => { setTtsEngine(e); setTtsEngineSel(e); };
  const [sysVoices, setSysVoices] = createSignal<{ name: string; lang: string }[]>([]);
  const [voiceSel, setVoiceSel] = createSignal(preferredVoice());
  const [testing, setTesting] = createSignal(false);
  const refreshVoices = () => setSysVoices(loadVoices().map((v) => ({ name: v.name, lang: v.lang })));
  const pickVoiceName = (name: string) => { setPreferredVoice(name); setVoiceSel(name); };
  const testVoice = async () => {
    if (testing()) { stopSpeaking(); setTesting(false); return; }
    setTesting(true);
    try { await speak("Hi, I'm Gemma. This is how I'll sound when we talk."); }
    finally { setTesting(false); }
  };
  // ElevenLabs (cloud) voice.
  const [elKeyInput, setElKeyInput] = createSignal("");
  const [elKeySet, setElKeySet] = createSignal(false);
  const [elVoices, setElVoices] = createSignal<{ id: string; name: string }[]>([]);
  const [elVoiceSel, setElVoiceSel] = createSignal(elVoiceId());
  const [elManualVoice, setElManualVoice] = createSignal("");
  const [elFlash, setElFlash] = createSignal("");
  const refreshElKey = () => void elevenlabsHasKey().then(setElKeySet).catch(() => {});
  const loadElVoices = () => void elevenlabsVoices().then((v) => setElVoices(v)).catch(() => setElVoices([]));
  const saveElKey = async () => {
    try {
      await elevenlabsSetKey(elKeyInput().trim());
      setElKeyInput("");
      refreshElKey();
      setElFlash("Saved");
      loadElVoices();
    } catch (e) { setElFlash(String(e)); }
  };
  const pickElVoice = (id: string) => { setElVoiceId(id); setElVoiceSel(id); };
  const saveManualElVoice = () => {
    const id = parseElevenLabsVoiceId(elManualVoice());
    if (!id) {
      setElFlash("Paste a voice link or ID");
      return;
    }
    pickElVoice(id);
    setElManualVoice("");
    setElFlash("Voice saved");
  };

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
  // Per-site privacy exceptions (#78): hosts the user opted out per feature.
  const [sitesOff, setSitesOff] = createSignal<string[]>([]); // shields disabled
  const [httpAllow, setHttpAllow] = createSignal<string[]>([]); // HTTPS-only exempt
  const [leanOn, setLeanOn] = createSignal<string[]>([]); // lean mode on

  const loadShields = () => void shieldsStatus().then((s) => { setShieldsOn(s.enabled); setBlocked(s.blocked); setSitesOff(s.sites_off); }).catch(() => {});
  const loadHttps = () => void httpsStatus().then((s) => { setHttpsOn(s.enabled); setHttpAllow(s.sites_allow_http); }).catch(() => {});
  const loadLean = () => void leanStatus().then((s) => setLeanOn(s.sites_on)).catch(() => {});

  onMount(() => {
    const id = activeId();
    if (id != null) updateTabTitle(id, "Settings");
    refreshVoices();
    try { window.speechSynthesis?.addEventListener?.("voiceschanged", refreshVoices); } catch { /* ignore */ }
    refreshElKey();
    if (ttsEngine() === "elevenlabs") loadElVoices();
    void searchEngines().then(setEngines).catch(() => {});
    void searchDefault().then(setDefaultEngine).catch(() => {});
    loadShields();
    loadHttps();
    loadLean();
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
  // Clear an exception → re-enable the default for that host.
  const reenableShields = (host: string) => void shieldsSetSite(host, true).then(loadShields).catch(() => {});
  const disallowHttp = (host: string) => void httpsAllowSite(host, false).then(loadHttps).catch(() => {});
  const leanOff = (host: string) => void leanSetSite(host, false).then(loadLean).catch(() => {});

  const hasExceptions = () => sitesOff().length + httpAllow().length + leanOn().length > 0;

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
          <Row label="Pages bar" hint="A strip above the page with quick links to Flux's native pages (open in a new tab).">
            <Toggle on={pagesBarOpen()} onClick={() => setPagesBarOpen(!pagesBarOpen())} />
          </Row>
          <Row label="Liquid home background" hint="A GPU particle-liquid backdrop on the start page (only animates while the start tab is visible). Off = the lightweight wave.">
            <Toggle on={liquidBg()} onClick={() => setLiquidBg(!liquidBg())} />
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
          <Show when={hasExceptions()}>
            <div class="set-exceptions">
              <div class="set-exc-head">Per-site exceptions</div>
              <For each={sitesOff()}>
                {(host) => (
                  <div class="set-exc-row">
                    <span class="set-exc-tag">shields off</span>
                    <span class="set-exc-host">{host}</span>
                    <button class="set-exc-x" title="Re-enable shields here" onClick={() => reenableShields(host)}>✕</button>
                  </div>
                )}
              </For>
              <For each={httpAllow()}>
                {(host) => (
                  <div class="set-exc-row">
                    <span class="set-exc-tag">HTTP allowed</span>
                    <span class="set-exc-host">{host}</span>
                    <button class="set-exc-x" title="Require HTTPS here again" onClick={() => disallowHttp(host)}>✕</button>
                  </div>
                )}
              </For>
              <For each={leanOn()}>
                {(host) => (
                  <div class="set-exc-row">
                    <span class="set-exc-tag">lean mode</span>
                    <span class="set-exc-host">{host}</span>
                    <button class="set-exc-x" title="Turn lean mode off here" onClick={() => leanOff(host)}>✕</button>
                  </div>
                )}
              </For>
            </div>
          </Show>
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

        <Section title="Integrations">
          <Row label="AudioPulse config folder" hint="Where AudioPulse keeps token.json — needed to ask Gemma to play/skip music. On a Windows build it's in WSL: e.g. \\wsl.localhost\Ubuntu-24.04\home\you\.config\audiopulse. Leave blank to auto-detect.">
            <input
              class="map-search-input"
              style={{ "max-width": "340px" }}
              placeholder="\\wsl.localhost\<distro>\home\<you>\.config\audiopulse"
              value={audiopulseDir()}
              onChange={(e) => setAudiopulseDir(e.currentTarget.value.trim())}
            />
          </Row>
          <Row label="Hey Gemma (always-on voice)" hint="Listen for “hey Gemma”, then converse by voice. Everything is local — speech-to-text (Vosk), the reply (Ollama), and the spoken voice never leave your device; audio before the wake word is discarded, never stored. Toggle it from the mic button in the agent panel. Default off.">
            <Toggle on={heyGemmaEnabled()} onClick={() => void setHeyGemmaEnabled(!heyGemmaEnabled())} />
          </Row>
          <Row label="Gemma's voice" hint="System and Piper are fully local. ElevenLabs is a cloud service — choosing it sends Gemma's reply text (not your mic audio) to ElevenLabs, needs an API key, and is metered. Piper: set FLUX_PIPER_MODEL to a .onnx voice; falls back to System if absent.">
            <select class="shields-select" value={ttsEngineSel()} onChange={(e) => { const v = e.currentTarget.value as TtsEngine; pickTts(v); if (v === "elevenlabs") { refreshElKey(); loadElVoices(); } }}>
              <option value="system">System voice (local)</option>
              <option value="piper">Piper (local neural)</option>
              <option value="elevenlabs">ElevenLabs (cloud)</option>
            </select>
          </Row>
          <Show when={ttsEngineSel() === "elevenlabs"}>
            <Row label="ElevenLabs API key" hint="Stored in your OS keyring, never in plaintext. Get a key at elevenlabs.io → Profile. Leave blank and save to remove it.">
              <div style={{ display: "flex", gap: "8px", "align-items": "center" }}>
                <input
                  class="map-search-input"
                  type="password"
                  style={{ "max-width": "260px" }}
                  placeholder={elKeySet() ? "•••••••• (key set)" : "xi-api-key…"}
                  value={elKeyInput()}
                  onInput={(e) => setElKeyInput(e.currentTarget.value)}
                />
                <button class="set-link-btn" onClick={() => void saveElKey()}>{elFlash() || "Save"}</button>
              </div>
            </Row>
            <Show when={elKeySet()}>
              <Row label="ElevenLabs voice" hint="Pick an account voice, or paste a shared voice link/ID when it is not listed. Use Test to preview.">
                <div style={{ display: "grid", gap: "8px" }}>
                  <div style={{ display: "flex", gap: "8px", "align-items": "center" }}>
                    <select class="shields-select" value={elVoiceSel()} onChange={(e) => pickElVoice(e.currentTarget.value)}>
                      <option value="">Select a voice…</option>
                      <Show when={elVoiceSel() && !elVoices().some((v) => v.id === elVoiceSel())}>
                        <option value={elVoiceSel()}>Custom voice ({elVoiceSel()})</option>
                      </Show>
                      <For each={elVoices()}>{(v) => <option value={v.id}>{v.name}</option>}</For>
                    </select>
                    <button class="set-link-btn" onClick={loadElVoices}>↻</button>
                    <button class="set-link-btn" onClick={() => void testVoice()}>{testing() ? "■ Stop" : "🔊 Test"}</button>
                  </div>
                  <div style={{ display: "flex", gap: "8px", "align-items": "center" }}>
                    <input
                      class="map-search-input"
                      style={{ "max-width": "360px" }}
                      placeholder="Paste ElevenLabs voice link or voice ID"
                      value={elManualVoice()}
                      onInput={(e) => setElManualVoice(e.currentTarget.value)}
                      onKeyDown={(e) => { if (e.key === "Enter") saveManualElVoice(); }}
                    />
                    <button class="set-link-btn" onClick={saveManualElVoice}>Use voice</button>
                  </div>
                </div>
              </Row>
            </Show>
          </Show>
          <Show when={ttsEngineSel() === "system"}>
            <Row label="System voice" hint="Which OS voice Gemma speaks with. Auto picks a female English voice. On Windows, “Microsoft Zira” is female; install the OneCore “Natural” voices (e.g. Aria, Jenny) for higher quality.">
              <div style={{ display: "flex", gap: "8px", "align-items": "center" }}>
                <select class="shields-select" value={voiceSel()} onChange={(e) => pickVoiceName(e.currentTarget.value)}>
                  <option value="">Auto (female)</option>
                  <For each={sysVoices()}>{(v) => <option value={v.name}>{v.name} ({v.lang})</option>}</For>
                </select>
                <button class="set-link-btn" onClick={() => void testVoice()}>{testing() ? "■ Stop" : "🔊 Test"}</button>
              </div>
            </Row>
          </Show>
        </Section>
      </div>
    </div>
  );
};

export default SettingsPage;
