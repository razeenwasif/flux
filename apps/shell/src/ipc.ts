/**
 * Typed IPC layer over Tauri v2. All shapes mirror the Rust structs in
 * crates/flux-core/src/state.rs — keep the two in lockstep (codegen via
 * specta is issue #12).
 */
import { Channel, invoke } from "@tauri-apps/api/core";
import { asRoute } from "./cloudroute";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";

export { Channel };

// ─── Window controls (custom chrome — decorations are off) ──────────────────

export type ResizeDir =
  "North" | "South" | "East" | "West" | "NorthEast" | "NorthWest" | "SouthEast" | "SouthWest";

/** True only inside the Tauri runtime — lets the mocked UI preview no-op. */
const inTauri = () => typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

/** macOS-style window controls + custom drag/resize, safe outside Tauri. */
export const win = {
  minimize: () => inTauri() && void getCurrentWindow().minimize(),
  toggleMaximize: () => inTauri() && void getCurrentWindow().toggleMaximize(),
  // Save the window geometry (window-state plugin) then force-close. A raw
  // destroy() force-closes but skips the plugin's save, so the window forgot its
  // size; close() emits closeRequested but doesn't actually close the borderless
  // multi-webview window. The backend command does both: save, then destroy.
  close: () => inTauri() && void invoke("close_main_window").catch(() => getCurrentWindow().destroy()),
  startDragging: () => inTauri() && void getCurrentWindow().startDragging(),
  startResize: (dir: ResizeDir) => inTauri() && void getCurrentWindow().startResizeDragging(dir),
};

/** Reserved session id for the vertical terminal column (see terminal.rs). */
export const PANE_SESSION = 0;

/** Sentinel url for the Flux start page (no webview; renders the dashboard). */
export const START_URL = "flux://start";
export const isStartUrl = (url: string) => url === START_URL || url.startsWith("flux://");

// Types generated from the Rust structs (BACKLOG #12) — re-exported so callers
// keep importing them from "./ipc". Regenerate via
// `FLUX_WRITE_BINDINGS=1 cargo test -p flux-core bindings`.
import type {
  AgentStatus as GenAgentStatus,
  RouteStatus as GenRouteStatus,
  NvimState as GenNvimState,
  FramePolicy as GenFramePolicy,
  ArchiveEntryWire as GenArchiveEntryWire,
  ArchiveMeta as GenArchiveMeta,
  Bookmark as GenBookmark,
  Boost as GenBoost,
  CalEvent as GenCalEvent,
  CalFeed as GenCalFeed,
  LocalEvent as GenLocalEvent,
  CurrencyRates as GenCurrencyRates,
  ShellHistHit as GenShellHistHit,
  FindHit as GenFindHit,
  WatchItem as GenWatchItem,
  TrackerGraph as GenTrackerGraph,
  ContentScript as GenContentScript,
  CookieStatus as GenCookieStatus,
  CredentialMeta as GenCredentialMeta,
  DirListing as GenDirListing,
  DownloadItem as GenDownloadItem,
  FileEntry as GenFileEntry,
  KbHit as GenKbHit,
  KbSourceStat as GenKbSourceStat,
  KbStatus as GenKbStatus,
  KbRecentItem as GenKbRecentItem,
  KbCheck as GenKbCheck,
  Notebook as GenNotebook,
  NotebookMeta as GenNotebookMeta,
  PageNote as GenPageNote,
  ServiceStatus as GenServiceStatus,
  SpotifyState as GenSpotifyState,
  SpotifyPlaylist as GenSpotifyPlaylist,
  TuiApp as GenTuiApp,
  HotRule as GenHotRule,
  HttpsStatus as GenHttpsStatus,
  InstalledExt as GenInstalledExt,
  LeanStatus as GenLeanStatus,
  Macro as GenMacro,
  MacroStatus as GenMacroStatus,
  Manifest as GenManifest,
  OmniHit as GenOmniHit,
  PermDecision as GenPermDecision,
  PermKind as GenPermKind,
  PermAsk as GenPermAsk,
  QuickLocation as GenQuickLocation,
  ReaderBlock as GenReaderBlock,
  ShieldsStatus as GenShieldsStatus,
  SitePerm as GenSitePerm,
  Step as GenStep,
  SyncReport as GenSyncReport,
  SyncStatus as GenSyncStatus,
  Todo as GenTodo,
  ClusterTag as GenClusterTag,
  Container as GenContainer,
  Feed as GenFeed,
  FeedItem as GenFeedItem,
  HistoryEntry as GenHistoryEntry,
  Visit as GenVisit,
  Edge as GenEdge,
  EdgeKind as GenEdgeKind,
  TraceGraph as GenTraceGraph,
  ForgetScope as GenForgetScope,
  SnapshotWire as GenSnapshotWire,
  ChatMsg as GenChatMsg,
  Draft as GenDraft,
  AmbientHint as GenAmbientHint,
  TabThread as GenTabThread,
  TraceHistogram as GenTraceHistogram,
  ProcInfo as GenProcInfo,
  PwaApp as GenPwaApp,
  SavedSession as GenSavedSession,
  SavedTab as GenSavedTab,
  DaySnapshot as GenDaySnapshot,
  SpeedResult as GenSpeedResult,
  ShellSnapshot as GenShellSnapshot,
  SysStats as GenSysStats,
  GpuInfo as GenGpuInfo,
  NetIface as GenNetIface,
  DiskInfo as GenDiskInfo,
  Place as GenPlace,
  TabFolder as GenTabFolder,
  TabGroup as GenTabGroup,
  TabKind as GenTabKind,
  TabMeta as GenTabMeta,
  VaultStatus as GenVaultStatus,
  VaultDiag as GenVaultDiag,
  VaultSavePrompt as GenVaultSavePrompt,
  WebPanel as GenWebPanel,
  Workspace as GenWorkspace,
  LaunchIntent as GenLaunchIntent,
  ChromeProfilePreview as GenChromeProfilePreview,
  ChromeBookmark as GenChromeBookmark,
  AgentAction as GenAgentAction,
  NoteAction as GenNoteAction,
  NoteProposal as GenNoteProposal,
  EditPlan as GenEditPlan,
  NextStep as GenNextStep,
  PacPlan as GenPacPlan,
  ReadingStructure as GenReadingStructure,
  PacStatus as GenPacStatus,
  Reminder as GenReminder,
  SearchEngine as GenSearchEngine,
  Resolution as GenResolution,
  MemInfo as GenMemInfo,
  HibernateCandidate as GenHibernateCandidate,
  EvictionRank as GenEvictionRank,
  PrefetchHint as GenPrefetchHint,
  Verdict as GenVerdict,
  NavAssessment as GenNavAssessment,
  LoadAssessment as GenLoadAssessment,
  OAuthConsent as GenOAuthConsent,
  PermissionNote as GenPermissionNote,
  SensitiveSite as GenSensitiveSite,
  Explainer as GenExplainer,
  PolicyFlag as GenPolicyFlag,
  AuditEntry as GenAuditEntry,
  TextFix as GenTextFix,
  Transcript as GenTranscript,
  MailConfig as GenMailConfig,
  MailMsg as GenMailMsg,
  StorageEntry as GenStorageEntry,
  StorageReport as GenStorageReport,
} from "./bindings.gen";
/** One logged agent action (ADR 0013, Pillar 0). */
export type AuditEntry = GenAuditEntry;
/** One notable clause found in a policy / ToS (ADR 0013, Pillar 3 M5). */
export type PolicyFlag = GenPolicyFlag;
/** Sentinel plain-language privacy explainer (ADR 0013, Pillar 3 M5). */
export type Explainer = GenExplainer;
/** Sentinel sensitive-site classification (ADR 0013, Pillar 2 M4). */
export type SensitiveSite = GenSensitiveSite;
/** Sentinel agent note on a permission prompt (ADR 0013, Pillar 2 M4). */
export type PermissionNote = GenPermissionNote;
/** Sentinel phishing verdict (ADR 0013, Pillar 1). */
export type PhishVerdict = GenVerdict;
/** All deterministic checks for one navigation (ADR 0013). */
export type NavAssessment = GenNavAssessment;
/** The model-backed pass once the page is captured (ADR 0013). */
export type LoadAssessment = GenLoadAssessment;
/** Sentinel OAuth consent review (ADR 0013, Pillar 1 M3). */
export type OAuthConsent = GenOAuthConsent;
export type ClusterTag = GenClusterTag;
export type TabKind = GenTabKind;
export type Workspace = GenWorkspace;
export type Container = GenContainer;
export type AgentStatus = GenAgentStatus;
/** Where the agent's next request goes: local, or the opt-in cloud (#175). */
export type RouteStatus = GenRouteStatus;
export type ShellSnapshot = GenShellSnapshot;
export type TabMeta = GenTabMeta;
export type TabGroup = GenTabGroup;
export type TabFolder = GenTabFolder;
export type WebPanel = GenWebPanel;
export type Bookmark = GenBookmark;
export type Feed = GenFeed;
export type FeedItem = GenFeedItem;
export type PwaApp = GenPwaApp;
export type HistoryEntry = GenHistoryEntry;
export type Visit = GenVisit;
export type Edge = GenEdge;
export type EdgeKind = GenEdgeKind;
export type TraceGraph = GenTraceGraph;
export type ForgetScope = GenForgetScope;
export type SnapshotWire = GenSnapshotWire;
export type ChatMsg = GenChatMsg;
export type Draft = GenDraft;
export type AmbientHint = GenAmbientHint;
export type TabThread = GenTabThread;
export type TraceHistogram = GenTraceHistogram;
export type SavedTab = GenSavedTab;
export type SavedSession = GenSavedSession;
export type DaySnapshot = GenDaySnapshot;
export type ProcInfo = GenProcInfo;
export type SysStats = GenSysStats;
export type GpuInfo = GenGpuInfo;
export type SpeedResult = GenSpeedResult;
export type ArchiveMeta = GenArchiveMeta;
export type CalFeed = GenCalFeed;
export type CalEvent = GenCalEvent;
export type LocalEvent = GenLocalEvent;
export type Todo = GenTodo;
// Batch 3 (BACKLOG #12): misc command structs. `MacroStep`/`ExtManifest`/
// `ExtContentScript`/`ArchiveEntry` keep their established frontend names as
// aliases over the generated types.
export type OmniHit = GenOmniHit;
export type ReaderBlock = GenReaderBlock;
export type ShieldsStatus = GenShieldsStatus;
export type HotRule = GenHotRule;
export type LeanStatus = GenLeanStatus;
export type HttpsStatus = GenHttpsStatus;
export type CookieStatus = GenCookieStatus;
export type PermKind = GenPermKind;
export type PermDecision = GenPermDecision;
export type SitePerm = GenSitePerm;
export type CredentialMeta = GenCredentialMeta;
export type VaultStatus = GenVaultStatus;
export type VaultSavePrompt = GenVaultSavePrompt;
export type ExtContentScript = GenContentScript;
export type ExtManifest = GenManifest;
export type InstalledExt = GenInstalledExt;
export type MacroStep = GenStep;
export type Macro = GenMacro;
export type MacroStatus = GenMacroStatus;
export type Boost = GenBoost;
export type DownloadItem = GenDownloadItem;
export type FileEntry = GenFileEntry;
export type DirListing = GenDirListing;
export type KbHit = GenKbHit;
export type KbSourceStat = GenKbSourceStat;
export type KbStatus = GenKbStatus;
export type QuickLocation = GenQuickLocation;
export type SyncStatus = GenSyncStatus;
export type SyncReport = GenSyncReport;
export type ArchiveEntry = GenArchiveEntryWire;

export const foldersList = () => invoke<TabFolder[]>("folders_list");
export const folderCreate = (name: string) => invoke<number>("folder_create", { name });
export const folderUpdate = (id: number, patch: { name?: string; collapsed?: boolean }) =>
  invoke<void>("folder_update", { id, name: patch.name ?? null, collapsed: patch.collapsed ?? null });
