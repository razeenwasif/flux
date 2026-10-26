/**
 * The welcome (Flux Next "welcome"): six steps on a first launch, each one
 * skippable: your name, bringing your browsing over (import.rs, flux-import's
 * browsers.rs), sites for the new tab, the launcher, the agent and how it
 * asks. The launcher's "Welcome to Flux" and "Import from another browser"
 * open it again. Over everything: it holds the pages out of sight while open.
 */
import { invoke } from "@tauri-apps/api/core";
import {
  For,
  Match,
  Show,
  Switch,
  createMemo,
  createSignal,
  onCleanup,
  onMount,
  type Component,
} from "solid-js";

import type { FormHelpPrefs } from "./bindings.gen";
import type { FoundBrowser, ImportPick, ImportResult, SiteSuggestion } from "./bindings.gen";
import { holdDialog } from "./dialogs";
import { keyOf } from "./keyLabel";
import "./Welcome.css";

const STEPS = ["Name", "Import", "Pinned sites", "Launcher", "Agent", "How the agent asks"];

/** The new tab's shortcut tiles (StartPage.tsx keeps them in flux.shortcuts). */
type Shortcut = { label: string; url: string; tint: string };
const TINTS = ["#7b61ff", "#ec4be0", "#2ff3ff", "#ff9f45", "#ff6b4a", "#5ce08a", "#f3b6d3", "#c9b5ff"];
const MAX_PINS = 8;

const fmt = (n: number) => n.toLocaleString();
const plural = (n: number, one: string, many = `${one}s`) => `${fmt(n)} ${n === 1 ? one : many}`;
/** Two letters per tile, none the same: GitHub "GI", GitLab "GT". */
const labels = (hosts: string[]): string[] => {
  const used = new Set<string>();
  return hosts.map((host) => {
    const n =
      (host.replace(/^www\./, "").split(".")[0] ?? host).toUpperCase().replace(/[^A-Z0-9]/g, "") || "?";
    const tries = [...n.slice(1)]
      .map((c) => n.charAt(0) + c)
      .concat([...Array(9)].map((_, i) => n.charAt(0) + (i + 1)));
    const label = tries.find((t) => !used.has(t)) ?? n.slice(0, 2);
    used.add(label);
    return label;
  });
};

