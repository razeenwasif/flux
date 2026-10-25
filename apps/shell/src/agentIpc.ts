/**
 * The agent panel's own calls (AgentPanel.tsx and nothing else), out of
 * ipc.ts so they load with the panel rather than on every start.
 */
import { Channel, invoke } from "@tauri-apps/api/core";
import { asRoute } from "./cloudroute";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type {
  AgentAction,
  AgentStatus,
  EditPlan,
  KbCheck,
  LocalEvent,
  NextStep,
  NoteProposal,
  NvimSelection,
  NvimState,
  PacPlan,
  PacStatus,
  Place,
  ReminderRow,
  RouteStatus,
  SystemStats,
  TabThread,
} from "./ipc";

/** Plan a page action without executing it — the UI previews + asks to approve (#8). */
export const agentPlan = (prompt: string) => invoke<AgentAction>("agent_plan", { prompt });

/** Run a shell command for the agent (rm + destructive commands are blocked). */
export const runShell = (command: string) => invoke<string>("run_shell", { command });

/** Denylist pre-check before typing a command into the live terminal. null = allowed. */
export const shellGuard = (command: string) => invoke<string | null>("shell_guard", { command });

/** Plan a file edit (search/replace) from an instruction; the UI diffs + approves. */
export const agentEditPlan = (path: string, content: string, instruction: string) =>
  invoke<EditPlan>("agent_edit_plan", { path, content, instruction });

/** Fired when a reminder is due (the scheduler emits it). */
export const onReminderDue = (cb: (r: ReminderRow) => void): Promise<UnlistenFn> =>
  listen<ReminderRow>("flux://reminder-due", (e) => cb(e.payload));

export const memoryAppend = (note: string) => invoke<string>("memory_append", { note });

/** Decompose a compound request into ordered single-action sub-commands (#115). */
export const agentPlanSteps = (goal: string) => invoke<string[]>("agent_plan_steps", { goal });

export const agentPacPlan = (request: string) => invoke<PacPlan>("agent_pac_plan", { request });

/** Preflight: is `pac` installed and is there an active auth profile? */
export const pacStatus = () => invoke<PacStatus>("pac_status");

export const agentNextStep = (goal: string, history: string[]) =>
  invoke<NextStep>("agent_next_step", { goal, history });

/** Models the stored key can reach (asked, not hardcoded). */
export const geminiModels = () => invoke<string[]>("gemini_models");

export const geminiDefaultModel = () => invoke<string>("gemini_default_model");

/** Escalate to (or back from) the cloud for THIS session. Returns what will
 *  actually happen, which is not always what was asked — escalating without a
 *  stored key fails, and the agent stays local. */
export const agentCloudSet = (on: boolean, model: string) =>
  invoke<RouteStatus>("agent_cloud_set", { on, model }).then(asRoute);

export const agentCloudStatus = () => invoke<RouteStatus>("agent_cloud_status").then(asRoute);

export const agentReadTextFile = (path: string) => invoke<string>("agent_read_text_file", { path });

export const agentPdfFetch = (url: string) => invoke<ArrayBuffer>("agent_pdf_fetch", { url });

export const agentWriteTextFile = (path: string, content: string) =>
  invoke<void>("agent_write_text_file", { path, content });

/** Never rejects: "no editor" is an ordinary state, not an error. */
export const nvimState = (session: number) => invoke<NvimState>("nvim_state", { session });

export const nvimSelection = (session: number) => invoke<NvimSelection>("nvim_selection", { session });

/** The current buffer's text, including unwritten changes. */
export const nvimBuffer = (session: number) => invoke<string>("nvim_buffer", { session });

/** Search + play the top match. Returns a human "▶ Playing …" line (or an error). */
export const spotifyPlay = (query: string) => invoke<string>("spotify_play", { query });

export const spotifyPause = () => invoke<string>("spotify_pause");

export const spotifyResume = () => invoke<string>("spotify_resume");

export const spotifyNext = () => invoke<string>("spotify_next");

export const spotifyPrev = () => invoke<string>("spotify_prev");

export const spotifyNowPlaying = () => invoke<string>("spotify_now_playing");

export const spotifyShuffle = (on: boolean) => invoke<string>("spotify_shuffle", { on });

/** Repeat mode: "one" (track) / "all" (context) / "off". */
export const spotifyRepeat = (mode: string) => invoke<string>("spotify_repeat", { mode });

