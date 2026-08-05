/**
 * Flux Agent sidebar — chat, single page actions (/act), and multi-step tasks
 * (/task, the iterative agent loop #A). Split out of App.tsx and lazy-loaded so
 * its weight stays off the eager chrome bundle (ADR 0001's 50 KB gzip budget);
 * it only loads when the agent panel is first opened.
 */
import {
  For,
  Show,
  createEffect,
  createSignal,
  onCleanup,
  onMount,
  untrack,
  type Component,
  type JSX,
} from "solid-js";
import { Portal } from "solid-js/web";
import {
  agentChat,
  agentChatStream,
  traceTabThread,
  traceChatSend,
  type TabThread,
  agentChatTabsStream,
  kbAnswer,
  OWN_SOURCES,
  kbCheck,
  type KbHit,
  fsOpen,
  agentShellPlan,
  agentPacPlan,
  pacStatus,
  runShell,
  shellGuard,
  readTextFile,
  fsList,
  ocrAvailable,
  agentPlaces,
  agentUnload,
  type Place,
  writeTextFile,
  agentEditPlan,
  memoryRead,
  memoryAppend,
  onReminderDue,
  systemStats,
  searchResolve,
  agentModels,
  spotifyNext,
  spotifyNowPlaying,
  spotifyPause,
  spotifyPlay,
  spotifyPrev,
  spotifyResume,
  spotifyShuffle,
  spotifyRepeat,
  spotifyVolume,
  spotifyPlayLiked,
  spotifyPlayPlaylist,
  spotifyLaunch,
  agentPlan,
  agentPlanSteps,
  agentNextStep,
  agentRunAction,
  agentTaskStep,
  agentLens,
  agentVision,
  attachmentRead,
  voiceTranscribe,
  webviewCapture,
  onScreenshot,
  isStartUrl,
  PDF_URL,
  scrollClip,
  onyxCapturePage,
  onyxNewNote,
  notePlan,
  noteApply,
  type NoteProposal,
  calEvents,
  calLocalEvents,
  calEventAdd,
  calEventUpdate,
  calEventDelete,
  onAgentStatus,
  type AgentAction,
  type NextStep,
  type AgentStatus,
} from "./ipc";
import { looksLikeNoteWrite } from "./noteintent";
import { looksAgentic } from "./agentintent";
import { joinPath, resolveAgentPath } from "./agentpaths";
import { readPdfText } from "./pdftext";
import {
  activeId,
  activeWorkspace,
  activeWorkspaceName,
  agentModelName,
  filesPanelOpen,
  fluxStateSnapshot,
  focusedAppId,
  openTab,
  pendingAsk,
  pendingLens,
  setAgentMenuOpen,
  setAgentModel,
  setPendingAsk,
  setPendingLens,
  tabs,
} from "./store";
import { FLUX_APPS } from "./apps";
import AgentAurora from "./AgentAurora";
import {
  heyGemmaEnabled,
  listening,
  micLive,
  setHeyGemmaEnabled,
  setVoiceHandler,
  startConversation,
  voiceStatus,
} from "./heygemma";
import { micConstraints } from "./mic";
import {
  activeTerminalText,
  activeTerminalCursorLine,
  activeTerminalLinesFrom,
  runInActiveTerminal,
} from "./terminals";
import { inspectElement, themeVarsDump } from "./debug";
import { speak, speaking, stopSpeaking } from "./speak";
import { addReminder, migrateReminders, parseWhen, pendingReminders, whenLabel } from "./reminders";

type FeedItem = {
  role: "user" | "assistant" | "action" | "error" | "plan" | "task" | "shell" | "edit" | "note";
  text: string;
  action?: AgentAction;
  /** A proposed write into your notes, awaiting confirmation (#108). */
  note?: NoteProposal;
  /** Set once applied — the written path, so the card stops offering to write. */
  noteDone?: string;
  pending?: boolean;
  image?: string;
  shellCmd?: string;
  editPath?: string;
  editNew?: string;
  editDiff?: string;
  citations?: KbHit[];
  voice?: string;
};