export const folderDelete = (id: number) => invoke<void>("folder_delete", { id });
export const tabSetFolder = (tabId: number, folder: number | null) =>
  invoke<void>("tab_set_folder", { tabId, folder });
/** Rename a tab (empty/null clears the custom name → revert to page title). */
export const tabRename = (tabId: number, name: string | null) =>
  invoke<void>("tab_rename", { tabId, name: name || null });

export type LaunchIntent = GenLaunchIntent;
export type ChromeProfilePreview = GenChromeProfilePreview;
export type ChromeBookmark = GenChromeBookmark;
export type AgentAction = GenAgentAction;

// ─── Commands ────────────────────────────────────────────────────────────

export const tabCreate = (kind: TabKind, url?: string, isPrivate?: boolean, container?: number) =>
  invoke<TabMeta>("tab_create", {
    kind,
    url: url ?? null,
    private: isPrivate ?? null,
    container: container ?? null,
  });
export const shellSnapshot = () => invoke<ShellSnapshot>("shell_snapshot");
// ─── Multi-account containers (BACKLOG #59) — Container type from bindings.gen ──
export const containersList = () => invoke<Container[]>("containers_list");
export const containerCreate = (name: string, color: number) =>
  invoke<number>("container_create", { name, color });
export const containerUpdate = (id: number, patch: { name?: string; color?: number }) =>
  invoke<void>("container_update", { id, name: patch.name ?? null, color: patch.color ?? null });
export const containerDelete = (id: number) => invoke<void>("container_delete", { id });
export const tabFocus = (id: number) => invoke<void>("tab_focus", { id });
export const tabClose = (id: number) => invoke<void>("tab_close", { id });
/** Peek / glance (#50): open a link in a transient floating window, not a tab. */
export const peekOpen = (url: string) => invoke<void>("peek_open", { url });
export const tabList = () => invoke<TabMeta[]>("tab_list");
export const tabSetPinned = (id: number, pinned: boolean) => invoke<void>("tab_set_pinned", { id, pinned });
/** Reorder the tab strip — `ids` is the new full display order (BACKLOG #30). */
export const tabReorder = (ids: number[]) => invoke<void>("tab_reorder", { ids });
// ─── Tab groups (BACKLOG #56) ────────────────────────────────────────────────
export const groupsList = () => invoke<TabGroup[]>("groups_list");
export const groupCreate = (name: string, color: number, tabIds: number[]) =>
  invoke<number>("group_create", { name, color, tabIds });
export const groupUpdate = (id: number, patch: { name?: string; color?: number; collapsed?: boolean }) =>
  invoke<void>("group_update", {
    id,
    name: patch.name ?? null,
    color: patch.color ?? null,
    collapsed: patch.collapsed ?? null,
  });
export const groupDelete = (id: number) => invoke<void>("group_delete", { id });
export const tabSetGroup = (tabId: number, group: number | null) =>
  invoke<void>("tab_set_group", { tabId, group });
/** Send a tab to another workspace (#44); detaches it from any group. */
export const tabSetWorkspace = (tabId: number, workspace: number) =>
  invoke<void>("tab_set_workspace", { tabId, workspace });
/** Send a whole group to another workspace (#44); returns the moved tab ids. */
export const groupSetWorkspace = (group: number, workspace: number) =>
  invoke<number[]>("group_set_workspace", { group, workspace });
/** "Group by topic" — seed groups from the semantic clusters; returns the count. */
export const groupsFromClusters = () => invoke<number>("groups_from_clusters");
// ─── Workspaces (BACKLOG #44) ────────────────────────────────────────────────
export const workspacesList = () => invoke<Workspace[]>("workspaces_list");
export const workspaceActive = () => invoke<number>("workspace_active");
export const workspaceSwitch = (id: number) => invoke<void>("workspace_switch", { id });
export const workspaceCreate = (name: string, color: number) =>
  invoke<number>("workspace_create", { name, color });
export const workspaceUpdate = (id: number, patch: { name?: string; color?: number }) =>
  invoke<void>("workspace_update", { id, name: patch.name ?? null, color: patch.color ?? null });
/** Delete a workspace + its tabs; returns the closed tab ids. */
export const workspaceDelete = (id: number) => invoke<number[]>("workspace_delete", { id });
// ─── Web panels (BACKLOG #48) — WebPanel type from bindings.gen ───────────────
export const panelsList = () => invoke<WebPanel[]>("panels_list");
export const panelAdd = (url: string, title: string) => invoke<WebPanel>("panel_add", { url, title });
export const panelRemove = (id: number) => invoke<void>("panel_remove", { id });
export const panelReorder = (ids: number[]) => invoke<void>("panel_reorder", { ids });
// Panel webview (its own native child webview; not part of the tab lifecycle).
export const panelOpen = (panelId: number, url: string, r: Rect) =>
  invoke<void>("panel_open", { panelId, url, x: r.x, y: r.y, width: r.width, height: r.height });
export const panelSetBounds = (panelId: number, r: Rect) =>
  invoke<void>("panel_set_bounds", { panelId, x: r.x, y: r.y, width: r.width, height: r.height });
export const panelShow = (panelId: number) => invoke<void>("panel_show", { panelId });
export const panelHide = (panelId: number) => invoke<void>("panel_hide", { panelId });
export const panelNavigate = (panelId: number, url: string) =>
  invoke<void>("panel_navigate", { panelId, url });
export const panelClose = (panelId: number) => invoke<void>("panel_close", { panelId });
/** Fires when a web panel reports its unread count (#48), parsed from its title. */
export const onPanelBadge = (cb: (panelId: number, count: number) => void): Promise<UnlistenFn> =>
  listen<[number, number]>("flux://panel-badge", (e) => cb(e.payload[0], e.payload[1]));
/** Sync a tab's live url/title to the backend so the persisted session is current. */
export const tabSetUrl = (id: number, url: string, title?: string) =>
  invoke<void>("tab_set_url", { id, url, title: title ?? null });
/** The backend's currently-focused tab id (for restoring focus on boot). */
export const tabActive = () => invoke<number | null>("tab_active");
export const launchIntent = () => invoke<LaunchIntent>("launch_intent");
export const chromeImportPreview = () => invoke<ChromeProfilePreview[]>("chrome_import_preview");
export const chromeImportBookmarks = (profileDir: string) =>
  invoke<ChromeBookmark[]>("chrome_import_bookmarks", { profileDir });
export const terminalEnv = () => invoke<Record<string, string>>("terminal_env");
export const agentExecute = (prompt: string) => invoke<AgentAction>("agent_execute", { prompt });
/** Plan a page action without executing it — the UI previews + asks to approve (#8). */
export const agentPlan = (prompt: string) => invoke<AgentAction>("agent_plan", { prompt });
/** Execute a user-approved planned action (#8). */
export const agentRunAction = (action: AgentAction) => invoke<AgentAction>("agent_run_action", { action });
/** Plan the next step of a multi-step task given the goal + steps done so far (#A). */
export const agentTaskStep = (goal: string, history: string[]) =>
  invoke<AgentAction>("agent_task_step", { goal, history });
/** Free-form chat with the local model (no page required). Returns the reply. */
export const agentChat = (prompt: string) => invoke<string>("agent_chat", { prompt });
/** Push-to-talk STT (#voice): transcribe base64 LE-i16 mono PCM at `sampleRate`. */
export const voiceTranscribe = (pcmB64: string, sampleRate: number) =>
  invoke<string>("voice_transcribe", { pcmB64, sampleRate });
/** More accurate STT via whisper.cpp (errors if whisper isn't installed). */
export const sttWhisper = (pcmB64: string, sampleRate: number) =>
  invoke<string>("stt_whisper", { pcmB64, sampleRate });
/** Grammar-restricted wake-word pass (Vosk) — reliable "hey gemma" spotting. */
export const wakeTranscribe = (pcmB64: string, sampleRate: number) =>
  invoke<string>("wake_transcribe", { pcmB64, sampleRate });
/** Run a shell command for the agent (rm + destructive commands are blocked). */
export const runShell = (command: string) => invoke<string>("run_shell", { command });
/** Denylist pre-check before typing a command into the live terminal. null = allowed. */
export const shellGuard = (command: string) => invoke<string | null>("shell_guard", { command });
/** Read a text file (WSL-aware) into the agent's context. */
export const readTextFile = (path: string) => invoke<string>("read_text_file", { path });
/** Write a text file (WSL-aware) — only after the user approves an edit. */
export const writeTextFile = (path: string, content: string) =>
  invoke<void>("write_text_file", { path, content });
export type EditPlan = GenEditPlan;
/** Plan a file edit (search/replace) from an instruction; the UI diffs + approves. */
export const agentEditPlan = (path: string, content: string, instruction: string) =>
  invoke<EditPlan>("agent_edit_plan", { path, content, instruction });
/** Persistent reminders (backend-scheduled; fire even with the panel closed). */
export type ReminderRow = GenReminder;
/** Fire an OS notification (clocks widget alarm/timer alerts, #134). */
export const osNotify = (title: string, body: string) => invoke<void>("os_notify", { title, body });
export const remindersList = () => invoke<ReminderRow[]>("reminders_list");
export const remindersAdd = (id: string, text: string, due: number | null, created: number) =>
  invoke<void>("reminders_add", { id, text, due, created });
export const remindersRemove = (id: string) => invoke<void>("reminders_remove", { id });
export const remindersImport = (items: ReminderRow[]) => invoke<void>("reminders_import", { items });
/** Fired when a reminder is due (the scheduler emits it). */
export const onReminderDue = (cb: (r: ReminderRow) => void): Promise<UnlistenFn> =>
  listen<ReminderRow>("flux://reminder-due", (e) => cb(e.payload));
/** Gemma's long-term memory (a Markdown file). Read for context / append facts. */
export const memoryRead = () => invoke<string>("memory_read");
export const memoryAppend = (note: string) => invoke<string>("memory_append", { note });
export const memoryWrite = (content: string) => invoke<void>("memory_write", { content });
export const memoryPath = () => invoke<string>("memory_path_str");
/** Turn a natural request into a shell command (or null if it's conversational). */
export const agentShellPlan = (prompt: string) => invoke<string | null>("agent_shell_plan", { prompt });
/** Decompose a compound request into ordered single-action sub-commands (#115). */
export const agentPlanSteps = (goal: string) => invoke<string[]>("agent_plan_steps", { goal });
/** Map a Power Platform request to ONE `pac` CLI command (deterministic ALM path,
 * #135). Risk is Rust-classified; nothing runs until the shell card is approved. */
export type PacPlan = GenPacPlan;
export type ReadingStructure = GenReadingStructure;
export type PacStatus = GenPacStatus;
export const agentPacPlan = (request: string) => invoke<PacPlan>("agent_pac_plan", { request });
/** Structural reading (#41 upgrade): classify the reader doc + map headings onto
 *  canonical sections (paper → Abstract/Methods/…). Rust-validated. */
export const readerStructure = (title: string, headings: string[]) =>
  invoke<ReadingStructure>("reader_structure", { title, headings });
/** Preflight: is `pac` installed and is there an active auth profile? */
export const pacStatus = () => invoke<PacStatus>("pac_status");
/** Adaptive loop: next command toward `goal` given the history of results so far. */
export type NextStep = GenNextStep;
export const agentNextStep = (goal: string, history: string[]) =>
  invoke<NextStep>("agent_next_step", { goal, history });
/** Store (or clear, with "") the Picovoice (Porcupine) access key in the keyring. */
export const porcupineSetKey = (key: string) => invoke<void>("porcupine_set_key", { key });
export const porcupineHasKey = () => invoke<boolean>("porcupine_has_key");
/** Resolve the access key (keyring) + keyword/model files (base64) for the Web SDK. */
export const porcupineConfig = (ppnPath: string, modelPath: string) =>
  invoke<{ accessKey: string; keywordB64: string; modelB64: string }>("porcupine_config", {
    ppnPath,
    modelPath,
  });
