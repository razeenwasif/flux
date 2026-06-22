/**
 * Boosts (BACKLOG #49) — a footer ✨ popover to "make this site better": describe
 * a change in plain language and the local agent writes the CSS (saved per host and
 * re-applied on every visit), OR write/edit the CSS by hand. A popover (not a page)
 * so the active tab stays the page the agent reads + boosts. CSS-only authoring
 * (safe to inject; raw JS is intentionally not exposed). An "All sites" view manages
 * every boost across hosts.
 */
import { For, Show, createEffect, createSignal, type Component } from "solid-js";

import { visibleInterval } from "./poll";
import { boostAuthor, boostDelete, boostSave, boostSetEnabled, boostsForHost, boostsList, isStartUrl, type Boost } from "./ipc";
import { activeTab } from "./store";

function hostOf(url: string): string | null {
  try { return new URL(url).hostname.replace(/^www\./, "") || null; } catch { return null; }
}

const Boosts: Component<{ initialOpen?: boolean }> = (props) => {
  const [open, setOpen] = createSignal(!!props.initialOpen);
  const [list, setList] = createSignal<Boost[]>([]);
  const [allList, setAllList] = createSignal<Boost[]>([]);
  const [allSites, setAllSites] = createSignal(false);
  const [instruction, setInstruction] = createSignal("");
  const [mode, setMode] = createSignal<"ai" | "css">("ai"); // author via the agent or raw CSS
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  // Boost id currently being edited inline, + the draft CSS.
  const [editId, setEditId] = createSignal<number | null>(null);
  const [editCss, setEditCss] = createSignal("");

  const host = () => {
    const t = activeTab();
    return t && t.kind === "browser" && !isStartUrl(t.url) ? hostOf(t.url) : null;
  };
  const refresh = () => {
    const h = host();
    if (h) void boostsForHost(h).then(setList).catch(() => setList([]));
    else setList([]);
    if (allSites()) void boostsList().then(setAllList).catch(() => setAllList([]));
  };
  // Reload when the popover opens or the site changes.
  createEffect(() => { if (open()) { host(); allSites(); refresh(); } });
  createEffect(() => {
    if (!open()) return;
    visibleInterval(refresh, 2000);
  });

  const apply = async () => {
    const instr = instruction().trim();
    if (!instr || busy()) return;
    const h = host();
    setBusy(true);
    setError(null);
    try {
      if (mode() === "css") {
        if (!h) throw new Error("open a web page first");
        await boostSave(null, h, "custom CSS", instr, true);
      } else {
        await boostAuthor(instr);
      }
      setInstruction("");
      refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };
  const toggle = (b: Boost) => void boostSetEnabled(b.id, b.host, !b.enabled).then(refresh);
  const remove = (b: Boost) => void boostDelete(b.id, b.host).then(refresh);
  const startEdit = (b: Boost) => { setEditId(b.id); setEditCss(b.css ?? ""); };
  const saveEdit = async (b: Boost) => {
    setBusy(true);
    setError(null);
    try {
      await boostSave(b.id, b.host, b.name, editCss(), b.enabled);
      setEditId(null);
      refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  // One boost row — `showHost` labels which site it's on (the All-sites view).
  const Row = (p: { b: Boost; showHost?: boolean }) => (
    <div class="boost-row-wrap">
      <div class="boost-row">
        <button classList={{ "boost-toggle": true, on: p.b.enabled }} title={p.b.enabled ? "Enabled — click to disable" : "Disabled"} onClick={() => toggle(p.b)}>
          {p.b.enabled ? "●" : "○"}
        </button>
        <span class="boost-name" title={p.b.css}>
          {p.b.name || "boost"}{p.showHost ? <span class="boost-host-tag"> · {p.b.host}</span> : null}
        </span>
        <button class="boost-del" title="Edit CSS" onClick={() => (editId() === p.b.id ? setEditId(null) : startEdit(p.b))}>✎</button>
        <button class="boost-del" title="Delete boost" onClick={() => remove(p.b)}>✕</button>
      </div>
      <Show when={editId() === p.b.id}>
        <textarea class="boost-input" rows={4} value={editCss()} spellcheck={false} onInput={(e) => setEditCss(e.currentTarget.value)} />
        <div class="boost-edit-actions">
          <button class="boost-apply" disabled={busy()} onClick={() => void saveEdit(p.b)}>Save CSS</button>
          <button class="boost-del" onClick={() => setEditId(null)}>Cancel</button>
        </div>
      </Show>
    </div>
  );

  return (
    <div style={{ display: "contents" }}>
      <button classList={{ "icon-btn": true, active: open() }} title="Boosts — customize this site with AI or CSS" onClick={() => setOpen((v) => !v)}>✨</button>
      <Show when={open()}>
        <div class="shield-backdrop" onClick={() => setOpen(false)} />
        <div class="glass popover shields-pop footer-pop">
          <div class="shields-row">
            <span class="shields-label">Boosts</span>
            <button classList={{ "boost-mode-tab": true, on: allSites() }} title="Manage boosts on every site" onClick={() => setAllSites((v) => !v)}>
              {allSites() ? "This site" : "All sites"}
            </button>
          </div>

          <Show
            when={!allSites()}
            fallback={
              <Show when={allList().length > 0} fallback={<div class="boost-empty">No boosts saved yet.</div>}>
                <div class="ctx-label">{allList().length} boost{allList().length === 1 ? "" : "s"} across {new Set(allList().map((b) => b.host)).size} site{new Set(allList().map((b) => b.host)).size === 1 ? "" : "s"}</div>
                <For each={allList()}>{(b) => <Row b={b} showHost />}</For>
              </Show>
            }
          >
            <Show when={host()} fallback={<div class="boost-empty">Open a web page to boost it.</div>}>
              <div class="shields-row">
                <span class="shields-host" title={host()!}>{host()}</span>
                <div class="boost-mode">
                  <button classList={{ "boost-mode-tab": true, on: mode() === "ai" }} onClick={() => setMode("ai")}>AI</button>
                  <button classList={{ "boost-mode-tab": true, on: mode() === "css" }} onClick={() => setMode("css")}>CSS</button>
                </div>
              </div>
              <textarea
                class="boost-input"
                placeholder={mode() === "ai" ? "Describe a change — e.g. hide the cookie banner, dark mode, widen the article" : "Write CSS — e.g.  .cookie-banner { display: none !important; }"}
                rows={mode() === "css" ? 4 : 2}
                value={instruction()}
                disabled={busy()}
                spellcheck={false}
                onInput={(e) => setInstruction(e.currentTarget.value)}
                onKeyDown={(e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); void apply(); } }}
              />
              <button class="boost-apply" disabled={busy() || !instruction().trim()} onClick={() => void apply()}>
                {busy() ? "✨ Saving…" : mode() === "ai" ? "✨ Apply (the agent writes the CSS)" : "✨ Apply CSS"}
              </button>
              <Show when={error()}><div class="boost-error">{error()}</div></Show>

              <Show when={list().length > 0}>
                <div class="shields-sep" />
                <div class="ctx-label">Boosts on {host()}</div>
                <For each={list()}>{(b) => <Row b={b} />}</For>
                <div class="boost-note">Changes apply live; reload if a site re-renders over them.</div>
              </Show>
            </Show>
          </Show>
        </div>
      </Show>
    </div>
  );
};

export default Boosts;