const AgentPanel: Component = () => {
  const [status, setStatus] = createSignal<AgentStatus>({ state: "idle" });
  const [prompt, setPrompt] = createSignal("");
  const [feed, setFeed] = createSignal<FeedItem[]>([]);
  const [busy, setBusy] = createSignal(false);
  // Saved chat sessions (#sessions). Each conversation persists to localStorage so
  // you can start a New chat and reopen earlier ones. `currentId` is the session the
  // live feed belongs to (assigned on the first message).
  type ChatSession = { id: string; title: string; ts: number; feed: FeedItem[] };
  const CHATS_KEY = "flux.chats";
  const loadChats = (): ChatSession[] => {
    try {
      return JSON.parse(localStorage.getItem(CHATS_KEY) || "[]");
    } catch {
      return [];
    }
  };
  const [chats, setChats] = createSignal<ChatSession[]>(loadChats());
  const [chatsMenu, setChatsMenu] = createSignal(false);
  let currentId = "";
  let seq = 0;
  const titleOf = (f: FeedItem[]) =>
    (f.find((it) => it.role === "user")?.text || "New chat").trim().slice(0, 44);
  const persistChats = (next: ChatSession[]) => {
    setChats(next);
    try {
      localStorage.setItem(CHATS_KEY, JSON.stringify(next.slice(0, 50)));
    } catch {
      /* quota */
    }
  };
  const persistCurrent = (f: FeedItem[]) => {
    if (!f.length) return;
    if (!currentId) currentId = `c${Date.now()}_${seq++}`;
    // Strip live "pending" state so reopened chats are read-only history.
    const session: ChatSession = {
      id: currentId,
      title: titleOf(f),
      ts: Date.now(),
      feed: f.map((it) => ({ ...it, pending: false })),
    };
    persistChats([session, ...chats().filter((s) => s.id !== currentId)].slice(0, 50));
  };
  const newChat = () => {
    if (working() || taskRunning()) return;
    currentId = ""; // the current conversation is already saved under its id
    setFeed([]);
    setChatsMenu(false);
  };
  const loadSession = (s: ChatSession) => {
    currentId = s.id;
    setFeed(s.feed.map((it) => ({ ...it })));
    setChatsMenu(false);
  };
  const deleteSession = (id: string, e: MouseEvent) => {
    e.stopPropagation();
    persistChats(chats().filter((s) => s.id !== id));
    if (currentId === id) {
      currentId = "";
      setFeed([]);
    }
  };
  // Interrupt ("stop the rant"): bump the generation so in-flight stream tokens are
  // ignored, cut any TTS, and free the input. The backend completion may keep
  // running, but its late tokens no-op against the new generation.
  let replyGen = 0;
  const cancelReply = () => {
    replyGen++;
    stopSpeaking();
    setBusy(false);
  };

  // Persist the live conversation (debounced so streaming tokens don't thrash localStorage).
  let persistTimer: number | undefined;
  createEffect(() => {
    const f = feed();
    clearTimeout(persistTimer);
    persistTimer = window.setTimeout(() => persistCurrent(f), 400);
  });
  // Chat-with-page/tabs (#34): "page" grounds in the active tab; "tabs" grounds
  // in every open browser tab in the active workspace; "thread" is the page's
  // PERSISTENT conversation (ADR 0011) — the same thread the Trail shows,
  // re-attached here whenever you're on the page.
  const [scope, setScope] = createSignal<"page" | "tabs" | "notes" | "thread">("page");
  // The active page's Trail thread (null = no Visit: internal page/private tab).
  const [pageThread, setPageThread] = createSignal<TabThread | null>(null);
  // Which visit's history was already replayed into the feed (avoid repeats).
  let threadShownFor: number | null = null;
  createEffect(() => {
    const id = activeId();
    if (id == null) {
      setPageThread(null);
      return;
    }
    void traceTabThread(id)
      .then((t) => {
        setPageThread(t);
        // A page with no Visit can't hold a thread — fall back to plain page
        // chat. Untracked read: this effect keys on the active tab only.
        if (t == null && untrack(scope) === "thread") setScope("page");
      })
      .catch(() => setPageThread(null));
  });
  // Attach the thread scope: replay its tail into the feed once per visit so the
  // conversation reads continuously ("you were here before").
  const attachThread = () => {
    const t = pageThread();
    if (!t) return;
    setScope("thread");
    if (threadShownFor === t.visit_id) return;
    threadShownFor = t.visit_id;
    const n = t.msgs.length;
    setFeed((f) => [
      ...f,
      {
        role: "action",
        text:
          n > 0
            ? `💬 Attached to this page's saved conversation (${n} message${n === 1 ? "" : "s"}) — replies persist with the page.`
            : "💬 Started this page's conversation — it persists with the page (see it again in the Trail).",
      },
      ...t.msgs
        .slice(-4)
        .map((m): FeedItem => ({ role: m.role === "user" ? "user" : "assistant", text: m.text })),
    ]);
  };
  // Multi-step tasks (#A): the iterative agent loop. `taskRunning` gates input;
  // `taskAuto` = "run all" (auto-approve non-stop steps); `taskStep` holds the
  // step currently awaiting Approve/Skip/Stop in step-through mode.
  const [taskRunning, setTaskRunning] = createSignal(false);
  const [taskAuto, setTaskAuto] = createSignal(false);
  const [taskStep, setTaskStep] = createSignal<{ action: AgentAction; n: number } | null>(null);
  let stepResolver: ((d: "approve" | "skip" | "stop") => void) | null = null;
  // Multi-step chain (#115): when a chain step needs an approval card (edit / shell),
  // this resolver is set so the chain waits for the user's Apply/Run (true) or
  // Cancel (false) before moving to the next step. The existing approve/cancel
  // handlers resolve it.
  let chainGate: ((r: { ok: boolean; result: string }) => void) | null = null;
  const resolveChainGate = (ok: boolean, result: string) => {
    const g = chainGate;
    chainGate = null;
    g?.({ ok, result });
  };
  // Model picker (#81): the dropdown of locally-pulled Ollama models.
  const [models, setModels] = createSignal<string[]>([]);
  const [modelMenu, setModelMenu] = createSignal(false);
  // Tell App to hide the active page webview while a dropdown is open (it's an OS
  // layer above the chrome, otherwise the menu is behind it — unclickable).
  createEffect(() => setAgentMenuOpen(modelMenu() || chatsMenu()));
  // Dropdowns render via a <Portal> to <body> with fixed position, so no agent-panel
  // stacking context (z-index, transform, backdrop-filter) can trap them behind.
  let modelBtn: HTMLButtonElement | undefined;
  let chatsBtn: HTMLButtonElement | undefined;
  const menuPos = (btn?: HTMLElement): JSX.CSSProperties => {
    const r = btn?.getBoundingClientRect();
    if (!r) return { position: "fixed", top: "56px", right: "14px", "z-index": "9999" };
    return {
      position: "fixed",
      top: `${Math.round(r.bottom + 5)}px`,
      right: `${Math.round(Math.max(8, window.innerWidth - r.right))}px`,
      "z-index": "9999",
    };
  };
  const toggleModelMenu = () => {
    const open = !modelMenu();
    setModelMenu(open);
    if (open)
      void agentModels()
        .then(setModels)
        .catch(() => setModels([]));
  };
  const shortModel = () => {
    const m = agentModelName();
    return m ? m.split(":")[0]! : "gemma";
  };
  let feedEl: HTMLDivElement | undefined;

  /** Tabs the agent can read. `isStartUrl` matches every flux:// url, which used
   *  to exclude PDFs opened in the built-in viewer along with the rest — but a
   *  PDF publishes its text as a snapshot, so it has exactly as much to say as a
   *  web page. */
  const browserTabIds = () =>
    tabs()
      .filter(
        (t) =>
          t.kind === "browser" &&
          t.workspace === activeWorkspace() &&
          (!isStartUrl(t.url) || t.url.startsWith(PDF_URL)),
      )
      .map((t) => t.id);

  onMount(async () => {
    const unlisten = await onAgentStatus(setStatus);
    onCleanup(unlisten);
  });

  // Auto-scroll the feed to the latest message.
  createEffect(() => {
    feed();
    if (feedEl) feedEl.scrollTop = feedEl.scrollHeight;
  });

  const working = () => busy() || status().state === "thinking" || listening() || speaking();

  // A quick AI answer for a search query, drafted by the local model (#ai).
  // Fed in via `pendingAsk` when the user runs a search with AI answers on.
  const answerSearch = async (query: string) => {
    if (working()) return;
    setFeed((f) => [...f, { role: "user", text: query }]);
    setBusy(true);
    try {
      const reply = await agentChat(`Give a concise, direct answer to this search query: "${query}"`);
      const text = reply.trim();
      setFeed((f) => [...f, { role: "assistant", text }]);
      void speak(text);
    } catch (err) {
      setFeed((f) => [...f, { role: "error", text: String(err) }]);
    } finally {
      setBusy(false);
    }
  };
  // Consume a queued search query (set by the omnibox) exactly once.
  createEffect(() => {
    const q = pendingAsk();
    if (q) {
      setPendingAsk(null);
      void answerSearch(q);
    }
  });

  // Visual Lens (#115): capture the active page (#54 emits the path when written),
  // then identify it with the local vision model.
  const capturePage = (tabId: number) =>
    new Promise<string>((resolve, reject) => {
      let unlisten: (() => void) | null = null;
      let settled = false;
      const done = () => {
        settled = true;
        unlisten?.();
        clearTimeout(timer);
      };
      const timer = setTimeout(() => {
        if (!settled) {
          done();
          reject(new Error("page capture timed out"));
        }
      }, 9000);
      void onScreenshot((path) => {
        if (!settled) {
          done();
          resolve(path);
        }
      }).then((u) => {
        unlisten = u;
        if (settled) u();
      });
      void webviewCapture(tabId).catch((e) => {
        if (!settled) {
          done();
          reject(e);
        }
      });
    });
  const runLens = async (userPrompt?: string) => {
    if (working() || taskRunning()) return;
    const t = tabs().find((x) => x.id === activeId());
    if (!t || t.kind !== "browser" || isStartUrl(t.url)) {
      setFeed((f) => [...f, { role: "error", text: "Open a web page first, then use Lens." }]);
      return;
    }
    setFeed((f) => [...f, { role: "task", text: "🔍 Looking…" }]);
    setBusy(true);
    try {
      const path = await capturePage(t.id);
      const answer = await agentLens(path, userPrompt);
      const text = answer.trim();
      setFeed((f) => [...f, { role: "assistant", text }]);
      void speak(text);
    } catch (e) {
      setFeed((f) => [...f, { role: "error", text: String(e) }]);
    } finally {
      setBusy(false);
    }
  };
  // ⌘K / a button can request a Lens via the store signal.
  createEffect(() => {
    if (pendingLens()) {
      setPendingLens(false);
      setFeed((f) => [...f, { role: "user", text: "🔍 Identify this page" }]);
      void runLens();
    }
  });

  // File attachments: an image (→ the local vision model) or a text file (→ chat
  // context). One at a time; shown as a chip above the input until sent.
  type Attachment =
    | { kind: "image"; name: string; b64: string; dataUrl: string }
    | { kind: "text"; name: string; text: string };
  const [attachment, setAttachment] = createSignal<Attachment | null>(null);
  let fileInput: HTMLInputElement | undefined;
  const MAX_BYTES = 20 * 1024 * 1024;
  const TEXT_EXT =
    /\.(txt|md|markdown|json|jsonc|csv|tsv|log|ya?ml|toml|ini|xml|html?|css|js|jsx|ts|tsx|rs|py|go|java|c|cpp|h|sh|sql|rb|php|swift|kt)$/i;

  const readFile = (file: File) =>
    new Promise<void>((resolve) => {
      if (file.size > MAX_BYTES) {
        setFeed((f) => [...f, { role: "error", text: `"${file.name}" is too large (max 20 MB).` }]);
        return resolve();
      }
      const reader = new FileReader();
      if (file.type.startsWith("image/")) {
        reader.onload = () => {
          const dataUrl = String(reader.result || "");
          const b64 = dataUrl.includes(",") ? dataUrl.slice(dataUrl.indexOf(",") + 1) : dataUrl;
          setAttachment({ kind: "image", name: file.name, b64, dataUrl });
          resolve();
        };
        reader.readAsDataURL(file);
      } else if (file.type.startsWith("text/") || TEXT_EXT.test(file.name)) {
        reader.onload = () => {
          setAttachment({ kind: "text", name: file.name, text: String(reader.result || "") });
          resolve();
        };
        reader.readAsText(file);
      } else {
        setFeed((f) => [
          ...f,
          {
            role: "error",
            text: `Can't read "${file.name}" — attach an image or a text file (video/binary isn't supported).`,
          },
        ]);
        resolve();
      }
    });
  const onPickFile = (e: Event) => {
    const file = (e.currentTarget as HTMLInputElement).files?.[0];
    if (file) void readFile(file);
    (e.currentTarget as HTMLInputElement).value = ""; // allow re-picking the same file
  };

  // Drag-and-drop onto the panel: an OS file (dataTransfer.files) or a file
  // dragged from Flux's explorer (its rows put the path in text/plain).
  const [dropping, setDropping] = createSignal(false);
  const onDrop = async (e: DragEvent) => {
    e.preventDefault();
    setDropping(false);
    const dt = e.dataTransfer;
    if (!dt) return;
    if (dt.files && dt.files.length) {
      void readFile(dt.files[0]!);
      return;
    }
    const path = (dt.getData("text/plain") || "").split("\n")[0]?.trim();
    if (!path) return;
    try {
      const a = await attachmentRead(path);
      if (a.kind === "image") setAttachment({ kind: "image", name: a.name, b64: a.b64, dataUrl: a.data_url });
      else setAttachment({ kind: "text", name: a.name, text: a.text });
    } catch (err) {
      setFeed((f) => [...f, { role: "error", text: String(err) }]);
    }
  };

  // Push-to-talk voice: hold the 🎤 to record, release to transcribe locally
  // (Vosk). Releasing the mic sends the transcript immediately; any typed input
  // already in the box is treated as a prefix for the spoken prompt.
  const [recording, setRecording] = createSignal(false);
  let micStream: MediaStream | null = null;
  let audioCtx: AudioContext | null = null;
  let recNode: ScriptProcessorNode | null = null;
  let pcmChunks: Float32Array[] = [];
  const startRec = async () => {
    if (recording() || working() || taskRunning()) return;
    try {
      micStream = await navigator.mediaDevices.getUserMedia(micConstraints({ echo: false }));
    } catch {
      setFeed((f) => [...f, { role: "error", text: "Microphone access was denied." }]);
      return;
    }
    audioCtx = new AudioContext();
    const src = audioCtx.createMediaStreamSource(micStream);
    recNode = audioCtx.createScriptProcessor(4096, 1, 1);
    pcmChunks = [];
    recNode.onaudioprocess = (e) => pcmChunks.push(new Float32Array(e.inputBuffer.getChannelData(0)));
    src.connect(recNode);
    recNode.connect(audioCtx.destination); // we write silence → no echo
    setRecording(true);
  };
  const b64FromBytes = (bytes: Uint8Array) => {
    let s = "";
    const CH = 0x8000;
    for (let i = 0; i < bytes.length; i += CH) s += String.fromCharCode(...bytes.subarray(i, i + CH));
    return btoa(s);
  };
  const stopRec = async () => {
    if (!recording()) return;
    setRecording(false);
    const rate = audioCtx?.sampleRate ?? 48000;
    try {
      recNode?.disconnect();
    } catch {
      /* ignore */
    }
    micStream?.getTracks().forEach((t) => t.stop());
    void audioCtx?.close();
    const len = pcmChunks.reduce((n, c) => n + c.length, 0);
    const chunks = pcmChunks;
    pcmChunks = [];
    micStream = null;
    audioCtx = null;
    recNode = null;
    if (len < rate * 0.25) return; // ignore < 0.25 s (a stray tap)
    const f32 = new Float32Array(len);
    let o = 0;
    for (const c of chunks) {
      f32.set(c, o);
      o += c.length;
    }
    const i16 = new Int16Array(len);
    for (let i = 0; i < len; i++) {
      const s = Math.max(-1, Math.min(1, f32[i]!));
      i16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    setBusy(true);
    let spoken = "";
    try {
      const text = await voiceTranscribe(b64FromBytes(new Uint8Array(i16.buffer)), rate);
      spoken = text.trim();
    } catch (e) {
      setFeed((f) => [...f, { role: "error", text: String(e) }]);
    } finally {
      setBusy(false);
    }
    if (!spoken) return;
    const prefix = prompt().trim();
    await send(prefix ? `${prefix} ${spoken}` : spoken);
  };

  // Music intents (AudioPulse via Spotify) — "play …" / "skip" / "shuffle on" /
  // "launch audiopulse" etc., optionally addressed to Gemma ("hey gemma, …").
  // `musicIntent` maps one clause → a backend call (or null). `runMusic` runs a
  // single clause, OR a compound macro ("launch audiopulse and play my liked
  // songs, shuffle on") when EVERY clause is itself a music intent — so a normal
  // "play X and Y" query (where "Y" isn't an intent) still plays as one search.
  const musicIntent = (clause: string): (() => Promise<string>) | null => {
    const cmd = clause
      .replace(
        /^\/?(?:and\s+|also\s+|then\s+|make\s+sure\s+to\s+|be\s+sure\s+to\s+|please\s+|can\s+you\s+|could\s+you\s+|would\s+you\s+)+/i,
        "",
      )
      .trim();
    let m: RegExpMatchArray | null;
    // "launch audiopulse" + synonyms; "spotify" is accepted too since Vosk often
    // mishears "pulse" (so "launch spotify" → launch AudioPulse).
    if (
      /^(?:launch|start(?:\s*up)?|open|boot(?:\s*up)?|fire\s*up)\s+(?:audio\s*pulse|audiopulse|spotify|ap)\b/i.test(
        cmd,
      )
    )
      return spotifyLaunch;
    // STT often mangles the imperative "play" into "played"/"playing"/"plays" — accept those.
    const PLAY = "play(?:ed|s|ing)?|put\\s*on|start";
    if (
      new RegExp(`^(?:${PLAY})\\s+(?:my\\s+|the\\s+)?liked(?:\\s+songs?)?(?:\\s+playlist)?$`, "i").test(cmd)
    )
      return spotifyPlayLiked;
    if ((m = cmd.match(new RegExp(`^(?:${PLAY})\\s+(?:my\\s+|the\\s+)?(.+?)\\s+playlist$`, "i")))) {
      const name = m[1]!.trim();
      return () => spotifyPlayPlaylist(name);
    }
    if ((m = cmd.match(new RegExp(`^(?:${PLAY}|queue)\\s+(.+)`, "i")))) {
      // Drop "the song"/"this track"/"a tune" filler so the search is just the title.
      const raw = m[1]!.trim();
      const q = raw
        .replace(
          /^(?:me\s+)?(?:the|this|a|that)?\s*(?:song|track|tune)\s+(?:called\s+|named\s+|titled\s+)?/i,
          "",
        )
        .trim();
      return () => spotifyPlay(q || raw);
    }
    if (/^(?:turn\s+)?shuffle(?:\s+on)?$|^turn\s+on\s+shuffle$/i.test(cmd)) return () => spotifyShuffle(true);
    if (/^(?:turn\s+)?shuffle\s+off$|^turn\s+off\s+shuffle$/i.test(cmd)) return () => spotifyShuffle(false);
    if ((m = cmd.match(/^(?:set\s+)?(?:the\s+)?volume\s+(?:to\s+)?(\d{1,3})%?$/i))) {
      const pct = Number(m[1]);
      return () => spotifyVolume(pct);
    }
    if (
      (m = cmd.match(
        /^(?:set\s+)?repeat(?:\s+(?:to\s+|mode\s+)?(one|all|track|context|song|playlist|album|off|none))?$/i,
      ))
    ) {
      const mode = (m[1] || "context").toLowerCase();
      return () => spotifyRepeat(mode);
    }
    if (/^(?:loop|repeat)\s+(?:this|song|track)$/i.test(cmd)) return () => spotifyRepeat("track");
    if (/^(?:skip|next)(?:\s+(?:song|track))?$/i.test(cmd)) return spotifyNext;
    if (/^(?:prev(?:ious)?|back|last(?:\s+song)?)$/i.test(cmd)) return spotifyPrev;
    if (/^pause$/i.test(cmd)) return spotifyPause;
    if (/^(?:resume|unpause|continue)$/i.test(cmd)) return spotifyResume;
    if (/^(?:what'?s\s*playing|now\s*playing|np)\??$/i.test(cmd)) return spotifyNowPlaying;
    return null;
  };
  const callMusic = async (fn: () => Promise<string>): Promise<string> => {
    try {
      const r = await fn();
      setFeed((f) => [...f, { role: "action", text: r }]);
      return r;
    } catch (e) {
      const m = String(e);
      setFeed((f) => [...f, { role: "error", text: m }]);
      return m;
    }
  };
  // Handle a music command (typed or voice). Returns the spoken summary if handled,
  // else null. Tries the COMPOUND split FIRST — "launch spotify and play my liked
  // songs, shuffle on" — so a leading intent (e.g. "launch …") doesn't swallow the
  // rest; only fires as a macro when EVERY clause is a music intent, so a normal
  // "play Stay with Me" search still falls through to a single play.
  const handleMusic = async (raw: string): Promise<string | null> => {
    const cmd = raw
      .replace(/^\/?(hey\s+)?gemma[,:\s]+/i, "")
      .replace(/^(can|could|would)\s+you\s+/i, "")
      .replace(/^please\s+/i, "")
      .trim();
    const clauses = cmd
      .split(/\s*(?:,|;|\.|\bthen\b|\band\b|\bwith\b)\s*/i)
      .map((s) => s.trim())
      .filter(Boolean);
    if (clauses.length >= 2) {
      const steps = clauses.map(musicIntent);
      if (steps.every(Boolean)) {
        let last = "";
        for (const step of steps) last = await callMusic(step!);
        return last;
      }
    }
    const single = musicIntent(cmd);
    if (single) return await callMusic(single);
    return null;
  };
  const runMusic = async (raw: string): Promise<boolean> => (await handleMusic(raw)) !== null;

  // "run <cmd>" / "execute <cmd>" / "/run <cmd>" → propose a shell command. Nothing
  // runs until you tap Run (rm + destructive commands are also blocked backend-side).
  const SHELL_RE = /^\/?(?:run|exec|execute|terminal|shell)\s+([\s\S]+)/i;
  const runShellCmd = async (cmd: string): Promise<string> => {
    const c = cmd.trim();
    if (!c) return "";
    setFeed((f) => [...f, { role: "shell", text: `$ ${c}`, shellCmd: c, pending: true }]);
    return `Run “${c}” in your terminal? Tap ▶ Run in terminal to confirm.`;
  };

  // "/pac <request>" — the deterministic Power Platform ALM path (#135). Preflight
  // that `pac` is installed + signed in, ask the model to map the request to ONE
  // pac command (grounded by a Rust-side cheatsheet), surface the explanation and
  // any environment-mutating risk, then reuse the shell approval card so nothing
  // runs until the user taps Run. Complements the browser-automation playbooks.
  const PAC_RE = /^\/?pac\s+([\s\S]+)/i;
  const runPac = async (request: string): Promise<string> => {
    const q = request.trim();
    if (!q) return "Tell me what to do, e.g. `/pac export my solution Contoso`.";
    setBusy(true);
    try {
      const st = await pacStatus().catch(() => null);
      if (st && !st.installed) {
        return `The Power Platform CLI (\`pac\`) isn't installed or isn't on PATH. Install it (\`dotnet tool install --global Microsoft.PowerApps.CLI.Tool\`), then try again.`;
      }
      const plan = await agentPacPlan(q);
      if (!plan.command) {
        return (
          plan.explanation ||
          "I couldn't map that to a `pac` command. Try naming the operation (export / import / unpack / list)."
        );
      }
      // Context lines before the approval card: what it does, a read-only/write
      // hint, an auth nudge if we're not signed in, and any danger heads-up.
      if (plan.explanation) setFeed((f) => [...f, { role: "assistant", text: plan.explanation }]);
      if (st && st.installed && !st.authenticated && !plan.command.includes("auth")) {
        setFeed((f) => [
          ...f,
          {
            role: "assistant",
            text: "⚠ No active `pac` auth profile — run `/pac sign in to <env url>` first, or this will fail.",
          },
        ]);
      }
      if (plan.danger) {
        setFeed((f) => [
          ...f,
          { role: "error", text: `⚠ Heads-up: this ${plan.danger} Review it before you run.` },
        ]);
      } else if (plan.read_only) {
        setFeed((f) => [
          ...f,
          { role: "assistant", text: "✓ Read-only — this can't change a remote environment." },
        ]);
      }
      return await runShellCmd(plan.command);
    } catch (e) {
      return `pac planning failed: ${String(e)}`;
    } finally {
      setBusy(false);
    }
  };
  // Poll the active terminal's new output (from `baseline`) until it goes quiet —
  // a PTY has no exit signal, so "stopped changing for STABLE ms" is our done-ish
  // heuristic, capped at MAX. Returns the captured tail.
  const readBackTerminal = async (baseline: number): Promise<string> => {
    const STEP = 350,
      STABLE = 1200,
      MAX = 30000;
    let last = "";
    let stable = 0;
    for (let t = 0; t < MAX; t += STEP) {
      await new Promise((r) => setTimeout(r, STEP));
      const cur = activeTerminalLinesFrom(baseline, 200);
      if (cur === last) {
        stable += STEP;
        if (stable >= STABLE && cur.trim()) break;
      } else {
        last = cur;
        stable = 0;
      }
    }
    return last;
  };

  const approveShell = async (idx: number, cmd: string) => {
    setFeed((f) => f.map((it, i) => (i === idx ? { ...it, pending: false } : it)));
    setBusy(true);
    try {
      // Same denylist as the headless run — we're typing straight into the PTY,
      // which bypasses run_shell's guard, so check it ourselves first.
      let block: string | null = null;
      try {
        block = await shellGuard(cmd);
      } catch {
        block = null;
      }
      if (block) {
        setFeed((f) => [...f, { role: "error", text: block! }]);
        return;
      }
      // Baseline = the prompt's cursor row BEFORE running, so we read exactly this
      // command's echo + output (and nothing above it).
      const baseline = activeTerminalCursorLine();
      const session = await runInActiveTerminal(cmd);
      if (session == null) {
        // Couldn't bring a terminal up — fall back to a headless run so the command
        // still executes and returns something.
        const out = await runShell(cmd);
        setFeed((f) => [...f, { role: "assistant", text: out }]);
        return;
      }
      const out = (await readBackTerminal(baseline)).trim();
      setFeed((f) => [
        ...f,
        {
          role: "assistant",
          text: out
            ? `Terminal output:\n${out}`
            : "(ran in your terminal — no output captured; check the terminal)",
        },
      ]);
      resolveChainGate(true, out || "(ran, no output captured)");
    } catch (e) {
      setFeed((f) => [...f, { role: "error", text: String(e) }]);
      resolveChainGate(false, String(e));
    } finally {
      setBusy(false);
    }
  };
  const cancelShell = (idx: number) => {
    setFeed((f) =>
      f.map((it, i) => (i === idx ? { ...it, pending: false, text: `${it.text}  — cancelled` } : it)),
    );
    resolveChainGate(false, "the user cancelled the command");
  };

  // Natural-language → command. When a message reads like a request about the
  // user's machine/files (not just any "list"/"show"), ask the model to translate
  // it to a shell command and propose it (with approval). Gated so normal chat
  // isn't taxed with an extra round-trip. Returns true if it proposed a command.
  const SYSTEMISH =
    /\b(?:my|this|the|current|home|working)\s+(?:files?|folders?|director(?:y|ies)|downloads?|desktop|documents|drive|disk)\b|\b(?:list|show|count|what'?s|whats)\b[^.?!]*\b(?:files?|folders?|director(?:y|ies)|processes|disk|drive)\b|\b(?:disk\s+(?:space|usage)|running\s+process(?:es)?|environment\s+variables?|current\s+director|home\s+director|on\s+my\s+(?:computer|machine|system|pc|laptop))\b|\b(?:ls|pwd|cat|grep|df|du|ps|mkdir|touch|whoami|uptime)\b|\bgit\s+(?:status|log|diff|branch)\b/i;
  // When "always" is on (Settings), translate every message; otherwise only the
  // machine/file-type ones. Returns the spoken summary if it proposed a command,
  // else null (so callers fall through to chat).
  const shellPlanAlways = () => localStorage.getItem("flux.shellplan.always") === "1";
  const maybeShellPlan = async (p: string): Promise<string | null> => {
    if (!shellPlanAlways() && !SYSTEMISH.test(p)) return null;
    let cmd: string | null = null;
    try {
      cmd = await agentShellPlan(p);
    } catch {
      return null;
    }
    if (!cmd) return null;
    return await runShellCmd(cmd);
  };

  // Gemma's personality, prepended to every chat. Editable in Settings.
  const DEFAULT_PERSONA =
    "You are Gemma, the user's friendly local AI in the Flux browser. Be upbeat, warm, and energetic — a little playful and encouraging, with the occasional emoji. Keep replies natural and concise; don't overdo the enthusiasm.";
  const persona = () => (localStorage.getItem("flux.gemma.persona") ?? DEFAULT_PERSONA).trim();

  // What Gemma can actually DO in Flux — injected into every chat so she's aware of
  // her tools and can tell the user the exact phrasing. Kept separate from the
  // (editable) persona so it can't be edited away. Only claim what's listed here.
  const CAPABILITIES =
    "Your capabilities in Flux (these run via the app, not just talk — tell the user the exact phrasing when helpful):\n" +
    '- Reminders & to-dos: "remind me to <x> in 10 min / at 3pm / tomorrow"; "what are my reminders". They fire with an OS notification + spoken alert even if the panel is closed.\n' +
    "- The user's own apps (pinned in the bottom-right dock): Nexus (ML training console), Prism (AutoML + entity resolution), Vector (issue tracker), Oracle (plant ID). When one is open you get its full guide — help with its features, workflows, and results.\n" +
    '- Calendar: "what\'s on my calendar today / this week / friday" reads your schedule (your Google ICS feed + Flux-local events); "schedule lunch with Sam tomorrow at noon for 1h" / "add a dentist appointment friday 3pm" creates an event; "move my standup to 10am"; "cancel the dentist appointment". You can add/move/delete events you created in Flux (Google-feed events are read-only — say so if asked to change one).\n' +
    '- Long-term memory: "remember that <x>" saves a fact you\'ll recall in future chats; "what do you remember".\n' +
    '- Run commands in the user\'s live terminal (one-tap approval; rm/destructive blocked): "run <cmd>" / "execute <cmd>", or ask naturally ("list the files in my home directory") and you propose the command. On approval it runs in their real terminal session (their cwd/env) and you read the output back — so you can edit a file, run the tests, read the result, and fix it.\n' +
    '- Read files into context: "read src/foo.rs" / "look at <path>" pulls a file in so you can answer about it without copy-paste (it stays for follow-ups); "forget the files" clears. You can also drag a file from the explorer onto the panel. PDFs come through as real text, page by page. A scan has no text layer, so you run OCR on it yourself and say the text was machine-read.\n' +
    '- List a folder: "list <dir>" / "what\'s in <dir>" reads a directory directly — no terminal, no approval needed.\n' +
    '- Read the terminal: "read the terminal" / "what\'s in my terminal" pulls the active Terminal tab\'s recent output into context (great for debugging a failed command).\n' +
    '- Edit files (with approval): "edit src/foo.rs: rename X to Y" / (after reading a file) "change it to …" — you propose a diff; nothing is written until the user taps Apply. Make surgical edits.\n' +
    '- Inspect Flux\'s own UI (for debugging it): "app state" (UI snapshot), "css variables" / "what\'s --flux-teal", "inspect <css selector>" (computed style + visibility — e.g. why an element is hidden or a var isn\'t applying).\n' +
    '- System awareness: "system status" / "how\'s my CPU" / "what\'s using memory" → CPU%, RAM, top processes.\n' +
    '- Web search: "search <x>" / "open a new tab and search <x>".\n' +
    '- Music (AudioPulse/Spotify): "play <song>", "play my liked songs", "shuffle on", "skip", "pause", "launch spotify".\n' +
    '- Page actions: "/act <do something on this page>" (one step) or "/task <multi-step goal>" (you plan steps the user approves). You can also chat grounded in the current page or all open tabs.\n' +
    '- Chain several of the above in one request: join steps with "then" / "+" — e.g. "read src/foo.rs then fix the bug then run the tests" or "play my liked songs + shuffle on". Each step runs in order; edits/commands still ask for approval.\n' +
    '- Adaptive goal loop: "/fix <goal>" (e.g. "/fix make the tests in src/foo.rs pass") — you run one step, read the result, and re-plan: run → read the failure → edit a fix → re-run, until it\'s done or stuck. Each edit/command still asks for approval.\n' +
    '- Power Platform (Power Apps / Power Automate ALM): "/pac <request>" maps to ONE Power Platform CLI command — e.g. "/pac export my solution Contoso", "/pac unpack the solution zip", "/pac list my canvas apps". It runs the command via the approval card; environment-mutating ones (import/delete/publish) are flagged first.\n' +
    '- Named places: the user can say "onyx", "scribe", "downloads" or "home" instead of a path, and name a vault folder ("save it to onyx under 00 - Optimization"). The paths and the vault\'s folder names are listed below — use them verbatim; never ask for a path you have been given, and never invent a folder that isn\'t listed.\n' +
    '- Notes: asking in plain words ("save this into my Convex notebook") or "/note <what to add>" drafts something to ADD to the user\'s Onyx vault or a Scribe notebook — a new note/page, or an append to an existing one. They see the exact text and approve it before anything is written. You can never edit, rewrite or delete what is already there.\n' +
    '- Voice: always-on "Hey Gemma" + push-to-talk; the user can interrupt you by talking or the Stop button.\n' +
    "When asked what you can do, summarize the above. Don't claim abilities not listed.\n" +
    "\n" +
    "HOW TO ACT. Your tools fire from the user's message, not from anything you say. So:\n" +
    '- NEVER announce an action in the future tense. "I will now list the files", "let me read those", ' +
    '"listing them now" — none of these do anything. You will simply have said it, and the user waits ' +
    'for a result that is never coming. If you catch yourself writing "I\'ll" or "I\'m about to", stop.\n' +
    "- NEVER ask permission to look at something. Reading a file, listing a folder and reading the " +
    "terminal have no side effects and need no approval. Anything that DOES — running a command, " +
    "editing a file, writing a note — already stops at its own approval card, so asking first just " +
    "adds a round trip.\n" +
    "- A request that needs several steps over files ('go through these PDFs and summarise them') " +
    "runs as a multi-step task automatically: it lists, reads each file, and drafts the note, one " +
    "step at a time. You don't need to ask the user to start it, and you must not offer to.\n" +
    "- If you genuinely can't do something, say so in one sentence and say what would work instead. " +
    "Don't offer to do it and then not do it.\n" +
    "- NEVER speculate about Flux's own plumbing. \"It depends on whether the text is being captured " +
    'and sent to me" tells the user nothing they can act on and is usually wrong. Either the page ' +
    "text is in your context or it isn't: if it is, use it; if it isn't, say what you can see (the " +
    "title, the file) and ask for the one thing you need. When a document IS in context but says it " +
    "has no readable text, that is a fact about the document — say so and point at the fix, don't " +
    "ask the user to paste it in.";

  // Conversation memory: prepend persona + capabilities + the recent turns so the
  // model has context. The trailing "user" entry is the message we just pushed, so
  // it's excluded. Capped to the last few turns to keep prompt-eval fast.
  const filesContext = (): string => {
    const fs = ctxFiles();
    if (!fs.length) return "";
    // Matches `plan_note`'s own 24 KB context budget — this is the only place
    // the text of what was read reaches a note draft, and a tighter cap here
    // just throws away material the backend was ready to accept.
    let budget = 24000;
    const blocks: string[] = [];
    for (const f of fs) {
      const body = f.content.slice(0, Math.max(0, budget));
      budget -= body.length;
      blocks.push(
        `--- file: ${f.path} ---\n${body}${body.length < f.content.length ? "\n…(truncated)" : ""}`,
      );
      if (budget <= 0) break;
    }
    return `Files the user has open / asked you to read (use them to answer):\n${blocks.join("\n\n")}\n\n`;
  };

  // When one of the user's pinned apps is open + focused, give Gemma that app's
  // guide so she can actually help with it (#131).
  const appContext = (): string => {
    const app = FLUX_APPS.find((a) => a.id === focusedAppId());
    if (!app) return "";
    return `The user is currently using **${app.name}** (${app.url}), one of their pinned apps. Here's how it works — use it to assist them:\n${app.guide}\n\n`;
  };

  /** Named folders the agent can be pointed at without a path (#166): the Onyx
   *  vault and its folders, Scribe, Downloads, home. Loaded once per panel —
   *  the vault is a setting that rarely changes within a session, and the note
   *  planner resolves its own copy server-side on every call anyway. */
  const [places, setPlaces] = createSignal<Place[]>([]);
  onMount(
    () =>
      void agentPlaces()
        .then(setPlaces)
        .catch(() => {}),
  );

  /** The places block, as the model reads it. Mirrors `places::describe`. */
  const placesContext = (): string => {
    const ps = places();
    if (!ps.length) return "";
    const lines = ps.map((p) => {
      const folders = p.folders.length ? `\n    folders: ${p.folders.join(", ")}` : "";
      return `  ${p.name} = ${p.path}  — ${p.what}${folders}`;
    });
    return (
      "Named places you can use instead of asking the user for a path — say the name, " +
      "expand to the path when a tool needs one:\n" +
      `${lines.join("\n")}\n\n`
    );
  };

  /** Drop the model from VRAM now rather than waiting out the keep-alive (#169).
   *  A 12B sits on several GB, and keeping it warm buys latency between *your*
   *  turns — worth nothing while you're doing something else that wants the GPU.
   *  Not destructive: the next message loads it again. */
  const [unloading, setUnloading] = createSignal(false);
  const unloadModel = async () => {
    if (unloading()) return;
    setUnloading(true);
    try {
      const name = await agentUnload();
      setModelMenu(false);
      setFeed((f) => [
        ...f,
        { role: "action", text: `⏏ Unloaded ${name} from VRAM — it'll reload on your next message.` },
      ]);
    } catch (e) {
      setFeed((f) => [...f, { role: "error", text: `Couldn't unload: ${String(e)}` }]);
    } finally {
      setUnloading(false);
    }
  };

  const convoPrompt = (current: string): string => {
    const mem = memText().trim();
    const p0 = persona() ? `${persona()}\n\n` : "";
    const preamble =
      `${p0}${CAPABILITIES}\n\n` +
      placesContext() +
      appContext() +
      filesContext() +
      (mem ? `What you remember about the user (your saved memory):\n${mem.slice(0, 4000)}\n\n` : "");
    const turns = feed().filter((it) => it.role === "user" || it.role === "assistant");
    const prior = (
      turns.length && turns[turns.length - 1]?.role === "user" ? turns.slice(0, -1) : turns
    ).slice(-8);
    if (!prior.length) return preamble ? `${preamble}User: ${current}` : current;
    const transcript = prior.map((it) => `${it.role === "user" ? "User" : "Gemma"}: ${it.text}`).join("\n");
    return `${preamble}Conversation so far:\n${transcript}\n\nReply to the new message, using the memory + conversation above for context.\nUser: ${current}`;
  };

  // Long-term memory (a Markdown file Gemma reads + appends to). "remember (that) X"
  // / "note X" / "/remember X" saves a fact; it's then injected into every chat
  // prompt above. "what do you remember" / "show your memory" reads it back.
  const [memText, setMemText] = createSignal("");

  // Files Gemma is "looking at" — read into context so she can answer without
  // copy-paste, and stay there for follow-ups. Capped so the prompt stays sane.
  const [ctxFiles, setCtxFiles] = createSignal<{ path: string; name: string; content: string }[]>([]);
  const FILE_RE =
    /^(?:read|open|load|look at|show me|check out|cat|add)\s+(?:the\s+)?(?:file\s+|context\s+)?(~?\/?[\w. /\\@-]*?(?:\.[a-z0-9]{1,8}|\/[\w.-]+)|[~/][\w. /\\@.-]+)\s*$/i;
  // "list <dir>" — the step that was missing. Without it the only way to see a
  // folder was `run ls`, which costs an approval card for a read-only look and
  // returns output the loop then has to parse out of a terminal. Reading a
  // directory is not a side effect, so it doesn't ask.
  const LIST_RE =
    /^(?:list|ls|dir|show|what'?s in|contents of)\s+(?:the\s+)?(?:files?\s+in\s+|contents\s+of\s+)?["']?([~/][\w.\-/ \\@]*|[A-Za-z]:\\[\w.\-\\ ]*)["']?\s*$/i;
  /** How many entries to hand the model. A media folder can hold thousands, and
   *  the list is context it pays for on every subsequent step. */
  const LIST_CAP = 60;
  /** The last directory the agent listed — what a bare filename resolves
   *  against. See `agentpaths.ts` for why that's needed. */
  let lastListedDir = "";
  const resolvePath = (raw: string): string => resolveAgentPath(raw, lastListedDir, places());

  const runListDir = async (raw: string): Promise<string> => {
    const path = resolvePath(raw);
    if (!path) return "";
    try {
      const listing = await fsList(path);
      lastListedDir = listing.path;
      const all = listing.entries;
      const dirs = all.filter((e) => e.is_dir).map((e) => `${e.name}/`);
      const files = all.filter((e) => !e.is_dir).map((e) => e.name);
      const shown = [...dirs, ...files].slice(0, LIST_CAP);
      setFeed((f) => [
        ...f,
        {
          role: "action",
          text: `📁 ${listing.path} — ${dirs.length} folder${dirs.length === 1 ? "" : "s"}, ${files.length} file${files.length === 1 ? "" : "s"}`,
        },
      ]);
      if (all.length === 0) return `${listing.path} is empty.`;
      const more = all.length > LIST_CAP ? `\n…and ${all.length - LIST_CAP} more` : "";
      // FULL paths, not bare names. The next step is written from this text, so
      // a listing of basenames produced `read 01-lecture.pdf` — a relative path,
      // resolved against whatever directory Flux was launched from, which is
      // never where the file is. Handing back paths that are already usable is
      // cheaper than teaching the model to reassemble them.
      return (
        `Contents of ${listing.path} (full paths, use them as-is):\n` +
        `${shown.map((n) => joinPath(listing.path, n)).join("\n")}${more}`
      );
    } catch (e) {
      const m = String(e);
      setFeed((f) => [...f, { role: "error", text: m }]);
      return m;
    }
  };

  const runReadFile = async (raw: string): Promise<string> => {
    const path = resolvePath(raw);
    if (!path) return "";
    // A PDF read through `read_text_file` returns the container — "%PDF-1.7",
    // object headers, compressed streams — and the model summarises *that*,
    // confidently. Extract the real text instead (#158).
    if (/\.pdf$/i.test(path)) return await runReadPdf(path);
    try {
      const content = await readTextFile(path);
      const name = path.split(/[/\\]/).pop() || path;
      setCtxFiles((c) => [...c.filter((f) => f.path !== path), { path, name, content }].slice(-8));
      const lines = content.split("\n").length;
      setFeed((f) => [
        ...f,
        {
          role: "action",
          text: `📄 Reading ${name} (${lines} lines) — it's in context now; ask me anything about it.`,
        },
      ]);
      return `Got ${name} — what would you like to know about it?`;
    } catch (e) {
      const m = String(e);
      setFeed((f) => [...f, { role: "error", text: m }]);
      return m;
    }
  };
  /** Is a `tesseract` binary installed? Probed once — the answer can't change
   *  mid-session in any way worth a round trip per PDF. */
  let ocrReady: boolean | null = null;
  const ocrAvailableOnce = async (): Promise<boolean> => {
    if (ocrReady === null) ocrReady = await ocrAvailable().catch(() => false);
    return ocrReady ?? false;
  };

  /** Read a PDF as text and park it in context, like any other file. */
  const runReadPdf = async (path: string): Promise<string> => {
    const name = path.split(/[/\\]/).pop() || path;
    try {
      // A scan has no text layer, and asking the user to go and click "Read with
      // OCR" is asking them to do by hand the one thing they asked for. Run it —
      // it's read-only, and the only real cost is time, which the progress line
      // accounts for.
      const canOcr = await ocrAvailableOnce();
      let ocrIdx = -1;
      const onOcr = (page: number, total: number) => {
        const line = `🔍 No text layer in ${name} — reading it with OCR, page ${page} of ${total}…`;
        if (ocrIdx < 0) {
          ocrIdx = feed().length;
          setFeed((f) => [...f, { role: "action", text: line }]);
        } else {
          setFeed((f) => f.map((it, i) => (i === ocrIdx ? { ...it, text: line } : it)));
        }
      };
      const { text, pages, pagesWithText, truncated, ocr } = await readPdfText(path, onOcr, canOcr);
      if (!text.trim()) {
        // Either OCR isn't installed, or it ran and found nothing legible. Those
        // want different answers from the user, so don't blur them together.
        const m = canOcr
          ? `${name} has ${pages} page${pages === 1 ? "" : "s"} and nothing legible on them — OCR ran and came back empty.`
          : `${name} has ${pages} page${pages === 1 ? "" : "s"} but no selectable text — it's a scan, and there's no \`tesseract\` binary installed to read it. Install tesseract and try again.`;
        setFeed((f) => [...f, { role: "error", text: m }]);
        return m;
      }
      if (ocr) {
        // Flag it every time it's used. A vision model read this off an image and
        // may not have got it right, and a summary built on it inherits that.
        const done = `🔍 Read ${name} with OCR — ${pagesWithText} of ${pages} page${pages === 1 ? "" : "s"}${truncated ? `, stopped at the first ${pagesWithText}` : ""}. Machine-read, so it may not match the page exactly.`;
        setFeed((f) =>
          ocrIdx >= 0
            ? f.map((it, i) => (i === ocrIdx ? { ...it, text: done } : it))
            : [...f, { role: "action", text: done }],
        );
        setCtxFiles((c) => [...c.filter((f) => f.path !== path), { path, name, content: text }].slice(-8));
        return `Read ${name} with OCR (machine-read from images; may contain recognition errors) — ${pagesWithText} of ${pages} pages.\n\n${text}`;
      }
      setCtxFiles((c) => [...c.filter((f) => f.path !== path), { path, name, content: text }].slice(-8));
      const partial = pagesWithText < pages ? `, ${pagesWithText} with text` : "";
      setFeed((f) => [
        ...f,
        {
          role: "action",
          text: `📕 Read ${name} (${pages} page${pages === 1 ? "" : "s"}${partial}${truncated ? ", truncated" : ""}) — it's in context now.`,
        },
      ]);
      return `Read ${name} — ${pages} pages${partial}${truncated ? " (truncated)" : ""}.\n\n${text}`;
    } catch (e) {
      // Name the exact path tried, not just the file. Nearly every failure here
      // is the path being wrong rather than the PDF being unreadable, and
      // "couldn't read lecture1.pdf" hides which of those it was.
      const m = `Couldn't read ${path}: ${String(e).replace(/^Error:\s*/, "")}`;
      setFeed((f) => [...f, { role: "error", text: m }]);
      return m;
    }
  };

  const clearCtxFiles = () => setCtxFiles([]);
  const lastCtxFile = () =>
    [...ctxFiles()]
      .reverse()
      .find((f) => !["terminal", "css-vars", "app-state"].includes(f.path) && !f.path.startsWith("inspect:"));

  // "edit <file>: <instruction>" / "change it to …" → propose search/replace edits,
  // show a diff, and write only on approval (apply happens client-side).
  const EDIT_RE =
    /^(?:\/edit|edit|modify|change|update|patch|fix|refactor)\s+(~?[\w./\\@-]+\.[a-z0-9]{1,8})\s*[:,–-]?\s*([\s\S]+)/i;
  const EDIT_IT_RE =
    /^(?:\/edit|edit|modify|change|update|patch|apply|fix|refactor)\s+(?:it|this(?:\s+file)?|that|the\s+file)\b[:,–-]?\s*([\s\S]+)/i;
  const applyEdits = (
    content: string,
    edits: { search: string; replace: string }[],
  ): { out: string; failed: string[] } => {
    let out = content;
    const failed: string[] = [];
    for (const e of edits) {
      if (!e.search) continue;
      if (out.includes(e.search)) {
        out = out.replace(e.search, e.replace);
        continue;
      }
      const s2 = e.search.replace(/\r\n/g, "\n");
      const n = out.replace(/\r\n/g, "\n");
      if (n.includes(s2)) {
        out = n.replace(s2, e.replace.replace(/\r\n/g, "\n"));
        continue;
      }
      failed.push((e.search.split("\n")[0] || "").slice(0, 50));
    }
    return { out, failed };
  };
  const editDiffText = (edits: { search: string; replace: string }[]): string =>
    edits
      .map(
        (e, i) =>
          `@@ change ${i + 1} @@\n${e.search
            .split("\n")
            .map((l) => `- ${l}`)
            .join("\n")}\n${e.replace
            .split("\n")
            .map((l) => `+ ${l}`)
            .join("\n")}`,
      )
      .join("\n\n");
  const runEdit = async (filePath: string, instruction: string): Promise<string> => {
    const path = filePath.trim().replace(/^["']|["']$/g, "");
    if (!path || !instruction.trim()) return "";
    setBusy(true);
    try {
      const inCtx = ctxFiles().find((f) => f.path === path);
      const content = inCtx ? inCtx.content : await readTextFile(path);
      const plan = await agentEditPlan(path, content, instruction.trim());
      if (!plan.edits.length) {
        setFeed((f) => [...f, { role: "assistant", text: `I couldn't make that edit: ${plan.summary}` }]);
        return plan.summary;
      }
      const { out, failed } = applyEdits(content, plan.edits);
      if (out === content) {
        setFeed((f) => [
          ...f,
          {
            role: "error",
            text: `Couldn't find the text to change in ${path}${failed.length ? ` (missed: ${failed.join("; ")})` : ""}. Try “read ${path}” first so I'm looking at the current version.`,
          },
        ]);
        return "Couldn't apply the edit.";
      }
      const diff =
        editDiffText(plan.edits) +
        (failed.length ? `\n\n⚠ ${failed.length} edit(s) didn't match the file and were skipped.` : "");
      setFeed((f) => [
        ...f,
        {
          role: "edit",
          text: `✏ ${path} — ${plan.summary}`,
          editPath: path,
          editNew: out,
          editDiff: diff,
          pending: true,
        },
      ]);
      return `Drafted an edit to ${path.split(/[/\\]/).pop()} — review the diff and tap Apply.`;
    } catch (e) {
      const m = String(e);
      setFeed((f) => [...f, { role: "error", text: m }]);
      return m;
    } finally {
      setBusy(false);
    }
  };
  const approveEdit = async (idx: number, path: string, content: string) => {
    setFeed((f) => f.map((it, i) => (i === idx ? { ...it, pending: false } : it)));
    try {
      await writeTextFile(path, content);
      setCtxFiles((c) => c.map((f) => (f.path === path ? { ...f, content } : f)));
      setFeed((f) => [...f, { role: "action", text: `✓ Wrote ${path.split(/[/\\]/).pop()}.` }]);
      resolveChainGate(true, `applied the edit to ${path.split(/[/\\]/).pop()}`);
    } catch (e) {
      setFeed((f) => [...f, { role: "error", text: String(e) }]);
      resolveChainGate(false, String(e));
    }
  };
  const cancelEdit = (idx: number) => {
    setFeed((f) =>
      f.map((it, i) => (i === idx ? { ...it, pending: false, text: `${it.text}  — cancelled` } : it)),
    );
    resolveChainGate(false, "the user cancelled the edit");
  };

  // "read the terminal" → pull the active terminal's scrollback into context.
  const TERM_RE =
    /^(?:read|look at|show me|check|grab|capture|see)\s+(?:the\s+|my\s+)?terminal(?:\s+(?:output|buffer|scrollback|window))?\s*$|^what(?:'?s| does| is)?\s*(?:in|on)?\s*(?:the\s+|my\s+)?terminal(?:\s+say(?:ing)?)?\s*\??$|^terminal\s+(?:output|contents?)\s*$/i;
  const runReadTerminal = (): string => {
    const t = activeTerminalText();
    if (!t || !t.text.trim()) {
      setFeed((f) => [
        ...f,
        { role: "error", text: "No terminal output to read — open a Terminal tab and run something first." },
      ]);
      return "There's no terminal output yet.";
    }
    setCtxFiles((c) =>
      [
        ...c.filter((f) => f.path !== "terminal"),
        { path: "terminal", name: "terminal output", content: t.text },
      ].slice(-8),
    );
    const lines = t.text.split("\n").length;
    setFeed((f) => [
      ...f,
      { role: "action", text: `🖥 Read your terminal (${lines} lines) — it's in context now.` },
    ]);
    return "Got your terminal output — what's up with it?";
  };

  // #4 UI introspection — inspect an element's computed style/visibility, dump the
  // CSS theme variables, or snapshot the app state. Results go into context too.
  const addContext = (path: string, name: string, content: string) =>
    setCtxFiles((c) => [...c.filter((f) => f.path !== path), { path, name, content }].slice(-8));
  const STATE_RE =
    /^(?:flux|app|ui)\s+state\b|^(?:debug|inspect|show)\s+(?:the\s+)?(?:app|ui|flux)\s+state\b|^what(?:'?s| is)\s+(?:the\s+)?(?:current\s+)?(?:app|ui|flux)\s+state\b/i;
  const VARS_RE =
    /^(?:(?:list|show|dump)\s+(?:me\s+)?)?(?:css|theme)\s+(?:variables?|vars|custom\s+properties)\b|^(?:what(?:'?s| is)|show me)\s+(?:the\s+(?:value\s+of\s+)?)?(--[\w-]+)\b/i;
  const INSPECT_RE = /^(?:inspect|examine)\s+(?:the\s+|element\s+)?(\S[\s\S]*?)\s*$/i;
  const runState = (): string => {
    const r = fluxStateSnapshot();
    addContext("app-state", "app state", r);
    setFeed((f) => [...f, { role: "assistant", text: r }]);
    return "Here's the current Flux UI state — it's in context if you want to dig in.";
  };
  const runVars = (name?: string): string => {
    const r = themeVarsDump(name);
    addContext("css-vars", name ? `var ${name}` : "css variables", r);
    setFeed((f) => [...f, { role: "assistant", text: r }]);
    return name ? r : "Dumped the CSS theme variables into context.";
  };
  const runInspect = (sel: string): string => {
    const r = inspectElement(sel.trim());
    addContext(`inspect:${sel.trim()}`, `inspect ${sel.trim().slice(0, 24)}`, r);
    setFeed((f) => [...f, { role: "assistant", text: r }]);
    return "Inspected it — details are in the panel and context.";
  };
  const refreshMemory = () =>
    void memoryRead()
      .then(setMemText)
      .catch(() => {});
  const REMEMBER_RE =
    /^(?:\/remember|remember|note|make a note|keep in mind|save (?:to memory|this))\b[:,]?\s+(?:that\s+|to\s+)?(.+)/i;
  const RECALL_RE =
    /^(?:\/memory|what do you remember|show (?:me )?(?:your |the )?memory|what'?s in your memory)\b/i;
  const runRemember = async (fact: string): Promise<string> => {
    const f = fact.trim().replace(/[?.!]+$/, "");
    if (!f) return "";
    try {
      const msg = await memoryAppend(f);
      refreshMemory();
      setFeed((fd) => [...fd, { role: "action", text: `🧠 Remembered: ${f}` }]);
      return msg;
    } catch (e) {
      const m = String(e);
      setFeed((fd) => [...fd, { role: "error", text: m }]);
      return m;
    }
  };
  const runRecall = (): string => {
    const mem = memText().trim();
    const text = mem
      ? mem
      : "I don't have anything in my memory yet. Say “remember that …” to add something.";
    setFeed((fd) => [...fd, { role: "assistant", text }]);
    return mem ? "Here's what I remember." : "Nothing in my memory yet.";
  };

  // "what can you do" / "/help" → a deterministic capabilities card.
  const HELP_RE =
    /^(?:\/help|\/capabilities|what can you do\b|what (?:are|r) your (?:capabilities|features|abilities|powers)|show (?:me )?(?:your )?(?:capabilities|features)|list (?:your )?(?:commands|capabilities)|what can i (?:ask|say|tell you)\b)/i;
  const runHelp = (): string => {
    const card =
      "Here's what I can do in Flux 💫\n" +
      "⏰ Reminders — “remind me to … at 3pm” · “what are my reminders”\n" +
      "🧠 Memory — “remember that …” · “what do you remember”\n" +
      "💻 Terminal — “run <cmd>” (or just ask, e.g. “list files in my home dir”); I confirm before running\n" +
      "🖥 System — “system status” · “how's my CPU” · “what's using memory”\n" +
      "🔎 Search — “search …” · “open a new tab and search …”\n" +
      "🎵 Music — “play my liked songs” · “shuffle on” · “skip” · “launch spotify”\n" +
      "📄 Page — “/act <do X here>” · “/task <multi-step goal>” · ask about the page or all tabs\n" +
      "🔗 Chains — join steps with “then”/“+”, e.g. “read foo.rs then fix the bug then run the tests”\n" +
      "🛠 Fix loop — “/fix <goal>”, e.g. “/fix make the tests pass”; I run → read the failure → fix → re-run\n" +
      "⚡ Power Platform — “/pac <request>”, e.g. “/pac export my solution Contoso”; I map it to a pac CLI command you approve\n" +
      "✎ Notes — just ask (“save this into my Convex notebook”), or “/note <what to add>”; you see the exact text and approve before anything is written\n" +
      "🎙 Voice — “Hey Gemma” always-on + push-to-talk; talk over me or tap ■ Stop to interrupt";
    setFeed((fd) => [...fd, { role: "assistant", text: card }]);
    return "I can handle reminders, memory, terminal commands, system stats, web search, music, page actions, and voice. What would you like to do?";
  };

  // System awareness — "system status" / "how's my cpu/memory" / "what's using ram".
  const SYS_RE =
    /^(?:system\s+(?:status|stats|info|usage)|how'?s?\s+my\s+(?:system|cpu|memory|ram|pc|computer)|(?:cpu|memory|ram)\s+usage|what'?s\s+(?:using|eating|hogging)\s+(?:my\s+)?(?:memory|ram|cpu))\b/i;
  const runSysStats = async (): Promise<string> => {
    try {
      const s = await systemStats();
      const gb = (mb: number) => (mb / 1024).toFixed(1);
      const sz = (mb: number) => (mb >= 1024 ? `${gb(mb)} GB` : `${mb} MB`);
      const top = s.top
        .slice(0, 5)
        .map((p) => `${p.name} ${sz(p.memMb)}`)
        .join(", ");
      setFeed((fd) => [
        ...fd,
        {
          role: "assistant",
          text: `🖥 CPU ${s.cpuPct}% · RAM ${gb(s.memUsedMb)}/${gb(s.memTotalMb)} GB (${s.memPct}%)\nTop by memory: ${top}`,
        },
      ]);
      const hog = s.top[0]?.name;
      return `CPU's at ${s.cpuPct} percent, memory at ${s.memPct} percent${hog ? `. ${hog} is using the most.` : "."}`;
    } catch (e) {
      const m = String(e);
      setFeed((fd) => [...fd, { role: "error", text: m }]);
      return m;
    }
  };

  // Proactive reminders/to-dos — "remind me to X [in 10 min / at 3pm / tomorrow]".
  // Dated ones fire at their time (spoken + shown); "what are my reminders" lists.
  const userName = () => (localStorage.getItem("flux.user.name") || "").trim();
  const remindersSpoken = () => localStorage.getItem("flux.reminders.speak") !== "0";
  const REMIND_RE =
    /^(?:remind me|set (?:a )?reminder|add (?:a )?(?:reminder|to-?do|task)|reminder)\b(?:\s+to)?[:,]?\s+(.+)/i;
  const REMINDERS_LIST_RE =
    /^(?:what(?:'?s| is| are)?(?:\s+on)?\s+my|list (?:my)?|show (?:me )?(?:my )?|do i have any)\s*(?:reminders?|to-?dos?|tasks?)\b|^my (?:reminders?|to-?dos?|tasks?)\b/i;
  const runRemind = async (raw: string): Promise<string> => {
    const { text, due } = parseWhen(raw.trim().replace(/[?.!]+$/, ""), Date.now());
    if (!text) return "";
    try {
      await addReminder(text, due);
    } catch (e) {
      const m = String(e);
      setFeed((f) => [...f, { role: "error", text: m }]);
      return m;
    }
    if (due != null) {
      setFeed((f) => [...f, { role: "action", text: `⏰ Reminder set (${whenLabel(due)}): ${text}` }]);
      return `Okay — I'll remind you ${whenLabel(due)}.`;
    }
    setFeed((f) => [...f, { role: "action", text: `📝 To-do added: ${text}` }]);
    return "Added to your to-dos.";
  };
  const runListReminders = async (): Promise<string> => {
    const ps = await pendingReminders().catch(() => []);
    if (!ps.length) {
      setFeed((f) => [...f, { role: "assistant", text: "You have no reminders or to-dos." }]);
      return "Nothing on your list.";
    }
    const lines = ps.map((r) => `- ${r.text}${r.due != null ? ` — ${whenLabel(r.due)}` : ""}`).join("\n");
    setFeed((f) => [...f, { role: "assistant", text: `Your reminders & to-dos:\n${lines}` }]);
    return "Here's what's on your list.";
  };
  // The Rust scheduler fires due reminders (event + OS toast). We just react to the
  // event: show it and (optionally) speak it with the user's name.
  onMount(() => {
    void migrateReminders();
    let unlisten: (() => void) | undefined;
    void onReminderDue((r) => {
      setFeed((f) => [...f, { role: "assistant", text: `🔔 Reminder: ${r.text}` }]);
      if (remindersSpoken())
        void speak(`Hey${userName() ? ` ${userName()}` : ""}, just popping in — ${r.text}.`);
    }).then((u) => {
      unlisten = u;
    });
    onCleanup(() => unlisten?.());
  });

  // "search X" / "google X" / "open a new tab and search X" → open a new browser tab
  // with the result (searchResolve respects the default engine + navigate-vs-search).
  // Works typed or by voice. /act and /task can't do this — they act on the current
  // page's DOM, not browser tabs.
  const SEARCH_RE =
    /^(?:open\s+(?:a\s+|the\s+)?new\s+tab\s+(?:and\s+|to\s+)?(?:search(?:\s+(?:for|up))?\s+|google\s+|for\s+)?|search(?:\s+(?:for|up))?\s+|google\s+|look\s*up\s+)(.+)/i;
  const runSearch = async (query: string): Promise<string> => {
    const q = query.trim().replace(/[?.!]+$/, "");
    if (!q) return "";
    try {
      const { url } = await searchResolve(q);
      await openTab("browser", url);
      return `Opened a tab for “${q}”.`;
    } catch (e) {
      const m = String(e);
      setFeed((f) => [...f, { role: "error", text: m }]);
      return m;
    }
  };

  // Handle one spoken command from the "hey gemma" loop: show it in the feed,
  // route it through the same music / shell / chat pipeline as typed input, and
  // return the reply text for the conductor to speak.
  const voiceRespond = async (transcript: string): Promise<string> => {
    const t = transcript.trim();
    // NB: don't gate on working() here — it includes listening()/speaking(), which
    // the voice pipeline sets true *while handling this very command*, so it would
    // reject every spoken command. Only bail if a real request/task is in flight.
    if (!t || busy() || taskRunning()) return "";
    setFeed((f) => [...f, { role: "user", text: t }]);
    // Strip the wake word AND polite lead-ins ("can you", "please", "I want you
    // to", …) so spoken intents like "hey gemma, can you remind me to …" still
    // match the ^-anchored intent regexes instead of falling through to chat.
    const stripped = t
      .replace(/^\/?(hey\s+)?gemma[,:\s]+/i, "")
      .replace(/^(?:can|could|would|will)\s+you\s+/i, "")
      .replace(/^(?:please|kindly|hey|ok|okay)\s+/i, "")
      .replace(/^i(?:'?d| would)?\s+(?:like|want|need)\s+(?:you\s+)?to\s+/i, "")
      .trim();
    // Multi-step chain (#115) — "play my liked songs + shuffle on", etc.
    if (await maybeRunChain(stripped)) return "Okay, done.";
    const pac = stripped.match(PAC_RE);
    if (pac?.[1]) return await runPac(pac[1]);
    const sh = stripped.match(SHELL_RE);
    if (sh?.[1]) return await runShellCmd(sh[1]);
    const musicReply = await handleMusic(t);
    if (musicReply !== null) return musicReply;
    const vs = stripped.match(SEARCH_RE);
    if (vs?.[1]) return await runSearch(vs[1]);
    {
      const me = stripped.match(EDIT_RE);
      if (me?.[1] && me[2]) return await runEdit(me[1], me[2]);
    }
    {
      const mei = stripped.match(EDIT_IT_RE);
      if (mei?.[1]) {
        const lf = lastCtxFile();
        if (lf) return await runEdit(lf.path, mei[1]);
      }
    }
    if (TERM_RE.test(stripped)) return runReadTerminal();
    const vrf = stripped.match(FILE_RE);
    if (vrf?.[1]) return await runReadFile(vrf[1]);
    const rm = stripped.match(REMEMBER_RE);
    if (rm?.[1]) return await runRemember(rm[1]);
    if (RECALL_RE.test(stripped)) return runRecall();
    const rmd = stripped.match(REMIND_RE);
    if (rmd?.[1]) return await runRemind(rmd[1]);
    if (REMINDERS_LIST_RE.test(stripped)) return await runListReminders();
    if (SYS_RE.test(stripped)) return await runSysStats();
    if (HELP_RE.test(stripped)) return runHelp();
    if (STATE_RE.test(stripped)) return runState();
    {
      const mv = stripped.match(VARS_RE);
      if (mv) return runVars(mv[1]);
    }
    {
      const mi = stripped.match(INSPECT_RE);
      if (mi?.[1]) return runInspect(mi[1]);
    }
    const shellReply = await maybeShellPlan(stripped);
    if (shellReply !== null) return shellReply;
    const cp = convoPrompt(t); // memory
    const idx = feed().length;
    setFeed((f) => [...f, { role: "assistant", text: "" }]);
    let acc = "";
    const append = (c: string) => {
      acc += c;
      setFeed((f) => f.map((it, i) => (i === idx ? { ...it, text: it.text + c } : it)));
    };
    setBusy(true);
    try {
      await agentChatStream(cp, append);
      // Retry once with the bare question if the model returned nothing (see send()).
      if (!acc.trim()) await agentChatStream(t, append);
    } catch (e) {
      acc = String(e);
      setFeed((f) => f.map((it, i) => (i === idx ? { ...it, role: "error", text: acc } : it)));
    } finally {
      setBusy(false);
    }
    setFeed((f) => f.map((it, i) => (i === idx ? { ...it, text: it.text.trim() || "(no response)" } : it)));
    return acc.trim();
  };
  onMount(() => {
    setVoiceHandler(voiceRespond);
    if (heyGemmaEnabled()) void startConversation();
    refreshMemory();
    // Reopen the most recent conversation so a reload doesn't lose your place.
    const recent = chats()[0];
    if (recent && !feed().length) loadSession(recent);
  });

  // The active browser tab's URL (for "clip this page"), or null.
  const activePageUrl = (): string | null => {
    const t = tabs().find((x) => x.id === activeId());
    return t && t.kind === "browser" && !isStartUrl(t.url) ? t.url : null;
  };

  // "clip <url|this page> to scroll [tags: a, b]" → write access to Scroll (#118).
  const tryClipToScroll = async (text: string): Promise<boolean> => {
    if (!/\bclip\b/i.test(text) || !/\bscroll\b/i.test(text)) return false;
    let url = text.match(/https?:\/\/[^\s)]+/i)?.[0] ?? null;
    if (!url) url = activePageUrl();
    if (!url) {
      setFeed((f) => [
        ...f,
        {
          role: "error",
          text: 'Give me a URL to clip, or open the article first ("clip this page to scroll").',
        },
      ]);
      return true;
    }
    const tags = text
      .match(/\btags?\b\s*[:=]?\s*([^\n]+)$/i)?.[1]
      ?.replace(/\band\b/gi, ",")
      .replace(/\s+/g, " ")
      .trim();
    setFeed((f) => [...f, { role: "task", text: "📎 Clipping to Scroll…" }]);
    try {
      const r = await scrollClip(url, tags);
      setFeed((f) => [...f, { role: "action", text: `✓ ${r}${tags ? ` · tags: ${tags}` : ""}` }]);
    } catch (e) {
      setFeed((f) => [...f, { role: "error", text: String(e) }]);
    }
    return true;
  };

  // ─── Deterministic intents ────────────────────────────────────────────────
  // These matchers run BEFORE the model sees the message, so the exact phrasings
  // below are the real user-facing API. Gemma describes them to users from
  // `FLUX_CAPABILITIES` in crates/flux-agent/src/lib.rs — **edit both together**.
  // If the card drifts, the model teaches a phrasing that matches nothing here
  // and the request silently degrades into ordinary chat.

  /** Per-workspace memory of the last Onyx folder used, so a course workspace
   *  keeps filing into its own folder after you name it once. */
  const folderKey = () => `flux.onyx.folder.${activeWorkspaceName() ?? "default"}`;

  /**
   * "capture this lecture [to onyx/<folder>] [#tags] [as <title>]" — files the
   * page's own visible text (a lecture transcript, an article) into Onyx, so
   * it joins the KB and can be cited later. Nothing is retyped or re-fetched:
   * Rust reads the already-captured DOM text.
   */
  const tryCapturePage = async (text: string): Promise<boolean> => {
    if (!/\b(capture|transcript|lecture)\b/i.test(text)) return false;
    if (!/\b(capture|save|file|add)\b/i.test(text)) return false;
    const folderInText = text.match(/\bonyx\/\s*([^#\n:]+?)(?=\s+as\s|\s*[#:]|\s*$)/i)?.[1]?.trim();
    const folder = folderInText || localStorage.getItem(folderKey()) || undefined;
    const tags = (text.match(/#[\w-]+/g) ?? []).join(" ");
    const asTitle = text
      .replace(/#[\w-]+/g, " ")
      .match(/\bas\s+"?([^"\n]+?)"?\s*$/i)?.[1]
      ?.trim();
    const title =
      asTitle ||
      tabs()
        .find((t) => t.id === activeId())
        ?.title?.slice(0, 80) ||
      "Lecture";
    setFeed((f) => [...f, { role: "task", text: "🎓 Capturing this page into Onyx…" }]);
    try {
      const path = await onyxCapturePage(title, folder, tags || undefined);
      if (folderInText) localStorage.setItem(folderKey(), folderInText);
      setFeed((f) => [
        ...f,
        {
          role: "action",
          text: `✓ Captured${folder ? ` → ${folder}` : ""}: ${title}${tags ? `\n${tags}` : ""}\n${path}\nReindex the Notebook to make it searchable.`,
        },
      ]);
    } catch (e) {
      setFeed((f) => [...f, { role: "error", text: String(e).replace(/^Error:\s*/, "") }]);
    }
    return true;
  };

  // "save (this answer | <text>) to onyx[/<folder>] [#tags] [as <title>]" → write
  // a note to the vault (#118). The folder is spelled as a path (`onyx/Optimization`)
  // rather than "in <x>" — "in" is far too common in prose to parse safely.
  const trySaveToOnyx = async (text: string): Promise<boolean> => {
    if (!/\bonyx\b/i.test(text) || !/\b(save|note|remember|add|write)\b/i.test(text)) return false;
    // `onyx/<folder>` up to a #tag, an "as <title>", a colon, or end of line.
    const folderInText = text.match(/\bonyx\/\s*([^#\n:]+?)(?=\s+as\s|\s*[#:]|\s*$)/i)?.[1]?.trim();
    const folder = folderInText || localStorage.getItem(folderKey()) || undefined;
    // #tags anywhere in the request; stripped from the body so they don't
    // pollute the note text.
    const tags = (text.match(/#[\w-]+/g) ?? []).join(" ");
    text = text.replace(/#[\w-]+/g, " ").replace(/\bonyx\/\s*[^#\n:]+/i, "onyx");
    const asTitle = text.match(/\bas\s+"?([^"\n]+?)"?\s*$/i)?.[1]?.trim();
    let content = "";
    if (/\b(that|this answer|the answer|your answer|last answer)\b/i.test(text)) {
      content = [...feed()].reverse().find((it) => it.role === "assistant")?.text ?? "";
      if (!content.trim()) {
        setFeed((f) => [
          ...f,
          {
            role: "error",
            text: 'No previous answer to save — ask me something first, then "save that to Onyx".',
          },
        ]);
        return true;
      }
    } else {
      // Everything after "… to onyx" (minus a trailing "as <title>") is the note body.
      content = text
        .replace(/^.*?\bto\s+onyx\b/i, "")
        .replace(/\bas\s+"?[^"\n]+"?\s*$/i, "")
        .replace(/^[\s:–-]+/, "")
        .trim();
      if (!content) {
        setFeed((f) => [
          ...f,
          {
            role: "error",
            text: 'Tell me what to save, e.g. "save to Onyx: gravity-wave detector notes…" or "save that to Onyx".',
          },
        ]);
        return true;
      }
    }
    const title = asTitle || content.split("\n")[0]!.slice(0, 60).trim() || "Note";
    setFeed((f) => [...f, { role: "task", text: "📝 Saving to Onyx…" }]);
    try {
      const path = await onyxNewNote(title, content, folder, tags || undefined);
      // Remember an explicitly named folder for this workspace's later saves.
      if (folderInText) localStorage.setItem(folderKey(), folderInText);
      const where = folder ? ` → ${folder}` : "";
      const tagged = tags ? `\n${tags}` : "";
      setFeed((f) => [...f, { role: "action", text: `✓ Saved to Onyx${where}: ${title}${tagged}\n${path}` }]);
      // Research-integrity check (#124): does this contradict / duplicate / add to
      // what's already in the KB? Best-effort — never blocks the save.
      try {
        const chk = await kbCheck(content);
        const icon =
          chk.verdict === "contradicts"
            ? "⚠"
            : chk.verdict === "overlaps"
              ? "↔"
              : chk.verdict === "adds"
                ? "➕"
                : "✦";
        setFeed((f) => [
          ...f,
          {
            role: "assistant",
            text: `${icon} ${chk.note}`,
            citations: chk.related.length ? chk.related : undefined,
          },
        ]);
      } catch {
        /* check is best-effort */
      }
    } catch (e) {
      setFeed((f) => [...f, { role: "error", text: String(e) }]);
    }
    return true;
  };

  // ── Calendar (#114): Gemma reads + writes the home calendar (local events) ───
  const pad2c = (n: number) => String(n).padStart(2, "0");
  const isoOf = (d: Date) => `${d.getFullYear()}-${pad2c(d.getMonth() + 1)}-${pad2c(d.getDate())}`;
  const hmOf = (d: Date) => `${pad2c(d.getHours())}:${pad2c(d.getMinutes())}`;
  const WEEKDAYS_L = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
  const MONTHS_L = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
  const dayLabelOf = (iso: string) => {
    const d = new Date(`${iso}T00:00`);
    const t = isoOf(new Date());
    if (iso === t) return "Today";
    if (iso === isoOf(new Date(Date.now() + 864e5))) return "Tomorrow";
    return d.toLocaleDateString([], { weekday: "long", month: "short", day: "numeric" });
  };

  /** Parse a date/time/duration out of a scheduling phrase. Returns the matched
   *  date/start/end plus the remaining text (the event title). */
  const parseEventSpec = (input: string): { date: string; start: string; end: string; title: string } => {
    let rest = input;
    const now = new Date();
    let date: Date | null = null;
    let start: string = "";
    let durMin = 60;
    const cut = (re: RegExp) => {
      const m = rest.match(re);
      if (m) {
        rest = (rest.slice(0, m.index) + rest.slice(m.index! + m[0].length)).replace(/\s{2,}/g, " ").trim();
      }
      return m;
    };

    // Duration — "for 90 min" / "for 2 hours".
    {
      const m = cut(/\bfor\s+(\d+(?:\.\d+)?)\s*(hours?|hrs?|h|minutes?|mins?|m)\b/i);
      if (m) {
        const n = Number(m[1]);
        durMin = /^h/i.test(m[2]!) ? Math.round(n * 60) : Math.round(n);
      }
    }

    // Date — today / tomorrow / weekday / "next week" / month-day.
    if (cut(/\btoday\b/i)) date = new Date(now);
    else if (cut(/\btomorrow\b/i)) date = new Date(now.getTime() + 864e5);
    else {
      const wd = cut(new RegExp(`\\b(next\\s+|this\\s+|on\\s+)?(${WEEKDAYS_L.join("|")})\\b`, "i"));
      if (wd) {
        const target = WEEKDAYS_L.indexOf(wd[2]!.toLowerCase());
        let delta = (target - now.getDay() + 7) % 7;
        if (/next/i.test(wd[1] ?? "")) delta += 7;
        date = new Date(now.getTime() + delta * 864e5);
      } else if (cut(/\bnext\s+week\b/i)) {
        date = new Date(now.getTime() + 7 * 864e5);
      } else {
        const mo =
          cut(
            new RegExp(`\\b(?:on\\s+)?(${MONTHS_L.join("|")})\\w*\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b`, "i"),
          ) ||
          cut(new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?(${MONTHS_L.join("|")})\\w*\\b`, "i"));
        if (mo) {
          const firstIsMonth = MONTHS_L.includes(mo[1]!.slice(0, 3).toLowerCase());
          const monIdx = MONTHS_L.indexOf((firstIsMonth ? mo[1]! : mo[2]!).slice(0, 3).toLowerCase());
          const dayNum = Number(firstIsMonth ? mo[2]! : mo[1]!);
          let y = now.getFullYear();
          if (new Date(y, monIdx, dayNum).getTime() < now.getTime() - 864e5) y += 1; // already passed → next year
          date = new Date(y, monIdx, dayNum);
        }
      }
    }

    // Time — "at 3[:30] pm" / "3pm" / "noon" / "midnight".
    if (cut(/\b(?:at\s+)?noon\b/i)) start = "12:00";
    else if (cut(/\b(?:at\s+)?midnight\b/i)) start = "00:00";
    else {
      const tm =
        cut(/\b(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i) || cut(/\bat\s+(\d{1,2})(?::(\d{2}))?\b/i);
      if (tm) {
        let h = Number(tm[1]);
        const mi = tm[2] ? Number(tm[2]) : 0;
        const ap = (tm[3] ?? "").toLowerCase();
        if (ap === "pm" && h < 12) h += 12;
        if (ap === "am" && h === 12) h = 0;
        start = `${pad2c(h)}:${pad2c(mi)}`;
      }
    }

    if (!date) {
      // No explicit date: if a time was given and it's already past today, use tomorrow.
      date = new Date(now);
      if (start) {
        const [h, m] = start.split(":").map(Number);
        const cand = new Date(now);
        cand.setHours(h!, m!, 0, 0);
        if (cand.getTime() <= now.getTime()) date = new Date(now.getTime() + 864e5);
      }
    }
    let end = "";
    if (start) {
      const [h, m] = start.split(":").map(Number);
      const e = new Date(0);
      e.setHours(h!, (m ?? 0) + durMin, 0, 0);
      end = hmOf(e);
    }
    // Clean leftover connective words from the title.
    const title = rest
      .replace(/^(?:to|for|about|:|-|–)\s+/i, "")
      .replace(/\b(?:on|in|to)\s+(?:my\s+)?calendar\b/gi, "")
      .replace(/\s{2,}/g, " ")
      .trim();
    return { date: isoOf(date), start, end, title };
  };

  const calRange = (text: string): { lo: string; hi: string; label: string } => {
    const today = new Date();
    const t = isoOf(today);
    if (/\btomorrow\b/i.test(text)) {
      const d = isoOf(new Date(Date.now() + 864e5));
      return { lo: d, hi: d, label: "tomorrow" };
    }
    if (/\b(this\s+)?week\b|\bnext\s+7\b|\bcoming\s+up\b|\bupcoming\b/i.test(text))
      return { lo: t, hi: isoOf(new Date(Date.now() + 7 * 864e5)), label: "this week" };
    for (let i = 0; i < 7; i++) {
      if (new RegExp(`\\b${WEEKDAYS_L[i]}\\b`, "i").test(text)) {
        const delta = (i - today.getDay() + 7) % 7;
        const d = isoOf(new Date(Date.now() + delta * 864e5));
        return { lo: d, hi: d, label: dayLabelOf(d) };
      }
    }
    if (/\btoday\b|\bright now\b/i.test(text)) return { lo: t, hi: t, label: "today" };
    return { lo: t, hi: isoOf(new Date(Date.now() + 7 * 864e5)), label: "the next 7 days" };
  };

  /** Read the calendar — "what's on my calendar today / this week / friday". */
  const tryCalendarQuery = async (text: string): Promise<boolean> => {
    if (!/\b(calendar|schedule|agenda|events?|meetings?|appointments?|free|busy)\b/i.test(text)) return false;
    if (!/\b(what|whats|what'?s|show|list|any|anything|do i have|free|busy|when|view|my)\b/i.test(text))
      return false;
    const { lo, hi, label } = calRange(text);
    setFeed((f) => [...f, { role: "task", text: "📅 Checking your calendar…" }]);
    let evs;
    try {
      evs = (await calEvents()).filter((e) => e.date >= lo && e.date <= hi);
    } catch (e) {
      setFeed((f) => [...f, { role: "error", text: String(e) }]);
      return true;
    }
    if (!evs.length) {
      const msg = `You're free ${label}. 🎉`;
      setFeed((f) => [...f, { role: "assistant", text: msg }]);
      return true;
    }
    const groups: { date: string; items: typeof evs }[] = [];
    for (const e of evs) {
      const g = groups.at(-1);
      if (g && g.date === e.date) g.items.push(e);
      else groups.push({ date: e.date, items: [e] });
    }
    const body = groups
      .map(
        (g) =>
          `**${dayLabelOf(g.date)}**\n` +
          g.items
            .map(
              (e) =>
                `• ${e.time ? `${e.time}${e.end ? `–${e.end}` : ""}` : "all-day"} — ${e.summary}${e.location ? ` (${e.location})` : ""}`,
            )
            .join("\n"),
      )
      .join("\n\n");
    setFeed((f) => [...f, { role: "assistant", text: `Here's your schedule for ${label}:\n\n${body}` }]);
    return true;
  };

  /** Add a local event — "schedule lunch with Sam friday at noon for 90 min". */
  const tryCalendarAdd = async (text: string): Promise<boolean> => {
    const m = text.match(
      /^(?:schedule|book|plan|add|create|put|set\s*up|new)\b\s*(?:an?\s+)?(?:event|meeting|appointment|call)?\s*[:\-]?\s*([\s\S]+)/i,
    );
    if (!m?.[1]) return false;
    const spec = parseEventSpec(m[1]);
    // Only treat as a calendar add if we found a date/time or the user said "calendar/event".
    if (
      !spec.start &&
      !/\b(calendar|event|meeting|appointment|all[\s-]?day|today|tomorrow|next|on)\b/i.test(text)
    )
      return false;
    if (!spec.title) {
      setFeed((f) => [...f, { role: "error", text: "What should I call the event?" }]);
      return true;
    }
    setFeed((f) => [...f, { role: "task", text: "📅 Adding to your calendar…" }]);
    try {
      const ev = await calEventAdd({ title: spec.title, date: spec.date, start: spec.start, end: spec.end });
      const when = spec.start
        ? `${dayLabelOf(spec.date)} at ${spec.start}${spec.end ? `–${spec.end}` : ""}`
        : `${dayLabelOf(spec.date)} (all day)`;
      setFeed((f) => [...f, { role: "action", text: `✓ Added "${ev.title}" — ${when}` }]);
    } catch (e) {
      setFeed((f) => [...f, { role: "error", text: String(e) }]);
    }
    return true;
  };

  /** Find local events whose title contains `q` (case-insensitive). */
  const findLocalByTitle = async (q: string) => {
    const all = await calLocalEvents();
    const needle = q.toLowerCase().trim();
    return all.filter((e) => e.title.toLowerCase().includes(needle));
  };

  /** Delete a local event — "cancel my dentist appointment". */
  const tryCalendarDelete = async (text: string): Promise<boolean> => {
    if (!/\b(calendar|event|meeting|appointment)\b/i.test(text)) return false;
    const m = text.match(
      /^(?:delete|cancel|remove|clear)\s+(?:the\s+|my\s+)?(?:event\s+|meeting\s+|appointment\s+)?(.+?)(?:\s+(?:event|meeting|appointment))?(?:\s+(?:from|on|in|off)\s+(?:my\s+)?calendar)?\s*$/i,
    );
    if (!m?.[1]) return false;
    const q = m[1].replace(/\b(?:event|meeting|appointment)\b/gi, "").trim();
    if (!q) return false;
    const hits = await findLocalByTitle(q);
    if (!hits.length) {
      setFeed((f) => [
        ...f,
        {
          role: "assistant",
          text: `I couldn't find a calendar event matching "${q}". (I can only edit events you added in Flux — Google-feed events are read-only.)`,
        },
      ]);
      return true;
    }
    if (hits.length > 1) {
      setFeed((f) => [
        ...f,
        {
          role: "assistant",
          text: `I found ${hits.length} matching events:\n${hits.map((e) => `• ${e.title} — ${dayLabelOf(e.date)}${e.start ? ` ${e.start}` : ""}`).join("\n")}\nWhich one? Be more specific.`,
        },
      ]);
      return true;
    }
    const ev = hits[0]!;
    try {
      await calEventDelete(ev.id);
      setFeed((f) => [...f, { role: "action", text: `✓ Deleted "${ev.title}" (${dayLabelOf(ev.date)}).` }]);
    } catch (e) {
      setFeed((f) => [...f, { role: "error", text: String(e) }]);
    }
    return true;
  };

  /** Move a local event — "move my standup to tomorrow at 10am". */
  const tryCalendarMove = async (text: string): Promise<boolean> => {
    const m = text.match(
      /^(?:move|reschedule|shift|push|change)\s+(?:the\s+|my\s+)?(.+?)\s+to\s+([\s\S]+)$/i,
    );
    if (!m?.[1] || !m[2]) return false;
    if (!/\b(calendar|event|meeting|appointment)\b/i.test(text) && !parseEventSpec(m[2]).start) return false;
    const q = m[1].replace(/\b(?:event|meeting|appointment)\b/gi, "").trim();
    const hits = await findLocalByTitle(q);
    if (!hits.length) {
      setFeed((f) => [
        ...f,
        {
          role: "assistant",
          text: `I couldn't find an event matching "${q}" to move. (Only Flux-added events are editable.)`,
        },
      ]);
      return true;
    }
    if (hits.length > 1) {
      setFeed((f) => [
        ...f,
        {
          role: "assistant",
          text: `Several events match "${q}" — which? ${hits.map((e) => e.title).join(", ")}`,
        },
      ]);
      return true;
    }
    const ev = hits[0]!;
    const spec = parseEventSpec(`x ${m[2]}`); // prefix so leftover title is ignored
    const patch: { date: string; start?: string; end?: string } = { date: spec.date };
    if (spec.start) {
      // Preserve the original duration if known.
      const origDur =
        ev.start && ev.end
          ? Number(ev.end.slice(0, 2)) * 60 +
            Number(ev.end.slice(3)) -
            (Number(ev.start.slice(0, 2)) * 60 + Number(ev.start.slice(3)))
          : 60;
      patch.start = spec.start;
      const [h, mm] = spec.start.split(":").map(Number);
      const e = new Date(0);
      e.setHours(h!, (mm ?? 0) + origDur, 0, 0);
      patch.end = hmOf(e);
    }
    try {
      await calEventUpdate(ev.id, patch);
      setFeed((f) => [
        ...f,
        {
          role: "action",
          text: `✓ Moved "${ev.title}" to ${dayLabelOf(spec.date)}${spec.start ? ` at ${spec.start}` : ""}.`,
        },
      ]);
    } catch (e) {
      setFeed((f) => [...f, { role: "error", text: String(e) }]);
    }
    return true;
  };

  /** Calendar dispatcher — query / add / move / delete. Returns true if handled. */
  const tryCalendar = async (text: string): Promise<boolean> => {
    if (await tryCalendarQuery(text)) return true;
    if (await tryCalendarMove(text)) return true;
    if (await tryCalendarDelete(text)) return true;
    if (await tryCalendarAdd(text)) return true;
    return false;
  };

  const send = async (
    p: string,
    /** Set when re-entering after note detection declined: skip the detector
     *  (or it loops) and don't echo the prompt a second time. */
    opts?: { skipNoteDetect?: boolean; echoed?: boolean },
  ) => {
    const att = attachment();
    if ((!p && !att) || working() || taskRunning()) return;
    // "/task <goal>" runs the multi-step agent loop (#A) — not with an attachment.
    if (!att) {
      const task = p.match(/^\/task\s+([\s\S]+)/i);
      if (task?.[1]) {
        setPrompt("");
        void runTask(task[1].trim());
        return;
      }
      // "/note <request>" drafts something to ADD to your notes. Explicitly a
      // slash command, not an inference from phrasing: writing is the one thing
      // here that changes your own files, and it should never happen because a
      // question was misread as an instruction.
      const note = p.match(/^\/note\s+([\s\S]+)/i);
      if (note?.[1]) {
        setPrompt("");
        setFeed((f) => [...f, { role: "user", text: p }]);
        void planNote(note[1].trim(), true);
        return;
      }
      // Plain language that asks for *work* goes to the same loop (#158). Ordinary
      // chat has no tools, and the model doesn't know that — so "go through the
      // PDFs in /x and summarise them into Onyx" produced a confident plan, an
      // offer to start, and then the same offer again, forever. Nothing here
      // writes or runs anything on its own: every side-effecting step still
      // stops at its approval card, which is what lets detection be generous.
      if (!opts?.skipNoteDetect && looksAgentic(p)) {
        setPrompt("");
        setFeed((f) => [...f, { role: "user", text: p }]);
        void runAdaptiveTask(p);
        return;
      }
      // Asking in plain words used to do nothing at all: `/note` was the only
      // route, so "write a summary into my Convex notebook" fell through to
      // ordinary chat and she'd answer as if she had. Silence was the wrong
      // failure — the *approval card* is what protects your notes, and planning
      // never writes, so detection can afford to be generous. A false positive
      // costs one Discard; a false negative costs the feature.
      if (!opts?.skipNoteDetect && looksLikeNoteWrite(p)) {
        setPrompt("");
        setFeed((f) => [...f, { role: "user", text: p }]);
        if (await planNote(p, false)) return;
        // Nothing to propose — it wasn't really a write request, so answer it.
        void send(p, { skipNoteDetect: true, echoed: true });
        return;
      }
      // "/fix <goal>" runs the adaptive tool loop — run → read the failure → fix →
      // re-run, reacting to each result until done or stuck (#115 follow-up).
      const fix = p.match(/^\/(?:fix|auto|iterate)\s+([\s\S]+)/i);
      if (fix?.[1]) {
        setPrompt("");
        setFeed((f) => [...f, { role: "user", text: p }]);
        void runAdaptiveTask(fix[1].trim());
        return;
      }
    }
    setPrompt("");
    if (!opts?.echoed) {
      setFeed((f) => [
        ...f,
        { role: "user", text: p, image: att?.kind === "image" ? att.dataUrl : undefined },
      ]);
    }
    setBusy(true);
    try {
      // An attachment routes to the vision model (image) or chat-with-file (text).
      if (att) {
        setAttachment(null);
        if (att.kind === "image") {
          const answer = await agentVision(att.b64, p);
          const text = answer.trim();
          setFeed((f) => [...f, { role: "assistant", text }]);
          void speak(text);
        } else {
          const idx = feed().length;
          setFeed((f) => [...f, { role: "assistant", text: "" }]);
          let acc = "";
          const append = (chunk: string) => {
            acc += chunk;
            setFeed((f) => f.map((it, i) => (i === idx ? { ...it, text: it.text + chunk } : it)));
          };
          await agentChatStream(
            `${p || "Summarize this file."}\n\n--- file: ${att.name} ---\n${att.text}`,
            append,
          );
          const text = acc.trim() || "(no response)";
          setFeed((f) => f.map((it, i) => (i === idx ? { ...it, text } : it)));
          void speak(text);
        }
        return;
      }
      // Visual Lens — "/lens", "what is this", "identify this/it", "what am I looking at".
      const lens =
        p.match(/^\/lens(?:\s+([\s\S]+))?$/i) ||
        p.match(/^(?:what(?:'?s| is) this|identify (?:this|it)|what am i looking at)\b[\s\S]*/i);
      if (lens) {
        await runLens(lens[1]?.trim() || (/^\/lens/i.test(p) ? "" : p));
        return;
      }
      // Strip a typed "hey gemma," prefix AND polite lead-ins so "hey gemma, can you
      // remind me to …" / "please run …" still match the ^-anchored intent regexes.
      const pc = p
        .replace(/^\/?(?:hey\s+)?gemma[,:\s]+/i, "")
        .replace(/^(?:can|could|would|will)\s+you\s+/i, "")
        .replace(/^(?:please|kindly)\s+/i, "")
        .replace(/^i(?:'?d| would)?\s+(?:like|want|need)\s+(?:you\s+)?to\s+/i, "")
        .trim();
      // Multi-step chain (#115) — "read foo.rs, fix the bug, then run the tests" →
      // decompose + run each step. Only fires on a connector + a real first action,
      // so single commands and chat fall straight through.
      if (await maybeRunChain(pc)) return;
      // Shell command — "run …" / "execute …" / "/run …" (rm + destructive blocked).
      const shell = pc.match(SHELL_RE);
      if (shell?.[1]) {
        await runShellCmd(shell[1].trim());
        return;
      }
      // Music command (AudioPulse) before chat — "play …" / "skip" / "pause" / …
      if (await runMusic(p)) return;
      // "search …" / "open a new tab and search …" → open a browser tab.
      const search = pc.match(SEARCH_RE);
      if (search?.[1]) {
        await runSearch(search[1]);
        return;
      }
      // "edit <file>: <instruction>" / "change it to …" → propose an edit (diff + approve).
      {
        const me = pc.match(EDIT_RE);
        if (me?.[1] && me[2]) {
          await runEdit(me[1], me[2]);
          return;
        }
      }
      {
        const mei = pc.match(EDIT_IT_RE);
        if (mei?.[1]) {
          const lf = lastCtxFile();
          if (lf) {
            await runEdit(lf.path, mei[1]);
            return;
          }
        }
      }
      // "read the terminal" → pull its scrollback into context (before the file read).
      if (TERM_RE.test(pc)) {
        runReadTerminal();
        return;
      }
      // "read <file>" → pull a file into Gemma's context; "forget the files" clears.
      const rf = pc.match(FILE_RE);
      if (rf?.[1]) {
        await runReadFile(rf[1]);
        return;
      }
      if (/^(?:forget|clear|drop|remove)\s+(?:the\s+)?(?:files?|file\s+context|context)\b/i.test(pc)) {
        clearCtxFiles();
        setFeed((f) => [...f, { role: "action", text: "🗑 Cleared the file context." }]);
        return;
      }
      // Long-term memory — "remember that …" / "what do you remember".
      const rem = pc.match(REMEMBER_RE);
      if (rem?.[1]) {
        await runRemember(rem[1]);
        return;
      }
      if (RECALL_RE.test(pc)) {
        runRecall();
        return;
      }
      // Reminders / to-dos — "remind me to …" / "what are my reminders".
      const rmd = pc.match(REMIND_RE);
      if (rmd?.[1]) {
        await runRemind(rmd[1]);
        return;
      }
      if (REMINDERS_LIST_RE.test(pc)) {
        await runListReminders();
        return;
      }
      // Calendar (#114) — "what's on my calendar", "schedule lunch tomorrow at noon",
      // "move my standup to 10am", "cancel the dentist appointment". Local events only.
      if (await tryCalendar(pc)) return;
      if (SYS_RE.test(pc)) {
        await runSysStats();
        return;
      }
      if (HELP_RE.test(pc)) {
        runHelp();
        return;
      }
      // #4 UI introspection (check state/vars before the broad "inspect <selector>").
      if (STATE_RE.test(pc)) {
        runState();
        return;
      }
      {
        const mv = pc.match(VARS_RE);
        if (mv) {
          runVars(mv[1]);
          return;
        }
      }
      {
        const mi = pc.match(INSPECT_RE);
        if (mi?.[1]) {
          runInspect(mi[1]);
          return;
        }
      }
      // Write access to the user's corpora (#118): clip to Scroll / save to Onyx.
      if (await tryClipToScroll(p)) return;
      // Before the generic Onyx save: "save this lecture to onyx" is a page
      // capture, not a note dictated in the prompt.
      if (await tryCapturePage(p)) return;
      if (await trySaveToOnyx(p)) return;
      // Natural request about the machine/files → propose a shell command (approval).
      if ((await maybeShellPlan(p)) !== null) return;
      // "/act <…>" (or /do) drives a page action; everything else is chat,
      // grounded in the active page or all open tabs per the scope toggle.
      const act = p.match(/^\/(?:act|do)\s+([\s\S]+)/i);
      if (act?.[1]) {
        // Plan first, then PREVIEW — nothing touches the page until you approve (#8).
        const action = await agentPlan(act[1].trim());
        if (action.action === "refuse") {
          setFeed((f) => [...f, { role: "assistant", text: describeAction(action) }]);
        } else {
          setFeed((f) => [...f, { role: "plan", text: describeAction(action), action, pending: true }]);
        }
      } else if (scope() === "thread" && pageThread()) {
        // The page's PERSISTENT thread (ADR 0011): route through trace_chat_send
        // so both sides land in the visit's thread — the same conversation the
        // Trail shows, continued from here.
        const vid = pageThread()!.visit_id;
        const gen = ++replyGen;
        const idx = feed().length;
        setFeed((f) => [...f, { role: "assistant", text: "" }]);
        let acc = "";
        await traceChatSend(vid, p, (e) => {
          if (gen !== replyGen || e.kind !== "token") return;
          acc += e.text;
          setFeed((f) => f.map((it, i) => (i === idx ? { ...it, text: it.text + e.text } : it)));
        });
        if (gen !== replyGen) return;
        const text = acc.trim() || "(no response)";
        setFeed((f) => f.map((it, i) => (i === idx ? { ...it, text } : it)));
        // Keep the local mirror fresh (message count on the scope button).
        const id = activeId();
        if (id != null)
          void traceTabThread(id)
            .then(setPageThread)
            .catch(() => {});
        void speak(text);
      } else if (scope() === "notes") {
        // Ground the answer in the knowledge base with citations — every indexed
        // source, since no `sources` filter is passed (kb_answer's None matches
        // all of SOURCES, browsing snapshots included, not just notes/papers)
        // (#116). Uses kb_answer directly (its own grounded prompt), not the page
        // preamble; sources arrive first, then tokens stream into one bubble.
        const gen = ++replyGen;
        const idx = feed().length;
        setFeed((f) => [...f, { role: "assistant", text: "" }]);
        let acc = "";
        // Scoped to your own corpora: a button called "My notes" shouldn't be
        // answering from pages you merely visited, and the Trail already graphs
        // those separately.
        await kbAnswer(
          p,
          (e) => {
            if (gen !== replyGen) return;
            if (e.kind === "sources")
              setFeed((f) => f.map((it, i) => (i === idx ? { ...it, citations: e.hits } : it)));
            else if (e.kind === "voice")
              setFeed((f) => f.map((it, i) => (i === idx ? { ...it, voice: e.label } : it)));
            else if (e.kind === "token") {
              acc += e.text;
              setFeed((f) => f.map((it, i) => (i === idx ? { ...it, text: it.text + e.text } : it)));
            }
          },
          OWN_SOURCES,
        );
        if (gen !== replyGen) return;
        const text = acc.trim() || "(no relevant notes found — try Reindex in the Notebook)";
        setFeed((f) => f.map((it, i) => (i === idx ? { ...it, text } : it)));
        void speak(text);
      } else {
        // Stream the reply token-by-token into one assistant bubble (#82) so the
        // answer renders live. Nothing else appends to the feed during the await,
        // so the captured index stays valid.
        const cp = convoPrompt(p); // build memory before pushing the empty reply bubble
        const gen = ++replyGen; // Stop button bumps replyGen to abandon this stream
        const idx = feed().length;
        setFeed((f) => [...f, { role: "assistant", text: "" }]);
        let acc = "";
        const append = (chunk: string) => {
          if (gen !== replyGen) return; // cancelled — ignore late tokens
          acc += chunk;
          setFeed((f) => f.map((it, i) => (i === idx ? { ...it, text: it.text + chunk } : it)));
        };
        if (scope() === "tabs") await agentChatTabsStream(cp, browserTabIds(), append);
        else await agentChatStream(cp, append);
        if (gen !== replyGen) return; // stopped mid-stream — don't finalize/speak
        // Small local models sometimes return nothing on a terse, symbol-heavy
        // prompt buried under the big system preamble. Give it one clean shot with
        // just the bare question before giving up.
        if (!acc.trim()) await agentChatStream(p, append);
        if (gen !== replyGen) return;
        const text = acc.trim() || "(no response)";
        setFeed((f) => f.map((it, i) => (i === idx ? { ...it, text } : it)));
        void speak(text);
      }
    } catch (err) {
      setFeed((f) => [...f, { role: "error", text: String(err) }]);
    } finally {
      setBusy(false);
    }
  };
  const run = (e: SubmitEvent) => {
    e.preventDefault();
    void send(prompt().trim());
  };

  // Open a KB citation: Scroll articles (http) in a tab, Onyx notes (paths) in the OS.
  const openCitation = (h: KbHit) => {
    if (/^https?:\/\//i.test(h.path)) void openTab("browser", h.path);
    else if (h.path) void fsOpen(h.path).catch(() => {});
  };

  // Approve a previewed action → execute it on the page (#8).
  const approve = async (idx: number, action: AgentAction) => {
    setFeed((f) => f.map((it, i) => (i === idx ? { ...it, pending: false } : it)));
    setBusy(true);
    try {
      await agentRunAction(action);
      setFeed((f) => [...f, { role: "action", text: `✓ ${describeAction(action)}` }]);
    } catch (err) {
      setFeed((f) => [...f, { role: "error", text: String(err) }]);
    } finally {
      setBusy(false);
    }
  };
  const cancelPlan = (idx: number) =>
    setFeed((f) =>
      f.map((it, i) => (i === idx ? { ...it, pending: false, text: `Skipped: ${it.text}` } : it)),
    );

  // ── Multi-step task loop (#A) ──────────────────────────────────────────────
  const MAX_TASK_STEPS = 8;
  // Step-through gate: resolve when the user clicks Approve / Skip / Stop.
  const awaitDecision = (action: AgentAction, n: number) =>
    new Promise<"approve" | "skip" | "stop">((resolve) => {
      stepResolver = resolve;
      setTaskStep({ action, n });
    });
  const decideStep = (d: "approve" | "skip" | "stop") => {
    const r = stepResolver;
    stepResolver = null;
    setTaskStep(null);
    r?.(d);
  };

  // ── Multi-step chains (#115) ────────────────────────────────────────────────
  // A compound request ("read foo.rs, fix the bug, then run the tests"; "play my
  // liked songs + shuffle on") is decomposed into Flux-formatted sub-commands and
  // each is routed through the same tools as a typed message. Side-effecting steps
  // (edit / shell) surface their normal approval card; the chain pauses there until
  // you Apply/Run (continue) or Cancel (abort the rest).

  // Strong multi-step connectors — used to decide whether to even try decomposing,
  // so ordinary single commands and chat questions aren't taxed with a round-trip.
  const CHAIN_CONNECTOR = /(?:^|\s)(?:and\s+then|then|after\s+that)\s|\s\+\s|\s*;\s*\S/i;
  // Does a step look like a concrete action (vs. plain chat)? Guards the trigger so a
  // chatty "what's X and then Y" doesn't get treated as a chain.
  const isActionStep = (s: string): boolean =>
    SHELL_RE.test(s) ||
    EDIT_RE.test(s) ||
    EDIT_IT_RE.test(s) ||
    SEARCH_RE.test(s) ||
    FILE_RE.test(s) ||
    TERM_RE.test(s) ||
    REMEMBER_RE.test(s) ||
    REMIND_RE.test(s) ||
    SYS_RE.test(s) ||
    /^(?:play|pause|skip|resume|shuffle|launch|open)\b/i.test(s);

  type StepOutcome = { ok: boolean; result: string };

  /** A note step written by the loop. Deliberately narrow — the loop emits this
   *  form because the planner prompt tells it to, so it doesn't need the
   *  generous phrasing detection that a human's typing does. */
  const NOTE_STEP_RE = /^(?:note|save to (?:onyx|scribe|notes?)|write note)\s*[:,-]?\s*([\s\S]+)/i;

  // If the previous step pushed an approval card, block until the user resolves it,
  // and surface the result (e.g. terminal output) so the loop can react to it.
  const awaitChainApproval = async (): Promise<StepOutcome> => {
    const last = feed()[feed().length - 1];
    if (last?.pending && (last.role === "edit" || last.role === "shell" || last.role === "note")) {
      return await new Promise<StepOutcome>((res) => {
        chainGate = res;
      });
    }
    return { ok: true, result: last?.text ?? "" }; // nothing to approve (e.g. edit couldn't be drafted)
  };

  // Route one step to the matching tool and return its outcome — `ok:false` aborts a
  // chain (user cancelled); `result` (output / reply / status) feeds the adaptive
  // loop's re-planning. Mirrors send()'s tool order, minus page actions.
  const routeChainStep = async (raw: string): Promise<StepOutcome> => {
    const pc = raw
      .trim()
      .replace(/^\/?(?:hey\s+)?gemma[,:\s]+/i, "")
      .replace(/^(?:can|could|would|will)\s+you\s+/i, "")
      .replace(/^(?:please|kindly)\s+/i, "")
      .trim();
    if (!pc) return { ok: true, result: "" };
    const shell = pc.match(SHELL_RE);
    if (shell?.[1]) {
      await runShellCmd(shell[1].trim());
      return await awaitChainApproval();
    }
    if (await runMusic(raw)) return { ok: true, result: "music command done" };
    const search = pc.match(SEARCH_RE);
    if (search?.[1]) return { ok: true, result: await runSearch(search[1]) };
    {
      const me = pc.match(EDIT_RE);
      if (me?.[1] && me[2]) {
        await runEdit(me[1], me[2]);
        return await awaitChainApproval();
      }
    }
    {
      const mei = pc.match(EDIT_IT_RE);
      if (mei?.[1]) {
        const lf = lastCtxFile();
        if (lf) {
          await runEdit(lf.path, mei[1]);
          return await awaitChainApproval();
        }
      }
    }
    if (TERM_RE.test(pc)) return { ok: true, result: runReadTerminal() };
    // Before FILE_RE: "list /a/b" would otherwise fall through to the file
    // reader, which would try to read a directory as text.
    const ls = pc.match(LIST_RE);
    if (ls?.[1]) return { ok: true, result: await runListDir(ls[1]) };
    const rf = pc.match(FILE_RE);
    if (rf?.[1]) return { ok: true, result: await runReadFile(rf[1]) };
    // "note <what to add>" — the loop could read, run and edit, but had no way
    // to finish a job in the user's own notes, so "summarise these into Onyx"
    // ended as a chat message that looked like it had been saved and hadn't.
    // Same approval card as everywhere else: this proposes, it never writes.
    const nt = pc.match(NOTE_STEP_RE);
    if (nt?.[1]) {
      const drafted = await planNote(nt[1].trim(), true);
      if (!drafted) return { ok: true, result: "Nothing to write — the note wasn't drafted." };
      return await awaitChainApproval();
    }
    const rem = pc.match(REMEMBER_RE);
    if (rem?.[1]) return { ok: true, result: await runRemember(rem[1]) };
    const rmd = pc.match(REMIND_RE);
    if (rmd?.[1]) return { ok: true, result: await runRemind(rmd[1]) };
    if (SYS_RE.test(pc)) return { ok: true, result: await runSysStats() };
    const sp = await maybeShellPlan(raw);
    if (sp !== null) return await awaitChainApproval();
    // Anything else: answer it as chat, streamed into one bubble.
    const idx = feed().length;
    setFeed((f) => [...f, { role: "assistant", text: "" }]);
    let acc = "";
    setBusy(true);
    try {
      await agentChatStream(convoPrompt(raw), (c) => {
        acc += c;
        setFeed((f) => f.map((it, i) => (i === idx ? { ...it, text: it.text + c } : it)));
      });
    } catch (e) {
      setFeed((f) => f.map((it, i) => (i === idx ? { ...it, role: "error", text: String(e) } : it)));
    } finally {
      setBusy(false);
    }
    setFeed((f) => f.map((it, i) => (i === idx ? { ...it, text: it.text.trim() || "(no response)" } : it)));
    return { ok: true, result: acc.trim() };
  };

  const runChain = async (steps: string[], goal: string): Promise<void> => {
    if (taskRunning()) return;
    setTaskRunning(true);
    setFeed((f) => [...f, { role: "task", text: `▶ ${steps.length} steps: ${steps.join(" → ")}` }]);
    try {
      for (let i = 0; i < steps.length; i++) {
        setFeed((f) => [...f, { role: "plan", text: `→ step ${i + 1}/${steps.length}: ${steps[i]}` }]);
        const { ok } = await routeChainStep(steps[i]!);
        if (!ok) {
          setFeed((f) => [...f, { role: "task", text: "⏹ Chain stopped (step cancelled)." }]);
          return;
        }
      }
      setFeed((f) => [...f, { role: "task", text: "✓ Chain complete." }]);
    } finally {
      chainGate = null;
      setTaskRunning(false);
    }
  };

  // Adaptive goal loop (#115 follow-up) — "/fix <goal>". Plan ONE step, run it,
  // observe the result, re-plan: run → read the failure → fix → re-run, until the
  // model says it's done / stuck or the step cap. Each step routes through the same
  // tools (so edits/commands still ask for approval), and the result is fed back.
  /** Step ceiling for the adaptive loop. Ten was sized for "fix the failing
   *  test" — run, read, edit, re-run. A folder of lecture slides needs one list
   *  plus one read per file plus a note, so ten stopped it a third of the way
   *  through and reported success. The cap exists to bound a model that has lost
   *  the plot, not to bound the work; every step is visible and each
   *  side-effecting one still asks. */
  const MAX_FIX_STEPS = 28;
  /** Draft a note write and put it up for confirmation. Never writes. */
  /** Draft a write and put it up for confirmation. Returns false when there was
   *  nothing to propose, so an auto-detected request can fall through to an
   *  ordinary reply instead of dead-ending on "nothing to write". */
  const planNote = async (request: string, explicit: boolean): Promise<boolean> => {
    setBusy(true);
    try {
      // Hand it whatever has been read into context. `note_plan` has always
      // taken a context argument and nothing ever passed one, so a note drafted
      // at the end of a task was written from the *request text alone* — the
      // agent would read six lecture PDFs and then summarise the sentence that
      // asked it to. The loop's own history is capped far too small to carry a
      // document; this is where the actual text lives.
      const proposal = await notePlan(request, filesContext() || undefined);
      if (!proposal.writes) {
        // Explicit `/note` gets the reason — you asked for a write and deserve
        // to know why there isn't one. An auto-detected request stays quiet and
        // is answered normally; a wrong guess shouldn't cost you an answer.
        if (explicit) setFeed((f) => [...f, { role: "assistant", text: proposal.summary }]);
        return false;
      }
      // `pending` so a chain step can block on it: without it the loop pushed a
      // note card and immediately planned the next step, so a task could finish
      // "successfully" while the write it was for sat unanswered.
      setFeed((f) => [...f, { role: "note", text: proposal.summary, note: proposal, pending: true }]);
      return true;
    } catch (err) {
      if (explicit) setFeed((f) => [...f, { role: "error", text: String(err) }]);
      return false;
    } finally {
      setBusy(false);
    }
  };

  /** Drop a proposal without writing. The card collapses to a plain line rather
   *  than vanishing, so the feed still records that something was offered. */
  const discardNote = (idx: number) => {
    setFeed((f) => f.map((it, i) => (i === idx ? { role: "assistant", text: `Discarded: ${it.text}` } : it)));
    // Discarding one note isn't cancelling the goal — the loop should carry on
    // and can decide what to do about the refusal.
    resolveChainGate(true, "The user discarded that note; nothing was written.");
  };

  /** Apply a proposal the user approved. */
  const applyNote = async (idx: number, proposal: NoteProposal): Promise<void> => {
    try {
      const path = await noteApply(proposal.action);
      setFeed((f) => f.map((it, i) => (i === idx ? { ...it, noteDone: path, pending: false } : it)));
      resolveChainGate(true, `Written to ${path}.`);
    } catch (err) {
      setFeed((f) => [...f, { role: "error", text: String(err) }]);
      resolveChainGate(true, `Writing the note failed: ${String(err)}`);
    }
  };

  const runAdaptiveTask = async (goal: string): Promise<void> => {
    if (taskRunning()) return;
    setTaskRunning(true);
    setFeed((f) => [...f, { role: "task", text: `▶ Goal: ${goal}` }]);
    const history: string[] = [];
    /** How many times each command has been proposed, normalised. */
    const repeats = new Map<string, number>();
    try {
      for (let i = 0; i < MAX_FIX_STEPS; i++) {
        setBusy(true);
        let step: NextStep;
        try {
          step = await agentNextStep(goal, history);
        } catch (e) {
          setFeed((f) => [...f, { role: "error", text: String(e) }]);
          return;
        } finally {
          setBusy(false);
        }
        // The wire type mirrors Rust's #[serde(default)] fields as optional.
        const command = step.command ?? "";
        if (step.done || !command.trim()) {
          setFeed((f) => [...f, { role: "task", text: `✓ ${step.summary?.trim() || "Done."}` }]);
          return;
        }
        // A small model that doesn't like a step's result will re-issue it
        // verbatim, forever — one goal burned 23 steps re-listing the same
        // folder. "Don't repeat a step" is in the planner prompt, and a prompt
        // is not a guarantee. Refuse to run it a second time and say so in the
        // history, which is a fact the model can act on rather than an
        // instruction it can ignore.
        const key = command.trim().toLowerCase().replace(/\s+/g, " ");
        const seen = (repeats.get(key) ?? 0) + 1;
        repeats.set(key, seen);
        if (seen > 1) {
          setFeed((f) => [
            ...f,
            { role: "plan", text: `↻ step ${i + 1}: already ran “${command}” — skipping the repeat` },
          ]);
          history.push(
            `STEP: ${command}\nRESULT: SKIPPED — you already ran this exact command earlier and its ` +
              `result is above. Do not issue it again. Move on to the next part of the goal, or set done=true.`,
          );
          // Twice is a hiccup; three times is a loop it isn't getting out of.
          if (seen >= 3) {
            setFeed((f) => [
              ...f,
              {
                role: "task",
                text: `⏹ Stopped — stuck repeating “${command}”. ${history.length} steps done; what's above still stands.`,
              },
            ]);
            return;
          }
          continue;
        }

        setFeed((f) => [...f, { role: "plan", text: `→ step ${i + 1}: ${command}` }]);
        const { ok, result } = await routeChainStep(command);
        if (!ok) {
          setFeed((f) => [...f, { role: "task", text: "⏹ Stopped (step cancelled)." }]);
          return;
        }
        // Cap each result so a long build log doesn't blow the model's context.
        history.push(`STEP: ${command}\nRESULT: ${result.slice(0, 1500)}`);
      }
      setFeed((f) => [...f, { role: "task", text: `⏹ Hit the ${MAX_FIX_STEPS}-step limit — stopping.` }]);
    } finally {
      chainGate = null;
      setTaskRunning(false);
    }
  };

  // Split a request on explicit step connectors (" + ", " then ", " and then ", ";").
  // `\s+\+\s+` (not bare "+") so "C++" / "a+b" aren't split.
  const splitOnConnectors = (text: string): string[] =>
    text
      .split(/\s+(?:and\s+then|then|after\s+that)\s+|\s+\+\s+|\s*;\s*/i)
      .map((s) => s.trim())
      .filter(Boolean);

  // Decide if `text` is a multi-step request and, if so, run it as a chain. Returns
  // true if it handled the message. Gated on a connector + a real first action so
  // single commands and chat fall through to normal routing.
  const maybeRunChain = async (text: string): Promise<boolean> => {
    if (taskRunning() || !CHAIN_CONNECTOR.test(text)) return false;
    // Explicit connectors → split deterministically (no model round-trip, and it
    // can't mis-decompose, e.g. "search rust async + remind me …" was getting
    // swallowed whole by the search regex). Only ask the model when the literal
    // split doesn't yield a clean multi-step request.
    let steps = splitOnConnectors(text);
    if (steps.length < 2 || !isActionStep(steps[0]!)) {
      setBusy(true);
      try {
        steps = await agentPlanSteps(text);
      } catch {
        steps = [];
      } finally {
        setBusy(false);
      }
    }
    if (steps.length < 2 || !isActionStep(steps[0]!)) return false;
    await runChain(steps, text);
    return true;
  };

  const runTask = async (goal: string) => {
    if (taskRunning()) return;
    setTaskRunning(true);
    setFeed((f) => [
      ...f,
      { role: "user", text: `/task ${goal}` },
      { role: "task", text: `▶ Task: ${goal}` },
    ]);
    const history: string[] = [];
    try {
      for (let i = 0; i < MAX_TASK_STEPS; i++) {
        // Plan the next step from the LIVE page + what's been done.
        setBusy(true);
        let action: AgentAction;
        try {
          action = await agentTaskStep(goal, history);
        } finally {
          setBusy(false);
        }
        if (action.action === "finish") {
          setFeed((f) => [...f, { role: "task", text: `✓ ${action.summary}` }]);
          return;
        }
        if (action.action === "refuse") {
          setFeed((f) => [...f, { role: "assistant", text: `✕ ${action.reason}` }]);
          return;
        }

        // Decide: step-through awaits a click; "run all" auto-approves.
        let decision: "approve" | "skip" | "stop" = "approve";
        if (taskAuto()) {
          setFeed((f) => [...f, { role: "plan", text: `→ ${describeAction(action)}` }]);
        } else {
          decision = await awaitDecision(action, i + 1);
        }
        if (decision === "stop") {
          setFeed((f) => [...f, { role: "task", text: "⏹ Task stopped." }]);
          return;
        }
        if (decision === "skip") {
          history.push(`(skipped) ${describeAction(action)}`);
          continue;
        }

        // Run the approved step, record it, let the page settle before re-planning.
        setBusy(true);
        try {
          await agentRunAction(action);
          setFeed((f) => [...f, { role: "action", text: describeAction(action) }]);
          history.push(describeAction(action));
        } finally {
          setBusy(false);
        }
        await new Promise((r) => setTimeout(r, 1200));
      }
      setFeed((f) => [...f, { role: "task", text: `Reached the ${MAX_TASK_STEPS}-step limit — stopping.` }]);
    } catch (err) {
      setFeed((f) => [...f, { role: "error", text: String(err) }]);
    } finally {
      stepResolver = null;
      setTaskStep(null);
      setTaskRunning(false);
    }
  };

  return (
    <aside
      class="agent"
      classList={{ "agent-droppable": filesPanelOpen(), "agent-dropping": dropping() }}
      onDragOver={(e) => {
        e.preventDefault();
        if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
        setDropping(true);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node)) setDropping(false);
      }}
      onDrop={(e) => void onDrop(e)}
    >
      <div class="agent-inner">
        {/* Ambient effects layer: circular aurora background + orbital edge glow. Its
            own absolutely-positioned + clipped layer so it never affects layout
            or clips the model dropdown. */}
        <div class="agent-fx" classList={{ busy: working() }} aria-hidden="true">
          <AgentAurora active={() => true} busy={() => working()} />
        </div>
        <header style={{ display: "flex", "align-items": "center", gap: "8px" }}>
          <span
            classList={{ "ai-thinking": working() }}
            style={{
              width: "10px",
              height: "10px",
              "border-radius": "50%",
              background: working() ? undefined : "var(--flux-violet)",
            }}
          />
          <strong>Flux Agent</strong>
          <div class="agent-model">
            <button
              ref={modelBtn}
              class="agent-model-btn"
              title="Pick the local model (Ollama)"
              onClick={toggleModelMenu}
            >
              {shortModel()} · local ▾
            </button>
            <Show when={modelMenu()}>
              <Portal>
                <div class="agent-menu-backdrop" onClick={() => setModelMenu(false)} />
                <div class="agent-model-menu" style={menuPos(modelBtn)}>
                  <Show
                    when={models().length > 0}
                    fallback={<div class="agent-model-empty">No Ollama models found (is it running?)</div>}
                  >
                    <For each={models()}>
                      {(m) => (
                        <button
                          classList={{ "agent-model-item": true, on: agentModelName() === m }}
                          onClick={() => {
                            setAgentModel(m);
                            setModelMenu(false);
                          }}
                        >
                          {m}
                        </button>
                      )}
                    </For>
                  </Show>
                  {/* Free the VRAM without waiting out the keep-alive. Lives in
                      the model menu because it is a model action, and the header
                      is already carrying four controls. */}
                  <div class="agent-model-sep" />
                  <button
                    class="agent-model-item agent-model-unload"
                    disabled={unloading()}
                    title={`Tell Ollama to drop ${agentModelName() || "the model"} from VRAM now. It reloads automatically next time you ask her something.`}
                    onClick={() => void unloadModel()}
                  >
                    {unloading() ? "Unloading…" : `⏏ Unload from VRAM`}
                  </button>
                </div>
              </Portal>
            </Show>
          </div>
          <button
            class="agent-voice-toggle"
            classList={{ on: micLive(), live: listening() }}
            title={micLive() ? `Hey Gemma is on — ${voiceStatus()}` : "Turn on “Hey Gemma” always-on voice"}
            aria-label="Toggle Hey Gemma voice"
            style={{ "margin-left": "auto" }}
            onClick={async () => {
              const turningOn = !heyGemmaEnabled();
              const ok = await setHeyGemmaEnabled(turningOn);
              if (turningOn && !ok)
                setFeed((f) => [
                  ...f,
                  {
                    role: "error",
                    text: `🎤 Couldn't start always-on voice — ${voiceStatus() || "microphone unavailable"}.`,
                  },
                ]);
            }}
          >
            <Show when={micLive()} fallback="🎙">
              <span class="agent-voice-dot" /> {listening() ? "●" : "🎙"}
            </Show>
          </button>
          <button
            class="agent-voice-toggle"
            title="New chat — saves the current one and starts fresh"
            aria-label="New chat"
            onClick={newChat}
          >
            ＋
          </button>
          <div class="agent-model">
            <button
              ref={chatsBtn}
              class="agent-model-btn"
              title="Past chats"
              aria-label="Past chats"
              onClick={() => setChatsMenu(!chatsMenu())}
            >
              ☰
            </button>
            <Show when={chatsMenu()}>
              <Portal>
                <div class="agent-menu-backdrop" onClick={() => setChatsMenu(false)} />
                <div class="agent-model-menu" style={menuPos(chatsBtn)}>
                  <Show
                    when={chats().length > 0}
                    fallback={<div class="agent-model-empty">No saved chats yet</div>}
                  >
                    <For each={chats()}>
                      {(s) => (
                        <button
                          classList={{ "agent-model-item": true, on: s.id === currentId }}
                          onClick={() => loadSession(s)}
                        >
                          <span
                            style={{
                              flex: 1,
                              overflow: "hidden",
                              "text-overflow": "ellipsis",
                              "white-space": "nowrap",
                            }}
                          >
                            {s.title}
                          </span>
                          <span class="agent-chat-del" title="Delete" onClick={(e) => deleteSession(s.id, e)}>
                            ✕
                          </span>
                        </button>
                      )}
                    </For>
                  </Show>
                </div>
              </Portal>
            </Show>
          </div>
        </header>

        <div class="agent-feed" ref={feedEl}>
          <Show
            when={feed().length > 0}
            fallback={
              <div class="agent-empty">
                Chat with your local Gemma — ask anything. Use <kbd>/act</kbd> for a single page action, or{" "}
                <kbd>/task</kbd> for a multi-step goal (e.g.{" "}
                <em>/task find the cheapest listing and open it</em>) — the agent plans one step at a time and
                you approve each (or tick “Run all”).
                <div class="agent-empty-tips">
                  Try: <em>“what can you do”</em> · <em>“remember that …”</em> ·
                  <em>“remind me to … at 3pm”</em> · <em>“system status”</em> ·<em>“search …”</em> ·{" "}
                  <em>“run …”</em> · <em>“play …”</em>
                </div>
              </div>
            }
          >
            <For each={feed()}>
              {(item, i) => (
                <div classList={{ "agent-msg": true, [`agent-${item.role}`]: true }}>
                  <Show when={item.image}>
                    <img class="agent-thumb" src={item.image} alt="attachment" />
                  </Show>
                  <Show when={item.voice}>
                    <div class="agent-voice" title="A fine-tuned domain specialist answered">
                      ⚛ {item.voice} specialist
                    </div>
                  </Show>
                  <div>{item.text}</div>
                  <Show when={item.citations?.length}>
                    <div class="agent-cites">
                      <For each={item.citations}>
                        {(h, n) => (
                          <button
                            class="agent-cite"
                            title={`[${n() + 1}] ${h.title} — open ${h.path}`}
                            onClick={() => openCitation(h)}
                          >
                            <span class="agent-cite-n">{n() + 1}</span>
                            <span class="agent-cite-title">{h.title}</span>
                          </button>
                        )}
                      </For>
                    </div>
                  </Show>
                  <Show when={item.role === "plan" && item.pending && item.action}>
                    <div class="agent-approve">
                      <button class="agent-approve-yes" onClick={() => void approve(i(), item.action!)}>
                        ✓ Approve
                      </button>
                      <button class="agent-approve-no" onClick={() => cancelPlan(i())}>
                        Skip
                      </button>
                    </div>
                  </Show>
                  <Show when={item.role === "shell" && item.pending && item.shellCmd}>
                    <div class="agent-approve">
                      <button
                        class="agent-approve-yes"
                        onClick={() => void approveShell(i(), item.shellCmd!)}
                      >
                        ▶ Run in terminal
                      </button>
                      <button class="agent-approve-no" onClick={() => cancelShell(i())}>
                        Cancel
                      </button>
                    </div>
                  </Show>
                  {/* A proposed write into your notes. The card shows the exact
                      text — you approve content, not a description of it. */}
                  <Show when={item.role === "note" && item.note}>
                    <div class="agent-note">
                      <div class="agent-note-head">
                        <span class="agent-note-ico">✎</span>
                        <span class="agent-note-target">{item.note!.summary}</span>
                      </div>
                      <Show when={item.note!.body}>
                        <pre class="agent-note-body">{item.note!.body}</pre>
                      </Show>
                      <Show
                        when={!item.noteDone}
                        fallback={
                          <div class="agent-note-done">
                            ✓ Added ·{" "}
                            <span class="agent-note-path" title={item.noteDone}>
                              {item.noteDone}
                            </span>
                          </div>
                        }
                      >
                        <div class="agent-approve">
                          <button class="agent-approve-yes" onClick={() => void applyNote(i(), item.note!)}>
                            ✓ Add to my notes
                          </button>
                          <button class="agent-approve-no" onClick={() => discardNote(i())}>
                            Discard
                          </button>
                        </div>
                      </Show>
                    </div>
                  </Show>
                  <Show when={item.role === "edit" && item.editDiff}>
                    <div class="agent-diff">
                      <For each={item.editDiff!.split("\n")}>
                        {(ln) => (
                          <div
                            classList={{
                              "diff-add": ln.startsWith("+ "),
                              "diff-del": ln.startsWith("- "),
                              "diff-hunk": ln.startsWith("@@"),
                            }}
                          >
                            {ln || " "}
                          </div>
                        )}
                      </For>
                    </div>
                    <Show when={item.pending && item.editPath && item.editNew !== undefined}>
                      <div class="agent-approve">
                        <button
                          class="agent-approve-yes"
                          onClick={() => void approveEdit(i(), item.editPath!, item.editNew!)}
                        >
                          ✓ Apply
                        </button>
                        <button class="agent-approve-no" onClick={() => cancelEdit(i())}>
                          Cancel
                        </button>
                      </div>
                    </Show>
                  </Show>
                </div>
              )}
            </For>
          </Show>
          <Show when={status().state === "acting"}>
            <div class="agent-msg agent-action">
              ✦ {(status() as Extract<AgentStatus, { state: "acting" }>).description}
            </div>
          </Show>
        </div>

        {/* Multi-step task controls (#A): the step awaiting approval + run-all/stop. */}
        <Show when={taskRunning()}>
          <div class="agent-task-bar">
            <Show
              when={taskStep()}
              fallback={
                <span class="agent-task-status">{working() ? "planning next step…" : "working…"}</span>
              }
            >
              {(s) => (
                <div class="agent-task-step">
                  <div class="agent-task-step-label">
                    Step {s().n}: {describeAction(s().action)}
                  </div>
                  <div class="agent-approve">
                    <button class="agent-approve-yes" onClick={() => decideStep("approve")}>
                      ✓ Run
                    </button>
                    <button class="agent-approve-no" onClick={() => decideStep("skip")}>
                      Skip
                    </button>
                    <button class="agent-approve-no" onClick={() => decideStep("stop")}>
                      ⏹ Stop
                    </button>
                  </div>
                </div>
              )}
            </Show>
            <label
              class="agent-task-auto"
              title="Auto-approve each step (destructive clicks are still blocked at click time)"
            >
              <input
                type="checkbox"
                checked={taskAuto()}
                onChange={(e) => setTaskAuto(e.currentTarget.checked)}
              />{" "}
              Run all
            </label>
          </div>
        </Show>

        {/* Chat-with-page/tabs (#34): scope toggle + one-tap prompts grounded in
            the captured DOM (the agent already receives the page/tab text). */}
        <div class="agent-context">
          <button
            classList={{ "agent-scope": true, on: scope() === "page" }}
            title="Answer using the current page"
            onClick={() => setScope("page")}
          >
            📄 This page
          </button>
          <button
            classList={{ "agent-scope": true, on: scope() === "tabs" }}
            title="Answer across all open tabs in this space"
            onClick={() => setScope("tabs")}
          >
            🗂 All tabs{" "}
            <Show when={scope() === "tabs"}>
              <span class="agent-scope-n">{browserTabIds().length}</span>
            </Show>
          </button>
          <button
            classList={{ "agent-scope": true, on: scope() === "notes" }}
            title="Answer from your knowledge base, with citations — Onyx notes, Scroll papers, Council debates, Scribe pages, and snapshots of pages you've visited"
            onClick={() => setScope("notes")}
          >
            ✦ My notes
          </button>
          {/* The page's persistent Trail conversation, re-attached (ADR 0011).
              Only offered when the page has a Visit to hang the thread on. */}
          <Show when={pageThread()}>
            <button
              classList={{ "agent-scope": true, on: scope() === "thread" }}
              title="This page's saved conversation — persists with the page, same thread as in the Trail"
              onClick={attachThread}
            >
              💬 Page thread{" "}
              <Show when={(pageThread()?.msgs.length ?? 0) > 0}>
                <span class="agent-scope-n">{pageThread()!.msgs.length}</span>
              </Show>
            </button>
          </Show>
        </div>
        <div class="agent-chips">
          <button
            class="agent-chip"
            disabled={working()}
            onClick={() => void send("Summarize this in a few clear bullet points.")}
          >
            Summarize
          </button>
          <button
            class="agent-chip"
            disabled={working()}
            onClick={() => void send("What are the key points and any action items?")}
          >
            Key points
          </button>
          <button
            class="agent-chip"
            disabled={working()}
            onClick={() => void send("Explain this like I'm new to the topic.")}
          >
            Explain
          </button>
          <Show when={activePageUrl()}>
            <button
              class="agent-chip"
              disabled={working()}
              title="Save this page to your Scroll library"
              onClick={() => void send("clip this page to scroll")}
            >
              📎 Clip to Scroll
            </button>
          </Show>
        </div>
        <Show when={attachment()}>
          {(a) => (
            <div class="agent-attach">
              <Show
                when={a().kind === "image"}
                fallback={<span class="agent-attach-name">📄 {a().name}</span>}
              >
                <img class="agent-attach-thumb" src={(a() as { dataUrl: string }).dataUrl} alt="" />
                <span class="agent-attach-name">{a().name}</span>
              </Show>
              <button class="agent-attach-x" title="Remove" onClick={() => setAttachment(null)}>
                ✕
              </button>
            </div>
          )}
        </Show>
        <Show when={ctxFiles().length > 0}>
          <div class="agent-ctxfiles">
            <For each={ctxFiles()}>
              {(f) => (
                <span class="agent-ctxchip" title={f.path}>
                  📄 {f.name}
                  <span
                    class="agent-ctxchip-x"
                    title="Remove from context"
                    onClick={() => setCtxFiles((c) => c.filter((x) => x.path !== f.path))}
                  >
                    ✕
                  </span>
                </span>
              )}
            </For>
            <Show when={ctxFiles().length > 1}>
              <button class="agent-ctxchip-clear" onClick={clearCtxFiles}>
                clear all
              </button>
            </Show>
          </div>
        </Show>
        <form onSubmit={run}>
          <input
            type="file"
            ref={fileInput}
            style={{ display: "none" }}
            accept="image/*,text/*,.md,.json,.jsonc,.csv,.tsv,.log,.yaml,.yml,.toml,.ini,.xml,.html,.htm,.css,.js,.jsx,.ts,.tsx,.rs,.py,.go,.java,.c,.cpp,.h,.sh,.sql,.rb,.php,.swift,.kt"
            onChange={onPickFile}
          />
          <div class="agent-input-row" classList={{ "ai-thinking-border": working() }}>
            <button
              type="button"
              class="agent-attach-btn"
              title="Attach an image or text file"
              disabled={working() || taskRunning()}
              onClick={() => fileInput?.click()}
            >
              📎
            </button>
            <button
              type="button"
              classList={{ "agent-attach-btn": true, "agent-mic-on": recording() }}
              title="Hold to talk (push-to-talk)"
              disabled={working() || taskRunning()}
              onPointerDown={(e) => {
                e.preventDefault();
                void startRec();
              }}
              onPointerUp={() => void stopRec()}
              onPointerLeave={() => {
                if (recording()) void stopRec();
              }}
            >
              🎤
            </button>
            <input
              value={prompt()}
              onInput={(e) => setPrompt(e.currentTarget.value)}
              placeholder={
                taskRunning()
                  ? "task running…"
                  : working()
                    ? "thinking…"
                    : attachment()
                      ? "Ask about the attachment…"
                      : scope() === "notes"
                        ? "Ask your notes & papers…"
                        : scope() === "tabs"
                          ? "Ask across tabs · /act · /task"
                          : "Ask · attach 📎 · /act · /task"
              }
              disabled={working() || taskRunning()}
              style={{
                flex: "1",
                "min-width": "0",
                padding: "10px 12px",
                border: working() ? "none" : undefined,
              }}
            />
            <Show when={working() || speaking()}>
              <button
                type="button"
                class="agent-attach-btn agent-stop-btn"
                title="Stop Gemma"
                aria-label="Stop"
                onClick={cancelReply}
              >
                ■
              </button>
            </Show>
          </div>
        </form>
      </div>
    </aside>
  );
};

function describeAction(a: AgentAction): string {
  switch (a.action) {
    case "click":
      return `✓ clicked ${a.selector} (${a.reason})`;
    case "extract_table":
      return `✓ extracted ${a.selector} → ${a.format}`;
    case "type":
      return `✓ typed into ${a.selector}`;
    case "reveal":
      return `✓ revealed ${a.selector}`;
    case "refuse":
      return `— ${a.reason}`;
    case "finish":
      return `✓ ${a.summary}`;
  }
}

export default AgentPanel;