/** Local TTS via Piper: returns a base64 WAV (errors if Piper isn't installed). */
export const voiceSpeak = (text: string) => invoke<string>("voice_speak", { text });
/** Store (or clear, with "") the ElevenLabs API key in the OS keyring. */
export const elevenlabsSetKey = (key: string) => invoke<void>("elevenlabs_set_key", { key });
export const elevenlabsHasKey = () => invoke<boolean>("elevenlabs_has_key");
export const elevenlabsVerifyKey = () => invoke<string>("elevenlabs_verify_key");
export const elevenlabsVerifyKeyValue = (key: string) =>
  invoke<string>("elevenlabs_verify_key_value", { key });
export const elevenlabsVoices = () => invoke<{ id: string; name: string }[]>("elevenlabs_voices");
export const elevenlabsImportVoice = (voiceId: string, publicOwnerId = "", name = "") =>
  invoke<{ id: string; name: string }>("elevenlabs_import_voice", { voiceId, publicOwnerId, name });
/** Cloud TTS via ElevenLabs: returns a base64 MP3 (sends the text to ElevenLabs). */
export const elevenlabsSpeak = (text: string, voiceId: string, modelId: string) =>
  invoke<string>("elevenlabs_speak", { text, voiceId, modelId });

// ─── Gemini cloud escalation (#175) ─────────────────────────────────────────
// The agent is local by default. These are the only calls that can change that,
// and the switch resets to local on every launch — see crates/flux-core/gemini.rs.
// Replies go through `asRoute`, which fails toward local; see cloudroute.ts.

/** Store (or clear, with "") the Gemini API key in the OS keyring. */
export const geminiSetKey = (key: string) => invoke<void>("gemini_set_key", { key });
/** Whether a key is stored. The key itself never reaches the renderer. */
export const geminiHasKey = () => invoke<boolean>("gemini_has_key");
export const geminiVerifyKey = () => invoke<string>("gemini_verify_key");
/** Models the stored key can reach (asked, not hardcoded). */
export const geminiModels = () => invoke<string[]>("gemini_models");
export const geminiDefaultModel = () => invoke<string>("gemini_default_model");
/** Escalate to (or back from) the cloud for THIS session. Returns what will
 *  actually happen, which is not always what was asked — escalating without a
 *  stored key fails, and the agent stays local. */
export const agentCloudSet = (on: boolean, model: string) =>
  invoke<RouteStatus>("agent_cloud_set", { on, model }).then(asRoute);
export const agentCloudStatus = () => invoke<RouteStatus>("agent_cloud_status").then(asRoute);

// ─── Agent file access (#176) ───────────────────────────────────────────────
// The agent reads through its own commands so the allowance can't be bypassed
// by calling the ungated ones. The Files tab and PDF viewer keep using those —
// the user opening their own files was never the thing in question.

/** Which folders the agent may read inside. `enabled: false` = unrestricted. */
export interface AgentRoots {
  enabled: boolean;
  roots: string[];
}
export const agentRootsGet = () => invoke<AgentRoots>("agent_roots_get");
export const agentRootsSet = (roots: AgentRoots) => invoke<void>("agent_roots_set", { roots });
/** Named places worth pre-filling the allowance with (drives excluded). */
export const agentRootsSuggested = () => invoke<string[]>("agent_roots_suggested");

/** Gated equivalents of `fsList` / `readTextFile` / `pdfFetch`. */
export const agentFsList = (path: string) => invoke<DirListing>("agent_fs_list", { path });
export const agentReadTextFile = (path: string) => invoke<string>("agent_read_text_file", { path });
export const agentPdfFetch = (url: string) => invoke<ArrayBuffer>("agent_pdf_fetch", { url });
export const agentWriteTextFile = (path: string, content: string) =>
  invoke<void>("agent_write_text_file", { path, content });

// ─── Live editor state (#179) ───────────────────────────────────────────────
// The nvim column boots with `--listen`, so the agent can read the buffer the
// user is actually looking at — unsaved edits included, which a disk read can't
// give. See crates/flux-core/src/nvim.rs.

/** Whether a site can render in a floating pane, and which header refused (#180).
 *  Asked over HEAD before the pane opens — inferring it from the DOM does not
 *  work; see framecheck.ts. */
export type FramePolicy = GenFramePolicy;
export const framePolicy = (url: string) => invoke<FramePolicy>("frame_policy", { url });

/** What the editor is doing. `connected: false` = no editor answering. */
export type NvimState = GenNvimState;
/** Never rejects: "no editor" is an ordinary state, not an error. */
export const nvimState = (session: number) => invoke<NvimState>("nvim_state", { session });
/** The current buffer's text, including unwritten changes. */
export const nvimBuffer = (session: number) => invoke<string>("nvim_buffer", { session });

// ─── AudioPulse / Spotify control (Path A: reuse AudioPulse's token) ──────────
/** Override AudioPulse's config-dir (e.g. a \\wsl.localhost\<distro>\… path). */
export const spotifySetDir = (path: string) => invoke<void>("spotify_set_dir", { path });
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
// ─── Mini-player bubble (#125) — structured state + playlists ────────────────
export type SpotifyState = GenSpotifyState;
export type SpotifyPlaylist = GenSpotifyPlaylist;
/** Structured now-playing for the bubble (default/empty when no active device). */
export const spotifyState = () => invoke<SpotifyState>("spotify_state");
/** The user's playlists, for the bubble's menu. */
export const spotifyPlaylists = () => invoke<SpotifyPlaylist[]>("spotify_playlists");
/** Play a playlist/album by exact Spotify URI. */
export const spotifyPlayContext = (uri: string) => invoke<string>("spotify_play_context", { uri });
/** One audio-level frame from the visualiser helper (#126). */
export type VizFrame = { e: number; bass: number; mid: number; treble: number };
/** Stream real audio levels (PulseAudio monitor → FFT-ish) for the bubble's
 *  beat-synced visualiser; `onFrame` fires ~40fps. Resolves when the stream ends.
 *  Lazily starts the `audioviz` helper if it isn't running. */
export const audivizStream = (onFrame: (f: VizFrame) => void): Promise<void> => {
  const ch = new Channel<string>();
  ch.onmessage = (raw) => {
    try {
      onFrame(JSON.parse(raw) as VizFrame);
    } catch {
      /* skip bad frame */
    }
  };
  return invoke<void>("audioviz_stream", { onFrame: ch });
};
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
/** Translate the active page's text to `target` (a language name) via the local model (#40). */
export const agentTranslate = (target: string) => invoke<string>("agent_translate", { target });
// ─── Agent model picker (BACKLOG #81) ────────────────────────────────────────
export const agentModels = () => invoke<string[]>("agent_models");
export const agentModel = () => invoke<string>("agent_model");
export const agentSetModel = (name: string) => invoke<void>("agent_set_model", { name });
/** Chat grounded in the captured text of several tabs (chat-with-tabs). */
export const agentChatTabs = (prompt: string, tabIds: number[]) =>
  invoke<string>("agent_chat_tabs", { prompt, tabIds });
// ─── Semantic everything-search (BACKLOG #66) ────────────────────────────────
// OmniHit type is generated (bindings.gen) and aliased above.
export const omniSearch = (query: string, limit?: number) =>
  invoke<OmniHit[]>("omni_search", { query, limit: limit ?? null });
export const tabsRecluster = () => invoke<void>("tabs_recluster");

/**
 * Publish a DOM snapshot to Rust (plain JSON args — real pages' CSPs block the
 * raw-body IPC path). In practice the tab webview's injected capture.js does
 * this directly via `plugin:fluxtab|dom_publish`; this helper is for the chrome.
 */
export function domPublish(tabId: number, url: string, html: string, text: string) {
  return invoke<void>("plugin:fluxtab|dom_publish", { tabId, url, html, text });
}
/** Publish a **Flux-owned** page's visible text (Scribe, Notebook, Trail…).
 *
 *  A `flux://` page is a Solid component in the chrome's DOM, not a webview, so
 *  nothing injects the capture script and it published nothing — leaving every
 *  internal page invisible to "All tabs", the connections rail and `/note`.
 *
 *  An app command, not `plugin:fluxtab|dom_publish`: the chrome window isn't
 *  granted `fluxtab:default`, so that call would have been denied (which is why
 *  `domPublish` above has never had a caller). */
export const domPublishInternal = (tabId: number, url: string, text: string) =>
  invoke<void>("dom_publish_internal", { tabId, url, text });

// ─── Events (Rust → UI) ──────────────────────────────────────────────────

export const onAgentStatus = (cb: (s: AgentStatus) => void): Promise<UnlistenFn> =>
  listen<AgentStatus>("flux://agent-status", (e) => cb(e.payload));

export const onClustersUpdated = (cb: () => void): Promise<UnlistenFn> =>
  listen("flux://clusters-updated", () => cb());

export const onDomUpdated = (cb: (tabId: number) => void): Promise<UnlistenFn> =>
  listen<number>("flux://dom-updated", (e) => cb(e.payload));

/** An extension asked to open a tab (flux.tabs.open, BACKLOG #94). */
export const onExtOpenTab = (cb: (url: string) => void): Promise<UnlistenFn> =>
  listen<string>("flux://ext-open-tab", (e) => cb(e.payload));

/** An app keyboard chord forwarded from a focused tab webview (BACKLOG #18). */
export const onShortcut = (cb: (action: string) => void): Promise<UnlistenFn> =>
  listen<string>("flux://shortcut", (e) => cb(e.payload));

/** A page webview left HTML5 fullscreen — re-tile so it stops covering the chrome. */
export const onFullscreenChanged = (cb: (fullscreen: boolean) => void): Promise<UnlistenFn> =>
  listen<boolean>("flux://fullscreen-changed", (e) => cb(e.payload));

/** Find-in-page result from the page: [tabId, matchCount, found] (BACKLOG #33). */
export const onFindResult = (
  cb: (tabId: number, count: number, found: boolean) => void,
): Promise<UnlistenFn> => listen<[number, number, boolean]>("flux://find-result", (e) => cb(...e.payload));

// ─── Search (pluggable backend) ─────────────────────────────────────────────

export type SearchEngine = GenSearchEngine;
export type Resolution = GenResolution;

/** Resolve omnibox input → final URL (navigate vs search vs keyword). */
export const searchResolve = (input: string) => invoke<Resolution>("search_resolve", { input });
/** Live search suggestions from the default engine's suggest endpoint (#32). */
export const searchSuggest = (query: string) => invoke<string[]>("search_suggest", { query });
export const searchEngines = () => invoke<SearchEngine[]>("search_engines");
export const searchDefault = () => invoke<string>("search_default");
export const searchSetDefault = (id: string) => invoke<void>("search_set_default", { id });
/** Register (or replace by id) an engine — e.g. your own search backend. */
export const searchAddEngine = (engine: SearchEngine) => invoke<void>("search_add_engine", { engine });
export const searchRemoveEngine = (id: string) => invoke<void>("search_remove_engine", { id });

// ─── Omni index dashboard (flux://omni) ─────────────────────────────────────

/** Sentinel url for the native Omni dashboard page (no webview). */
export const OMNI_URL = "flux://omni";
export const NOTEBOOK_URL = "flux://notebook";
/** The Trail — browsing provenance graph (ADR 0011). */
export const TRAIL_URL = "flux://trail";
/** Built-in whiteboard / paint surface. */
export const WHITEBOARD_URL = "flux://whiteboard";
// ─── Scribe — handwritten per-course notebooks (ADR 0014) ───────────────────
export const SCRIBE_URL = "flux://scribe";
export type Notebook = GenNotebook;
export type NotebookMeta = GenNotebookMeta;
/** Shelf list of notebooks (metadata only, newest first). */
export const scribeList = () => invoke<NotebookMeta[]>("scribe_list");
/** Full notebook (all pages + strokes) by id. */
export const scribeLoad = (id: string) => invoke<Notebook>("scribe_load", { id });
/** Create an empty notebook (one blank grid page) and return it. */
export const scribeCreate = (name: string, course?: string) =>
  invoke<Notebook>("scribe_create", { name, course });
