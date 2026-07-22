/**
 * Agent action audit log (ADR 0013, Pillar 0) — `flux://sentinel`.
 *
 * The log has been written and sealed since M1; this is the surface that lets
 * you read it. It answers one question honestly: *what has the agent actually
 * done on my behalf?* Every entry is an action that reached execution — what it
 * was, when, which tab, whether the destructive deny-list matched, and whether
 * it carried explicit user confirmation.
 *
 * An unconfirmed row is the one thing here that should never appear: the read≠act
 * gate is meant to make it impossible, so the page calls it out loudly rather
 * than rendering it as just another line.
 */
import { For, Show, createResource, createSignal, type Component } from "solid-js";

import { sentinelAuditList, sentinelAuditClear, type AuditEntry } from "./ipc";

const when = (ms: number): string => {
  const d = new Date(ms);
  const today = new Date().toDateString() === d.toDateString();
  return today
    ? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : d.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
};

const SentinelAuditPage: Component = () => {
  const [entries, { refetch }] = createResource<AuditEntry[]>(() =>
    sentinelAuditList().catch(() => []),
  );
  const [confirming, setConfirming] = createSignal(false);

  const clearAll = async () => {
    await sentinelAuditClear().catch(() => {});
    setConfirming(false);
    void refetch();
  };

  const unconfirmed = () => (entries() ?? []).filter((e) => !e.confirmed).length;

  return (
    <div class="page audit-page">
      <header class="audit-head">
        <div>
          <h1>Agent activity</h1>
          <p class="audit-sub">
            Every action the Flux agent ran on your behalf. Stored on this device only, sealed at
            rest with the same key as your browsing history.
          </p>
        </div>
        <div class="audit-actions">
          <button class="audit-btn" onClick={() => void refetch()}>
            Refresh
          </button>
          <Show
            when={confirming()}
            fallback={
              <button
                class="audit-btn"
                disabled={(entries() ?? []).length === 0}
                onClick={() => setConfirming(true)}
              >
                Clear log
              </button>
            }
          >
            <button class="audit-btn danger" onClick={() => void clearAll()}>
              Really clear
            </button>
            <button class="audit-btn" onClick={() => setConfirming(false)}>
              Cancel
            </button>
          </Show>
        </div>
      </header>

      <Show when={unconfirmed() > 0}>
        <div class="audit-alarm">
          ⚠ {unconfirmed()} action{unconfirmed() === 1 ? "" : "s"} ran without explicit confirmation.
          That should not be possible — please report this.
        </div>
      </Show>

      <Show
        when={(entries() ?? []).length > 0}
        fallback={
          <div class="audit-empty">
            <p>The agent hasn't run any actions yet.</p>
            <p class="audit-sub">
              Actions appear here when you ask the agent to do something on a page — click a link,
              extract a table, run a task step.
            </p>
          </div>
        }
      >
        <ul class="audit-list">
          <For each={entries()}>
            {(e) => (
              <li classList={{ destructive: !!e.destructive, unconfirmed: !e.confirmed }}>
                <span class="audit-when">{when(e.ms)}</span>
                <span class="audit-what">{e.action}</span>
                <span class="audit-meta">
                  tab {e.tab}
                  <Show when={e.destructive}>
                    {(term) => <b class="audit-flag">flagged: {term()}</b>}
                  </Show>
                  <Show when={!e.confirmed}>
                    <b class="audit-flag">unconfirmed</b>
                  </Show>
                </span>
              </li>
            )}
          </For>
        </ul>
      </Show>
    </div>
  );
};

export default SentinelAuditPage;
