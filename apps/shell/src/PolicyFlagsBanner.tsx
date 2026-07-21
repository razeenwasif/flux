/**
 * Privacy-policy / ToS red-flags (ADR 0013, Pillar 3 M5). Nobody reads these
 * documents; the local model reads one and surfaces the few clauses you'd have
 * wanted to know — data sold on, tracking, retention, content licences, forced
 * arbitration.
 *
 * On demand by design: reading a long document is the one explainer worth an
 * explicit click, so nothing runs until you ask. Descriptive only — it reports
 * what the document says, it never advises or acts on it.
 */
import { For, Show, createSignal, type Component } from "solid-js";

import { sentinelPolicyFlags, type PolicyFlag } from "./ipc";

const PolicyFlagsBanner: Component<{ onDismiss: () => void }> = (props) => {
  const [flags, setFlags] = createSignal<PolicyFlag[] | null>(null);
  const [busy, setBusy] = createSignal(false);
  const [empty, setEmpty] = createSignal(false);

  const read = async () => {
    setBusy(true);
    try {
      const f = await sentinelPolicyFlags();
      setFlags(f);
      setEmpty(f.length === 0);
    } catch {
      setEmpty(true); // no model / no text — say nothing rather than guess
    } finally {
      setBusy(false);
    }
  };

  return (
    <div class="sentinel-banner policy" role="status">
      <span class="sentinel-ico">📄</span>
      <div class="sentinel-body">
        <div class="sentinel-title">
          This looks like a policy or terms page — want the clauses that matter?
        </div>
        <Show when={flags()}>
          <ul class="policy-flags">
            <For each={flags()}>
              {(f) => (
                <li>
                  <b>{f.clause}</b>
                  <span> — {f.why}</span>
                </li>
              )}
            </For>
          </ul>
        </Show>
        <Show when={empty()}>
          <div class="sentinel-reasons">
            <span>Nothing notable found (or no local model running).</span>
          </div>
        </Show>
      </div>
      <div class="sentinel-actions">
        <Show when={!flags() && !empty()}>
          <button class="sentinel-leave" disabled={busy()} onClick={() => void read()}>
            {busy() ? "Reading…" : "Read it for me"}
          </button>
        </Show>
        <button class="sentinel-dismiss" onClick={() => props.onDismiss()}>
          Dismiss
        </button>
      </div>
    </div>
  );
};

export default PolicyFlagsBanner;