/** Persist a whole notebook (the debounced autosave). */
export const scribeSave = (notebook: Notebook) => invoke<void>("scribe_save", { notebook });
export const scribeDelete = (id: string) => invoke<void>("scribe_delete", { id });
/** Publish one page to the Onyx vault as Markdown + an embedded PNG; returns
 * the written .md path. `pngB64` is the rendered page (base64, no data: prefix). */
export type PageNote = GenPageNote;
export const scribePublishPage = (id: string, pageIndex: number, note: PageNote, pngB64: string) =>
  invoke<string>("scribe_publish_page", { id, pageIndex, note, pngB64 });
/** One suggested spelling/grammar fix in a Scribe page. */
export type TextFix = GenTextFix;
/** Proofread a page with the local model. Returns suggestions only — each one a
 *  verbatim span of the text sent, so the editor can always locate it. An empty
 *  list means "nothing to fix", including when no model is available. */
export const scribeProofread = (text: string) => invoke<TextFix[]>("scribe_proofread", { text });
/** The corpora the user authored or deliberately read, as opposed to `web` —
 *  pages they merely visited, which the Trail already graphs. Mirrors
 *  `kb::OWN_SOURCES`; anything scoped to "my knowledge" rather than "everything
 *  Flux has seen" should use this. */
export const OWN_SOURCES = ["onyx", "scroll", "council", "scribe", "pdf", "scribe-ocr", "pdf-ocr"];

/** A page's handwriting transcribed to LaTeX by the local vision model. */
export type Transcript = GenTranscript;
/** Transcribe a Scribe page's ink to LaTeX. Slow (a vision model, per drawing)
 *  and never written back into the page — the result is stored and indexed under
 *  its own `scribe-ocr` source so its machine-read origin shows in citations. */
export const scribeTranscribe = (id: string, pageIndex: number) =>
  invoke<Transcript>("scribe_transcribe", { id, pageIndex });
export const scribeTranscript = (notebook: string, page: string) =>
  invoke<Transcript | null>("scribe_transcript", { notebook, page });

/** Hand a PDF's extracted text to Flux: it becomes the tab's snapshot (so the
 *  agent can read the open document) and is stored for the knowledge base (so it
 *  stays answerable after the tab closes). */
/** Is a `tesseract` binary available? OCR is offered only when this is true —
 *  a button that always fails is worse than no button. */
export const ocrAvailable = () => invoke<boolean>("ocr_available");
/** Recognise one page image (base64 PNG). One call per page so progress is
 *  visible and a single bad page doesn't lose the rest. */
export const ocrImage = (pngB64: string, lang?: string) =>
  invoke<string>("ocr_image", { pngB64, lang: lang ?? null });
export const pdfPublishText = (
  tabId: number,
  src: string,
  title: string,
  text: string,
  pages: number,
  pagesWithText: number,
  /** True when the text came from OCR. Routes it to the `pdf-ocr` source so a
   *  citation says a machine read it off an image. */
  ocr = false,
) => invoke<void>("pdf_publish_text", { tabId, src, title, text, pages, pagesWithText, ocr });

// ─── Mail (read-only IMAP) ──────────────────────────────────────────────────
export type MailConfig = GenMailConfig;
export type MailMsg = GenMailMsg;
/** The saved account, or null. Never returns the password. */
export const mailConfig = () => invoke<MailConfig | null>("mail_config");
/** Verify an account and save it — the password reaches the OS keychain only
 *  after the server accepts it, so a typo can't be stored as if it worked. */
export const mailConnect = (host: string, port: number, email: string, password: string) =>
  invoke<void>("mail_connect", { host, port, email, password });
export const mailDisconnect = () => invoke<void>("mail_disconnect");
/** Newest messages in INBOX, newest first. Listing never sets flags, so *looking*
 *  at the pane can't mark anything seen in your real client. */
export const mailFetch = (limit?: number) => invoke<MailMsg[]>("mail_fetch", { limit: limit ?? null });
/** Mark every unread message in INBOX as read. The one write the mail module can
 *  perform — the change is real and shows up everywhere else the account is open.
 *  Returns how many were marked. */
export const mailMarkAllRead = () => invoke<number>("mail_mark_all_read");

// ─── Browsing data on disk ──────────────────────────────────────────────────
/** One clearable group of stored data, with its size and whether it's abnormal. */
export type StorageEntry = GenStorageEntry;
export type StorageReport = GenStorageReport;
/** Measure the engine's profile. Walks the tree, so it can take a moment. */
export const storageUsage = () => invoke<StorageReport>("storage_usage");
/** Queue groups for deletion. Nothing is deleted until the next launch — the
 *  engine holds these files open while it runs, and the case that matters most
 *  is a profile so broken it crashes on load. Returns the message to show. */
export const storageClear = (keys: string[]) => invoke<string>("storage_clear", { keys });
export const storageClearCancel = () => invoke<void>("storage_clear_cancel");
/** The last report taken this session, without re-walking. */
export const storageLast = () => invoke<StorageReport | null>("storage_last");

// ─── TUI app launcher (#117) ────────────────────────────────────────────────
export type TuiApp = GenTuiApp;
/** The user's curated terminal-app list (seeded on first run). */
export const tuiAppsList = () => invoke<TuiApp[]>("tui_apps_list");
/** Replace the whole list (edits/reorder happen client-side, then save). */
export const tuiAppsSet = (apps: TuiApp[]) => invoke<void>("tui_apps_set", { apps });
/** Executable names found in the standard user bin dirs — a quick-add helper. */
export const tuiAppsDetect = () => invoke<string[]>("tui_apps_detect");
// ─── Local background services (Omni / Scroll auto-start) ───────────────────
export type ServiceStatus = GenServiceStatus;
/** Running state of the managed local services (Omni, Scroll). */
export const servicesStatus = () => invoke<ServiceStatus[]>("services_status");
/** Manually start a service by name; returns true if it kicked one off. */
export const servicesStart = (name: string) => invoke<boolean>("services_start", { name });
// ─── Corpus write access (#118) — let the agent add to Scroll / Onyx ────────
/** Clip a URL into Scroll (POSTs its /clip form; Scroll scrapes + stores). */
export const scrollClip = (url: string, tags?: string) => invoke<string>("scroll_clip", { url, tags });
/** Create a Markdown note in the Onyx vault; returns the written path. `folder`
 *  is a vault subfolder (the course); `tags` is free-typed (commas or spaces,
 *  `#` optional) and becomes YAML frontmatter. */
export const onyxNewNote = (title: string, content: string, folder?: string, tags?: string) =>
  invoke<string>("onyx_new_note", { title, content, folder, tags });

/** What the agent proposes to add to your notes (#108). Planning NEVER writes —
 *  the two commands are deliberately separate, so there is no path from the
 *  model's output to your vault that doesn't pass through `noteApply`. */
export type NoteAction = GenNoteAction;
export type NoteProposal = GenNoteProposal;
/** Ask the model what to add. Returns a proposal to confirm; writes nothing. */
export const notePlan = (request: string, context?: string) =>
  invoke<NoteProposal>("note_plan", { request, context });
/** Apply a proposal the user approved. Returns the written path. */
export const noteApply = (action: NoteAction) => invoke<string>("note_apply", { action });
/** Capture the ACTIVE page's visible text into an Onyx note — for lecture
 *  transcripts (Echo360 &c.). Errors if too little text was captured, rather
 *  than filing an empty stub. Returns the written path. */
export const onyxCapturePage = (title: string, folder?: string, tags?: string) =>
  invoke<string>("onyx_capture_page", { title, folder, tags });
/** Novelty / contradiction check of `text` against the KB (#124). */
export type KbCheck = GenKbCheck;
export const kbCheck = (text: string) => invoke<KbCheck>("kb_check", { text });
// ─── Knowledge Base / second brain (#116, ADR 0010) ─────────────────────────
/** Per-source + overall index status for the Notebook view. */
export type KbRecentItem = GenKbRecentItem;
export const kbStatus = () => invoke<KbStatus>("kb_status");
/** Docs added to the KB in the last `days` (default 7) — weekly digest input (#125). */
export const kbRecent = (days = 7) => invoke<KbRecentItem[]>("kb_recent", { days });
/** (Re)build the index for one source (or all when omitted). Returns fresh status. */
export const kbReindex = (source?: string) => invoke<KbStatus>("kb_reindex", { source });
/** Point a source at a location (Onyx vault path / Scroll URL); empty clears it.
 *  Persisted in Flux's config — the env-free way to index a vault that lives
 *  elsewhere (e.g. a WSL UNC path from a Windows build). */
export const kbSetSource = (source: string, location: string) =>
  invoke<KbStatus>("kb_set_source", { source, location });
/** Cosine top-k retrieval over the corpus (optionally restricted to `sources`). */
export const kbQuery = (query: string, k = 8, sources?: string[]) =>
  invoke<KbHit[]>("kb_query", { query, k, sources });
/** KB items related to the currently-open page (ambient connections rail, #123). */
export const kbRelated = (limit = 6) => invoke<KbHit[]>("kb_related", { limit });
/** One frame of a streamed grounded answer (hand-mirrors the kb_answer events). */
export type KbAnswerEvent =
  | { kind: "sources"; hits: KbHit[] }
  | { kind: "voice"; label: string; model: string }
  | { kind: "token"; text: string }
  | { kind: "done" };
/**
 * Grounded, streamed answer over the knowledge base (#116): `onEvent` fires with
 * the cited sources first, then answer tokens, then done. Resolves when complete.
 */
export const kbAnswer = (
  query: string,
  onEvent: (e: KbAnswerEvent) => void,
  sources?: string[],
): Promise<void> => {
  const ch = new Channel<string>();
  ch.onmessage = (raw) => {
    try {
      onEvent(JSON.parse(raw) as KbAnswerEvent);
    } catch {
      /* skip a bad frame */
    }
  };
  return invoke<void>("kb_answer", { query, sources, onToken: ch });
};

export interface OmniStats {
  live_docs: number;
  total_docs: number;
  tombstones: number;
  segments: number;
  embedded: boolean;
  ann: boolean;
  ann_vectors: number;
  dated: number;
  embedder_kind: string;
  embedder_dim: number;
  avg_title_len: number;
  avg_body_len: number;
  segment_sizes: { live: number; total: number }[];
  top_docs: { url: string; title: string; rank: number }[];
}

export interface OmniSite {
  key: string;
  name: string;
  home: string;
  blurb: string;
}

/** Fetch Omni's live `/stats` (proxied through Rust to dodge the webview CSP). */
export const omniStats = async (): Promise<OmniStats> => JSON.parse(await invoke<string>("omni_stats"));

/** Fetch Omni's curated essential-site shortcuts (`/sites`). */
export const omniSites = async (): Promise<OmniSite[]> => JSON.parse(await invoke<string>("omni_sites"));

/** Omni's semantic graph (#119): nodes (docs, sized by PageRank) + cosine-neighbour
 *  edges (`s`/`t` index into `nodes`). Hand-typed (the body is raw JSON from Omni). */
export interface OmniGraphData {
  nodes: { title: string; url: string; rank: number }[];
  edges: { s: number; t: number; w: number }[];
}
export const omniGraph = async (n = 300, k = 6): Promise<OmniGraphData> =>
  JSON.parse(await invoke<string>("omni_graph", { n, k }));

/** A grounding source cited by a generative answer. */
export interface OmniAnswerSource {
  n: number;
  title: string;
  url: string;
}

/** One streamed answer event (mirrors Omni's SSE `data:` payloads). */
export type OmniAnswerEvent =
  { type: "sources"; sources: OmniAnswerSource[] } | { type: "token"; text: string } | { type: "done" };

