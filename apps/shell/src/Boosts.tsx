/**
 * Boosts (BACKLOG #49) — a footer ✨ popover to "make this site better": describe
 * a change in plain language and the local agent writes the CSS, saved per host
 * and re-applied on every visit. A popover (not a page) so the active tab stays
 * the page the agent reads + boosts. CSS-only authoring (safe to inject).
 */
import { For, Show, createEffect, createSignal, onCleanup, type Component } from "solid-js";
import { boostAuthor, boostDelete, boostSetEnabled, boostsForHost, isStartUrl, type Boost } from "./ipc";
import { activeTab } from "./store";

function hostOf(url: string): string | null {
  try { return new URL(url).hostname.replace(/^www\./, "") || null; } catch { return null; }
}

const Boosts: Component = () => {
  const [open, setOpen] = createSignal(false);
  const [list, setList] = createSignal<Boost[]>([]);
  const [instruction, setInstruction] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);

  const host = () => {
    const t = activeTab();
    return t && t.kind === "browser" && !isStartUrl(t.url) ? hostOf(t.url) : null;
  };
  const refresh = () => {
    const h = host();
    if (h) void boostsForHost(h).then(setList).catch(() => setList([]));
    else setList([]);
  };
  // Reload when the popover opens or the site changes.
  createEffect(() => { if (open()) { host(); refresh(); } });
  createEffect(() => {
    if (!open()) return;
    const t = window.setInterval(refresh, 2000);
    onCleanup(() => clearInterval(t));
  });

  const apply = async () => {
    const instr = instruction().trim();
    if (!instr || busy()) return;
    setBusy(true);
    setError(null);
    try {
      await boostAuthor(instr);
      setInstruction("");
      refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };
  const toggle = (b: Boost) => { const h = host(); if (h) void boostSetEnabled(b.id, h, !b.enabled).then(refresh); };
  const remove = (b: Boost) => { const h = host(); if (h) void boostDelete(b.id, h).then(refresh); };

  return (
    <div style={{ display: "contents" }}>
      <button classList={{ "icon-btn": true, active: open() }} title="Boosts — customize this site with AI" onClick={() => setOpen((v) => !v)}>✨</button>
      <Show when={open()}>
        <div class="shield-backdrop" onClick={() => setOpen(false)} />
        <div class="glass popover shields-pop footer-pop">
          <Show when={host()} fallback={<div class="boost-empty">Open a web page to boost it.</div>}>
            <div class="shields-row">
              <span class="shields-label">Boost</span>
              <span class="shields-host" title={host()!}>{host()}</span>
            </div>
            <textarea
              class="boost-input"
              placeholder="Describe a change — e.g. hide the cookie banner, dark mode, widen the article"
              rows={2}
              value={instruction()}
              disabled={busy()}
              onInput={(e) => setInstruction(e.currentTarget.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); void apply(); } }}
            />
            <button class="boost-apply" disabled={busy() || !instruction().trim()} onClick={() => void apply()}>
              {busy() ? "✨ Writing CSS…" : "✨ Apply (the agent writes the CSS)"}
            </button>
            <Show when={error()}><div class="boost-error">{error()}</div></Show>

            <Show when={list().length > 0}>
              <div class="shields-sep" />
              <div class="ctx-label">Boosts on {host()}</div>
              <For each={list()}>
                {(b) => (
                  <div class="boost-row">
                    <button classList={{ "boost-toggle": true, on: b.enabled }} title={b.enabled ? "Enabled — click to disable" : "Disabled"} onClick={() => toggle(b)}>
                      {b.enabled ? "●" : "○"}
                    </button>
                    <span class="boost-name" title={b.css}>{b.name || "boost"}</span>
                    <button class="boost-del" title="Delete boost" onClick={() => remove(b)}>✕</button>
                  </div>
                )}
              </For>
              <div class="boost-note">Changes apply live; reload if a site re-renders over them.</div>
            </Show>
          </Show>
        </div>
      </Show>
    </div>
  );
};

export default Boosts;