const Welcome: Component<{ start: number; onClose: () => void }> = (props) => {
  const [step, setStep] = createSignal(Math.min(Math.max(props.start, 0), STEPS.length - 1));
  const release = holdDialog();
  onCleanup(release);
  let card!: HTMLDivElement;
  const next = () => (step() < STEPS.length - 1 ? setStep(step() + 1) : props.onClose());
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      props.onClose();
    }
  };
  onMount(() => window.addEventListener("keydown", onKey));
  onCleanup(() => window.removeEventListener("keydown", onKey));
  // Each step starts at its first field or button, for the keyboard.
  const focusStep = () =>
    queueMicrotask(() =>
      card?.querySelector<HTMLElement>(".wl-body input, .wl-body button, .wl-primary")?.focus(),
    );

  // ── 1. Name ──
  const [name, setName] = createSignal(localStorage.getItem("flux.user.name") ?? "");
  const saveName = () => {
    const v = name().trim();
    if (v) localStorage.setItem("flux.user.name", v);
    else localStorage.removeItem("flux.user.name");
  };

  // ── 2. Import ──
  const [browsers, setBrowsers] = createSignal<FoundBrowser[] | null>(null);
  const [picked, setPicked] = createSignal<Record<string, string>>({}); // browser → profile dir
  const [bring, setBring] = createSignal({ bookmarks: true, history: true, pinned: true });
  const [importing, setImporting] = createSignal(false);
  const [imported, setImported] = createSignal<ImportResult | null>(null);
  const scan = () => {
    setBrowsers(null);
    void invoke<FoundBrowser[]>("import_scan")
      .then((list) => {
        setBrowsers(list);
        // Everything found comes along, each browser's profile in use.
        const pick: Record<string, string> = {};
        for (const b of list) {
          const p = b.profiles.find((x) => x.in_use) ?? b.profiles[0];
          if (b.state === "ready" && p && (p.bookmarks || p.history || p.pinned)) pick[b.id] = p.dir;
        }
        setPicked(pick);
      })
      .catch(() => setBrowsers([]));
  };
  const profileOf = (b: FoundBrowser) => b.profiles.find((p) => p.dir === picked()[b.id]);
  const chosen = createMemo(() => (browsers() ?? []).filter((b) => picked()[b.id]));
  const totals = createMemo(() => {
    let bookmarks = 0;
    let history = 0;
    let pinned = 0;
    for (const b of chosen()) {
      const p = profileOf(b);
      bookmarks += p?.bookmarks ?? 0;
      history += p?.history ?? 0;
      pinned += p?.pinned ?? 0;
    }
    return { bookmarks, history, pinned };
  });
  const bookmarkFrom = () =>
    chosen()
      .filter((b) => profileOf(b)?.bookmarks)
      .map((b) => b.name);
  const runImport = async () => {
    const picks: ImportPick[] = chosen().map((b) => ({ browser: b.id, dir: picked()[b.id]! }));
    if (!picks.length || !(bring().bookmarks || bring().history || bring().pinned)) return next();
    setImporting(true);
    try {
      const r = await invoke<ImportResult>("import_run", {
        picks,
        bookmarks: bring().bookmarks,
        history: bring().history,
        pinned: bring().pinned,
      });
      setImported(r);
      window.dispatchEvent(new Event("flux:bookmarks-changed"));
      loadSites(); // the import's history ranks the next step's sites
    } catch (e) {
      setImported({ bookmarks: 0, history: 0, pinned: 0, failed: [String(e)] });
    } finally {
      setImporting(false);
    }
  };
  const importSummary = () => {
    const r = imported()!;
    const parts = [
      r.bookmarks && plural(r.bookmarks, "bookmark"),
      r.history && plural(r.history, "page"),
      r.pinned && plural(r.pinned, "pinned site"),
    ].filter(Boolean);
    return parts.length ? `Brought ${parts.join(", ")}.` : "Nothing new to bring: it's all here already.";
  };

  // ── 3. Pinned sites ──
  const [sites, setSites] = createSignal<SiteSuggestion[] | null>(null);
  const savedShortcuts = (): Shortcut[] | null => {
    try {
      const s = localStorage.getItem("flux.shortcuts");
      return s ? (JSON.parse(s) as Shortcut[]) : null;
    } catch {
      return null;
    }
  };
  const [pins, setPins] = createSignal<string[]>([]); // urls, in order
  const loadSites = () =>
    void invoke<SiteSuggestion[]>("import_top_sites", { limit: 16 })
      .then((s) => {
        setSites(s);
        const saved = savedShortcuts();
        setPins(saved?.length ? saved.map((x) => x.url) : s.slice(0, 5).map((x) => x.url));
      })
      .catch(() => setSites([]));
  const hostOf = (url: string) => {
    try {
      return new URL(url).hostname.replace(/^www\./, "");
    } catch {
      return url;
    }
  };
  /** The tiles to choose from: the suggestions, and any saved tile they miss. */
  const tiles = createMemo(() => {
    const list = [...(sites() ?? [])];
    for (const s of savedShortcuts() ?? []) {
      if (!list.some((x) => hostOf(x.url) === hostOf(s.url)))
        list.push({ url: s.url, host: hostOf(s.url), title: s.label });
    }
    return list;
  });
  /** Each tile's label, as the new tab will show it. */
  const tileLabels = createMemo(() => {
    const hosts = tiles().map((t) => t.host);
    const tags = labels(hosts);
    return new Map(hosts.map((h, i) => [h, tags[i]!]));
  });
  const togglePin = (url: string) =>
    setPins((p) => (p.includes(url) ? p.filter((u) => u !== url) : p.length < MAX_PINS ? [...p, url] : p));
  const savePins = () => {
    if (!sites()) return;
    const tags = labels(pins().map(hostOf));
    const list: Shortcut[] = pins().map((url, i) => ({
      label: tags[i]!,
      url,
      tint: TINTS[i % TINTS.length]!,
    }));
    localStorage.setItem("flux.shortcuts", JSON.stringify(list));
    window.dispatchEvent(new Event("flux:shortcuts-changed"));
  };

  // ── 5. Agent ──
  const [models, setModels] = createSignal<string[] | null>(null);
  // ── 6. How the agent asks ──
  const [formHelp, setFormHelp] = createSignal<FormHelpPrefs | null>(null);
  const toggleFormHelp = () => {
    const p = formHelp();
    if (!p) return;
    void invoke<FormHelpPrefs>("formhelp_set_settings", { prefs: { ...p, enabled: !p.enabled } })
      .then(setFormHelp)
      .catch(() => {});
  };

  onMount(() => {
    scan();
    loadSites();
    void invoke<string[]>("agent_models")
      .then(setModels)
      .catch(() => setModels([]));
    void invoke<FormHelpPrefs>("formhelp_settings", {})
      .then(setFormHelp)
      .catch(() => {});
    focusStep();
  });

  const go = (to: number) => {
    if (step() === 0) saveName();
    if (step() === 2) savePins();
    setStep(to);
    focusStep();
  };
  const primary = () => {
    if (step() === 0) saveName();
    if (step() === 1 && !imported()) return void runImport();
    if (step() === 2) savePins();
    next();
    focusStep();
  };
  const primaryLabel = () =>
    step() === 1 && !imported()
      ? importing()
        ? "Bringing it over…"
        : chosen().length
          ? "Import and continue"
          : "Continue"
      : step() === STEPS.length - 1
        ? "Start browsing"
        : "Continue";

  return (
    <div class="wl-scrim">
      <div class="wl" role="dialog" aria-modal="true" aria-labelledby="wl-title" ref={card}>
        <nav class="wl-rail" aria-label="Setup steps">
          <div class="wl-mark">flux</div>
          <ol>
            <For each={STEPS}>
              {(label, i) => (
                <li>
                  <button
                    type="button"
                    classList={{ on: step() === i(), done: step() > i() }}
                    aria-current={step() === i() ? "step" : undefined}
                    onClick={() => go(i())}
                  >
                    <span class="wl-dot" aria-hidden="true">
                      {step() > i() ? "✓" : i() + 1}
                    </span>
                    {label}
                  </button>
                </li>
              )}
            </For>
          </ol>
          <button type="button" class="wl-close" onClick={props.onClose}>
            Close setup
          </button>
        </nav>

        <section class="wl-main">
          <p class="wl-kicker">
            <span class="wl-new">New</span> Step {step() + 1} of {STEPS.length}
          </p>
          <div class="wl-body">
            <Switch>
              <Match when={step() === 0}>
                <h1 id="wl-title">Hello. What should Flux call you?</h1>
                <p class="wl-sub">
                  It greets you on the new tab, and the agent uses it in reminders. Leave it blank if you'd
                  rather.
                </p>
                <label class="wl-name">
                  <span class="wl-sr">Your name</span>
                  <input
                    value={name()}
                    placeholder="Your name"
                    autocomplete="given-name"
                    onInput={(e) => setName(e.currentTarget.value)}
                    onKeyDown={(e) => e.key === "Enter" && primary()}
                  />
                </label>
              </Match>

              <Match when={step() === 1}>
                <h1 id="wl-title">Bring your browsing with you</h1>
                <p class="wl-sub">
                  <Show when={browsers()} fallback="Looking for other browsers on this Mac…">
                    {(list) => {
                      const n = () => list().filter((b) => b.state === "ready").length;
                      return n()
                        ? `Flux found ${n() === 1 ? "one browser" : `${n()} browsers`} on this Mac. Pick what comes along; you can import again later in Settings → Data.`
                        : "Flux didn't find another browser it can read. You can import later in Settings → Data.";
                    }}
                  </Show>
                </p>
                <div class="wl-card" data-legend="Import">
                  <h2 class="wl-h2">Browsers to import from</h2>
                  <ul class="wl-browsers">
                    <For each={browsers() ?? []}>
                      {(b) => {
                        const on = () => !!picked()[b.id];
                        const p = () => profileOf(b) ?? b.profiles.find((x) => x.in_use) ?? b.profiles[0];
                        const status = () =>
                          b.state === "ready"
                            ? `Detected: ${b.detail}`
                            : b.state === "locked"
                              ? `Detected, locked: ${b.detail}`
                              : b.state === "empty"
                                ? `Here: ${b.detail.toLowerCase()}`
                                : `Not found: ${b.detail}`;
                        const counts = () => {
                          const x = p();
                          if (!x || b.state !== "ready") return "";
                          return [
                            x.bookmarks && plural(x.bookmarks, "bookmark"),
                            x.history && plural(x.history, "page"),
                            x.pinned && `${fmt(x.pinned)} pinned`,
                          ]
                            .filter(Boolean)
                            .join(" · ");
                        };
                        return (
                          <li classList={{ "wl-browser": true, off: b.state !== "ready" }}>
                            <span class={`wl-badge b-${b.id}`} aria-hidden="true">
                              {b.name[0]}
                            </span>
                            <span class="wl-bname">
                              <strong>{b.name}</strong>
                              <span class="wl-bstate">{status()}</span>
                              <Show when={counts()}>
                                <span class="wl-bcount">{counts()}</span>
                              </Show>
                            </span>
                            <Show when={b.profiles.length > 1}>
                              <select
                                class="wl-profile"
                                aria-label={`${b.name} profile`}
                                value={picked()[b.id] ?? p()?.dir ?? ""}
                                onChange={(e) => setPicked((m) => ({ ...m, [b.id]: e.currentTarget.value }))}
                              >
                                <For each={b.profiles}>{(x) => <option value={x.dir}>{x.name}</option>}</For>
                              </select>
                            </Show>
                            <Switch>
                              <Match when={b.state === "ready"}>
                                <input
                                  type="checkbox"
                                  class="wl-check"
                                  aria-label={`Import from ${b.name}`}
                                  checked={on()}
                                  disabled={!!imported()}
                                  onChange={() =>
                                    setPicked((m) => {
                                      const n = { ...m };
                                      if (n[b.id]) delete n[b.id];
                                      else n[b.id] = p()!.dir;
                                      return n;
                                    })
                                  }
                                />
                              </Match>
                              <Match when={b.state === "locked"}>
                                <span class="wl-locked">
                                  <button
                                    type="button"
                                    class="wl-link"
                                    onClick={() => void invoke("import_open_disk_access").catch(() => {})}
                                  >
                                    Open Full Disk Access
                                  </button>
                                  <button type="button" class="wl-link" onClick={scan}>
                                    Check again
                                  </button>
                                </span>
                              </Match>
                            </Switch>
                          </li>
                        );
                      }}
                    </For>
                  </ul>
                </div>
                <div class="wl-card" data-legend="Bring">
                  <h2 class="wl-h2">What to bring</h2>
                  <ul class="wl-bring">
                    <li>
                      <span>
                        <strong>Bookmarks</strong>
                        <span class="wl-bstate">
                          {totals().bookmarks
                            ? `${fmt(totals().bookmarks)} from ${bookmarkFrom().join(" and ")}`
                            : "None in the browsers you picked"}
                        </span>
                      </span>
                      <input
                        type="checkbox"
                        class="wl-check"
                        aria-label="Bring bookmarks"
                        checked={bring().bookmarks}
                        disabled={!!imported()}
                        onChange={() => setBring((x) => ({ ...x, bookmarks: !x.bookmarks }))}
                      />
                    </li>
                    <li>
                      <span>
                        <strong>History</strong>
                        <span class="wl-bstate">Last 180 days</span>
                      </span>
                      <input
                        type="checkbox"
                        class="wl-check"
                        aria-label="Bring history"
                        checked={bring().history}
                        disabled={!!imported()}
                        onChange={() => setBring((x) => ({ ...x, history: !x.history }))}
                      />
                    </li>
                    <Show when={picked().arc}>
                      <li>
                        <span>
                          <strong>Pinned sites</strong>
                          <span class="wl-bstate">
                            Arc's pinned tabs and Favorites come along, as bookmarks
                          </span>
                        </span>
                        <input
                          type="checkbox"
                          class="wl-check"
                          aria-label="Bring Arc's pinned sites"
                          checked={bring().pinned}
                          disabled={!!imported()}
                          onChange={() => setBring((x) => ({ ...x, pinned: !x.pinned }))}
                        />
                      </li>
                    </Show>
                  </ul>
                  <p class="wl-note">
                    Passwords stay where they are: the Vault imports them (flux://passwords).
                  </p>
                </div>
              </Match>

              <Match when={step() === 2}>
                <h1 id="wl-title">Sites for your new tab</h1>
                <p class="wl-sub">
                  Pick up to {MAX_PINS}. They sit under the clock on every new tab;{" "}
                  {sites()?.length
                    ? "the ones you visit most come first."
                    : "these are Flux's picks until you've browsed a while."}
                </p>
                <div class="wl-sites" role="group" aria-label="Sites for the new tab">
                  <For each={tiles()}>
                    {(s) => {
                      const on = () => pins().includes(s.url);
                      return (
                        <button
                          type="button"
                          classList={{ "wl-site": true, on: on() }}
                          aria-pressed={on()}
                          onClick={() => togglePin(s.url)}
                        >
                          <span class="wl-tile" aria-hidden="true">
                            {tileLabels().get(s.host)}
                          </span>
                          <span class="wl-site-text">
                            <strong>{s.host}</strong>
                            <span>{s.title || s.host}</span>
                          </span>
                          <span class="wl-tick" aria-hidden="true">
                            {on() ? "✓" : "+"}
                          </span>
                        </button>
                      );
                    }}
                  </For>
                </div>
                <p class="wl-note">
                  {pins().length} of {MAX_PINS} picked. Change them on the new tab any time.
                </p>
              </Match>

              <Match when={step() === 3}>
                <h1 id="wl-title">One key finds anything</h1>
                <p class="wl-sub">
                  <kbd>{keyOf("palette") || "⌘K"}</kbd> opens the launcher: the web, your open tabs, history,
                  notes, and every command, in one list.
                </p>
                <div class="wl-demo" aria-hidden="true">
                  <div class="wl-demo-q">rust docs</div>
                  <div class="wl-demo-sec">Search</div>
                  <div class="wl-demo-row on">⌕ rust docs — DuckDuckGo</div>
                  <div class="wl-demo-sec">Tabs</div>
                  <div class="wl-demo-row">▣ The Rust Programming Language</div>
                  <div class="wl-demo-sec">History</div>
                  <div class="wl-demo-row">↺ std - Rust · doc.rust-lang.org</div>
                  <div class="wl-demo-sec">Commands</div>
                  <div class="wl-demo-row">› Open Rust docs in a split</div>
                </div>
                <ul class="wl-keys">
                  <li>
                    <code>@tabs</code> <code>@history</code> <code>@notes</code> look in one place;{" "}
                    <code>&gt;</code> lists the commands
                  </li>
                  <li>
                    <kbd>⌘↵</kbd> opens in the background, <kbd>⌥↵</kbd> keeps what you typed as a task
                  </li>
                  <li>Every command is in the menu bar too. Settings → Keyboard changes any key.</li>
                </ul>
              </Match>

              <Match when={step() === 4}>
                <h1 id="wl-title">An agent that works on your Mac</h1>
                <p class="wl-sub">
                  <kbd>{keyOf("toggle-agent") || "⌘⇧A"}</kbd> opens it beside the page. It answers from the
                  page you're on, your open tabs or your notes, and does small jobs on pages.
                </p>
                <div class="wl-card" data-legend="Model">
                  <Show when={models()} fallback={<p class="wl-sub">Looking for a model…</p>}>
                    {(m) => (
                      <Show
                        when={m().length}
                        fallback={
                          <div class="wl-model">
                            <strong>No model yet</strong>
                            <p>
                              Install Ollama from ollama.com, then run <code>ollama pull gemma4</code> in a
                              terminal. Or use a model on another machine: Settings → Integrations → Model
                              server.
                            </p>
                          </div>
                        }
                      >
                        <div class="wl-model ready">
                          <strong>Ready: {m()[0]}</strong>
                          <p>
                            {m().length > 1 ? `and ${plural(m().length - 1, "other model")}. ` : ""}It runs
                            where your model server is, so pages and notes don't leave it. Settings →
                            Integrations changes it.
                          </p>
                        </div>
                      </Show>
                    )}
                  </Show>
                </div>
              </Match>

              <Match when={step() === 5}>
                <h1 id="wl-title">It asks before it acts</h1>
                <p class="wl-sub">The agent can work on a page for you. Here's where it stops and asks.</p>
                <div class="wl-rules">
                  <div class="wl-rule">
                    <strong>Reads and drafts on its own</strong>
                    <p>Reading the page, searching, filling in a draft: nothing leaves until you say so.</p>
                  </div>
                  <div class="wl-rule">
                    <strong>Asks once before it commits</strong>
                    <p>
                      Sending, submitting, posting: it shows what will happen, waits for you, then does it
                      once.
                    </p>
                  </div>
                  <div class="wl-rule">
                    <strong>Never types your secrets</strong>
                    <p>
                      Passwords and card numbers are yours to type, and buying is yours to do. A page's text
                      is content, never orders.
                    </p>
                  </div>
                </div>
                <Show when={formHelp()}>
                  {(p) => (
                    <div class="wl-bring wl-toggle">
                      <span>
                        <strong>Form help</strong>
                        <span class="wl-bstate">
                          Suggest what goes in a form field, from your own model. Off until you turn it on.
                        </span>
                      </span>
                      <input
                        type="checkbox"
                        class="wl-check"
                        aria-label="Form help"
                        checked={p().enabled}
                        onChange={toggleFormHelp}
                      />
                    </div>
                  )}
                </Show>
              </Match>
            </Switch>
          </div>

          <footer class="wl-foot">
            <span class="wl-summary" role="status">
              <Switch>
                <Match when={step() === 1 && imported()}>
                  <>
                    {importSummary()}
                    <Show when={imported()!.failed.length}>
                      <span class="wl-failed"> Couldn't read: {imported()!.failed.join("; ")}</span>
                    </Show>
                  </>
                </Match>
                <Match when={step() === 1 && chosen().length}>
                  {plural(chosen().length, "browser")}
                  {bring().history && totals().history ? ` · about ${fmt(totals().history)} pages` : ""}
                </Match>
              </Switch>
            </span>
            <Show when={step() < STEPS.length - 1}>
              <button type="button" class="wl-btn" onClick={() => go(step() + 1)} disabled={importing()}>
                Skip
              </button>
            </Show>
            <button type="button" class="wl-btn wl-primary" onClick={primary} disabled={importing()}>
              {primaryLabel()}
            </button>
          </footer>
        </section>
      </div>
    </div>
  );
};

export default Welcome;
