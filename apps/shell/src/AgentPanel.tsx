/**
 * Flux Agent sidebar — chat, single page actions (/act), and multi-step tasks
 * (/task, the iterative agent loop #A). Split out of App.tsx and lazy-loaded so
 * its weight stays off the eager chrome bundle (ADR 0001's 50 KB gzip budget);
 * it only loads when the agent panel is first opened.
 */
import { For, Show, createEffect, createSignal, onCleanup, onMount, type Component } from "solid-js";
import {
  agentChat,
  agentChatStream,
  agentChatTabsStream,
  agentShellPlan,
  runShell,
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
import { activeId, activeWorkspace, agentModelName, filesPanelOpen, openTab, pendingAsk, pendingLens, setAgentModel, setPendingAsk, setPendingLens, tabs } from "./store";
import AgentAurora from "./AgentAurora";
import { heyGemmaEnabled, listening, micLive, setHeyGemmaEnabled, setVoiceHandler, startConversation, voiceStatus } from "./heygemma";
import { speak } from "./speak";

type FeedItem = { role: "user" | "assistant" | "action" | "error" | "plan" | "task" | "shell"; text: string; action?: AgentAction; pending?: boolean; image?: string; shellCmd?: string };

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

  const working = () => busy() || status().state === "thinking";

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
      micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
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
      const q = m[1]!.trim().replace(/^(?:me\s+)?(?:the|this|a|that)?\s*(?:song|track|tune)\s+(?:called\s+|named\s+|titled\s+)?/i, "").trim();
      return () => spotifyPlay(q || m[1]!.trim());
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

  // Conversation memory: prepend the recent turns so the model has context. The
  // trailing "user" entry is the message we just pushed, so it's excluded. Capped
  // to the last few turns to keep prompt-eval fast.
  const convoPrompt = (current: string): string => {
    const turns = feed().filter((it) => it.role === "user" || it.role === "assistant");
    const prior = (turns.length && turns[turns.length - 1]?.role === "user" ? turns.slice(0, -1) : turns).slice(-8);
    if (!prior.length) return current;
    const transcript = prior.map((it) => `${it.role === "user" ? "User" : "Gemma"}: ${it.text}`).join("\n");
    return `Conversation so far:\n${transcript}\n\nReply to the new message, using the conversation above for context.\nUser: ${current}`;
  };

  // "search X" / "google X" / "open a new tab and search X" → open a new browser tab
  // with the result (searchResolve respects the default engine + navigate-vs-search).
  // Works typed or by voice. /act and /task can't do this — they act on the current
  // page's DOM, not browser tabs.
  const SEARCH_RE =
    /^(?:open\s+(?:a\s+|the\s+)?new\s+tab\s+(?:and\s+|to\s+)?(?:search(?:\s+for)?\s+|google\s+|for\s+)?|search(?:\s+for)?\s+|google\s+|look\s*up\s+)(.+)/i;
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
    const stripped = t.replace(/^\/?(hey\s+)?gemma[,:\s]+/i, "").trim();
    const sh = stripped.match(SHELL_RE);
    if (sh?.[1]) return await runShellCmd(sh[1]);
    const musicReply = await handleMusic(t);
    if (musicReply !== null) return musicReply;
    const vs = stripped.match(SEARCH_RE);
    if (vs?.[1]) return await runSearch(vs[1]);
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
      // Shell command — "run …" / "execute …" / "/run …" (rm + destructive blocked).
      const shell = p.match(SHELL_RE);
      if (shell?.[1]) { await runShellCmd(shell[1].trim()); return; }
      // Music command (AudioPulse) before chat — "play …" / "skip" / "pause" / …
      if (await runMusic(p)) return;
      // "search …" / "open a new tab and search …" → open a browser tab.
      const search = p.match(SEARCH_RE);
      if (search?.[1]) { await runSearch(search[1]); return; }
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
        const idx = feed().length;
        setFeed((f) => [...f, { role: "assistant", text: "" }]);
        let acc = "";
        const append = (chunk: string) => {
          acc += chunk;
          setFeed((f) => f.map((it, i) => (i === idx ? { ...it, text: it.text + chunk } : it)));
        };
        if (scope() === "tabs") await agentChatTabsStream(cp, browserTabIds(), append);
        else await agentChatStream(cp, append);
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
            <button class="agent-model-btn" title="Pick the local model (Ollama)" onClick={toggleModelMenu}>
              {shortModel()} · local ▾
            </button>
            <Show when={modelMenu()}>
              <div class="agent-model-menu glass">
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
            title="New chat — clear the conversation"
            aria-label="New chat"
            onClick={() => { if (!working() && !taskRunning()) setFeed([]); }}
          >
            ＋
          </button>
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
