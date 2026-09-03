/**
 * flux://settings — the real Settings page (BACKLOG #78). Consolidates the
 * toggles that were scattered across the footer ⚙ popover and the Shields popover
 * into one organized, full-width page: Appearance, Search, Privacy & security,
 * Navigation, Memory, and Data. All state lives in the store (persisted to
 * localStorage) or behind flux-core commands — this page is just a tidy front end
 * over what already existed, plus the privacy controls that had no home here.
 */
import { For, Show, createSignal, onMount, type Component, type JSX } from "solid-js";

import { visibleInterval } from "./poll";
import { THEMES, setTheme, theme } from "./themes";
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
  geminiSetKey,
  agentRootsGet,
  agentRootsSet,
  agentRootsSuggested,
  type AgentRoots,
  geminiHasKey,
  geminiVerifyKey,
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
  SENTINEL_URL,
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
  proxyGet,
  proxySet,
  type MemInfo,
  type SearchEngine,
  traceDraftsEnabled,
  traceDraftsSet,
  termPersist,
  TERM_PERSIST_KEY,
  storageUsage,
  storageClear,
  storageClearCancel,
  type StorageReport,
  type TermPersist,
} from "./ipc";
import {
  heyGemmaEnabled,
  setHeyGemmaEnabled,
  setSttEngine,
  setWakeEngine,
  sttEngine,
  wakeEngine,
} from "./heygemma";
import { porcupinePpnPath, porcupinePvPath, setPorcupinePpnPath, setPorcupinePvPath } from "./porcupine";
import { micDeviceId, micDevices, noiseSuppress, setMicDeviceId, setNoiseSuppress } from "./mic";
import {
  elVoiceId,
  elVoiceName,
  loadVoices,
  preferredVoice,
  previewElevenLabs,
  setElVoiceId,
  setElVoiceName,
  setPreferredVoice,
  setSpeechLength,
  setTtsEngine,
  speak,
  speechLength,
  stopSpeaking,
  ttsEngine,
  type SpeechLength,
  type TtsEngine,
} from "./speak";
import {
  aiAnswersOn,
  audiopulseDir,
  setAudiopulseDir,
  bookmarkBarOpen,
  editorColOpen,
  darkMode,
  autoArchiveDays,
  setAutoArchiveDays,
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
  setEditorColOpen,
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
  windowAcrylic,
  setWindowAcrylic,
  activeId,
  updateTabTitle,
} from "./store";

const TRACKING_LABELS = ["Off", "Basic", "Balanced", "Strict"];

const Section: Component<{ title: string; sub?: string; children: JSX.Element }> = (props) => (
  <section class="set-section">
    <div class="set-section-head">
      <h2>{props.title}</h2>
      <Show when={props.sub}>
        <span class="set-section-sub">{props.sub}</span>
      </Show>
    </div>
    <div class="set-card">{props.children}</div>
  </section>
);

