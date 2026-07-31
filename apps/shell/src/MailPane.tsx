/**
 * Mail — a read-only glance at the inbox, in Flux's own UI.
 *
 * Deliberately **not** the Gmail API: that needs an OAuth client, a Google Cloud
 * project, and consent for a *restricted* scope, which for a personal tool is a
 * great deal of ceremony (and, unverified, periodic re-consent). IMAP with an app
 * password is a keychain entry and a socket, and this pane only ever reads.
 *
 * Scope on purpose: see what's arrived and skim it. Anything needing a reply is a
 * click away in the real client.
 *
 * The IMAP backend lands next; until it does this pane says so rather than
 * pretending to be empty, since "no mail" and "not set up" look identical.
 */
import { type Component } from "solid-js";

const MailPane: Component = () => (
  <div class="mail-pane">
    <div class="mail-head">
      <span class="mail-title">✉ Mail</span>
    </div>
    <div class="mail-empty">
      <p>Not connected yet.</p>
      <p class="mail-dim">
        The IMAP backend is next. It'll take a host, an address and an app password (kept in the OS keychain),
        and show unread mail here.
      </p>
    </div>
  </div>
);

export default MailPane;
