/**
 * Flux Agent sidebar — chat, single page actions (/act), and multi-step tasks
 * (/task, the iterative agent loop #A). Split out of App.tsx and lazy-loaded so
 * its weight stays off the eager chrome bundle (ADR 0001's 50 KB gzip budget);
 * it only loads when the agent panel is first opened.
 */
import { For, Show, createEffect, createSignal, onCleanup, onMount, type Component, type JSX } from "solid-js";
import { Portal } from "solid-js/web";
import {
  agentChat,
  agentChatStream,
  agentChatTabsStream,
  agentShellPlan,
  runShell,
  readTextFile,
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
  agentRunAction,
  agentTaskStep,
  agentLens,
  agentVision,
  attachmentRead,
  voiceTranscribe,
  webviewCapture,
  onScreenshot,
  isStartUrl,
  onAgentStatus,
  type AgentAction,
  type AgentStatus,
} from "./ipc";
import { activeId, activeWorkspace, agentModelName, filesPanelOpen, fluxStateSnapshot, openTab, pendingAsk, pendingLens, setAgentMenuOpen, setAgentModel, setPendingAsk, setPendingLens, tabs } from "./store";
import AgentAurora from "./AgentAurora";
import { heyGemmaEnabled, listening, micLive, setHeyGemmaEnabled, setVoiceHandler, startConversation, voiceStatus } from "./heygemma";
import { micConstraints } from "./mic";
import { activeTerminalText } from "./terminals";
import { inspectElement, themeVarsDump } from "./debug";
import { speak, speaking, stopSpeaking } from "./speak";
import { addReminder, migrateReminders, parseWhen, pendingReminders, whenLabel } from "./reminders";