const Row: Component<{ label: string; hint?: string; children: JSX.Element }> = (props) => (
  <div class="set-row">
    <div class="set-row-text">
      <span class="set-row-label">{props.label}</span>
      <Show when={props.hint}>
        <span class="set-row-hint">{props.hint}</span>
      </Show>
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
      u.searchParams.get("voice_id") || u.searchParams.get("voiceId") || u.searchParams.get("voice");
    const publicOwnerId =
      u.searchParams.get("public_owner_id") ||
      u.searchParams.get("publicOwnerId") ||
      u.searchParams.get("public_user_id") ||
      u.searchParams.get("publicUserId") ||
      u.searchParams.get("owner_id") ||
      u.searchParams.get("ownerId");
    if (voiceId) return { voiceId, publicOwnerId: publicOwnerId || undefined };
  } catch {
    /* not a URL */
  }

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
  const pickTts = (e: TtsEngine) => {
    setTtsEngine(e);
    setTtsEngineSel(e);
  };
  const [speechLenSel, setSpeechLenSel] = createSignal<SpeechLength>(speechLength());
  const pickSpeechLen = (v: SpeechLength) => {
    setSpeechLength(v);
    setSpeechLenSel(v);
  };
  const [personaVal, setPersonaVal] = createSignal(localStorage.getItem("flux.gemma.persona") ?? "");
  const [sttSel, setSttSel] = createSignal(sttEngine());
  const pickStt = (e: string) => {
    setSttEngine(e);
    setSttSel(e);
  };
  // Translate every chat message to a command vs. only machine/file-type ones.
  const [shellAlways, setShellAlways] = createSignal(localStorage.getItem("flux.shellplan.always") === "1");
  const toggleShellAlways = () => {
    const v = !shellAlways();
    localStorage.setItem("flux.shellplan.always", v ? "1" : "0");
    setShellAlways(v);
  };
  // Browsing data on disk. Measured on demand: walking a multi-gigabyte profile
  // isn't something to do on every Settings open.
  const [store, setStore] = createSignal<StorageReport | null>(null);
  const [storeBusy, setStoreBusy] = createSignal(false);
  const [storeMsg, setStoreMsg] = createSignal("");
  const [storePick, setStorePick] = createSignal<string[]>([]);
  const measure = () => {
    setStoreBusy(true);
    setStoreMsg("");
    void storageUsage()
      .then(setStore)
      .catch((e) => setStoreMsg(String(e)))
      .finally(() => setStoreBusy(false));
  };
  const togglePick = (k: string) =>
    setStorePick((cur) => (cur.includes(k) ? cur.filter((x) => x !== k) : [...cur, k]));
  const doClear = () => {
    const keys = storePick();
    if (!keys.length) return;
    void storageClear(keys)
      .then((m) => {
        setStoreMsg(m);
        setStorePick([]);
        measure();
      })
      .catch((e) => setStoreMsg(String(e)));
  };
  const cancelClear = () => {
    void storageClearCancel()
      .then(() => {
        setStoreMsg("Queued clear cancelled.");
        measure();
      })
      .catch((e) => setStoreMsg(String(e)));
  };
  const mb = (n: number) =>
    n >= 1024 * 1024 * 1024 ? `${(n / 1024 ** 3).toFixed(1)} GB` : `${Math.round(n / 1024 / 1024)} MB`;

  // Terminal persistence (BACKLOG #98). Applies to terminals opened from now on:
  // the mode is resolved when the PTY is spawned, so a change can't reach into a
  // shell that's already running.
  const [persist, setPersist] = createSignal<TermPersist>(termPersist());
  const pickPersist = (v: string) => {
    const mode = v as TermPersist;
    setPersist(mode);
    localStorage.setItem(TERM_PERSIST_KEY, mode);
  };

  // Gemma's long-term memory (Markdown file).
  const [memPath, setMemPath] = createSignal("");
  const [memCount, setMemCount] = createSignal(0);
  const [memFlash, setMemFlash] = createSignal("");
  const refreshMem = () => {
    void memoryPath()
      .then(setMemPath)
      .catch(() => {});
    void memoryRead()
      .then((m) => setMemCount(m.split("\n").filter((l) => l.trim().startsWith("- ")).length))
      .catch(() => {});
  };
  const clearMem = async () => {
    try {
      await memoryWrite("");
      setMemFlash("Cleared");
      refreshMem();
    } catch (e) {
      setMemFlash(String(e));
    }
  };
  // Proactive reminders: the name Gemma greets you with + whether to speak them.
  const [userNameVal, setUserNameVal] = createSignal(localStorage.getItem("flux.user.name") || "");
  const [remSpoken, setRemSpoken] = createSignal(localStorage.getItem("flux.reminders.speak") !== "0");
  const toggleRemSpoken = () => {
    const v = !remSpoken();
    localStorage.setItem("flux.reminders.speak", v ? "1" : "0");
    setRemSpoken(v);
  };
  // Microphone device + noise suppression (common recognition culprits).
  const [micList, setMicList] = createSignal<{ id: string; label: string }[]>([]);
  const [micSel, setMicSel] = createSignal(micDeviceId());
  const [nsOn, setNsOn] = createSignal(noiseSuppress());
  const refreshMics = () =>
    void micDevices()
      .then(setMicList)
      .catch(() => {});
  const pickMic = (id: string) => {
    setMicDeviceId(id);
    setMicSel(id);
  };
  const toggleNs = () => {
    const v = !nsOn();
    setNoiseSuppress(v);
    setNsOn(v);
  };
  // Wake word (Porcupine).
  const [wakeSel, setWakeSel] = createSignal(wakeEngine());
  const pickWake = (e: string) => {
    setWakeEngine(e);
    setWakeSel(e);
  };
  const [pcKeyInput, setPcKeyInput] = createSignal("");
  const [pcKeySet, setPcKeySet] = createSignal(false);
  const [pcFlash, setPcFlash] = createSignal("");
  const [ppnPath, setPpnPath] = createSignal(porcupinePpnPath());
  const [pvPath, setPvPath] = createSignal(porcupinePvPath());
  const refreshPcKey = () =>
    void porcupineHasKey()
      .then(setPcKeySet)
      .catch(() => {});
  const savePcKey = async () => {
    try {
      await porcupineSetKey(pcKeyInput().trim());
      setPcKeyInput("");
      refreshPcKey();
      setPcFlash("Saved");
    } catch (e) {
      setPcFlash(String(e));
    }
  };
  const [sysVoices, setSysVoices] = createSignal<{ name: string; lang: string }[]>([]);
  const [voiceSel, setVoiceSel] = createSignal(preferredVoice());
  const [testing, setTesting] = createSignal(false);
  const refreshVoices = () => setSysVoices(loadVoices().map((v) => ({ name: v.name, lang: v.lang })));
  const pickVoiceName = (name: string) => {
    setPreferredVoice(name);
    setVoiceSel(name);
  };
  const testVoice = async () => {
    if (testing()) {
      stopSpeaking();
      setTesting(false);
      return;
    }
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
    } finally {
      setTesting(false);
    }
  };
  // Agent file access (#176). Off = the historical behaviour (the agent can read
  // anything this process can). On, its list/read/edit tools are confined.
  const [roots, setRoots] = createSignal<AgentRoots>({ enabled: false, roots: [] });
  const [rootInput, setRootInput] = createSignal("");
  const refreshRoots = () =>
    void agentRootsGet()
      .then(setRoots)
      .catch(() => {});
  const saveRoots = (next: AgentRoots) => {
    setRoots(next);
    void agentRootsSet(next).catch(() => refreshRoots());
  };
  const toggleRoots = async () => {
    const on = !roots().enabled;
    // Turning it on with nothing allowed would block every read, which reads as
    // "the feature is broken". Pre-fill with the named places (not the drives —
    // naming a drive is a convenience, reading it is a decision).
    let list = roots().roots;
    if (on && list.length === 0) {
      list = await agentRootsSuggested().catch(() => [] as string[]);
    }
    saveRoots({ enabled: on, roots: list });
  };
  const addRoot = () => {
    const p = rootInput().trim();
    if (!p || roots().roots.includes(p)) return;
    saveRoots({ ...roots(), roots: [...roots().roots, p] });
    setRootInput("");
  };
  const removeRoot = (p: string) => saveRoots({ ...roots(), roots: roots().roots.filter((x) => x !== p) });

  // Gemini cloud escalation for the agent (#175). Storing a key does NOT route
  // anything: it only makes the per-session switch in the agent panel available.
  const [gemKeyInput, setGemKeyInput] = createSignal("");
  const [gemKeySet, setGemKeySet] = createSignal(false);
  const [gemFlash, setGemFlash] = createSignal("");
  const refreshGemKey = () =>
    void geminiHasKey()
      .then(setGemKeySet)
      .catch(() => {});
  const saveGemKey = async () => {
    try {
      const raw = gemKeyInput().trim();
      if (!raw) {
        await geminiSetKey("");
        setGemKeyInput("");
        setGemKeySet(false);
        setGemFlash("Key removed — the agent is local only");
        return;
      }
      await geminiSetKey(raw);
      // Verify *after* storing so the message reflects what was actually saved,
      // and a bad key is reported rather than sitting there until first use.
      const msg = await geminiVerifyKey();
      setGemKeyInput("");
      setGemKeySet(true);
      setGemFlash(msg);
    } catch (e) {
      setGemFlash(String(e));
      refreshGemKey();
      refreshRoots();
    }
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
  const selectedElVoiceLabel = () =>
    selectedElVoice()?.name || elVoiceNameSel() || `Custom voice (${elVoiceSel()})`;
  const selectableElVoices = () => elVoices().filter((v) => v.id !== elVoiceSel());
  const refreshElKey = () =>
    void elevenlabsHasKey()
      .then(setElKeySet)
      .catch(() => {});
  const loadElVoices = () =>
    void elevenlabsVoices()
      .then((v) => {
        setElVoices(v);
        const current = selectedElVoice();
        if (current) {
          setElVoiceName(current.name);
          setElVoiceNameSel(current.name);
        }
      })
      .catch(() => setElVoices([]));
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
    } catch (e) {
      setElFlash(String(e));
    }
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
  // Typed-draft capture (ADR 0011, opt-in) — backend-persisted with the store.
  const [draftsOn, setDraftsOn] = createSignal(false);
  const toggleDrafts = () => {
    const next = !draftsOn();
    setDraftsOn(next);
    void traceDraftsSet(next).catch(() => setDraftsOn(!next));
  };
  const [cookieFlash, setCookieFlash] = createSignal("");
  const [mem, setMem] = createSignal<MemInfo | null>(null);
  // Per-site privacy exceptions (#78): hosts the user opted out per feature.
  const [sitesOff, setSitesOff] = createSignal<string[]>([]); // shields disabled
  const [httpAllow, setHttpAllow] = createSignal<string[]>([]); // HTTPS-only exempt
  // Outbound proxy (#63).
  const [proxy, setProxy] = createSignal("");
  const [proxyMsg, setProxyMsg] = createSignal("");
  const [proxyErr, setProxyErr] = createSignal(false);
  const saveProxy = async () => {
    try {
      await proxySet(proxy().trim() || null);
      setProxyErr(false);
      setProxyMsg(proxy().trim() ? "Saved — reload tabs to apply" : "Direct (no proxy)");
    } catch (e) {
      setProxyErr(true);
      setProxyMsg(
        String(e)
          .replace(/.*invalid|.*Error:?\s*/i, "")
          .trim() || String(e),
      );
    }
  };
  const [leanOn, setLeanOn] = createSignal<string[]>([]); // lean mode on

  const loadShields = () =>
    void shieldsStatus()
      .then((s) => {
        setShieldsOn(s.enabled);
        setBlocked(s.blocked);
        setSitesOff(s.sites_off);
      })
      .catch(() => {});
  const loadHttps = () =>
    void httpsStatus()
      .then((s) => {
        setHttpsOn(s.enabled);
        setHttpAllow(s.sites_allow_http);
      })
      .catch(() => {});
  const loadLean = () =>
    void leanStatus()
      .then((s) => setLeanOn(s.sites_on))
      .catch(() => {});

  onMount(() => {
    const id = activeId();
    if (id != null) updateTabTitle(id, "Settings");
    void traceDraftsEnabled()
      .then(setDraftsOn)
      .catch(() => {});
    refreshVoices();
    try {
      window.speechSynthesis?.addEventListener?.("voiceschanged", refreshVoices);
    } catch {
      /* ignore */
    }
    refreshElKey();
    if (ttsEngine() === "elevenlabs") loadElVoices();
    refreshGemKey();
    refreshPcKey();
    refreshMem();
    refreshMics();
    void searchEngines()
      .then(setEngines)
      .catch(() => {});
    void searchDefault()
      .then(setDefaultEngine)
      .catch(() => {});
    loadShields();
    loadHttps();
    void proxyGet()
      .then((p) => setProxy(p ?? ""))
      .catch(() => {});
    loadLean();
    void trackingStatus()
      .then(setTracking)
      .catch(() => {});
    void permissionsStatus()
      .then(setBlockPerms)
      .catch(() => {});
    const pollMem = () =>
      void memStatus()
        .then(setMem)
        .catch(() => {});
    visibleInterval(pollMem, 3000);
  });

  const pickEngine = (id: string) => {
    setDefaultEngine(id);
    void searchSetDefault(id).catch(() => {});
  };
  const toggleShields = () => {
    const v = !shieldsOn();
    setShieldsOn(v);
    void shieldsSetEnabled(v).catch(() => {});
  };
  const toggleHttps = () => {
    const v = !httpsOn();
    setHttpsOn(v);
    void httpsSetEnabled(v).catch(() => {});
  };
  const setTrack = (lvl: number) => {
    setTracking(lvl);
    void trackingSetLevel(lvl).catch(() => {});
  };
  const toggleBlockPerms = () => {
    const v = !blockPerms();
    setBlockPerms(v);
    void permissionsSetBlock(v).catch(() => {});
  };
  const clearCookies = () => {
    void cookiesClearAll()
      .then(() => {
        setCookieFlash("✓ cleared");
        window.setTimeout(() => setCookieFlash(""), 2000);
      })
      .catch(() => {});
  };
  // Clear an exception → re-enable the default for that host.
  const reenableShields = (host: string) =>
    void shieldsSetSite(host, true)
      .then(loadShields)
      .catch(() => {});
  const disallowHttp = (host: string) =>
    void httpsAllowSite(host, false)
      .then(loadHttps)
      .catch(() => {});
  const leanOff = (host: string) =>
    void leanSetSite(host, false)
      .then(loadLean)
      .catch(() => {});

  const hasExceptions = () => sitesOff().length + httpAllow().length + leanOn().length > 0;

  return (
    <div class="hist-page set-page">
      <header class="hist-head">
        <div class="hist-title">⚙ Settings</div>
      </header>
      <div class="set-body">
        <Section title="Appearance">
          {/* Swatches rather than a dropdown: a colour theme is the one setting
              you can't evaluate from its name. */}
          <Row label="Theme" hint="Colours the whole of Flux. Applies immediately.">
            <div class="theme-picker">
              <For each={THEMES}>
                {(t) => (
                  <button
                    classList={{ "theme-chip": true, on: theme() === t.id }}
                    title={t.blurb}
                    onClick={() => setTheme(t.id)}
                  >
                    <span class="theme-swatch">
                      <For each={t.swatch}>{(c) => <i style={{ background: c }} />}</For>
                    </span>
                    <span class="theme-name">{t.name}</span>
                  </button>
                )}
              </For>
            </div>
          </Row>
          <Row label="Dark mode (websites)" hint="Ask sites to render dark (prefers-color-scheme).">
            <Toggle on={darkMode()} onClick={() => setDarkMode(!darkMode())} />
          </Row>
          <Row label="Bookmark bar" hint="A chip row docked under the page for one-click bookmarks.">
            <Toggle on={bookmarkBarOpen()} onClick={() => setBookmarkBarOpen(!bookmarkBarOpen())} />
          </Row>
          <Row
            label="Editor column (nvim)"
            hint="A persistent editor column (nvim) pinned beside the main page (Ctrl+Shift+E)."
          >
            <Toggle on={editorColOpen()} onClick={() => setEditorColOpen(!editorColOpen())} />
          </Row>
          <Row
            label="Pages bar"
            hint="A strip above the page with quick links to Flux's native pages (open in a new tab)."
          >
            <Toggle on={pagesBarOpen()} onClick={() => setPagesBarOpen(!pagesBarOpen())} />
          </Row>
          <Row
            label="Liquid home background"
            hint="A GPU particle-liquid backdrop on the start page (only animates while the start tab is visible). Off = the lightweight wave."
          >
            <Toggle on={liquidBg()} onClick={() => setLiquidBg(!liquidBg())} />
          </Row>
          <Row
            label="Acrylic / Frosted window"
            hint="Make the window frame translucent and frosted (acrylic). The main page stays opaque."
          >
            <Toggle on={windowAcrylic()} onClick={() => setWindowAcrylic(!windowAcrylic())} />
          </Row>
        </Section>

        <Section title="Search">
          <Row label="Default engine" hint="Used for omnibox searches.">
            <select
              class="shields-select"
              value={defaultEngine()}
              onChange={(e) => pickEngine(e.currentTarget.value)}
            >
              <For each={engines()}>{(en) => <option value={en.id}>{en.name}</option>}</For>
              <Show when={engines().length === 0}>
                <option value="">(loads in the app)</option>
              </Show>
            </select>
          </Row>
          <Row
            label="Search suggestions"
            hint="Send keystrokes to the engine for live suggestions. History stays local either way."
          >
            <Toggle on={searchSuggestOn()} onClick={() => setSearchSuggestOn(!searchSuggestOn())} />
          </Row>
          <Row
            label="AI answers for searches"
            hint="The local Gemma drafts a quick answer in the agent panel. On-device."
          >
            <Toggle on={aiAnswersOn()} onClick={() => setAiAnswersOn(!aiAnswersOn())} />
          </Row>
          <Row
            label="Omni answer on search"
            hint="Stream a grounded answer card from your Omni index each search. Runs the local LLM."
          >
            <Toggle on={omniAutoAnswer()} onClick={() => setOmniAutoAnswer(!omniAutoAnswer())} />
          </Row>
        </Section>

        <Section title="Browsing data">
          <Row
            label="Stored on disk"
            hint={
              store()
                ? `Measured at ${store()!.root}. Clearing happens on the next launch — the engine keeps these files open while it's running, so they can't be deleted from under it.`
                : "Cache, service workers, site storage and cookies the engine keeps. Nothing evicts these on a schedule, so a service-worker cache can quietly reach hundreds of megabytes."
            }
          >
            <button class="set-link-btn" disabled={storeBusy()} onClick={measure}>
              {storeBusy() ? "Measuring…" : store() ? "Re-measure" : "Measure"}
            </button>
          </Row>
          <Show when={store()}>
            <div class="store-list">
              <Show when={store()!.warn}>
                <p class="store-warn">
                  ⚠ {mb(store()!.total_bytes)} stored, and at least one group is far larger than it should be.
                  Nothing is known to break at this size — it's simply more than a browsing profile should be
                  holding, and worth clearing.
                </p>
              </Show>
              <Show when={store()!.pending.length > 0}>
                <p class="store-pending">
                  Queued for deletion on next launch: {store()!.pending.join(", ")}.{" "}
                  <button class="store-link" onClick={cancelClear}>
                    Cancel
                  </button>
                </p>
              </Show>
              <For each={store()!.entries}>
                {(e) => (
                  <label classList={{ "store-row": true, warn: e.warn }} title={e.hint}>
                    <input
                      type="checkbox"
                      checked={storePick().includes(e.key)}
                      onChange={() => togglePick(e.key)}
                    />
                    <span class="store-label">{e.label}</span>
                    <span class="store-size">{mb(e.bytes)}</span>
                    <Show when={e.warn}>
                      <span class="store-flag">⚠</span>
                    </Show>
                  </label>
                )}
              </For>
              <div class="store-actions">
                <button class="set-link-btn" disabled={storePick().length === 0} onClick={doClear}>
                  Clear selected on next launch
                </button>
                <Show when={storeMsg()}>
                  <span class="store-msg">{storeMsg()}</span>
                </Show>
              </div>
            </div>
          </Show>
        </Section>

        <Section title="Terminal">
          <Row
            label="Keep sessions across restarts"
            hint="Off by default. “Running processes” hands the shell to dtach (or tmux) so it survives closing Flux — but on reattach a shell redraws only its prompt, not its earlier output. “Scrollback” records output to disk and replays it, which needs nothing installed and survives a crash or reboot, but the processes are gone. “Both” is the pair. Note that scrollback writes terminal output — including anything printed by a command — to a capped file under Flux's data directory. Applies to terminals opened from now on."
          >
            <select
              class="shields-select"
              value={persist()}
              onChange={(e) => pickPersist(e.currentTarget.value)}
            >
              <option value="off">Off</option>
              <option value="both">Both (recommended)</option>
              <option value="live">Running processes only</option>
              <option value="transcript">Scrollback only</option>
            </select>
          </Row>
        </Section>

        <Section title="Privacy & security">
          <Row
            label="Shields (content blocker)"
            hint={`Block ads + trackers at the request level. ${blocked().toLocaleString()} blocked this session.`}
          >
            <Toggle on={shieldsOn()} onClick={toggleShields} />
          </Row>
          <Row label="HTTPS-only" hint="Upgrade http:// to https://; per-site exceptions are remembered.">
            <Toggle on={httpsOn()} onClick={toggleHttps} />
          </Row>
          <Row
            label="Proxy (HTTP / SOCKS5)"
            hint="Route page traffic through a proxy you supply — bring-your-own, e.g. socks5://127.0.0.1:1080 for an SSH -D tunnel / Cloudflare WARP / Tor, or http://host:port. Applies to new and reloaded tabs; empty = direct."
          >
            <div class="set-proxy">
              <input
                class="set-proxy-in"
                placeholder="socks5://127.0.0.1:1080"
                value={proxy()}
                spellcheck={false}
                onInput={(e) => {
                  setProxy(e.currentTarget.value);
                  setProxyMsg("");
                }}
                onBlur={() => void saveProxy()}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void saveProxy();
                }}
              />
              <Show when={proxyMsg()}>
                <span classList={{ "set-proxy-msg": true, err: proxyErr() }}>{proxyMsg()}</span>
              </Show>
            </div>
          </Row>
          <Row label="Tracking prevention" hint="How aggressively to block known tracking scripts.">
            <select
              class="shields-select"
              value={String(tracking())}
              onChange={(e) => setTrack(Number(e.currentTarget.value))}
            >
              <For each={TRACKING_LABELS}>{(lbl, i) => <option value={String(i())}>{lbl}</option>}</For>
            </select>
          </Row>
          <Row
            label="Capture typed drafts (Trail)"
            hint="Off by default. Save what you were typing (comments, issues, long forms) with the page's Trail visit, so a closed tab can't eat a draft. Structurally redacted — password/card/OTP fields and login forms are never read, card numbers can't be stored — and the store is encrypted at rest. Applies to newly-loaded pages."
          >
            <Toggle on={draftsOn()} onClick={toggleDrafts} />
          </Row>
          <Row label="Block camera / mic / location" hint="Auto-deny these permission prompts globally.">
            <Toggle on={blockPerms()} onClick={toggleBlockPerms} />
          </Row>
          <Row
            label="Per-site permissions"
            hint="Manage camera/mic/location/notifications/clipboard per site."
          >
            <button class="set-link-btn" onClick={() => props.onNavigate(PERMISSIONS_URL)}>
              Manage…
            </button>
          </Row>
          <Row
            label="Agent activity"
            hint="What the Flux agent has done on your behalf — sealed on this device."
          >
            <button class="set-link-btn" onClick={() => props.onNavigate(SENTINEL_URL)}>
              View log…
            </button>
          </Row>
          <Row label="Cookies" hint="Clear every cookie in the store.">
            <button class="set-link-btn" onClick={clearCookies}>
              {cookieFlash() || "Clear all"}
            </button>
          </Row>
          <Show when={hasExceptions()}>
            <div class="set-exceptions">
              <div class="set-exc-head">Per-site exceptions</div>
              <For each={sitesOff()}>
                {(host) => (
                  <div class="set-exc-row">
                    <span class="set-exc-tag">shields off</span>
                    <span class="set-exc-host">{host}</span>
                    <button
                      class="set-exc-x"
                      title="Re-enable shields here"
                      onClick={() => reenableShields(host)}
                    >
                      ✕
                    </button>
                  </div>
                )}
              </For>
              <For each={httpAllow()}>
                {(host) => (
                  <div class="set-exc-row">
                    <span class="set-exc-tag">HTTP allowed</span>
                    <span class="set-exc-host">{host}</span>
                    <button
                      class="set-exc-x"
                      title="Require HTTPS here again"
                      onClick={() => disallowHttp(host)}
                    >
                      ✕
                    </button>
                  </div>
                )}
              </For>
              <For each={leanOn()}>
                {(host) => (
                  <div class="set-exc-row">
                    <span class="set-exc-tag">lean mode</span>
                    <span class="set-exc-host">{host}</span>
                    <button class="set-exc-x" title="Turn lean mode off here" onClick={() => leanOff(host)}>
                      ✕
                    </button>
                  </div>
                )}
              </For>
            </div>
          </Show>
        </Section>

        <Section title="Navigation">
          <Row
            label="Vim link hints (f)"
            hint="Press f to label links, type the label to click. Also j/k, gg/G."
          >
            <Toggle on={vimHints()} onClick={() => setVimHints(!vimHints())} />
          </Row>
          <Row label="Mouse gestures" hint="Hold right-drag: left=back, right=forward, down=reload, up=top.">
            <Toggle on={mouseGestures()} onClick={() => setMouseGestures(!mouseGestures())} />
          </Row>
        </Section>

        <Section title="Memory">
          <Row
            label="Sleep inactive tabs"
            hint="Unload a background tab's memory; it reloads when you return."
          >
            <Toggle on={hibernateEnabled()} onClick={() => setHibernateEnabled(!hibernateEnabled())} />
          </Row>
          <Show when={hibernateEnabled()}>
            <Row label="Sleep after" hint="Idle time before a background tab is unloaded.">
              <select
                class="shields-select"
                value={String(hibernateMins())}
                onChange={(e) => setHibernateMins(Number(e.currentTarget.value))}
              >
                <option value="5">5 min</option>
                <option value="15">15 min</option>
                <option value="30">30 min</option>
                <option value="60">1 hour</option>
              </select>
            </Row>
          </Show>
          <Row
            label="Sleep under memory pressure"
            hint="When free RAM runs low, sleep the least-recently-used tabs early."
          >
            <Toggle on={memEvict()} onClick={() => setMemEvict(!memEvict())} />
          </Row>
          <Row
            label="Auto-archive stale tabs"
            hint="Close tabs left untouched this long into the Archived Tabs list (🗄), where you can reopen them. Pinned tabs are never archived."
          >
            <select
              class="shields-select"
              value={String(autoArchiveDays())}
              onChange={(e) => setAutoArchiveDays(Number(e.currentTarget.value))}
            >
              <option value="0">Off</option>
              <option value="1">1 day</option>
              <option value="3">3 days</option>
              <option value="7">7 days</option>
              <option value="14">14 days</option>
              <option value="30">30 days</option>
            </select>
          </Row>
          <Show when={mem()}>
            <div class="set-mem-stat">
              Flux {mem()!.process_mb} MB · {(mem()!.available_mb / 1024).toFixed(1)} GB free (
              {mem()!.available_pct}%)
              <button class="set-link-btn" onClick={() => props.onNavigate(RESOURCES_URL)}>
                Resource monitor
              </button>
              <button class="set-link-btn" onClick={() => props.onNavigate(TASKS_URL)}>
                Task manager
              </button>
            </div>
          </Show>
        </Section>

        <Section title="Data">
          <div class="set-link-row">
            <button class="set-link-btn" onClick={() => props.onNavigate(SYNC_URL)}>
              🔄 Sync
            </button>
            <button class="set-link-btn" onClick={() => props.onNavigate(SESSIONS_URL)}>
              🗃 Sessions
            </button>
            <button class="set-link-btn" onClick={() => props.onNavigate(HISTORY_URL)}>
              🕘 History
            </button>
            <button class="set-link-btn" onClick={() => props.onNavigate(BOOKMARKS_URL)}>
              🔖 Bookmarks
            </button>
            <button class="set-link-btn" onClick={() => props.onNavigate(ARCHIVE_URL)}>
              📚 Archive
            </button>
          </div>
        </Section>

        <Section title="Integrations">
          <Row
            label="AudioPulse config folder"
            hint="Where AudioPulse keeps token.json — needed to ask Gemma to play/skip music. On a Windows build it's in WSL: e.g. \\wsl.localhost\Ubuntu-24.04\home\you\.config\audiopulse. Leave blank to auto-detect."
          >
            <input
              class="map-search-input"
              style={{ "max-width": "340px" }}
              placeholder="\\wsl.localhost\<distro>\home\<you>\.config\audiopulse"
              value={audiopulseDir()}
              onChange={(e) => setAudiopulseDir(e.currentTarget.value.trim())}
            />
          </Row>
          <Row
            label="Agent file access"
            hint="Off (default): Gemma's list/read/edit tools can open anything this app can — your whole disk, including mounted Windows drives. On: they're confined to the folders below, and everything else is refused with a message saying so. Your own Files tab and PDF viewer are unaffected; this is about what the agent may reach on its own. Worth turning on if you use cloud escalation, since a file the agent reads while escalated is a file Google receives."
          >
            <Toggle on={roots().enabled} onClick={() => void toggleRoots()} />
          </Row>
          <Show when={roots().enabled}>
            <Row
              label="Folders the agent may read"
              hint="Applies to subfolders too. Paths that resolve outside these (including via .. or a symlink) are refused. On a WSL build, a Windows drive is /mnt/c/…"
            >
              <div class="set-stack-control">
                <div style={{ display: "flex", gap: "8px", "align-items": "center" }}>
                  <input
                    class="map-search-input"
                    style={{ "max-width": "340px" }}
                    placeholder="/home/you/Courses  or  /mnt/c/Users/you/Documents"
                    value={rootInput()}
                    onInput={(e) => setRootInput(e.currentTarget.value)}
                    onKeyDown={(e) => e.key === "Enter" && addRoot()}
                  />
                  <button class="set-link-btn" onClick={addRoot}>
                    Add
                  </button>
                </div>
                <Show
                  when={roots().roots.length > 0}
                  fallback={
                    <div class="set-status-line">
                      No folders allowed yet — the agent can't read anything until you add one.
                    </div>
                  }
                >
                  <For each={roots().roots}>
                    {(p) => (
                      <div style={{ display: "flex", gap: "8px", "align-items": "center" }}>
                        <span class="set-row-hint" style={{ "word-break": "break-all" }}>
                          {p}
                        </span>
                        <button class="set-link-btn" onClick={() => removeRoot(p)}>
                          Remove
                        </button>
                      </div>
                    )}
                  </For>
                </Show>
              </div>
            </Row>
          </Show>
          <Row
            label="Gemini API key (cloud escalation)"
            hint="Optional. Lets you escalate a single session to Gemini from the agent panel's model menu, for jobs a local model can't do — a folder of lecture PDFs, prompts past the local context window. Storing a key routes nothing on its own, and escalation resets to local every time Flux restarts. While it's on, the agent's prompts — page text, PDFs, vault notes, terminal output — are sent to Google. Note a Gemini app subscription is NOT an API key: get one from Google AI Studio (aistudio.google.com), and check whether your tier is excluded from training. Stored in your OS keyring. Leave blank and save to remove."
          >
            <div class="set-stack-control">
              <div style={{ display: "flex", gap: "8px", "align-items": "center" }}>
                <input
                  class="map-search-input"
                  type="password"
                  style={{ "max-width": "260px" }}
                  placeholder={gemKeySet() ? "•••••••• (key set)" : "AIza…"}
                  value={gemKeyInput()}
                  onInput={(e) => setGemKeyInput(e.currentTarget.value)}
                />
                <button class="set-link-btn" onClick={() => void saveGemKey()}>
                  Save
                </button>
              </div>
              <Show when={gemFlash()}>
                <div class="set-status-line" title={gemFlash()}>
                  {gemFlash()}
                </div>
              </Show>
            </div>
          </Row>
          <Row
            label="Hey Gemma (always-on voice)"
            hint="Listen for “hey Gemma”, then converse by voice. Everything is local — speech-to-text (Vosk), the reply (Ollama), and the spoken voice never leave your device; audio before the wake word is discarded, never stored. Toggle it from the mic button in the agent panel. Default off."
          >
            <Toggle on={heyGemmaEnabled()} onClick={() => void setHeyGemmaEnabled(!heyGemmaEnabled())} />
          </Row>
          <Row
            label="Translate every message to a command"
            hint="Off (default): only chat messages that look like they're about your machine/files become terminal commands (proposed for approval) — keeps normal chat fast. On: Gemma tries to turn ANY message into a command, which adds a model round-trip to every message. Either way, “run <cmd>” always works and nothing executes without your approval."
          >
            <Toggle on={shellAlways()} onClick={toggleShellAlways} />
          </Row>
          <Row
            label="Gemma's memory"
            hint={`Long-term memory Gemma reads for context and adds to when you say “remember that …”. It's a Markdown file you can open/edit: ${memPath() || "(set FLUX_MEMORY_FILE to relocate)"}`}
          >
            <div style={{ display: "flex", gap: "8px", "align-items": "center" }}>
              <span class="set-row-hint" style={{ "white-space": "nowrap" }}>
                {memCount()} {memCount() === 1 ? "note" : "notes"}
              </span>
              <button class="set-link-btn" onClick={() => void clearMem()}>
                {memFlash() || "Clear"}
              </button>
            </div>
          </Row>
          <Row
            label="Your name"
            hint="What Gemma calls you in proactive reminders (“Hey <name>, just popping in …”). Leave blank for a generic greeting."
          >
            <input
              class="map-search-input"
              style={{ "max-width": "200px" }}
              placeholder="e.g. Razeen"
              value={userNameVal()}
              onChange={(e) => {
                const v = e.currentTarget.value.trim();
                setUserNameVal(v);
                localStorage.setItem("flux.user.name", v);
              }}
            />
          </Row>
          <Row
            label="Speak reminders aloud"
            hint="When a reminder is due, Gemma shows it and (if on) says it out loud. Set reminders with “remind me to … in 10 minutes / at 3pm / tomorrow”."
          >
            <Toggle on={remSpoken()} onClick={toggleRemSpoken} />
          </Row>
          <Row
            label="Microphone"
            hint="Which input device voice uses. Pick your headset/best mic — the OS default (e.g. a webcam array mic) is a common cause of poor recognition. Device names appear after you've allowed mic access once."
          >
            <div style={{ display: "flex", gap: "8px", "align-items": "center" }}>
              <select
                class="shields-select"
                style={{ "max-width": "240px" }}
                value={micSel()}
                onChange={(e) => pickMic(e.currentTarget.value)}
              >
                <option value="">System default</option>
                <Show when={micSel() && !micList().some((m) => m.id === micSel())}>
                  <option value={micSel()}>Saved microphone</option>
                </Show>
                <For each={micList()}>{(m) => <option value={m.id}>{m.label}</option>}</For>
              </select>
              <button class="set-link-btn" onClick={refreshMics}>
                ↻
              </button>
            </div>
          </Row>
          <Row
            label="Noise suppression"
            hint="Browser noise suppression is tuned for human listening and often DEGRADES whisper/Vosk. Leave OFF (raw audio) for best recognition; turn on only if a noisy room is the problem. Auto-gain stays on either way."
          >
            <Toggle on={nsOn()} onClick={toggleNs} />
          </Row>
          <Row
            label="Recognition (STT)"
            hint="How your spoken command is transcribed. Vosk is instant. Whisper (whisper.cpp) is much more accurate but adds ~1–3s per command — set FLUX_WHISPER_MODEL to a ggml model (e.g. ggml-base.en.bin); falls back to Vosk if whisper isn't installed. Both are fully local."
          >
            <select class="shields-select" value={sttSel()} onChange={(e) => pickStt(e.currentTarget.value)}>
              <option value="vosk">Vosk (fast)</option>
              <option value="whisper">Whisper (accurate)</option>
            </select>
          </Row>
          <Row
            label="Wake word"
            hint="How “hey Gemma” is detected. Vosk grammar-spotting is instant, zero setup. Whisper is the most accurate but runs whisper.cpp on each utterance (needs FLUX_WHISPER_MODEL; more CPU). Porcupine is a dedicated model but its console needs a business email. All run locally."
          >
            <select
              class="shields-select"
              value={wakeSel()}
              onChange={(e) => {
                pickWake(e.currentTarget.value);
                if (e.currentTarget.value === "porcupine") refreshPcKey();
              }}
            >
              <option value="vosk">Vosk (grammar spotting · fast)</option>
              <option value="whisper">Whisper (most accurate · slower)</option>
              <option value="porcupine">Porcupine (needs business email)</option>
            </select>
          </Row>
          <Show when={wakeSel() === "porcupine"}>
            <Row
              label="Picovoice access key"
              hint="Stored in your OS keyring. Free key from console.picovoice.ai. Leave blank and save to remove."
            >
              <div style={{ display: "flex", gap: "8px", "align-items": "center" }}>
                <input
                  class="map-search-input"
                  type="password"
                  style={{ "max-width": "260px" }}
                  placeholder={pcKeySet() ? "•••••••• (key set)" : "access key…"}
                  value={pcKeyInput()}
                  onInput={(e) => setPcKeyInput(e.currentTarget.value)}
                />
                <button class="set-link-btn" onClick={() => void savePcKey()}>
                  {pcFlash() || "Save"}
                </button>
              </div>
            </Row>
            <Row
              label="Keyword file (.ppn)"
              hint="Path to your custom “Hey Gemma” .ppn (WebAssembly/Web platform), e.g. \\wsl.localhost\…\Hey-Gemma_en_wasm_v3_0_0.ppn or a Windows path."
            >
              <input
                class="map-search-input"
                style={{ "max-width": "340px" }}
                placeholder="…/Hey-Gemma_en_wasm.ppn"
                value={ppnPath()}
                onChange={(e) => {
                  const v = e.currentTarget.value.trim();
                  setPpnPath(v);
                  setPorcupinePpnPath(v);
                }}
              />
            </Row>
            <Row
              label="Model file (.pv)"
              hint="Path to porcupine_params.pv (download from the Picovoice GitHub: lib/common/porcupine_params.pv)."
            >
              <input
                class="map-search-input"
                style={{ "max-width": "340px" }}
                placeholder="…/porcupine_params.pv"
                value={pvPath()}
                onChange={(e) => {
                  const v = e.currentTarget.value.trim();
                  setPvPath(v);
                  setPorcupinePvPath(v);
                }}
              />
            </Row>
          </Show>
          <Row
            label="Gemma's voice"
            hint="System and Piper are fully local. ElevenLabs is a cloud service — choosing it sends Gemma's reply text (not your mic audio) to ElevenLabs, needs an API key, and is metered. Piper: set FLUX_PIPER_MODEL to a .onnx voice; falls back to System if absent."
          >
            <select
              class="shields-select"
              value={ttsEngineSel()}
              onChange={(e) => {
                const v = e.currentTarget.value as TtsEngine;
                pickTts(v);
                if (v === "elevenlabs") {
                  refreshElKey();
                  loadElVoices();
                }
              }}
            >
              <option value="system">System voice (local)</option>
              <option value="piper">Piper (local neural)</option>
              <option value="elevenlabs">ElevenLabs (cloud)</option>
            </select>
          </Row>
          <Row
            label="Spoken reply length"
            hint="How much of a reply Gemma says aloud (the full text always shows in the panel). You can cut her off any time — talk over her or tap ■ Stop."
          >
            <select
              class="shields-select"
              value={speechLenSel()}
              onChange={(e) => pickSpeechLen(e.currentTarget.value as SpeechLength)}
            >
              <option value="brief">Brief (~2 sentences)</option>
              <option value="medium">Medium (~7 sentences)</option>
              <option value="full">Full (everything)</option>
            </select>
          </Row>
          <Row
            label="Gemma's personality"
            hint="Prepended to every reply to set her tone. Leave blank for the default (upbeat, warm, energetic, a little playful). Edit for your own vibe — e.g. “dry and terse” or “formal and precise”."
          >
            <textarea
              class="map-search-input"
              style={{
                "max-width": "340px",
                "min-height": "56px",
                "font-family": "inherit",
                resize: "vertical",
              }}
              placeholder="Default: upbeat, warm, energetic, a little playful 🙂"
              value={personaVal()}
              onChange={(e) => {
                const v = e.currentTarget.value;
                setPersonaVal(v);
                if (v.trim()) localStorage.setItem("flux.gemma.persona", v.trim());
                else localStorage.removeItem("flux.gemma.persona");
              }}
            />
          </Row>
          <Show when={ttsEngineSel() === "elevenlabs"}>
            <Row
              label="ElevenLabs API key"
              hint="Stored in your OS keyring, never in plaintext. Get a key at elevenlabs.io → Profile. Leave blank and save to remove it."
            >
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
                  <button class="set-link-btn" onClick={() => void saveElKey()}>
                    Save
                  </button>
                </div>
                <Show when={elFlash()}>
                  <div class="set-status-line" title={elFlash()}>
                    {elFlash()}
                  </div>
                </Show>
              </div>
            </Row>
            <Show when={elKeySet()}>
              <Row
                label="ElevenLabs voice"
                hint="Pick an account voice, or paste a shared voice link/ID when it is not listed. Use Test to preview."
              >
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
                    <button class="set-link-btn" onClick={loadElVoices}>
                      ↻
                    </button>
                    <button class="set-link-btn" onClick={() => void testVoice()}>
                      {testing() ? "■ Stop" : "🔊 Test"}
                    </button>
                  </div>
                  <div style={{ display: "flex", gap: "8px", "align-items": "center" }}>
                    <input
                      class="map-search-input"
                      style={{ "max-width": "360px" }}
                      placeholder="Paste ElevenLabs voice link or voice ID"
                      value={elManualVoice()}
                      onInput={(e) => setElManualVoice(e.currentTarget.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") void saveManualElVoice();
                      }}
                    />
                    <button
                      class="set-link-btn"
                      disabled={elSavingVoice()}
                      onClick={() => void saveManualElVoice()}
                    >
                      {elSavingVoice() ? "Adding…" : "Use voice"}
                    </button>
                  </div>
                </div>
              </Row>
            </Show>
          </Show>
          <Show when={ttsEngineSel() === "system"}>
            <Row
              label="System voice"
              hint="Which OS voice Gemma speaks with. Auto picks a female English voice. On Windows, “Microsoft Zira” is female; install the OneCore “Natural” voices (e.g. Aria, Jenny) for higher quality."
            >
              <div style={{ display: "flex", gap: "8px", "align-items": "center" }}>
                <select
                  class="shields-select"
                  value={voiceSel()}
                  onChange={(e) => pickVoiceName(e.currentTarget.value)}
                >
                  <option value="">Auto (female)</option>
                  <For each={sysVoices()}>
                    {(v) => (
                      <option value={v.name}>
                        {v.name} ({v.lang})
                      </option>
                    )}
                  </For>
                </select>
                <button class="set-link-btn" onClick={() => void testVoice()}>
                  {testing() ? "■ Stop" : "🔊 Test"}
                </button>
              </div>
            </Row>
          </Show>
        </Section>
      </div>
    </div>
  );
};

export default SettingsPage;
