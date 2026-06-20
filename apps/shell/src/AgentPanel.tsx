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
  agentModels,
  spotifyNext,
  spotifyNowPlaying,
  spotifyPause,
  spotifyPlay,
  spotifyPrev,
  spotifyResume,
  agentPlan,
  agentRunAction,
  agentTaskStep,
  agentLens,
  agentVision,
  webviewCapture,
  onScreenshot,
  isStartUrl,
  onAgentStatus,
  type AgentAction,
  type AgentStatus,
} from "./ipc";
import { activeId, activeWorkspace, agentModelName, pendingAsk, pendingLens, setAgentModel, setPendingAsk, setPendingLens, tabs } from "./store";
import AgentAurora from "./AgentAurora";

type FeedItem = { role: "user" | "assistant" | "action" | "error" | "plan" | "task"; text: string; action?: AgentAction; pending?: boolean; image?: string };

const AgentPanel: Component = () => {
  const [status, setStatus] = createSignal<AgentStatus>({ state: "idle" });
  const [prompt, setPrompt] = createSignal("");
  const [feed, setFeed] = createSignal<FeedItem[]>([]);
  const [busy, setBusy] = createSignal(false);
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
      setFeed((f) => [...f, { role: "assistant", text: reply.trim() }]);
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
      setFeed((f) => [...f, { role: "assistant", text: answer.trim() }]);
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

  // Music intents (AudioPulse via Spotify) — "play …" / "skip" / "pause" etc.,
  // optionally addressed to Gemma ("hey gemma, play …" / "can you skip"). Returns
  // true if it handled the message (and posts the result/error to the feed).
  const runMusic = async (raw: string): Promise<boolean> => {
    const cmd = raw
      .replace(/^(hey\s+)?gemma[,:\s]+/i, "")
      .replace(/^(can|could|would)\s+you\s+/i, "")
      .replace(/^please\s+/i, "")
      .trim();
    const call = async (fn: () => Promise<string>) => {
      try { const r = await fn(); setFeed((f) => [...f, { role: "action", text: r }]); }
      catch (e) { setFeed((f) => [...f, { role: "error", text: String(e) }]); }
    };
    const play = cmd.match(/^\/?(?:play|put on|queue)\s+(.+)/i);
    if (play?.[1]) { await call(() => spotifyPlay(play[1]!.trim())); return true; }
    if (/^\/?(?:skip|next)(?:\s+(?:song|track))?$/i.test(cmd)) { await call(spotifyNext); return true; }
    if (/^\/?(?:prev(?:ious)?|back|last(?:\s+song)?)$/i.test(cmd)) { await call(spotifyPrev); return true; }
    if (/^\/?pause$/i.test(cmd)) { await call(spotifyPause); return true; }
    if (/^\/?(?:resume|unpause|continue)$/i.test(cmd)) { await call(spotifyResume); return true; }
    if (/^\/?(?:what'?s\s*playing|now\s*playing|np)\??$/i.test(cmd)) { await call(spotifyNowPlaying); return true; }
    return false;
  };

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
          setFeed((f) => [...f, { role: "assistant", text: answer.trim() }]);
        } else {
          const idx = feed().length;
          setFeed((f) => [...f, { role: "assistant", text: "" }]);
          const append = (chunk: string) => setFeed((f) => f.map((it, i) => (i === idx ? { ...it, text: it.text + chunk } : it)));
          await agentChatStream(`${p || "Summarize this file."}\n\n--- file: ${att.name} ---\n${att.text}`, append);
          setFeed((f) => f.map((it, i) => (i === idx ? { ...it, text: it.text.trim() || "(no response)" } : it)));
        }
        return;
      }
      // Visual Lens — "/lens", "what is this", "identify this/it", "what am I looking at".
      const lens = p.match(/^\/lens(?:\s+([\s\S]+))?$/i) ||
        p.match(/^(?:what(?:'?s| is) this|identify (?:this|it)|what am i looking at)\b[\s\S]*/i);
      if (lens) { await runLens(lens[1]?.trim() || (/^\/lens/i.test(p) ? "" : p)); return; }
      // Music command (AudioPulse) before chat — "play …" / "skip" / "pause" / …
      if (await runMusic(p)) return;
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
        const idx = feed().length;
        setFeed((f) => [...f, { role: "assistant", text: "" }]);
        const append = (chunk: string) =>
          setFeed((f) => f.map((it, i) => (i === idx ? { ...it, text: it.text + chunk } : it)));
        if (scope() === "tabs") await agentChatTabsStream(p, browserTabIds(), append);
        else await agentChatStream(p, append);
        setFeed((f) =>
          f.map((it, i) => (i === idx ? { ...it, text: it.text.trim() || "(no response)" } : it)),
        );
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
    <aside class="agent">
      <div class="agent-inner">
        {/* Ambient effects layer: circular aurora background + orbital edge glow. Its
            own absolutely-positioned + clipped layer so it never affects layout
            or clips the model dropdown. */}
        <div class="agent-fx" classList={{ busy: working() }} aria-hidden="true">
          <AgentAurora active={() => true} />
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
