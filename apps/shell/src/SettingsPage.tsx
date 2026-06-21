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
  memoryPath,
  memoryRead,
  memoryWrite,
  elevenlabsHasKey,
  elevenlabsImportVoice,
  elevenlabsSetKey,
  elevenlabsVerifyKey,
  elevenlabsVerifyKeyValue,
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
  porcupineHasKey,
  porcupineSetKey,
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
import { heyGemmaEnabled, setHeyGemmaEnabled, setSttEngine, setWakeEngine, sttEngine, wakeEngine } from "./heygemma";
import { porcupinePpnPath, porcupinePvPath, setPorcupinePpnPath, setPorcupinePvPath } from "./porcupine";
import { micDeviceId, micDevices, noiseSuppress, setMicDeviceId, setNoiseSuppress } from "./mic";
import { elVoiceId, elVoiceName, loadVoices, preferredVoice, previewElevenLabs, setElVoiceId, setElVoiceName, setPreferredVoice, setTtsEngine, speak, stopSpeaking, ttsEngine, type TtsEngine } from "./speak";
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

type ElevenLabsVoiceRef = { voiceId: string; publicOwnerId?: string };

function parseElevenLabsVoiceRef(input: string): ElevenLabsVoiceRef {
  const raw = input.trim();
  if (!raw) return { voiceId: "" };
  const direct = raw.match(/^[A-Za-z0-9_-]{10,}$/)?.[0];
  if (direct) return { voiceId: direct };

  const fromAddPath = raw.match(/\/voices?\/add\/([A-Za-z0-9_-]{10,})\/([A-Za-z0-9_-]{10,})(?:[/?#]|$)/i);
  if (fromAddPath) return { publicOwnerId: fromAddPath[1]!, voiceId: fromAddPath[2]! };

  try {
    const u = new URL(raw);
    const voiceId =
      u.searchParams.get("voice_id") ||
      u.searchParams.get("voiceId") ||
      u.searchParams.get("voice");
    const publicOwnerId =
      u.searchParams.get("public_owner_id") ||
      u.searchParams.get("publicOwnerId") ||
      u.searchParams.get("public_user_id") ||
      u.searchParams.get("publicUserId") ||
      u.searchParams.get("owner_id") ||
      u.searchParams.get("ownerId");
    if (voiceId) return { voiceId, publicOwnerId: publicOwnerId || undefined };
  } catch { /* not a URL */ }

  const fromPath = raw.match(/\/voices?\/([A-Za-z0-9_-]{10,})(?:[/?#]|$)/i)?.[1];
  if (fromPath) return { voiceId: fromPath };

  const ids = raw.match(/[A-Za-z0-9_-]{16,}/g);
  if (!ids?.length) return { voiceId: raw };
  const publicOwnerId = ids.find((id) => id.length >= 32);
  const voiceId = [...ids].reverse().find((id) => id !== publicOwnerId) || ids.at(-1) || raw;
  return { voiceId, publicOwnerId };
}

const SettingsPage: Component<{ onNavigate: (url: string) => void }> = (props) => {
  // Gemma's voice (TTS engine) + "Hey Gemma" always-on listening.
  const [ttsEngineSel, setTtsEngineSel] = createSignal<TtsEngine>(ttsEngine());
  const pickTts = (e: TtsEngine) => { setTtsEngine(e); setTtsEngineSel(e); };
  const [sttSel, setSttSel] = createSignal(sttEngine());
  const pickStt = (e: string) => { setSttEngine(e); setSttSel(e); };
  // Translate every chat message to a command vs. only machine/file-type ones.
  const [shellAlways, setShellAlways] = createSignal(localStorage.getItem("flux.shellplan.always") === "1");
  const toggleShellAlways = () => {
    const v = !shellAlways();
    localStorage.setItem("flux.shellplan.always", v ? "1" : "0");
    setShellAlways(v);
  };
  // Gemma's long-term memory (Markdown file).
  const [memPath, setMemPath] = createSignal("");
  const [memCount, setMemCount] = createSignal(0);
  const [memFlash, setMemFlash] = createSignal("");
  const refreshMem = () => {
    void memoryPath().then(setMemPath).catch(() => {});
    void memoryRead().then((m) => setMemCount(m.split("\n").filter((l) => l.trim().startsWith("- ")).length)).catch(() => {});
  };
  const clearMem = async () => {
    try { await memoryWrite(""); setMemFlash("Cleared"); refreshMem(); }
    catch (e) { setMemFlash(String(e)); }
  };
  // Proactive reminders: the name Gemma greets you with + whether to speak them.
  const [userNameVal, setUserNameVal] = createSignal(localStorage.getItem("flux.user.name") || "");
  const [remSpoken, setRemSpoken] = createSignal(localStorage.getItem("flux.reminders.speak") !== "0");
  const toggleRemSpoken = () => { const v = !remSpoken(); localStorage.setItem("flux.reminders.speak", v ? "1" : "0"); setRemSpoken(v); };
  // Microphone device + noise suppression (common recognition culprits).
  const [micList, setMicList] = createSignal<{ id: string; label: string }[]>([]);
  const [micSel, setMicSel] = createSignal(micDeviceId());
  const [nsOn, setNsOn] = createSignal(noiseSuppress());
  const refreshMics = () => void micDevices().then(setMicList).catch(() => {});
  const pickMic = (id: string) => { setMicDeviceId(id); setMicSel(id); };
  const toggleNs = () => { const v = !nsOn(); setNoiseSuppress(v); setNsOn(v); };
  // Wake word (Porcupine).
  const [wakeSel, setWakeSel] = createSignal(wakeEngine());
  const pickWake = (e: string) => { setWakeEngine(e); setWakeSel(e); };
  const [pcKeyInput, setPcKeyInput] = createSignal("");
  const [pcKeySet, setPcKeySet] = createSignal(false);
  const [pcFlash, setPcFlash] = createSignal("");
  const [ppnPath, setPpnPath] = createSignal(porcupinePpnPath());
  const [pvPath, setPvPath] = createSignal(porcupinePvPath());
  const refreshPcKey = () => void porcupineHasKey().then(setPcKeySet).catch(() => {});
  const savePcKey = async () => {
    try { await porcupineSetKey(pcKeyInput().trim()); setPcKeyInput(""); refreshPcKey(); setPcFlash("Saved"); }
    catch (e) { setPcFlash(String(e)); }
  };
  const [sysVoices, setSysVoices] = createSignal<{ name: string; lang: string }[]>([]);
  const [voiceSel, setVoiceSel] = createSignal(preferredVoice());
  const [testing, setTesting] = createSignal(false);
  const refreshVoices = () => setSysVoices(loadVoices().map((v) => ({ name: v.name, lang: v.lang })));
  const pickVoiceName = (name: string) => { setPreferredVoice(name); setVoiceSel(name); };
  const testVoice = async () => {
    if (testing()) { stopSpeaking(); setTesting(false); return; }
    setTesting(true);
    try {
      if (ttsEngineSel() === "elevenlabs") {
        await previewElevenLabs("Hi, I'm Gemma");
        setElFlash("Voice tested");
      } else {
        await speak("Hi, I'm Gemma. This is how I'll sound when we talk.");
      }
    } catch (e) {
      setElFlash(String(e));
    }
    finally { setTesting(false); }
  };
  // ElevenLabs (cloud) voice.
  const [elKeyInput, setElKeyInput] = createSignal("");
  const [elKeySet, setElKeySet] = createSignal(false);
  const [elVoices, setElVoices] = createSignal<{ id: string; name: string }[]>([]);
  const [elVoiceSel, setElVoiceSel] = createSignal(elVoiceId());
  const [elVoiceNameSel, setElVoiceNameSel] = createSignal(elVoiceName());
  const [elManualVoice, setElManualVoice] = createSignal("");
  const [elFlash, setElFlash] = createSignal("");
  const [elSavingVoice, setElSavingVoice] = createSignal(false);
  const selectedElVoice = () => elVoices().find((v) => v.id === elVoiceSel());
  const selectedElVoiceLabel = () => selectedElVoice()?.name || elVoiceNameSel() || `Custom voice (${elVoiceSel()})`;
  const selectableElVoices = () => elVoices().filter((v) => v.id !== elVoiceSel());
  const refreshElKey = () => void elevenlabsHasKey().then(setElKeySet).catch(() => {});
  const loadElVoices = () => void elevenlabsVoices().then((v) => {
    setElVoices(v);
    const current = selectedElVoice();
    if (current) {
      setElVoiceName(current.name);
      setElVoiceNameSel(current.name);
    }
  }).catch(() => setElVoices([]));
  const saveElKey = async () => {
    try {
      const raw = elKeyInput().trim();
      if (!raw) {
        await elevenlabsSetKey("");
        setElKeyInput("");
        setElKeySet(false);
        setElVoices([]);
        setElFlash("Key removed");
        return;
      }
      await elevenlabsVerifyKeyValue(raw);
      await elevenlabsSetKey(raw);
      const msg = await elevenlabsVerifyKey();
      setElKeyInput("");
      setElKeySet(true);
      setElFlash(msg);
      loadElVoices();
    } catch (e) { setElFlash(String(e)); }
  };
  const pickElVoice = (id: string, name = "") => {
    const resolvedName = name || elVoices().find((v) => v.id === id)?.name || "";
    setElVoiceId(id);
    setElVoiceName(resolvedName);
    setElVoiceSel(id);
    setElVoiceNameSel(resolvedName);
  };
  const saveManualElVoice = async () => {
    const ref = parseElevenLabsVoiceRef(elManualVoice());
    if (!ref.voiceId) {
      setElFlash("Paste a voice link or ID");
      return;
    }
    setElSavingVoice(true);
    setElFlash("Adding voice…");
    try {
      const v = await elevenlabsImportVoice(ref.voiceId, ref.publicOwnerId || "", "Flux Gemma");
      pickElVoice(v.id || ref.voiceId, v.name || "Flux Gemma");
      setElManualVoice("");
      setElFlash("Voice ready");
      loadElVoices();
    } catch (e) {
      setElFlash(String(e));
    } finally {
      setElSavingVoice(false);
    }
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
    refreshPcKey();
    refreshMem();
    refreshMics();
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
          <Row label="Translate every message to a command" hint="Off (default): only chat messages that look like they're about your machine/files become terminal commands (proposed for approval) — keeps normal chat fast. On: Gemma tries to turn ANY message into a command, which adds a model round-trip to every message. Either way, “run <cmd>” always works and nothing executes without your approval.">
            <Toggle on={shellAlways()} onClick={toggleShellAlways} />
          </Row>
          <Row label="Gemma's memory" hint={`Long-term memory Gemma reads for context and adds to when you say “remember that …”. It's a Markdown file you can open/edit: ${memPath() || "(set FLUX_MEMORY_FILE to relocate)"}`}>
            <div style={{ display: "flex", gap: "8px", "align-items": "center" }}>
              <span class="set-row-hint" style={{ "white-space": "nowrap" }}>{memCount()} {memCount() === 1 ? "note" : "notes"}</span>
              <button class="set-link-btn" onClick={() => void clearMem()}>{memFlash() || "Clear"}</button>
            </div>
          </Row>
          <Row label="Your name" hint="What Gemma calls you in proactive reminders (“Hey <name>, just popping in …”). Leave blank for a generic greeting.">
            <input class="map-search-input" style={{ "max-width": "200px" }} placeholder="e.g. Razeen" value={userNameVal()} onChange={(e) => { const v = e.currentTarget.value.trim(); setUserNameVal(v); localStorage.setItem("flux.user.name", v); }} />
          </Row>
          <Row label="Speak reminders aloud" hint="When a reminder is due, Gemma shows it and (if on) says it out loud. Set reminders with “remind me to … in 10 minutes / at 3pm / tomorrow”.">
            <Toggle on={remSpoken()} onClick={toggleRemSpoken} />
          </Row>
          <Row label="Microphone" hint="Which input device voice uses. Pick your headset/best mic — the OS default (e.g. a webcam array mic) is a common cause of poor recognition. Device names appear after you've allowed mic access once.">
            <div style={{ display: "flex", gap: "8px", "align-items": "center" }}>
              <select class="shields-select" style={{ "max-width": "240px" }} value={micSel()} onChange={(e) => pickMic(e.currentTarget.value)}>
                <option value="">System default</option>
                <For each={micList()}>{(m) => <option value={m.id}>{m.label}</option>}</For>
              </select>
              <button class="set-link-btn" onClick={refreshMics}>↻</button>
            </div>
          </Row>
          <Row label="Noise suppression" hint="Browser noise suppression is tuned for human listening and often DEGRADES whisper/Vosk. Leave OFF (raw audio) for best recognition; turn on only if a noisy room is the problem. Auto-gain stays on either way.">
            <Toggle on={nsOn()} onClick={toggleNs} />
          </Row>
          <Row label="Recognition (STT)" hint="How your spoken command is transcribed. Vosk is instant. Whisper (whisper.cpp) is much more accurate but adds ~1–3s per command — set FLUX_WHISPER_MODEL to a ggml model (e.g. ggml-base.en.bin); falls back to Vosk if whisper isn't installed. Both are fully local.">
            <select class="shields-select" value={sttSel()} onChange={(e) => pickStt(e.currentTarget.value)}>
              <option value="vosk">Vosk (fast)</option>
              <option value="whisper">Whisper (accurate)</option>
            </select>
          </Row>
          <Row label="Wake word" hint="How “hey Gemma” is detected. Vosk grammar-spotting is instant, zero setup. Whisper is the most accurate but runs whisper.cpp on each utterance (needs FLUX_WHISPER_MODEL; more CPU). Porcupine is a dedicated model but its console needs a business email. All run locally.">
            <select class="shields-select" value={wakeSel()} onChange={(e) => { pickWake(e.currentTarget.value); if (e.currentTarget.value === "porcupine") refreshPcKey(); }}>
              <option value="vosk">Vosk (grammar spotting · fast)</option>
              <option value="whisper">Whisper (most accurate · slower)</option>
              <option value="porcupine">Porcupine (needs business email)</option>
            </select>
          </Row>
          <Show when={wakeSel() === "porcupine"}>
            <Row label="Picovoice access key" hint="Stored in your OS keyring. Free key from console.picovoice.ai. Leave blank and save to remove.">
              <div style={{ display: "flex", gap: "8px", "align-items": "center" }}>
                <input
                  class="map-search-input"
                  type="password"
                  style={{ "max-width": "260px" }}
                  placeholder={pcKeySet() ? "•••••••• (key set)" : "access key…"}
                  value={pcKeyInput()}
                  onInput={(e) => setPcKeyInput(e.currentTarget.value)}
                />
                <button class="set-link-btn" onClick={() => void savePcKey()}>{pcFlash() || "Save"}</button>
              </div>
            </Row>
            <Row label="Keyword file (.ppn)" hint="Path to your custom “Hey Gemma” .ppn (WebAssembly/Web platform), e.g. \\wsl.localhost\…\Hey-Gemma_en_wasm_v3_0_0.ppn or a Windows path.">
              <input class="map-search-input" style={{ "max-width": "340px" }} placeholder="…/Hey-Gemma_en_wasm.ppn" value={ppnPath()} onChange={(e) => { const v = e.currentTarget.value.trim(); setPpnPath(v); setPorcupinePpnPath(v); }} />
            </Row>
            <Row label="Model file (.pv)" hint="Path to porcupine_params.pv (download from the Picovoice GitHub: lib/common/porcupine_params.pv).">
              <input class="map-search-input" style={{ "max-width": "340px" }} placeholder="…/porcupine_params.pv" value={pvPath()} onChange={(e) => { const v = e.currentTarget.value.trim(); setPvPath(v); setPorcupinePvPath(v); }} />
            </Row>
          </Show>
          <Row label="Gemma's voice" hint="System and Piper are fully local. ElevenLabs is a cloud service — choosing it sends Gemma's reply text (not your mic audio) to ElevenLabs, needs an API key, and is metered. Piper: set FLUX_PIPER_MODEL to a .onnx voice; falls back to System if absent.">
            <select class="shields-select" value={ttsEngineSel()} onChange={(e) => { const v = e.currentTarget.value as TtsEngine; pickTts(v); if (v === "elevenlabs") { refreshElKey(); loadElVoices(); } }}>
              <option value="system">System voice (local)</option>
              <option value="piper">Piper (local neural)</option>
              <option value="elevenlabs">ElevenLabs (cloud)</option>
            </select>
          </Row>
          <Show when={ttsEngineSel() === "elevenlabs"}>
            <Row label="ElevenLabs API key" hint="Stored in your OS keyring, never in plaintext. Get a key at elevenlabs.io → Profile. Leave blank and save to remove it.">
              <div class="set-stack-control">
                <div style={{ display: "flex", gap: "8px", "align-items": "center" }}>
                  <input
                    class="map-search-input"
                    type="password"
                    style={{ "max-width": "260px" }}
                    placeholder={elKeySet() ? "•••••••• (key set)" : "xi-api-key…"}
                    value={elKeyInput()}
                    onInput={(e) => setElKeyInput(e.currentTarget.value)}
                  />
                  <button class="set-link-btn" onClick={() => void saveElKey()}>Save</button>
                </div>
                <Show when={elFlash()}>
                  <div class="set-status-line" title={elFlash()}>{elFlash()}</div>
                </Show>
              </div>
            </Row>
            <Show when={elKeySet()}>
              <Row label="ElevenLabs voice" hint="Pick an account voice, or paste a shared voice link/ID when it is not listed. Use Test to preview.">
                <div style={{ display: "grid", gap: "8px" }}>
                  <div style={{ display: "flex", gap: "8px", "align-items": "center" }}>
                    <select
                      class="shields-select"
                      value={elVoiceSel()}
                      onChange={(e) => {
                        const id = e.currentTarget.value;
                        pickElVoice(id, e.currentTarget.selectedOptions[0]?.textContent || "");
                      }}
                    >
                      <option value="">Select a voice…</option>
                      <Show when={elVoiceSel()}>
                        <option value={elVoiceSel()}>{selectedElVoiceLabel()}</option>
                      </Show>
                      <For each={selectableElVoices()}>{(v) => <option value={v.id}>{v.name}</option>}</For>
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
                      onKeyDown={(e) => { if (e.key === "Enter") void saveManualElVoice(); }}
                    />
                    <button class="set-link-btn" disabled={elSavingVoice()} onClick={() => void saveManualElVoice()}>
                      {elSavingVoice() ? "Adding…" : "Use voice"}
                    </button>
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