/**
 * Stream a generative RAG answer for `query` from Omni, calling `onEvent` for each
 * event (sources first, then tokens, then done). Proxied + relayed through Rust
 * over a Tauri Channel to dodge the webview CSP. Resolves when the stream ends.
 */
export const omniAnswer = (
  query: string,
  onEvent: (e: OmniAnswerEvent) => void,
  model?: string,
): Promise<void> => {
  const ch = new Channel<string>();
  ch.onmessage = (raw) => {
    try {
      onEvent(JSON.parse(raw) as OmniAnswerEvent);
    } catch {
      /* ignore a malformed frame */
    }
  };
  return invoke<void>("omni_answer", { query, model, onToken: ch });
};

// ─── Omni live ingest (feed browsed pages into the index) ───────────────────

/** Whether auto-ingest (index every substantial page on load) is on. */
export const omniIngestStatus = () => invoke<boolean>("omni_ingest_status");
/** Toggle auto-ingest for this session. */
export const omniIngestSetAuto = (enabled: boolean) => invoke<void>("omni_ingest_set_auto", { enabled });
/** Explicitly save the active tab's page to Omni; returns Omni's JSON reply. */
export const omniIngestActive = async (): Promise<{ added: number; skipped: number }> =>
  JSON.parse(await invoke<string>("omni_ingest_active"));

// ─── Content blocker / shields (BACKLOG #57) ────────────────────────────────
// ShieldsStatus / HotRule types are generated (bindings.gen) and aliased above.
export const shieldsStatus = () => invoke<ShieldsStatus>("shields_status");
export const shieldsSetEnabled = (on: boolean) => invoke<void>("shields_set_enabled", { on });
/** Turn shields on/off for one site (`on = false` allowlists it). */
export const shieldsSetSite = (host: string, on: boolean) => invoke<void>("shields_set_site", { host, on });
/** Re-fetch + rebuild the upstream filter lists (background). */
export const shieldsRefresh = () => invoke<void>("shields_refresh");

/** The session's hot rule set — filters that actually fired, busiest first (#99). */
export const shieldsHotRules = (limit: number) => invoke<HotRule[]>("shields_hot_rules", { limit });

// ─── Per-site lean mode (BACKLOG #105) ───────────────────────────────────────
export const leanStatus = () => invoke<LeanStatus>("lean_status");
export const leanSetEnabled = (on: boolean) => invoke<void>("lean_set_enabled", { on });
export const leanSetSite = (host: string, on: boolean) => invoke<void>("lean_set_site", { host, on });

// ─── HTTPS-only mode (BACKLOG #58) ──────────────────────────────────────────
export const httpsStatus = () => invoke<HttpsStatus>("https_status");
export const httpsSetEnabled = (on: boolean) => invoke<void>("https_set_enabled", { on });
/** Outbound proxy (#63): the saved http://… / socks5://… endpoint, or null = direct. */
export const proxyGet = () => invoke<string | null>("proxy_get");
/** Save the proxy endpoint (null/empty = direct). Rejects a non-http/socks5 URL. */
export const proxySet = (url: string | null) => invoke<void>("proxy_set", { url });
/** Allow (or stop allowing) a host to stay on plain HTTP under HTTPS-only. */
export const httpsAllowSite = (host: string, allow: boolean) =>
  invoke<void>("https_allow_site", { host, allow });

// ─── Cookie controls (BACKLOG #58) ──────────────────────────────────────────

/** Clear cookies for one host (all schemes). */
export const cookiesClearSite = (host: string) => invoke<void>("cookies_clear_site", { host });
/** Clear every cookie in the store. */
export const cookiesClearAll = () => invoke<void>("cookies_clear_all");

export const cookiesStatus = () => invoke<CookieStatus>("cookies_status");
/** Flag (or unflag) a host to clear its cookies when its tab closes. */
export const cookiesSetClearOnClose = (host: string, on: boolean) =>
  invoke<void>("cookies_set_clear_on_close", { host, on });

// ─── Tracking prevention (BACKLOG #58) ──────────────────────────────────────
// Level: 0 = Off · 1 = Basic · 2 = Balanced · 3 = Strict.
export const trackingStatus = () => invoke<number>("tracking_status");
export const trackingSetLevel = (level: number) => invoke<void>("tracking_set_level", { level });

// ─── Site permissions (BACKLOG #58 / #38) ────────────────────────────────────
/** Whether camera/mic/geo permission requests are auto-denied (global, #58). */
export const permissionsStatus = () => invoke<boolean>("permissions_status");
export const permissionsSetBlock = (on: boolean) => invoke<void>("permissions_set_block", { on });

/** Per-site permission manager (#38). */
export const PERMISSIONS_URL = "flux://permissions";
export const SENTINEL_URL = "flux://sentinel";
// PermKind / PermDecision / SitePerm are generated (bindings.gen) and aliased above.
export const permissionsList = () => invoke<SitePerm[]>("permissions_list");
export const permissionsSet = (host: string, kind: PermKind, decision: PermDecision) =>
  invoke<void>("permissions_set", { host, kind, decision });
export const permissionsClearHost = (host: string) => invoke<void>("permissions_clear_host", { host });
export const permissionsClearAll = () => invoke<void>("permissions_clear_all");
/** A page hit Ask — the engine is deferred until the chrome's permission bar
 *  answers (Windows/WebView2; other engines keep their native prompt). */
export type PermAsk = GenPermAsk;
export const onPermissionAsk = (cb: (a: PermAsk) => void): Promise<UnlistenFn> =>
  listen<PermAsk>("flux://permission-ask", (e) => cb(e.payload));
/** Resolve a deferred Ask. `remember` persists the decision for the site. */
export const permissionAnswer = (
  id: number,
  host: string,
  kind: PermKind,
  allow: boolean,
  remember: boolean,
) => invoke<void>("permission_answer", { id, host, kind, allow, remember });

// ─── Password vault (BACKLOG #61, ADR 0009) ──────────────────────────────────
// Metadata only — passwords never come to the chrome except via vault_reveal
// (explicit) or are injected straight into the page by vault_fill.
// CredentialMeta / VaultStatus are generated (bindings.gen) and aliased above.
/** Sentinel url for the full-page vault manager (DOM-rendered, no webview). */
export const VAULT_URL = "flux://passwords";
export const vaultStatus = () => invoke<VaultStatus>("vault_status");
/** Unlock a master-password-protected vault. */
export const vaultUnlock = (password: string) => invoke<void>("vault_unlock", { password });
/** Lock now (clears the decrypted vault + key from memory). */
export const vaultLock = () => invoke<void>("vault_lock");
/** Enable/change master-password protection (Argon2id; removes the keychain key). */
export const vaultSetMasterPassword = (password: string) =>
  invoke<void>("vault_set_master_password", { password });
/** Remove master-password protection (verifies it, moves the key back to the keychain). */
export const vaultDisableMasterPassword = (password: string) =>
  invoke<void>("vault_disable_master_password", { password });
/** Idle auto-lock timeout in minutes (0 = never). */
export const vaultSetAutolock = (minutes: number) => invoke<void>("vault_set_autolock", { minutes });
/** Fires when the vault auto-locks after idle. */
export const onVaultLocked = (cb: () => void): Promise<UnlistenFn> =>
  listen("flux://vault-locked", () => cb());
/** Fires when keychain-mode vault hydration finishes after startup. */
export const onVaultReady = (cb: () => void): Promise<UnlistenFn> => listen("flux://vault-ready", () => cb());
/** Fires when the page sentinel saved a credential (registration sign-up). */
export const onVaultSaved = (cb: (host: string) => void): Promise<UnlistenFn> =>
  listen<string>("flux://vault-saved", (e) => cb(e.payload));
/** Fires when the page sentinel captures a manually-typed login worth saving. */
export const onVaultSavePrompt = (cb: (p: VaultSavePrompt) => void): Promise<UnlistenFn> =>
  listen<VaultSavePrompt>("flux://vault-save-prompt", (e) => cb(e.payload));
/** Fires when a password field takes focus on a site that impersonates a brand
 *  you value (ADR 0013, Pillar 1) — the earliest possible warning, before the
 *  first keystroke. Payload: [tabId, host, verdict]. */
export const onSentinelInputWarning = (
  cb: (tabId: number, host: string, verdict: PhishVerdict) => void,
): Promise<UnlistenFn> =>
  listen<[number, string, PhishVerdict]>("flux://sentinel-input-warning", (e) =>
    cb(e.payload[0], e.payload[1], e.payload[2]),
  );
/** Commit the pending save (the bar's "Save"/"Update"). */
export const vaultSaveConfirm = () => invoke<void>("vault_save_confirm");
/** Drop the pending save ("Not now"). */
export const vaultSaveDismiss = () => invoke<void>("vault_save_dismiss");
/** Drop the pending save and never offer for this host again. */
export const vaultNeverSave = () => invoke<void>("vault_never_save");
export const vaultList = () => invoke<CredentialMeta[]>("vault_list");
export const vaultForHost = (host: string) => invoke<CredentialMeta[]>("vault_for_host", { host });
/** Reveal one password (explicit user action). */
export const vaultReveal = (id: string) => invoke<string | null>("vault_reveal", { id });
export const vaultAdd = (name: string, url: string, username: string, password: string) =>
  invoke<void>("vault_add", { name, url, username, password });
export const vaultRemove = (id: string) => invoke<void>("vault_remove", { id });
/** Import a Proton Pass export (CSV / ZIP / PGP / JSON) from a file path.
 *  `passphrase` is only needed for a PGP-encrypted export. Returns the count. */
export const vaultImportProton = (path: string, passphrase?: string) =>
  invoke<number>("vault_import_proton", { path, passphrase: passphrase ?? null });
/** Autofill credential `id` into the active tab's login form (same-origin enforced). */
export const vaultFill = (tabId: number, id: string) => invoke<void>("vault_fill", { tabId, id });
/** Why autofill didn't offer on this tab. Chrome-only (never page-callable):
 *  unlike `vault_page_info`, which hides the reason from a possibly-hostile
 *  page, this names the actual stage that stopped it. */
export type VaultDiag = GenVaultDiag;
export const vaultWhy = (tab: number) => invoke<VaultDiag>("vault_why", { tab });

// ─── Extensions (BACKLOG #92, ADR 0008) ──────────────────────────────────────
// ExtContentScript / ExtManifest / InstalledExt are generated (bindings.gen,
// from extensions.rs Manifest/ContentScript/InstalledExt) and aliased above.
/** Install the extension whose folder is `dir` (must hold flux.extension.json). */
export const extInstall = (dir: string) => invoke<ExtManifest>("ext_install", { dir });
export const extList = () => invoke<InstalledExt[]>("ext_list");
export const extSetEnabled = (id: string, on: boolean) => invoke<void>("ext_set_enabled", { id, on });
export const extRemove = (id: string) => invoke<void>("ext_remove", { id });

// ─── Per-tab web content (webviews) ─────────────────────────────────────────

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export const webviewOpen = (tabId: number, url: string, r: Rect) =>
  invoke<void>("webview_open", { tabId, url, x: r.x, y: r.y, width: r.width, height: r.height });
export const webviewSetBounds = (tabId: number, r: Rect) =>
  invoke<void>("webview_set_bounds", { tabId, x: r.x, y: r.y, width: r.width, height: r.height });
export const webviewShow = (tabId: number) => invoke<void>("webview_show", { tabId });
export const webviewHide = (tabId: number) => invoke<void>("webview_hide", { tabId });
export const webviewNavigate = (tabId: number, url: string) =>
  invoke<void>("webview_navigate", { tabId, url });
