/**
 * Mail — a read-only glance at the inbox, in Flux's own UI.
 *
 * Deliberately **not** the Gmail API: that needs an OAuth client, a Google Cloud
 * project, and consent for a *restricted* scope, which for a personal tool is a
 * great deal of ceremony. IMAP with an app password is a keychain entry and a
 * socket, and this pane only ever reads — no flags are set, so glancing here
 * can't mark anything seen in your real client.
 *
 * Scope on purpose: see what has arrived and skim it. Anything needing a reply is
 * one click away in Gmail, via the message-id search that opens exactly that
 * message rather than a guess based on subject.
 */
import { For, Show, createSignal, onMount, type Component } from "solid-js";

import { mailConfig, mailConnect, mailDisconnect, mailFetch, type MailMsg } from "./ipc";
import { openTab } from "./store";
import { visibleInterval } from "./poll";

/** Gmail's own app-password host, which is what this is overwhelmingly for. */
const DEFAULT_HOST = "imap.gmail.com";
const DEFAULT_PORT = 993;

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

const MailPane: Component = () => {
  const [configured, setConfigured] = createSignal<boolean | null>(null); // null = still loading
  const [msgs, setMsgs] = createSignal<MailMsg[]>([]);
  const [err, setErr] = createSignal("");
  const [busy, setBusy] = createSignal(false);

  // Setup form
  const [host, setHost] = createSignal(DEFAULT_HOST);
  const [port, setPort] = createSignal(String(DEFAULT_PORT));
  const [email, setEmail] = createSignal("");
  const [pass, setPass] = createSignal("");

  const refresh = () => {
    setBusy(true);
    void mailFetch(20)
      .then((m) => {
        setMsgs(m);
        setErr("");
      })
      // Say why. An empty list and a failed fetch look identical otherwise, and
      // this pane is empty most of the time by design.
      .catch((e) => setErr(String(e).replace(/^Error:\s*/, "")))
      .finally(() => setBusy(false));
  };

  onMount(() => {
    void mailConfig().then((c) => {
      setConfigured(c != null);
      if (c) {
        setEmail(c.email);
        refresh();
        // Polls only while the pane is on screen.
        visibleInterval(refresh, 120_000);
      }
    });
  });

  const connect = (e: Event) => {
    e.preventDefault();
    setBusy(true);
    setErr("");
    void mailConnect(host().trim(), Number(port()) || DEFAULT_PORT, email().trim(), pass())
      .then(() => {
        setPass(""); // it lives in the keychain now; don't keep it in a signal
        setConfigured(true);
        refresh();
        visibleInterval(refresh, 120_000);
      })
      .catch((e) => setErr(String(e).replace(/^Error:\s*/, "")))
      .finally(() => setBusy(false));
  };

  const forget = () => {
    void mailDisconnect().then(() => {
      setConfigured(false);
      setMsgs([]);
      setErr("");
    });
  };

  /** Open the real client on exactly this message. */
  const open = (m: MailMsg) => {
    if (!m.message_id) return;
    void openTab(
      "browser",
      `https://mail.google.com/mail/u/0/#search/rfc822msgid:${encodeURIComponent(m.message_id)}`,
    );
  };

  const unread = () => msgs().filter((m) => m.unread).length;

  return (
    <div class="mail-pane">
      <div class="mail-head">
        <span class="mail-title">✉ Mail</span>
        <Show when={unread() > 0}>
          <span class="mail-count">{unread()}</span>
        </Show>
        <span style={{ flex: 1 }} />
        <Show when={configured()}>
          <button class="mail-btn" title="Refresh" disabled={busy()} onClick={refresh}>
            ↻
          </button>
          <button class="mail-btn" title="Forget this account" onClick={forget}>
            ✕
          </button>
        </Show>
      </div>

      <Show when={err()}>
        <p class="mail-err">{err()}</p>
      </Show>

      <Show when={configured() === false}>
        <form class="mail-setup" onSubmit={connect}>
          <p class="mail-dim">
            Read-only, over IMAP. Use an <strong>app password</strong>, not your account password — Gmail
            requires 2-factor authentication to issue one. It's kept in the OS keychain.
          </p>
          <input
            value={email()}
            placeholder="you@gmail.com"
            onInput={(e) => setEmail(e.currentTarget.value)}
          />
          <input
            type="password"
            value={pass()}
            placeholder="app password"
            onInput={(e) => setPass(e.currentTarget.value)}
          />
          <div class="mail-setup-row">
            <input value={host()} onInput={(e) => setHost(e.currentTarget.value)} />
            <input class="mail-port" value={port()} onInput={(e) => setPort(e.currentTarget.value)} />
          </div>
          <button class="mail-btn wide" type="submit" disabled={busy()}>
            {busy() ? "Checking…" : "Connect"}
          </button>
        </form>
      </Show>

      <Show when={configured()}>
        <div class="mail-list">
          <For
            each={msgs()}
            fallback={<div class="mail-dim">{busy() ? "Checking…" : "Inbox is empty."}</div>}
          >
            {(m) => (
              <button
                classList={{ "mail-msg": true, unread: m.unread }}
                title={m.message_id ? "Open in Gmail" : m.subject}
                onClick={() => open(m)}
              >
                <span class="mail-msg-top">
                  <span class="mail-from">{m.from}</span>
                  <span class="mail-when">{ago(m.date_ms)}</span>
                </span>
                <span class="mail-subject">{m.subject}</span>
              </button>
            )}
          </For>
        </div>
      </Show>
    </div>
  );
};

export default MailPane;