type FeedItem = { role: "user" | "assistant" | "action" | "error" | "plan" | "task" | "shell" | "edit"; text: string; action?: AgentAction; pending?: boolean; image?: string; shellCmd?: string; editPath?: string; editNew?: string; editDiff?: string };

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
  const loadChats = (): ChatSession[] => { try { return JSON.parse(localStorage.getItem(CHATS_KEY) || "[]"); } catch { return []; } };
  const [chats, setChats] = createSignal<ChatSession[]>(loadChats());
  const [chatsMenu, setChatsMenu] = createSignal(false);
  let currentId = "";
  let seq = 0;
  const titleOf = (f: FeedItem[]) => (f.find((it) => it.role === "user")?.text || "New chat").trim().slice(0, 44);
  const persistChats = (next: ChatSession[]) => { setChats(next); try { localStorage.setItem(CHATS_KEY, JSON.stringify(next.slice(0, 50))); } catch { /* quota */ } };
  const persistCurrent = (f: FeedItem[]) => {
    if (!f.length) return;
    if (!currentId) currentId = `c${Date.now()}_${seq++}`;
    // Strip live "pending" state so reopened chats are read-only history.
    const session: ChatSession = { id: currentId, title: titleOf(f), ts: Date.now(), feed: f.map((it) => ({ ...it, pending: false })) };
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
    if (currentId === id) { currentId = ""; setFeed([]); }
  };
  // Interrupt ("stop the rant"): bump the generation so in-flight stream tokens are
  // ignored, cut any TTS, and free the input. The backend completion may keep
  // running, but its late tokens no-op against the new generation.
  let replyGen = 0;
  const cancelReply = () => { replyGen++; stopSpeaking(); setBusy(false); };

  // Persist the live conversation (debounced so streaming tokens don't thrash localStorage).
  let persistTimer: number | undefined;
  createEffect(() => {
    const f = feed();
    clearTimeout(persistTimer);
    persistTimer = window.setTimeout(() => persistCurrent(f), 400);
  });
  // Chat-with-page/tabs (#34): "page" grounds in the active tab; "tabs" grounds
  // in every open browser tab in the active workspace.
  const [scope, setScope] = createSignal<"page" | "tabs">("page");
  // Multi-step tasks (#A): the iterative agent loop. `taskRunning` gates input;
  // `taskAuto` = "run all" (auto-approve non-stop steps); `taskStep` holds the
  // step currently awaiting Approve/Skip/Stop in step-through mode.
  const [taskRunning, setTaskRunning] = createSignal(false);
  const [taskAuto, setTaskAuto] = createSignal(false);
  const [taskStep, setTaskStep] = createSignal<{ action: AgentAction; n: number } | null>(null);
  let stepResolver: ((d: "approve" | "skip" | "stop") => void) | null = null;
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
    return { position: "fixed", top: `${Math.round(r.bottom + 5)}px`, right: `${Math.round(Math.max(8, window.innerWidth - r.right))}px`, "z-index": "9999" };
  };
  const toggleModelMenu = () => {
    const open = !modelMenu();
    setModelMenu(open);
    if (open) void agentModels().then(setModels).catch(() => setModels([]));
  };
  const shortModel = () => {
    const m = agentModelName();
    return m ? m.split(":")[0]! : "gemma";
  };
  let feedEl: HTMLDivElement | undefined;

  const browserTabIds = () =>
    tabs().filter((t) => t.kind === "browser" && t.workspace === activeWorkspace() && !isStartUrl(t.url)).map((t) => t.id);

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
      const done = () => { settled = true; unlisten?.(); clearTimeout(timer); };
      const timer = setTimeout(() => { if (!settled) { done(); reject(new Error("page capture timed out")); } }, 9000);
      void onScreenshot((path) => { if (!settled) { done(); resolve(path); } }).then((u) => { unlisten = u; if (settled) u(); });
      void webviewCapture(tabId).catch((e) => { if (!settled) { done(); reject(e); } });
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
  const TEXT_EXT = /\.(txt|md|markdown|json|jsonc|csv|tsv|log|ya?ml|toml|ini|xml|html?|css|js|jsx|ts|tsx|rs|py|go|java|c|cpp|h|sh|sql|rb|php|swift|kt)$/i;

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
        reader.onload = () => { setAttachment({ kind: "text", name: file.name, text: String(reader.result || "") }); resolve(); };
        reader.readAsText(file);
      } else {
        setFeed((f) => [...f, { role: "error", text: `Can't read "${file.name}" — attach an image or a text file (video/binary isn't supported).` }]);
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
    if (dt.files && dt.files.length) { void readFile(dt.files[0]!); return; }
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
    try { recNode?.disconnect(); } catch { /* ignore */ }
    micStream?.getTracks().forEach((t) => t.stop());
    void audioCtx?.close();
    const len = pcmChunks.reduce((n, c) => n + c.length, 0);
    const chunks = pcmChunks; pcmChunks = []; micStream = null; audioCtx = null; recNode = null;
    if (len < rate * 0.25) return; // ignore < 0.25 s (a stray tap)
    const f32 = new Float32Array(len);
    let o = 0; for (const c of chunks) { f32.set(c, o); o += c.length; }
    const i16 = new Int16Array(len);
    for (let i = 0; i < len; i++) { const s = Math.max(-1, Math.min(1, f32[i]!)); i16[i] = s < 0 ? s * 0x8000 : s * 0x7fff; }
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
      .replace(/^\/?(?:and\s+|also\s+|then\s+|make\s+sure\s+to\s+|be\s+sure\s+to\s+|please\s+|can\s+you\s+|could\s+you\s+|would\s+you\s+)+/i, "")
      .trim();
    let m: RegExpMatchArray | null;
    // "launch audiopulse" + synonyms; "spotify" is accepted too since Vosk often
    // mishears "pulse" (so "launch spotify" → launch AudioPulse).
    if (/^(?:launch|start(?:\s*up)?|open|boot(?:\s*up)?|fire\s*up)\s+(?:audio\s*pulse|audiopulse|spotify|ap)\b/i.test(cmd)) return spotifyLaunch;
    // STT often mangles the imperative "play" into "played"/"playing"/"plays" — accept those.
    const PLAY = "play(?:ed|s|ing)?|put\\s*on|start";
    if (new RegExp(`^(?:${PLAY})\\s+(?:my\\s+|the\\s+)?liked(?:\\s+songs?)?(?:\\s+playlist)?$`, "i").test(cmd)) return spotifyPlayLiked;
    if ((m = cmd.match(new RegExp(`^(?:${PLAY})\\s+(?:my\\s+|the\\s+)?(.+?)\\s+playlist$`, "i")))) {
      const name = m[1]!.trim();
      return () => spotifyPlayPlaylist(name);
    }
    if ((m = cmd.match(new RegExp(`^(?:${PLAY}|queue)\\s+(.+)`, "i")))) {
      // Drop "the song"/"this track"/"a tune" filler so the search is just the title.
      const raw = m[1]!.trim();
      const q = raw.replace(/^(?:me\s+)?(?:the|this|a|that)?\s*(?:song|track|tune)\s+(?:called\s+|named\s+|titled\s+)?/i, "").trim();
      return () => spotifyPlay(q || raw);
    }
    if (/^(?:turn\s+)?shuffle(?:\s+on)?$|^turn\s+on\s+shuffle$/i.test(cmd)) return () => spotifyShuffle(true);
    if (/^(?:turn\s+)?shuffle\s+off$|^turn\s+off\s+shuffle$/i.test(cmd)) return () => spotifyShuffle(false);
    if ((m = cmd.match(/^(?:set\s+)?(?:the\s+)?volume\s+(?:to\s+)?(\d{1,3})%?$/i))) {
      const pct = Number(m[1]);
      return () => spotifyVolume(pct);
    }
    if ((m = cmd.match(/^(?:set\s+)?repeat(?:\s+(?:to\s+|mode\s+)?(one|all|track|context|song|playlist|album|off|none))?$/i))) {
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
    try { const r = await fn(); setFeed((f) => [...f, { role: "action", text: r }]); return r; }
    catch (e) { const m = String(e); setFeed((f) => [...f, { role: "error", text: m }]); return m; }
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
    const clauses = cmd.split(/\s*(?:,|;|\.|\bthen\b|\band\b|\bwith\b)\s*/i).map((s) => s.trim()).filter(Boolean);
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
    return `Run “${c}”? Tap Run in the panel to confirm.`;
  };
  const approveShell = async (idx: number, cmd: string) => {
    setFeed((f) => f.map((it, i) => (i === idx ? { ...it, pending: false } : it)));
    setBusy(true);
    try {
      const out = await runShell(cmd);
      setFeed((f) => [...f, { role: "assistant", text: out }]);
    } catch (e) {
      setFeed((f) => [...f, { role: "error", text: String(e) }]);
    } finally {
      setBusy(false);
    }
  };
  const cancelShell = (idx: number) =>
    setFeed((f) => f.map((it, i) => (i === idx ? { ...it, pending: false, text: `${it.text}  — cancelled` } : it)));

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
    try { cmd = await agentShellPlan(p); } catch { return null; }
    if (!cmd) return null;
    return await runShellCmd(cmd);
  };

  // Gemma's personality, prepended to every chat. Editable in Settings.
  const DEFAULT_PERSONA =
    "You are Gemma, the user's friendly local AI in the Flux browser. Be upbeat, warm, and energetic — a little playful, romantic, flirtatious and encouraging, with the occasional emoji. Keep replies natural and concise; don't overdo the enthusiasm.";
  const persona = () => (localStorage.getItem("flux.gemma.persona") ?? DEFAULT_PERSONA).trim();

  // What Gemma can actually DO in Flux — injected into every chat so she's aware of
  // her tools and can tell the user the exact phrasing. Kept separate from the
  // (editable) persona so it can't be edited away. Only claim what's listed here.
  const CAPABILITIES =
    "Your capabilities in Flux (these run via the app, not just talk — tell the user the exact phrasing when helpful):\n" +
    "- Reminders & to-dos: \"remind me to <x> in 10 min / at 3pm / tomorrow\"; \"what are my reminders\". They fire with an OS notification + spoken alert even if the panel is closed.\n" +
    "- Long-term memory: \"remember that <x>\" saves a fact you'll recall in future chats; \"what do you remember\".\n" +
    "- Run terminal commands (one-tap approval; rm/destructive blocked): \"run <cmd>\" / \"execute <cmd>\", or ask naturally (\"list the files in my home directory\") and you propose the command.\n" +
    "- Read files into context: \"read src/foo.rs\" / \"look at <path>\" pulls a file in so you can answer about it without copy-paste (it stays for follow-ups); \"forget the files\" clears. You can also drag a file from the explorer onto the panel.\n" +
    "- Read the terminal: \"read the terminal\" / \"what's in my terminal\" pulls the active Terminal tab's recent output into context (great for debugging a failed command).\n" +
    "- Edit files (with approval): \"edit src/foo.rs: rename X to Y\" / (after reading a file) \"change it to …\" — you propose a diff; nothing is written until the user taps Apply. Make surgical edits.\n" +
    "- Inspect Flux's own UI (for debugging it): \"app state\" (UI snapshot), \"css variables\" / \"what's --flux-teal\", \"inspect <css selector>\" (computed style + visibility — e.g. why an element is hidden or a var isn't applying).\n" +
    "- System awareness: \"system status\" / \"how's my CPU\" / \"what's using memory\" → CPU%, RAM, top processes.\n" +
    "- Web search: \"search <x>\" / \"open a new tab and search <x>\".\n" +
    "- Music (AudioPulse/Spotify): \"play <song>\", \"play my liked songs\", \"shuffle on\", \"skip\", \"pause\", \"launch spotify\".\n" +
    "- Page actions: \"/act <do something on this page>\" (one step) or \"/task <multi-step goal>\" (you plan steps the user approves). You can also chat grounded in the current page or all open tabs.\n" +
    "- Voice: always-on \"Hey Gemma\" + push-to-talk; the user can interrupt you by talking or the Stop button.\n" +
    "When asked what you can do, summarize the above. Don't claim abilities not listed.";

  // Conversation memory: prepend persona + capabilities + the recent turns so the
  // model has context. The trailing "user" entry is the message we just pushed, so
  // it's excluded. Capped to the last few turns to keep prompt-eval fast.
  const filesContext = (): string => {
    const fs = ctxFiles();
    if (!fs.length) return "";
    let budget = 14000;
    const blocks: string[] = [];
    for (const f of fs) {
      const body = f.content.slice(0, Math.max(0, budget));
      budget -= body.length;
      blocks.push(`--- file: ${f.path} ---\n${body}${body.length < f.content.length ? "\n…(truncated)" : ""}`);
      if (budget <= 0) break;
    }
    return `Files the user has open / asked you to read (use them to answer):\n${blocks.join("\n\n")}\n\n`;
  };

  const convoPrompt = (current: string): string => {
    const mem = memText().trim();
    const p0 = persona() ? `${persona()}\n\n` : "";
    const preamble = `${p0}${CAPABILITIES}\n\n` + filesContext() + (mem ? `What you remember about the user (your saved memory):\n${mem.slice(0, 4000)}\n\n` : "");
    const turns = feed().filter((it) => it.role === "user" || it.role === "assistant");
    const prior = (turns.length && turns[turns.length - 1]?.role === "user" ? turns.slice(0, -1) : turns).slice(-8);
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
  const FILE_RE = /^(?:read|open|load|look at|show me|check out|cat|add)\s+(?:the\s+)?(?:file\s+|context\s+)?(~?\/?[\w. /\\@-]*?(?:\.[a-z0-9]{1,8}|\/[\w.-]+)|[~/][\w. /\\@.-]+)\s*$/i;
  const runReadFile = async (raw: string): Promise<string> => {
    const path = raw.trim().replace(/^["']|["']$/g, "");
    if (!path) return "";
    try {
      const content = await readTextFile(path);
      const name = path.split(/[/\\]/).pop() || path;
      setCtxFiles((c) => [...c.filter((f) => f.path !== path), { path, name, content }].slice(-8));
      const lines = content.split("\n").length;
      setFeed((f) => [...f, { role: "action", text: `📄 Reading ${name} (${lines} lines) — it's in context now; ask me anything about it.` }]);
      return `Got ${name} — what would you like to know about it?`;
    } catch (e) {
      const m = String(e);
      setFeed((f) => [...f, { role: "error", text: m }]);
      return m;
    }
  };
  const clearCtxFiles = () => setCtxFiles([]);
  const lastCtxFile = () =>
    [...ctxFiles()].reverse().find((f) => !["terminal", "css-vars", "app-state"].includes(f.path) && !f.path.startsWith("inspect:"));

  // "edit <file>: <instruction>" / "change it to …" → propose search/replace edits,
  // show a diff, and write only on approval (apply happens client-side).
  const EDIT_RE = /^(?:\/edit|edit|modify|change|update|patch|fix|refactor)\s+(~?[\w./\\@-]+\.[a-z0-9]{1,8})\s*[:,–-]?\s*([\s\S]+)/i;
  const EDIT_IT_RE = /^(?:\/edit|edit|modify|change|update|patch|apply|fix|refactor)\s+(?:it|this(?:\s+file)?|that|the\s+file)\b[:,–-]?\s*([\s\S]+)/i;
  const applyEdits = (content: string, edits: { search: string; replace: string }[]): { out: string; failed: string[] } => {
    let out = content;
    const failed: string[] = [];
    for (const e of edits) {
      if (!e.search) continue;
      if (out.includes(e.search)) { out = out.replace(e.search, e.replace); continue; }
      const s2 = e.search.replace(/\r\n/g, "\n");
      const n = out.replace(/\r\n/g, "\n");
      if (n.includes(s2)) { out = n.replace(s2, e.replace.replace(/\r\n/g, "\n")); continue; }
      failed.push((e.search.split("\n")[0] || "").slice(0, 50));
    }
    return { out, failed };
  };
  const editDiffText = (edits: { search: string; replace: string }[]): string =>
    edits.map((e, i) =>
      `@@ change ${i + 1} @@\n${e.search.split("\n").map((l) => `- ${l}`).join("\n")}\n${e.replace.split("\n").map((l) => `+ ${l}`).join("\n")}`,
    ).join("\n\n");
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
        setFeed((f) => [...f, { role: "error", text: `Couldn't find the text to change in ${path}${failed.length ? ` (missed: ${failed.join("; ")})` : ""}. Try “read ${path}” first so I'm looking at the current version.` }]);
        return "Couldn't apply the edit.";
      }
      const diff = editDiffText(plan.edits) + (failed.length ? `\n\n⚠ ${failed.length} edit(s) didn't match the file and were skipped.` : "");
      setFeed((f) => [...f, { role: "edit", text: `✏ ${path} — ${plan.summary}`, editPath: path, editNew: out, editDiff: diff, pending: true }]);
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
    } catch (e) {
      setFeed((f) => [...f, { role: "error", text: String(e) }]);
    }
  };
  const cancelEdit = (idx: number) =>
    setFeed((f) => f.map((it, i) => (i === idx ? { ...it, pending: false, text: `${it.text}  — cancelled` } : it)));

  // "read the terminal" → pull the active terminal's scrollback into context.
  const TERM_RE = /^(?:read|look at|show me|check|grab|capture|see)\s+(?:the\s+|my\s+)?terminal(?:\s+(?:output|buffer|scrollback|window))?\s*$|^what(?:'?s| does| is)?\s*(?:in|on)?\s*(?:the\s+|my\s+)?terminal(?:\s+say(?:ing)?)?\s*\??$|^terminal\s+(?:output|contents?)\s*$/i;
  const runReadTerminal = (): string => {
    const t = activeTerminalText();
    if (!t || !t.text.trim()) {
      setFeed((f) => [...f, { role: "error", text: "No terminal output to read — open a Terminal tab and run something first." }]);
      return "There's no terminal output yet.";
    }
    setCtxFiles((c) => [...c.filter((f) => f.path !== "terminal"), { path: "terminal", name: "terminal output", content: t.text }].slice(-8));
    const lines = t.text.split("\n").length;
    setFeed((f) => [...f, { role: "action", text: `🖥 Read your terminal (${lines} lines) — it's in context now.` }]);
    return "Got your terminal output — what's up with it?";
  };

  // #4 UI introspection — inspect an element's computed style/visibility, dump the
  // CSS theme variables, or snapshot the app state. Results go into context too.
  const addContext = (path: string, name: string, content: string) =>
    setCtxFiles((c) => [...c.filter((f) => f.path !== path), { path, name, content }].slice(-8));
  const STATE_RE = /^(?:flux|app|ui)\s+state\b|^(?:debug|inspect|show)\s+(?:the\s+)?(?:app|ui|flux)\s+state\b|^what(?:'?s| is)\s+(?:the\s+)?(?:current\s+)?(?:app|ui|flux)\s+state\b/i;
  const VARS_RE = /^(?:(?:list|show|dump)\s+(?:me\s+)?)?(?:css|theme)\s+(?:variables?|vars|custom\s+properties)\b|^(?:what(?:'?s| is)|show me)\s+(?:the\s+(?:value\s+of\s+)?)?(--[\w-]+)\b/i;
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
  const refreshMemory = () => void memoryRead().then(setMemText).catch(() => {});
  const REMEMBER_RE = /^(?:\/remember|remember|note|make a note|keep in mind|save (?:to memory|this))\b[:,]?\s+(?:that\s+|to\s+)?(.+)/i;
  const RECALL_RE = /^(?:\/memory|what do you remember|show (?:me )?(?:your |the )?memory|what'?s in your memory)\b/i;
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
    const text = mem ? mem : "I don't have anything in my memory yet. Say “remember that …” to add something.";
    setFeed((fd) => [...fd, { role: "assistant", text }]);
    return mem ? "Here's what I remember." : "Nothing in my memory yet.";
  };

  // "what can you do" / "/help" → a deterministic capabilities card.
  const HELP_RE = /^(?:\/help|\/capabilities|what can you do\b|what (?:are|r) your (?:capabilities|features|abilities|powers)|show (?:me )?(?:your )?(?:capabilities|features)|list (?:your )?(?:commands|capabilities)|what can i (?:ask|say|tell you)\b)/i;
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
      "🎙 Voice — “Hey Gemma” always-on + push-to-talk; talk over me or tap ■ Stop to interrupt";
    setFeed((fd) => [...fd, { role: "assistant", text: card }]);
    return "I can handle reminders, memory, terminal commands, system stats, web search, music, page actions, and voice. What would you like to do?";
  };

  // System awareness — "system status" / "how's my cpu/memory" / "what's using ram".
  const SYS_RE = /^(?:system\s+(?:status|stats|info|usage)|how'?s?\s+my\s+(?:system|cpu|memory|ram|pc|computer)|(?:cpu|memory|ram)\s+usage|what'?s\s+(?:using|eating|hogging)\s+(?:my\s+)?(?:memory|ram|cpu))\b/i;
  const runSysStats = async (): Promise<string> => {
    try {
      const s = await systemStats();
      const gb = (mb: number) => (mb / 1024).toFixed(1);
      const sz = (mb: number) => (mb >= 1024 ? `${gb(mb)} GB` : `${mb} MB`);
      const top = s.top.slice(0, 5).map((p) => `${p.name} ${sz(p.memMb)}`).join(", ");
      setFeed((fd) => [...fd, { role: "assistant", text: `🖥 CPU ${s.cpuPct}% · RAM ${gb(s.memUsedMb)}/${gb(s.memTotalMb)} GB (${s.memPct}%)\nTop by memory: ${top}` }]);
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
  const REMIND_RE = /^(?:remind me|set (?:a )?reminder|add (?:a )?(?:reminder|to-?do|task)|reminder)\b(?:\s+to)?[:,]?\s+(.+)/i;
  const REMINDERS_LIST_RE = /^(?:what(?:'?s| is| are)?(?:\s+on)?\s+my|list (?:my)?|show (?:me )?(?:my )?|do i have any)\s*(?:reminders?|to-?dos?|tasks?)\b|^my (?:reminders?|to-?dos?|tasks?)\b/i;
  const runRemind = async (raw: string): Promise<string> => {
    const { text, due } = parseWhen(raw.trim().replace(/[?.!]+$/, ""), Date.now());
    if (!text) return "";
    try { await addReminder(text, due); } catch (e) { const m = String(e); setFeed((f) => [...f, { role: "error", text: m }]); return m; }
    if (due != null) {
      setFeed((f) => [...f, { role: "action", text: `⏰ Reminder set (${whenLabel(due)}): ${text}` }]);
      return `Okay — I'll remind you ${whenLabel(due)}.`;
    }
    setFeed((f) => [...f, { role: "action", text: `📝 To-do added: ${text}` }]);
    return "Added to your to-dos.";
  };
  const runListReminders = async (): Promise<string> => {
    const ps = await pendingReminders().catch(() => []);
    if (!ps.length) { setFeed((f) => [...f, { role: "assistant", text: "You have no reminders or to-dos." }]); return "Nothing on your list."; }
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
      if (remindersSpoken()) void speak(`Hey${userName() ? ` ${userName()}` : ""}, just popping in — ${r.text}.`);
    }).then((u) => { unlisten = u; });
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
    if (!t || working() || taskRunning()) return "";
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
    const sh = stripped.match(SHELL_RE);
    if (sh?.[1]) return await runShellCmd(sh[1]);
    const musicReply = await handleMusic(t);
    if (musicReply !== null) return musicReply;
    const vs = stripped.match(SEARCH_RE);
    if (vs?.[1]) return await runSearch(vs[1]);
    { const me = stripped.match(EDIT_RE); if (me?.[1] && me[2]) return await runEdit(me[1], me[2]); }
    { const mei = stripped.match(EDIT_IT_RE); if (mei?.[1]) { const lf = lastCtxFile(); if (lf) return await runEdit(lf.path, mei[1]); } }
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
    { const mv = stripped.match(VARS_RE); if (mv) return runVars(mv[1]); }
    { const mi = stripped.match(INSPECT_RE); if (mi?.[1]) return runInspect(mi[1]); }
    const shellReply = await maybeShellPlan(stripped);
    if (shellReply !== null) return shellReply;
    const cp = convoPrompt(t); // memory
    const idx = feed().length;
    setFeed((f) => [...f, { role: "assistant", text: "" }]);
    let acc = "";
    const append = (c: string) => { acc += c; setFeed((f) => f.map((it, i) => (i === idx ? { ...it, text: it.text + c } : it))); };
    setBusy(true);
    try {
      await agentChatStream(cp, append);
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

  const send = async (p: string) => {
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
    }
    setPrompt("");
    setFeed((f) => [...f, { role: "user", text: p, image: att?.kind === "image" ? att.dataUrl : undefined }]);
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
          await agentChatStream(`${p || "Summarize this file."}\n\n--- file: ${att.name} ---\n${att.text}`, append);
          const text = acc.trim() || "(no response)";
          setFeed((f) => f.map((it, i) => (i === idx ? { ...it, text } : it)));
          void speak(text);
        }
        return;
      }
      // Visual Lens — "/lens", "what is this", "identify this/it", "what am I looking at".
      const lens = p.match(/^\/lens(?:\s+([\s\S]+))?$/i) ||
        p.match(/^(?:what(?:'?s| is) this|identify (?:this|it)|what am i looking at)\b[\s\S]*/i);
      if (lens) { await runLens(lens[1]?.trim() || (/^\/lens/i.test(p) ? "" : p)); return; }
      // Strip a typed "hey gemma," prefix AND polite lead-ins so "hey gemma, can you
      // remind me to …" / "please run …" still match the ^-anchored intent regexes.
      const pc = p
        .replace(/^\/?(?:hey\s+)?gemma[,:\s]+/i, "")
        .replace(/^(?:can|could|would|will)\s+you\s+/i, "")
        .replace(/^(?:please|kindly)\s+/i, "")
        .replace(/^i(?:'?d| would)?\s+(?:like|want|need)\s+(?:you\s+)?to\s+/i, "")
        .trim();
      // Shell command — "run …" / "execute …" / "/run …" (rm + destructive blocked).
      const shell = pc.match(SHELL_RE);
      if (shell?.[1]) { await runShellCmd(shell[1].trim()); return; }
      // Music command (AudioPulse) before chat — "play …" / "skip" / "pause" / …
      if (await runMusic(p)) return;
      // "search …" / "open a new tab and search …" → open a browser tab.
      const search = pc.match(SEARCH_RE);
      if (search?.[1]) { await runSearch(search[1]); return; }
      // "edit <file>: <instruction>" / "change it to …" → propose an edit (diff + approve).
      { const me = pc.match(EDIT_RE); if (me?.[1] && me[2]) { await runEdit(me[1], me[2]); return; } }
      { const mei = pc.match(EDIT_IT_RE); if (mei?.[1]) { const lf = lastCtxFile(); if (lf) { await runEdit(lf.path, mei[1]); return; } } }
      // "read the terminal" → pull its scrollback into context (before the file read).
      if (TERM_RE.test(pc)) { runReadTerminal(); return; }
      // "read <file>" → pull a file into Gemma's context; "forget the files" clears.
      const rf = pc.match(FILE_RE);
      if (rf?.[1]) { await runReadFile(rf[1]); return; }
      if (/^(?:forget|clear|drop|remove)\s+(?:the\s+)?(?:files?|file\s+context|context)\b/i.test(pc)) { clearCtxFiles(); setFeed((f) => [...f, { role: "action", text: "🗑 Cleared the file context." }]); return; }
      // Long-term memory — "remember that …" / "what do you remember".
      const rem = pc.match(REMEMBER_RE);
      if (rem?.[1]) { await runRemember(rem[1]); return; }
      if (RECALL_RE.test(pc)) { runRecall(); return; }
      // Reminders / to-dos — "remind me to …" / "what are my reminders".
      const rmd = pc.match(REMIND_RE);
      if (rmd?.[1]) { await runRemind(rmd[1]); return; }
      if (REMINDERS_LIST_RE.test(pc)) { await runListReminders(); return; }
      if (SYS_RE.test(pc)) { await runSysStats(); return; }
      if (HELP_RE.test(pc)) { runHelp(); return; }
      // #4 UI introspection (check state/vars before the broad "inspect <selector>").
      if (STATE_RE.test(pc)) { runState(); return; }
      { const mv = pc.match(VARS_RE); if (mv) { runVars(mv[1]); return; } }
      { const mi = pc.match(INSPECT_RE); if (mi?.[1]) { runInspect(mi[1]); return; } }
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
        const text = acc.trim() || "(no response)";
        setFeed((f) =>
          f.map((it, i) => (i === idx ? { ...it, text } : it)),
        );
        void speak(text);
      }
    } catch (err) {
      setFeed((f) => [...f, { role: "error", text: String(err) }]);
    } finally {
      setBusy(false);
    }
  };
  const run = (e: SubmitEvent) => { e.preventDefault(); void send(prompt().trim()); };

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
    setFeed((f) => f.map((it, i) => (i === idx ? { ...it, pending: false, text: `Skipped: ${it.text}` } : it)));

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

  const runTask = async (goal: string) => {
    if (taskRunning()) return;
    setTaskRunning(true);
    setFeed((f) => [...f, { role: "user", text: `/task ${goal}` }, { role: "task", text: `▶ Task: ${goal}` }]);
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
      onDragOver={(e) => { e.preventDefault(); if (e.dataTransfer) e.dataTransfer.dropEffect = "copy"; setDropping(true); }}
      onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setDropping(false); }}
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
            <button ref={modelBtn} class="agent-model-btn" title="Pick the local model (Ollama)" onClick={toggleModelMenu}>
              {shortModel()} · local ▾
            </button>
            <Show when={modelMenu()}>
              <Portal>
                <div class="agent-menu-backdrop" onClick={() => setModelMenu(false)} />
                <div class="agent-model-menu" style={menuPos(modelBtn)}>
                  <Show when={models().length > 0} fallback={<div class="agent-model-empty">No Ollama models found (is it running?)</div>}>
                    <For each={models()}>
                      {(m) => (
                        <button classList={{ "agent-model-item": true, on: agentModelName() === m }} onClick={() => { setAgentModel(m); setModelMenu(false); }}>
                          {m}
                        </button>
                      )}
                    </For>
                  </Show>
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
            onClick={() => void setHeyGemmaEnabled(!heyGemmaEnabled())}
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
            <button ref={chatsBtn} class="agent-model-btn" title="Past chats" aria-label="Past chats" onClick={() => setChatsMenu(!chatsMenu())}>☰</button>
            <Show when={chatsMenu()}>
              <Portal>
                <div class="agent-menu-backdrop" onClick={() => setChatsMenu(false)} />
                <div class="agent-model-menu" style={menuPos(chatsBtn)}>
                  <Show when={chats().length > 0} fallback={<div class="agent-model-empty">No saved chats yet</div>}>
                    <For each={chats()}>
                      {(s) => (
                        <button classList={{ "agent-model-item": true, on: s.id === currentId }} onClick={() => loadSession(s)}>
                          <span style={{ flex: 1, overflow: "hidden", "text-overflow": "ellipsis", "white-space": "nowrap" }}>{s.title}</span>
                          <span class="agent-chat-del" title="Delete" onClick={(e) => deleteSession(s.id, e)}>✕</span>
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
                Chat with your local Gemma — ask anything. Use <kbd>/act</kbd> for a
                single page action, or <kbd>/task</kbd> for a multi-step goal
                (e.g. <em>/task find the cheapest listing and open it</em>) — the agent
                plans one step at a time and you approve each (or tick “Run all”).
                <div class="agent-empty-tips">
                  Try: <em>“what can you do”</em> · <em>“remember that …”</em> ·
                  <em>“remind me to … at 3pm”</em> · <em>“system status”</em> ·
                  <em>“search …”</em> · <em>“run …”</em> · <em>“play …”</em>
                </div>
              </div>
            }
          >
            <For each={feed()}>
              {(item, i) => (
                <div classList={{ "agent-msg": true, [`agent-${item.role}`]: true }}>
                  <Show when={item.image}><img class="agent-thumb" src={item.image} alt="attachment" /></Show>
                  <div>{item.text}</div>
                  <Show when={item.role === "plan" && item.pending && item.action}>
                    <div class="agent-approve">
                      <button class="agent-approve-yes" onClick={() => void approve(i(), item.action!)}>✓ Approve</button>
                      <button class="agent-approve-no" onClick={() => cancelPlan(i())}>Skip</button>
                    </div>
                  </Show>
                  <Show when={item.role === "shell" && item.pending && item.shellCmd}>
                    <div class="agent-approve">
                      <button class="agent-approve-yes" onClick={() => void approveShell(i(), item.shellCmd!)}>▶ Run</button>
                      <button class="agent-approve-no" onClick={() => cancelShell(i())}>Cancel</button>
                    </div>
                  </Show>
                  <Show when={item.role === "edit" && item.editDiff}>
                    <div class="agent-diff">
                      <For each={item.editDiff!.split("\n")}>
                        {(ln) => <div classList={{ "diff-add": ln.startsWith("+ "), "diff-del": ln.startsWith("- "), "diff-hunk": ln.startsWith("@@") }}>{ln || " "}</div>}
                      </For>
                    </div>
                    <Show when={item.pending && item.editPath && item.editNew !== undefined}>
                      <div class="agent-approve">
                        <button class="agent-approve-yes" onClick={() => void approveEdit(i(), item.editPath!, item.editNew!)}>✓ Apply</button>
                        <button class="agent-approve-no" onClick={() => cancelEdit(i())}>Cancel</button>
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
              fallback={<span class="agent-task-status">{working() ? "planning next step…" : "working…"}</span>}
            >
              {(s) => (
                <div class="agent-task-step">
                  <div class="agent-task-step-label">Step {s().n}: {describeAction(s().action)}</div>
                  <div class="agent-approve">
                    <button class="agent-approve-yes" onClick={() => decideStep("approve")}>✓ Run</button>
                    <button class="agent-approve-no" onClick={() => decideStep("skip")}>Skip</button>
                    <button class="agent-approve-no" onClick={() => decideStep("stop")}>⏹ Stop</button>
                  </div>
                </div>
              )}
            </Show>
            <label class="agent-task-auto" title="Auto-approve each step (destructive clicks are still blocked at click time)">
              <input type="checkbox" checked={taskAuto()} onChange={(e) => setTaskAuto(e.currentTarget.checked)} /> Run all
            </label>
          </div>
        </Show>

        {/* Chat-with-page/tabs (#34): scope toggle + one-tap prompts grounded in
            the captured DOM (the agent already receives the page/tab text). */}
        <div class="agent-context">
          <button classList={{ "agent-scope": true, on: scope() === "page" }} title="Answer using the current page" onClick={() => setScope("page")}>📄 This page</button>
          <button classList={{ "agent-scope": true, on: scope() === "tabs" }} title="Answer across all open tabs in this space" onClick={() => setScope("tabs")}>🗂 All tabs <Show when={scope() === "tabs"}><span class="agent-scope-n">{browserTabIds().length}</span></Show></button>
        </div>
        <div class="agent-chips">
          <button class="agent-chip" disabled={working()} onClick={() => void send("Summarize this in a few clear bullet points.")}>Summarize</button>
          <button class="agent-chip" disabled={working()} onClick={() => void send("What are the key points and any action items?")}>Key points</button>
          <button class="agent-chip" disabled={working()} onClick={() => void send("Explain this like I'm new to the topic.")}>Explain</button>
        </div>
        <Show when={attachment()}>
          {(a) => (
            <div class="agent-attach">
              <Show when={a().kind === "image"} fallback={<span class="agent-attach-name">📄 {a().name}</span>}>
                <img class="agent-attach-thumb" src={(a() as { dataUrl: string }).dataUrl} alt="" />
                <span class="agent-attach-name">{a().name}</span>
              </Show>
              <button class="agent-attach-x" title="Remove" onClick={() => setAttachment(null)}>✕</button>
            </div>
          )}
        </Show>
        <Show when={ctxFiles().length > 0}>
          <div class="agent-ctxfiles">
            <For each={ctxFiles()}>
              {(f) => (
                <span class="agent-ctxchip" title={f.path}>
                  📄 {f.name}
                  <span class="agent-ctxchip-x" title="Remove from context" onClick={() => setCtxFiles((c) => c.filter((x) => x.path !== f.path))}>✕</span>
                </span>
              )}
            </For>
            <Show when={ctxFiles().length > 1}>
              <button class="agent-ctxchip-clear" onClick={clearCtxFiles}>clear all</button>
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
            <button type="button" class="agent-attach-btn" title="Attach an image or text file" disabled={working() || taskRunning()} onClick={() => fileInput?.click()}>📎</button>
            <button
              type="button"
              classList={{ "agent-attach-btn": true, "agent-mic-on": recording() }}
              title="Hold to talk (push-to-talk)"
              disabled={working() || taskRunning()}
              onPointerDown={(e) => { e.preventDefault(); void startRec(); }}
              onPointerUp={() => void stopRec()}
              onPointerLeave={() => { if (recording()) void stopRec(); }}
            >🎤</button>
            <input
              value={prompt()}
              onInput={(e) => setPrompt(e.currentTarget.value)}
              placeholder={taskRunning() ? "task running…" : working() ? "thinking…" : attachment() ? "Ask about the attachment…" : scope() === "tabs" ? "Ask across tabs · /act · /task" : "Ask · attach 📎 · /act · /task"}
              disabled={working() || taskRunning()}
              style={{ flex: "1", "min-width": "0", padding: "10px 12px", border: working() ? "none" : undefined }}
            />
            <Show when={working() || speaking()}>
              <button type="button" class="agent-attach-btn agent-stop-btn" title="Stop Gemma" aria-label="Stop" onClick={cancelReply}>■</button>
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