export const webviewZoom = (tabId: number, factor: number) => invoke<void>("webview_zoom", { tabId, factor });
// ─── Reader mode (BACKLOG #41) ───────────────────────────────────────────────
// ReaderBlock type is generated (bindings.gen) and aliased above.
export const webviewExtractReader = (tabId: number) => invoke<void>("webview_extract_reader", { tabId });
// ─── Resource monitor (BACKLOG #70) ─────────────────────────────────────────
export const RESOURCES_URL = "flux://resources";
/** Per-tab captured-DOM payload size in bytes (proxy for page weight). */
export const tabDomSizes = () => invoke<[number, number][]>("tab_dom_sizes");

// ─── E2E-encrypted sync (BACKLOG #62) ────────────────────────────────────────
export const SYNC_URL = "flux://sync";
// SyncStatus / SyncReport are generated (bindings.gen) and aliased above.
export const syncStatus = () => invoke<SyncStatus>("sync_status");
export const syncSetFolder = (path: string) => invoke<void>("sync_set_folder", { path });
/** Unlock sync. Resolves `true` when this device minted a **new** sync identity
 *  — i.e. the folder had no blob yet, so the key was derived from a fresh salt.
 *  If another device has already synced here, that means its file hadn't arrived
 *  and the two will never see each other's data. */
export const syncUnlock = (passphrase: string) => invoke<boolean>("sync_unlock", { passphrase });
export const syncLock = () => invoke<void>("sync_lock");
export const syncNow = () => invoke<SyncReport>("sync_now");
/** Turn periodic background auto-sync on/off (#62). */
export const syncSetAuto = (enabled: boolean) => invoke<void>("sync_set_auto", { enabled });
/** Fires after a background (auto) sync completes, with what it merged. */
export const onSyncDone = (cb: (r: SyncReport) => void): Promise<UnlistenFn> =>
  listen<SyncReport>("flux://sync-done", (e) => cb(e.payload));
/** Fires when a background sync fails (e.g. locked, folder gone). */
export const onSyncError = (cb: (msg: string) => void): Promise<UnlistenFn> =>
  listen<string>("flux://sync-error", (e) => cb(e.payload));

// ─── Install-site-as-app / PWAs (BACKLOG #42) ────────────────────────────────
export const APPS_URL = "flux://apps";
export const pwaList = () => invoke<PwaApp[]>("pwa_list");
export const pwaInstall = (url: string, name: string) => invoke<PwaApp>("pwa_install", { url, name });
export const pwaLaunch = (id: number) => invoke<void>("pwa_launch", { id });
export const pwaRemove = (id: number) => invoke<void>("pwa_remove", { id });

// ─── Scriptable macros (BACKLOG #67) ─────────────────────────────────────────
// MacroStep (Rust `Step`) / Macro / MacroStatus are generated and aliased above.
export const macrosList = () => invoke<Macro[]>("macros_list");
export const macrosStatus = () => invoke<MacroStatus>("macros_status");
export const macroStartRecord = () => invoke<void>("macro_start_record");
export const macroStopRecord = (name: string) => invoke<Macro | null>("macro_stop_record", { name });
export const macroCancelRecord = () => invoke<void>("macro_cancel_record");
export const macroDelete = (id: number) => invoke<void>("macro_delete", { id });
export const macroRename = (id: number, name: string) => invoke<void>("macro_rename", { id, name });
export const macroRun = (id: number) => invoke<void>("macro_run", { id });

// ─── Per-site boosts (BACKLOG #49) ───────────────────────────────────────────
// Boost type is generated (bindings.gen) and aliased above.
export const boostsForHost = (host: string) => invoke<Boost[]>("boosts_for_host", { host });
/** Every saved boost across all hosts (the manage-all view). */
export const boostsList = () => invoke<Boost[]>("boosts_list");
/** Create (id=null) or edit a boost's CSS by hand. JS stays "" (CSS-only by design). */
export const boostSave = (id: number | null, host: string, name: string, css: string, enabled: boolean) =>
  invoke<Boost>("boost_save", { id, host, name, css, js: "", enabled });
export const boostSetEnabled = (id: number, host: string, enabled: boolean) =>
  invoke<void>("boost_set_enabled", { id, host, enabled });
export const boostDelete = (id: number, host: string) => invoke<void>("boost_delete", { id, host });
/** Ask the local agent to write + apply a CSS boost for the active page. */
export const boostAuthor = (instruction: string) => invoke<Boost>("boost_author", { instruction });

// ─── Offline archive / read-later (BACKLOG #69) ──────────────────────────────
export const ARCHIVE_URL = "flux://archive";
// ArchiveMeta + ArchiveEntry (the wire shape, `ArchiveEntryWire`) are generated:
// the Rust persist struct carries embedding/embedder fields kept off the wire (#12).
/** Save the active page for offline reading + semantic search. */
export const archiveSave = () => invoke<ArchiveMeta>("archive_save");
export const archiveList = () => invoke<ArchiveMeta[]>("archive_list");
export const archiveGet = (id: number) => invoke<ArchiveEntry | null>("archive_get", { id });
export const archiveDelete = (id: number) => invoke<void>("archive_delete", { id });
/** Semantic search over saved pages (empty query → newest first). */
export const archiveSearch = (query: string, limit: number) =>
  invoke<ArchiveMeta[]>("archive_search", { query, limit });

// ─── Native RSS / Atom reader (BACKLOG #72) ──────────────────────────────────
export const FEEDS_URL = "flux://feeds";
export const feedsList = () => invoke<Feed[]>("feeds_list");
/** Subscribe to a feed URL (deduped). Fetches + parses to derive the title. */
export const feedAdd = (url: string) => invoke<Feed>("feed_add", { url });
export const feedRemove = (id: number) => invoke<void>("feed_remove", { id });
/** Fetch + parse a feed's items live. id 0/undefined → all feeds aggregated. */
export const feedItems = (id?: number) => invoke<FeedItem[]>("feed_items", { id: id ?? null });

// ─── Calendar via ICS (BACKLOG #114) — read-only, no OAuth ───────────────────
export const calList = () => invoke<CalFeed[]>("cal_list");
/** Subscribe to a calendar's secret ICS URL (validated on add). */
export const calAdd = (url: string, name?: string) => invoke<CalFeed>("cal_add", { url, name: name ?? null });
export const calRemove = (id: number) => invoke<void>("cal_remove", { id });
/** Copy a subscribed calendar's events into Flux's own editable events (a
 *  subscribed ICS is read-only). Recurring events import as one series with
 *  their RRULE. Safe to re-run — returns `[imported, skippedAsDuplicates]`. */
export const calImportFeed = (id: number) => invoke<[number, number]>("cal_import_feed", { id });
/** Fetch + parse all subscribed calendars (+ local events), sorted by date. */
export const calEvents = () => invoke<CalEvent[]>("cal_events");

// ─── Local (editable) calendar events (BACKLOG #114) ─────────────────────────
/** List just the on-device events (no ICS overlay) — used by the agent. */
export const calLocalEvents = () => invoke<LocalEvent[]>("cal_local_events");
export interface CalEventFields {
  title: string;
  date: string; // YYYY-MM-DD
  start?: string; // HH:MM or ""
  end?: string; // HH:MM or ""
  location?: string;
  notes?: string;
  rrule?: string; // iCalendar RRULE (e.g. "FREQ=WEEKLY") or "" for one-off
}
export const calEventAdd = (e: CalEventFields) =>
  invoke<LocalEvent>("cal_event_add", {
    title: e.title,
    date: e.date,
    start: e.start ?? null,
    end: e.end ?? null,
    location: e.location ?? null,
    notes: e.notes ?? null,
    rrule: e.rrule ?? null,
  });
/** Patch a local event — only the provided fields change (so a drag sends just date/start/end). */
export const calEventUpdate = (id: number, patch: Partial<CalEventFields>) =>
  invoke<LocalEvent>("cal_event_update", {
    id,
    title: patch.title ?? null,
    date: patch.date ?? null,
    start: patch.start ?? null,
    end: patch.end ?? null,
    location: patch.location ?? null,
    notes: patch.notes ?? null,
    rrule: patch.rrule ?? null,
  });
export const calEventDelete = (id: number) => invoke<void>("cal_event_delete", { id });

// ─── Currency rates for the converter widget (#127) ──────────────────────────
export type CurrencyRates = GenCurrencyRates;
/** Live ECB reference rates (frankfurter.app); `rates[code]` = units per 1 `base`. */
export const currencyRates = (base: string) => invoke<CurrencyRates>("currency_rates", { base });

// ─── Semantic shell-history search (BACKLOG #122) ────────────────────────────
export type ShellHistHit = GenShellHistHit;
/** Rank shell history by meaning (empty query → most recent). Auto-indexes first run. */
export const shellHistorySearch = (query: string, limit?: number) =>
  invoke<ShellHistHit[]>("shell_history_search", { query, limit: limit ?? null });
/** Rebuild the history corpus from ~/.bash_history + ~/.zsh_history; returns the count. */
export const shellHistoryReindex = () => invoke<number>("shell_history_reindex");

// ─── Watch a page for semantic changes (BACKLOG #128) ────────────────────────
export type WatchItem = GenWatchItem;
export const watchList = () => invoke<WatchItem[]>("watch_list");
export const watchIsWatched = (url: string) => invoke<boolean>("watch_is_watched", { url });
export const watchAdd = (url: string, title: string, intervalSecs?: number) =>
  invoke<WatchItem>("watch_add", { url, title, intervalSecs: intervalSecs ?? null });
export const watchRemove = (id: number) => invoke<void>("watch_remove", { id });
export const watchMarkSeen = (id: number) => invoke<void>("watch_mark_seen", { id });
export const watchCheckNow = (id: number) => invoke<WatchItem | null>("watch_check_now", { id });
/** Fired when a watched page's content semantically changed. */
export const onWatchChanged = (cb: (w: WatchItem) => void): Promise<UnlistenFn> =>
  listen<WatchItem>("flux://watch-changed", (e) => cb(e.payload));

// ─── Tracker graph (BACKLOG #129) ────────────────────────────────────────────
export type TrackerGraph = GenTrackerGraph;
/** Live first-party → third-party request graph (fills as you browse). */
export const trackerGraph = () => invoke<TrackerGraph>("tracker_graph");
export const trackerClear = () => invoke<void>("tracker_clear");

// ─── Semantic find — in-page + across tabs (BACKLOG #126) ────────────────────
export type FindHit = GenFindHit;
/** Rank passages across `tabIds` by meaning (pass [activeId] for in-page, all tabs for across). */
export const semanticFind = (query: string, tabIds: number[], limit?: number) =>
  invoke<FindHit[]>("semantic_find", { query, tabIds, limit: limit ?? null });

// ─── Local tasks / to-dos (BACKLOG #114) ─────────────────────────────────────
export const todosList = () => invoke<Todo[]>("todos_list");
export const todoAdd = (title: string, due?: string, profile?: string) =>
  invoke<Todo | null>("todo_add", { title, due: due ?? null, profile: profile ?? null });
/** Rename a task and/or set its due date. Omitted fields are left alone. */
export const todoEdit = (id: number, title?: string, due?: string) =>
  invoke<boolean>("todo_edit", { id, title: title ?? null, due: due ?? null });
/** Set the order of the given tasks (drag to reorder). Tasks not listed keep
 *  their slots, so reordering one list leaves the others alone. */
export const todosReorder = (ids: number[]) => invoke<boolean>("todos_reorder", { ids });
/** Move a task to another list ("Uni", "Personal", …). */
export const todoSetProfile = (id: number, profile: string) =>
  invoke<void>("todo_set_profile", { id, profile });
export const todoToggle = (id: number) => invoke<void>("todo_toggle", { id });
export const todoRemove = (id: number) => invoke<void>("todo_remove", { id });
export const todosClearDone = () => invoke<number>("todos_clear_done");