export const spotifyVolume = (percent: number) => invoke<string>("spotify_volume", { percent });

export const spotifyPlayLiked = () => invoke<string>("spotify_play_liked");

export const spotifyPlayPlaylist = (name: string) => invoke<string>("spotify_play_playlist", { name });

/** Launch AudioPulse (Linux/WSL build) so its Spotify Connect device comes online. */
export const spotifyLaunch = () => invoke<string>("spotify_launch");

/**
 * Streaming chat (BACKLOG #82): calls `onToken` for each chunk as the model
 * generates it, resolving with the full reply when done. The sidebar renders
 * the answer live instead of waiting for the whole completion.
 */
export const agentChatStream = (prompt: string, onToken: (chunk: string) => void): Promise<void> => {
  const ch = new Channel<string>();
  ch.onmessage = onToken;
  return invoke<void>("agent_chat_stream", { prompt, onToken: ch });
};

/** Streaming counterpart of {@link agentChatTabs} (BACKLOG #82). */
export const agentChatTabsStream = (
  prompt: string,
  tabIds: number[],
  onToken: (chunk: string) => void,
): Promise<void> => {
  const ch = new Channel<string>();
  ch.onmessage = onToken;
  return invoke<void>("agent_chat_tabs_stream", { prompt, tabIds, onToken: ch });
};

// ─── Agent model picker (BACKLOG #81) ────────────────────────────────────────
export const agentModels = () => invoke<string[]>("agent_models");

// ─── Events (Rust → UI) ──────────────────────────────────────────────────

export const onAgentStatus = (cb: (s: AgentStatus) => void): Promise<UnlistenFn> =>
  listen<AgentStatus>("flux://agent-status", (e) => cb(e.payload));

/** Outcome of a compiled agent action, reported by the page itself:
 *  [tabId, kind, detail, format, payload]. Untrusted: any page can send one. */
export const onAgentReport = (
  cb: (tabId: number, kind: string, detail: string, format: string, payload: string) => void,
): Promise<UnlistenFn> =>
  listen<[number, string, string, string, string]>("flux://agent-report", (e) => cb(...e.payload));

// ─── Corpus write access (#118) — let the agent add to Scroll / Onyx ────────
/** Clip a URL into Scroll (POSTs its /clip form; Scroll scrapes + stores). */
export const scrollClip = (url: string, tags?: string) => invoke<string>("scroll_clip", { url, tags });

/** Ask the model what to add. Returns a proposal to confirm; writes nothing. */
export const notePlan = (request: string, context?: string) =>
  invoke<NoteProposal>("note_plan", { request, context });

/** Capture the ACTIVE page's visible text into an Onyx note — for lecture
 *  transcripts (Echo360 &c.). Errors if too little text was captured, rather
 *  than filing an empty stub. Returns the written path. */
export const onyxCapturePage = (title: string, folder?: string, tags?: string) =>
  invoke<string>("onyx_capture_page", { title, folder, tags });

export const kbCheck = (text: string) => invoke<KbCheck>("kb_check", { text });

// ─── Local (editable) calendar events (BACKLOG #114) ─────────────────────────
/** List just the on-device events (no ICS overlay) — used by the agent. */
export const calLocalEvents = () => invoke<LocalEvent[]>("cal_local_events");

export const agentPlaces = () => invoke<Place[]>("agent_places");

/** Drop the agent's model from VRAM now instead of waiting out the 30-minute
 *  keep-alive (#169). Resolves to the model that was unloaded; it reloads by
 *  itself on the next request. Empty/omitted → whichever model is active. */
export const agentUnload = (model?: string) => invoke<string>("agent_unload", { model });

/** Visual Lens (#115): identify the captured PNG with the local vision model. */
export const agentLens = (imagePath: string, prompt?: string) =>
  invoke<string>("agent_lens", { imagePath, prompt: prompt ?? null });

/** Ask the local vision model about an uploaded image (base64, no data: prefix). */
export const agentVision = (imageB64: string, prompt?: string) =>
  invoke<string>("agent_vision", { imageB64, prompt: prompt ?? null });

/** CPU + memory + heaviest processes (agent "system awareness"). */
export const systemStats = () => invoke<SystemStats>("system_stats");

/** The active page's persistent thread (re-attach by visit) — null when the
 *  tab has no current Visit (internal pages, private tabs). */
export const traceTabThread = (tabId: number) => invoke<TabThread | null>("trace_tab_thread", { tabId });
