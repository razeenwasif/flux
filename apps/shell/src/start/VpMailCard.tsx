/**
 * Velvet Paper's Mailbox card (design.ts): the newest few INBOX messages from
 * the same account the dock's mail pane uses (`mail_config` / `mail_fetch`).
 * Read-only — listing never sets flags. Fetched once per visit to the start
 * page; the dock pane is what polls. With no account it says so and offers the
 * pane's own setup.
 */
import { For, Match, Show, Switch, createSignal, onMount, type Component } from "solid-js";

import { mailConfig, mailFetch, type MailMsg } from "../ipc";
import { openTab, setDockOpen } from "../store";

const SHOWN = 4;

const ago = (ms: number): string => {
  if (!ms) return "";
  const mins = Math.round((Date.now() - ms) / 60000);
  if (mins < 1) return "now";
  if (mins < 60) return `${mins}m`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h`;
  const days = Math.round(hrs / 24);
  return days < 7
    ? `${days}d`
    : new Date(ms).toLocaleDateString(undefined, { day: "numeric", month: "short" });
};

/** `"Ada Lovelace" <ada@example.com>` → `Ada Lovelace`; a bare address stays. */
const senderName = (from: string): string => {
  const m = /^\s*"?([^"<]*?)"?\s*<[^>]+>\s*$/.exec(from);
  return (m?.[1] || from).trim() || from;
};

const clean = (e: unknown) => String(e).replace(/^Error:\s*/, "");

const VpMailCard: Component<{
  /** Its place in the start page's card grid (CSS `order`). */
  order: number;
}> = (props) => {
  const [configured, setConfigured] = createSignal<boolean | null>(null); // null = still loading
  const [msgs, setMsgs] = createSignal<MailMsg[]>([]);
  const [err, setErr] = createSignal("");

  onMount(() => {
    void mailConfig()
      .then((c) => {
        setConfigured(c != null);
        if (c)
          void mailFetch(SHOWN + 2)
            .then(setMsgs)
            .catch((e) => setErr(clean(e)));
      })
      .catch((e) => {
        setConfigured(false);
        setErr(clean(e));
      });
  });

  const unread = () => msgs().filter((m) => m.unread).length;
  /** Open the real client on exactly this message (as the mail pane does). */
  const open = (m: MailMsg) => {
    if (!m.message_id) return;
    void openTab(
      "browser",
      `https://mail.google.com/mail/u/0/#search/rfc822msgid:${encodeURIComponent(m.message_id)}`,
    );
  };

  return (
    <section
      class="glass start-card vp-mail-card"
      data-legend={unread() > 0 ? `Mailbox · ${unread()} unread` : "Mailbox"}
      data-row="lead"
      style={{ order: props.order }}
    >
      <Switch>
        <Match when={configured() === null}>
          <div class="start-empty">Checking your mail…</div>
        </Match>
        <Match when={configured() === false}>
          <div class="start-empty">Connect a mailbox and your newest messages show here.</div>
        </Match>
        <Match when={err()}>
          <div class="start-empty">{err()}</div>
        </Match>
        <Match when={msgs().length === 0}>
          <div class="start-empty">Your inbox is empty.</div>
        </Match>
        <Match when={true}>
          <div class="vp-mail-list">
            <For each={msgs().slice(0, SHOWN)}>
              {(m) => (
                <button
                  class="vp-mail-row"
                  classList={{ unread: m.unread }}
                  title={`${m.from}\n${m.subject}`}
                  onClick={() => open(m)}
                >
                  <span class="vp-mail-chip" aria-hidden="true">
                    {senderName(m.from).slice(0, 1).toUpperCase()}
                  </span>
                  <span class="vp-mail-text">
                    <span class="vp-mail-top">
                      <span class="vp-mail-from">{senderName(m.from)}</span>
                      <span class="vp-mail-time">{ago(m.date_ms)}</span>
                    </span>
                    <span class="vp-mail-subject">{m.subject || "(no subject)"}</span>
                  </span>
                  <Show when={m.unread}>
                    <span class="vp-mail-dot" role="img" aria-label="Unread" />
                  </Show>
                </button>
              )}
            </For>
          </div>
        </Match>
      </Switch>
      <button class="vp-pill vp-mail-open" onClick={() => setDockOpen(true)}>
        {configured() === false ? "Set up mail" : "Open mail"}
      </button>
    </section>
  );
};

export default VpMailCard;