// ─── Built-in PDF viewer (BACKLOG #35) ───────────────────────────────────────
export const PDF_URL = "flux://pdf";
/** Is this URL/path a PDF? (extension check, ignoring query/hash) */
export const isPdfUrl = (url: string) => (url.split(/[?#]/)[0] ?? "").toLowerCase().endsWith(".pdf");
/** Route a PDF URL through the Flux viewer (no-op if it already is one). */
export const pdfViewerUrl = (src: string) =>
  src.startsWith(PDF_URL) ? src : `${PDF_URL}?src=${encodeURIComponent(src)}`;
/** Fetch a PDF's bytes server-side (CORS-free), base64-encoded. */
/** Fetch a PDF's raw bytes (ADR/BACKLOG #35). Arrives as an ArrayBuffer over the
 *  IPC binary channel — no base64, so a large file costs one copy rather than ~5. */
export const pdfFetch = (url: string) => invoke<ArrayBuffer>("pdf_fetch", { url });
/** Save edited PDF bytes (base64) to Downloads (BACKLOG #112); returns the path. */
export const pdfSave = (dataB64: string, filename: string) =>
  invoke<string>("pdf_save", { dataB64, filename });

// ─── Task manager (BACKLOG #107) ─────────────────────────────────────────────
export const TASKS_URL = "flux://tasks";
// ProcInfo + SysStats from bindings.gen.
export const tasksList = () => invoke<ProcInfo[]>("tasks_list");
export type NetIface = GenNetIface;
export type DiskInfo = GenDiskInfo;
/** Mounted filesystems, for the task manager's disk card. */
export const tasksDisks = () => invoke<DiskInfo[]>("tasks_disks");

/** Named folders the agent can be pointed at without a path (#166) — the Onyx
 *  vault and its folders, Scribe, Downloads, home. Resolved fresh on each call:
 *  the vault path is a setting, and a stale answer files a note in the wrong
 *  directory. */
export type Place = GenPlace;
export const agentPlaces = () => invoke<Place[]>("agent_places");

/** Drop the agent's model from VRAM now instead of waiting out the 30-minute
 *  keep-alive (#169). Resolves to the model that was unloaded; it reloads by
 *  itself on the next request. Empty/omitted → whichever model is active. */
export const agentUnload = (model?: string) => invoke<string>("agent_unload", { model });
export const tasksKill = (pid: number) => invoke<boolean>("tasks_kill", { pid });
export const tasksStats = () => invoke<SysStats>("tasks_stats");
/** Live GPU stats via nvidia-smi (empty on non-NVIDIA / no driver). */
export const gpuStats = () => invoke<GpuInfo[]>("gpu_stats");

// ─── Network speed test (BACKLOG #108) ───────────────────────────────────────
export const SPEEDTEST_URL = "flux://speedtest";
export const netspeedRun = () => invoke<SpeedResult>("netspeed_run");
/** Live progress: phase ("ping"→"download"→"upload"→"done") + instantaneous
 *  Mbps (0 for ping/upload) so the dial can animate during download. */
export interface NetProgress {
  phase: string;
  mbps: number;
}
export const onNetspeedProgress = (cb: (p: NetProgress) => void): Promise<UnlistenFn> =>
  listen<NetProgress>("flux://netspeed-progress", (e) => cb(e.payload));

// ─── Predictive prefetch (BACKLOG #103) ──────────────────────────────────────
export type PrefetchHint = GenPrefetchHint;
/** Record a navigation transition so the model can learn (`from` may be ""). */
export const prefetchRecord = (from: string, to: string) => invoke<void>("prefetch_record", { from, to });
/** Hosts worth preconnecting next from `url`, most-confident first. */
export const prefetchHints = (url: string, max: number) =>
  invoke<PrefetchHint[]>("prefetch_hints", { url, max });
/** Pause/resume speculation under memory pressure. */
export const prefetchSetPressure = (on: boolean) => invoke<void>("prefetch_set_pressure", { on });
/** Inject `<link rel=preconnect>` for predicted next hosts into the active page. */
export const webviewPreconnect = (tabId: number, hosts: string[]) =>
  invoke<void>("webview_preconnect", { tabId, hosts });
/** Open the devtools inspector for a tab's webview (F12). */
export const webviewDevtools = (tabId: number) => invoke<void>("webview_devtools", { tabId });

// ─── Belady/Markov hibernation ranking (BACKLOG #106) ────────────────────────
export type HibernateCandidate = GenHibernateCandidate;
export type EvictionRank = GenEvictionRank;
/** Rank background tabs worst-first for hibernation (least likely needed next). */
export const hibernateRank = (currentUrl: string, candidates: HibernateCandidate[]) =>
  invoke<EvictionRank[]>("hibernate_rank", { currentUrl, candidates });

// ─── Web capture (BACKLOG #54) ───────────────────────────────────────────────
export const webviewCapture = (tabId: number) => invoke<string>("webview_capture", { tabId });
/** Visual Lens (#115): identify the captured PNG with the local vision model. */
export const agentLens = (imagePath: string, prompt?: string) =>
  invoke<string>("agent_lens", { imagePath, prompt: prompt ?? null });
/** Ask the local vision model about an uploaded image (base64, no data: prefix). */
export const agentVision = (imageB64: string, prompt?: string) =>
  invoke<string>("agent_vision", { imageB64, prompt: prompt ?? null });
/** Read a file dragged from the explorer into the agent (image → b64, text → text). */
export interface DroppedAttachment {
  kind: "image" | "text";
  name: string;
  b64: string;
  text: string;
  data_url: string;
}
export const attachmentRead = (path: string) => invoke<DroppedAttachment>("attachment_read", { path });
export const onScreenshot = (cb: (path: string) => void): Promise<UnlistenFn> =>
  listen<string>("flux://screenshot", (e) => cb(e.payload));
export const onReader = (
  cb: (tabId: number, title: string, blocks: ReaderBlock[]) => void,
): Promise<UnlistenFn> =>
  listen<[number, string, ReaderBlock[]]>("flux://reader", (e) =>
    cb(e.payload[0], e.payload[1], e.payload[2]),
  );
export const webviewBack = (tabId: number) => invoke<void>("webview_back", { tabId });
export const webviewForward = (tabId: number) => invoke<void>("webview_forward", { tabId });
export const webviewReload = (tabId: number) => invoke<void>("webview_reload", { tabId });
export const webviewStop = (tabId: number) => invoke<void>("webview_stop", { tabId });
/** Hibernate a tab: destroy its webview to free RAM (no clear-on-close). #45 */
export const webviewHibernate = (tabId: number) => invoke<void>("webview_hibernate", { tabId });
/** Snapshot a tab's scroll/form state before it sleeps, to restore on wake. #45 */
export const webviewCaptureState = (tabId: number) => invoke<void>("webview_capture_state", { tabId });
/** Mobile: a tab's cached cover snapshot (base64 data URL), "" if none. Pulled over
 *  normal IPC because images are too large for the plugin event channel (ADR 0012). */
export const webviewThumbnail = (tabId: number) => invoke<string>("webview_thumbnail", { tabId });

/** Sentinel: assess a URL for phishing/impersonation (ADR 0013). null = clean. */
/** Every deterministic Sentinel check for one navigation, in a single round trip
 *  (ADR 0013): phishing resemblance, OAuth consent scopes, and whether the site
 *  is worth isolating. No model, no page content — instant. */
export const sentinelOnNavigate = (url: string) => invoke<NavAssessment>("sentinel_on_navigate", { url });

/** The model-backed pass, once the page text has been captured (ADR 0013): the
 *  refined phishing verdict and any decoded cookie-consent banner. Reads the page
 *  snapshot once for both. Neither half wakes the model without cause. */
export const sentinelAfterLoad = (url: string, title: string) =>
  invoke<LoadAssessment>("sentinel_after_load", { url, title });

/** One-line agent assessment of a live permission request (ADR 0013, Pillar 2).
 *  Advisory annotation only — it never allows or denies. `null` when the model
 *  or page content is unavailable, in which case the prompt is unchanged. */
export const sentinelAssessPermission = (host: string, permission: string) =>
  invoke<PermissionNote | null>("sentinel_assess_permission", { host, permission });

/** Narrate the tracker graph in plain language (ADR 0013, Pillar 3 M5). The
 *  summary's figures are computed in Rust; `insight` is the model's optional
 *  interpretation and is empty when no model is running. */
export const sentinelTrackerNarrative = () => invoke<Explainer>("sentinel_tracker_narrative");

/** Read the active page as a policy/ToS and return the clauses that matter
 *  (ADR 0013, Pillar 3 M5). On demand — this reads a long document. Empty when
 *  nothing is notable, there's no page text, or no model is running. */
export const sentinelPolicyFlags = () => invoke<PolicyFlag[]>("sentinel_policy_flags");

/** The sealed agent-action audit log, newest first (ADR 0013, Pillar 0). */
export const sentinelAuditList = () => invoke<AuditEntry[]>("sentinel_audit_list");

/** Forget the audit log — the user's record of their own agent. */
export const sentinelAuditClear = () => invoke<void>("sentinel_audit_clear");

/** Click the page's genuine reject / necessary-only control. The click
 *  vocabulary is Rust-owned — the model never chooses what gets clicked. */
export const sentinelRejectConsent = (tabId: number) => invoke<void>("sentinel_reject_consent", { tabId });

export type MemInfo = GenMemInfo;
/** System + Flux memory, for the memory-pressure tab eviction (#45). */
export const memStatus = () => invoke<MemInfo>("mem_status");
export type SystemStats = {
  cpuPct: number;
  memTotalMb: number;
  memUsedMb: number;
  memPct: number;
  top: { name: string; memMb: number; cpu: number }[];
};
/** CPU + memory + heaviest processes (agent "system awareness"). */
export const systemStats = () => invoke<SystemStats>("system_stats");

// ─── Native dark mode (BACKLOG #40) ──────────────────────────────────────────
export const darkmodeStatus = () => invoke<boolean>("darkmode_status");
/** Force-dark all tab webviews (true) or restore (false). */
export const darkmodeSet = (on: boolean) => invoke<void>("darkmode_set", { on });

/** Pull OS keyboard focus back to the chrome window (so focusing a chrome DOM
 *  element actually grabs the keyboard while a page webview held focus). #18 */
export const chromeFocus = () => invoke<void>("chrome_focus");

/** Page-initiated new window (window.open / target="_blank" / modified click)
 *  forwarded from a tab webview → open it as a new Flux tab. `background` keeps
 *  focus on the current tab (middle-click / Ctrl-click). */
export const onOpenUrl = (cb: (url: string, background: boolean) => void): Promise<UnlistenFn> =>
  listen<[string, boolean]>("flux://open-url", (e) => cb(e.payload[0], e.payload[1]));

// ─── Navigation toggles (BACKLOG #51/#52) ────────────────────────────────────
export const navStatus = () => invoke<[boolean, boolean]>("nav_status");
export const navSet = (hints: boolean, gestures: boolean) => invoke<void>("nav_set", { hints, gestures });

// ─── Per-page notes (BACKLOG #53) ────────────────────────────────────────────
export const noteGet = (url: string) => invoke<string>("note_get", { url });
export const noteSet = (url: string, text: string) => invoke<void>("note_set", { url, text });

/** A host's favicon as a data: URL (fetched cookielessly + cached), or null. #21 */
export const faviconFetch = (host: string) => invoke<string | null>("favicon", { host });

// ─── Browsing history (BACKLOG #39) ──────────────────────────────────────────
/** Sentinel url for the full-page history view (DOM-rendered, no webview). */
export const HISTORY_URL = "flux://history";
export const historyRecent = (limit?: number) =>
  invoke<HistoryEntry[]>("history_recent", { limit: limit ?? null });
export const historySearch = (query: string, limit?: number) =>
  invoke<HistoryEntry[]>("history_search", { query, limit: limit ?? null });
export const historyDelete = (url: string) => invoke<void>("history_delete", { url });

// ─── The Trail — browsing provenance spine (ADR 0011) ────────────────────────
/** Most-recent Visits for the Trail timeline (newest first). */
export const traceRecent = (limit?: number) => invoke<Visit[]>("trace_recent", { limit: limit ?? null });
/** A single Visit by id (node detail). */
export const traceVisit = (id: number) => invoke<Visit | null>("trace_visit", { id });
/** The provenance graph (optionally time-windowed by `last_ms`) for the Trail view. */
export const traceGraph = (
  afterMs?: number,
  beforeMs?: number,
  /** Narrow to one workspace. Matches the visit's workspace id, falling back to
   *  `task` (the name) for visits recorded before ids were stamped. */
  taskId?: number,
  task?: string,
) =>
  invoke<TraceGraph>("trace_graph", {
    afterMs: afterMs ?? null,
    beforeMs: beforeMs ?? null,
    taskId: taskId ?? null,
    task: task ?? null,
  });
/** Follow a workspace rename so its earlier visits stay in the scoped view. */
export const traceRenameTask = (id: number | null, from: string, to: string) =>
  invoke<number>("trace_rename_task", { id, from, to });
/** Forget part (or all) of the Trail — the day-one privacy control. */
export const traceForget = (scope: ForgetScope) => invoke<void>("trace_forget", { scope });
/** Dwell-capture the active tab's current Visit — snapshot + embed (ADR 0011 step 1).
 *  Returns the snapshot id, or null if there's no current visit / no cached text. */
export const traceSnapshot = (tabId: number) => invoke<number | null>("trace_snapshot", { tabId });
/** A dwell snapshot's stored content (node detail). */
export const traceSnapshotGet = (id: number) => invoke<SnapshotWire | null>("trace_snapshot_get", { id });
/** Ambient watcher (local-only): past pages where the current page's error
 *  signature was seen before — empty unless the page shows a shaped error. */
export const traceAmbient = (tabId: number) => invoke<AmbientHint[]>("trace_ambient", { tabId });
/** Typed-draft capture (ADR 0011, opt-in): a visit's captured drafts. */
export const traceDrafts = (visitId: number) => invoke<Draft[]>("trace_drafts", { visitId });
export const traceDraftsEnabled = () => invoke<boolean>("trace_drafts_enabled", {});
export const traceDraftsSet = (on: boolean) => invoke<void>("trace_drafts_set", { on });
/** A visit's persistent chat thread (ADR 0011 step d) — empty if none yet. */
export const traceChat = (visitId: number) => invoke<ChatMsg[]>("trace_chat", { visitId });
/** The active page's persistent thread (re-attach by visit) — null when the
 *  tab has no current Visit (internal pages, private tabs). */
export const traceTabThread = (tabId: number) => invoke<TabThread | null>("trace_tab_thread", { tabId });
/** Group open tabs into Trail-connected "rabbit-hole" branches (largest first;
 *  every input tab appears exactly once — unconnected tabs come back solo). */
export const traceBranches = (tabs: { id: number; url: string }[]) =>
  invoke<number[][]>("trace_branches", { tabs });
/** Visit-density histogram — the Trail scrubber's activity backdrop. */
export const traceHistogram = (buckets?: number) =>
  invoke<TraceHistogram>("trace_histogram", { buckets: buckets ?? null });
/** Event frames streamed back by `trace_chat_send` (same shape family as kb_answer). */
export type TraceChatEvent = { kind: "token"; text: string } | { kind: "done" };
/** Send a message to a visit's chat — grounded in its snapshot, streamed token-by-token.
 *  Resolves once the reply is complete (and persisted to the thread). */
export const traceChatSend = (
  visitId: number,
  message: string,
  onEvent: (e: TraceChatEvent) => void,
): Promise<void> => {
  const ch = new Channel<string>();
  ch.onmessage = (raw) => {
    try {
      onEvent(JSON.parse(raw) as TraceChatEvent);
    } catch {
      /* skip a bad frame */
    }
  };
  return invoke<void>("trace_chat_send", { visitId, message, onToken: ch });
};

// ─── Bookmarks (BACKLOG #22) ─────────────────────────────────────────────────
/** Sentinel url for the full-page bookmarks view (DOM-rendered, no webview). */
export const BOOKMARKS_URL = "flux://bookmarks";
export const bookmarksList = () => invoke<Bookmark[]>("bookmarks_list");
export const bookmarkFolders = () => invoke<string[]>("bookmark_folders");
export const bookmarkAdd = (title: string, url: string, folder?: string) =>
  invoke<Bookmark>("bookmark_add", { title, url, folder: folder ?? null });
export const bookmarkRemove = (id: number) => invoke<void>("bookmark_remove", { id });
/** Rename a bookmark's display title (blank → host fallback). */
export const bookmarkRename = (id: number, title: string) => invoke<void>("bookmark_rename", { id, title });
export const bookmarksClear = () => invoke<void>("bookmarks_clear");
/** Import every bookmark from a Chrome profile; returns the count added. */
export const bookmarksImportChrome = (profileDir: string) =>
  invoke<number>("bookmarks_import_chrome", { profileDir });

// ─── Settings page (BACKLOG #78) ─────────────────────────────────────────────
export const SETTINGS_URL = "flux://settings";

// ─── Named sessions (BACKLOG #47) ────────────────────────────────────────────
export const SESSIONS_URL = "flux://sessions";
export const sessionsList = () => invoke<SavedSession[]>("sessions_list");
export const sessionSave = (name: string) => invoke<SavedSession>("session_save", { name });
export const sessionDelete = (id: number) => invoke<void>("session_delete", { id });
export const sessionRestore = (id: number) => invoke<SavedTab[]>("session_restore", { id });
/** Daily auto-snapshots (#47), newest day first. */
export const snapshotsList = () => invoke<DaySnapshot[]>("snapshots_list");
/** Tabs captured for a given day index (#47). */
export const snapshotRestore = (day: number) => invoke<SavedTab[]>("snapshot_restore", { day });
export const historyClear = () => invoke<void>("history_clear");

// ─── Downloads (BACKLOG #34) ─────────────────────────────────────────────────
// DownloadItem type is generated (bindings.gen) and aliased above.
export const downloadsList = () => invoke<DownloadItem[]>("downloads_list");
export const downloadsClear = () => invoke<void>("downloads_clear");
export const downloadOpen = (id: number) => invoke<void>("download_open", { id });
export const downloadReveal = (id: number) => invoke<void>("download_reveal", { id });
export const downloadCancel = (id: number) => invoke<void>("download_cancel", { id });
export const downloadPause = (id: number) => invoke<void>("download_pause", { id });
export const downloadResume = (id: number) => invoke<void>("download_resume", { id });
/** Fires (with the download id) on any progress/state change. */
export const onDownloadUpdated = (cb: () => void): Promise<UnlistenFn> =>
  listen<number>("flux://download-updated", () => cb());
/** Find-in-page (BACKLOG #33). Empty query clears the highlight. */
export const webviewFind = (tabId: number, query: string, forward = true) =>
  invoke<void>("webview_find", { tabId, query, forward });
export const webviewClose = (tabId: number) => invoke<void>("webview_close", { tabId });
/** Diagnostic: window scale/size + the tab webview's actual physical bounds. */
export const webviewDebug = (tabId: number) => invoke<string>("webview_debug", { tabId });

/** Page load progress for a tab: [tabId, url, "started" | "finished"]. */
export const onTabLoaded = (
  cb: (tabId: number, url: string, phase: "started" | "finished") => void,
): Promise<UnlistenFn> =>
  listen<[number, string, "started" | "finished"]>("flux://tab-loaded", (e) =>
    cb(e.payload[0], e.payload[1], e.payload[2]),
  );

// ─── Filesystem explorer (Files tab) ────────────────────────────────────────
// FileEntry / DirListing / QuickLocation are generated (bindings.gen) and aliased above.
export const fsList = (path: string) => invoke<DirListing>("fs_list", { path });
/** One frame of a streamed directory listing (#86); hand-mirrors Rust's `ListMsg`. */
export type ListMsg =
  | { kind: "head"; path: string; parent: string | null }
  | { kind: "entries"; entries: FileEntry[] }
  | { kind: "done"; total: number }
  | { kind: "error"; message: string };
/**
 * Stream a directory listing in chunks (#86): `onMsg` fires per frame
 * (head → entries… → done, or error), so a 100k-entry directory never arrives as
 * one giant payload. Resolves when the stream ends.
 */
export const fsListStream = (path: string, onMsg: (m: ListMsg) => void): Promise<void> => {
  const ch = new Channel<ListMsg>();
  ch.onmessage = onMsg;
  return invoke<void>("fs_list_stream", { path, onMsg: ch });
};
/** Recursive filename search under `root` (#88). Hand-written type (not specta). */
export type FsHit = { path: string; name: string; is_dir: boolean };
export const fsSearch = (root: string, query: string, limit = 500, semantic = false) =>
  invoke<FsHit[]>("fs_search", { root, query, limit, semantic });
export const fsHome = () => invoke<string>("fs_home");
export const fsQuickLocations = () => invoke<QuickLocation[]>("fs_quick_locations");
export const fsOpen = (path: string) => invoke<void>("fs_open", { path });

// File operations (BACKLOG #83). Paths are full; `dest` is a directory.
export const fsCreateDir = (path: string) => invoke<void>("fs_create_dir", { path });
export const fsCreateFile = (path: string) => invoke<void>("fs_create_file", { path });
export const fsRename = (from: string, to: string) => invoke<void>("fs_rename", { from, to });
export const fsMove = (paths: string[], dest: string) => invoke<void>("fs_move", { paths, dest });
export const fsCopy = (paths: string[], dest: string) => invoke<void>("fs_copy", { paths, dest });
/** Move to OS trash (recoverable). */
export const fsTrash = (paths: string[]) => invoke<void>("fs_trash", { paths });
/** Permanent delete (no undo). */
export const fsDelete = (paths: string[]) => invoke<void>("fs_delete", { paths });
/** Undo the last reversible op (rename/move/trash); returns a description or null. */
export const fsUndo = () => invoke<string | null>("fs_undo");
/** Live directory watch for a Files tab (#85): one watcher per tab id. */
export const fsWatch = (id: number, path: string) => invoke<void>("fs_watch", { id, path });
export const fsUnwatch = (id: number) => invoke<void>("fs_unwatch", { id });
/** Fires (with the watched directory) when a watched dir's contents change. */
export const onFsChanged = (cb: (path: string) => void): Promise<UnlistenFn> =>
  listen<string>("flux://fs-changed", (e) => cb(e.payload));

// ─── Terminal (PTY) ────────────────────────────────────────────────────────

/** What a terminal survives a Flux restart (BACKLOG #98). `live` keeps the shell
 *  and its children running via dtach/tmux; `transcript` replays the recorded
 *  output. They're independent — `both` is the pair that gives back the running
 *  work *and* the scrollback. Off by default: `transcript` writes terminal output
 *  to disk. */
export type TermPersist = "off" | "live" | "transcript" | "both";
export const TERM_PERSIST_KEY = "flux.term.persist";
export const termPersist = (): TermPersist =>
  (localStorage.getItem(TERM_PERSIST_KEY) as TermPersist | null) ?? "off";

/** Spawn a PTY for `session`; `onData` streams raw output bytes (number[]). */
export const terminalSpawn = (
  session: number,
  cols: number,
  rows: number,
  onData: Channel<number[]>,
  persist: TermPersist = termPersist(),
) => invoke<void>("terminal_spawn", { session, cols, rows, onData, persist });

/** Write input bytes (encoded keystrokes/paste) to the session's stdin. */
export const terminalWrite = (session: number, data: Uint8Array) =>
  invoke<void>("terminal_write", { session, data: Array.from(data) });

export const terminalResize = (session: number, cols: number, rows: number) =>
  invoke<void>("terminal_resize", { session, cols, rows });

export const terminalKill = (session: number) => invoke<void>("terminal_kill", { session });

/** Fires when a session's shell exits (EOF). */
export const onTermExit = (cb: (session: number) => void): Promise<UnlistenFn> =>
  listen<number>("flux://term-exit", (e) => cb(e.payload));
