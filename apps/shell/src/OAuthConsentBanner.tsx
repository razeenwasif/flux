/**
 * Sentinel OAuth consent review (ADR 0013, Pillar 1 M3). The domain is genuine
 * (accounts.google.com, github.com, …) — the risk is *what the app is asking
 * for*. A chrome-layer strip (un-spoofable) that decodes the requested scopes
 * into plain English, sensitive ones flagged, so you see the real reach before
 * you click Allow. Advisory: it informs, it doesn't block the grant.
 */
import { For, type Component } from "solid-js";

import type { OAuthConsent } from "./ipc";

const OAuthConsentBanner: Component<{
  consent: OAuthConsent;
  onDismiss: () => void;
}> = (props) => {
  return (
    <div class="sentinel-banner oauth" role="alert">
      <span class="sentinel-ico">🔑</span>
      <div class="sentinel-body">
        <div class="sentinel-title">
          <b>{props.consent.app}</b> is asking for access to your{" "}
          {props.consent.provider} account
        </div>
        <ul class="oauth-scopes">
          <For each={props.consent.scopes}>
            {(s) => (
              <li classList={{ sensitive: s.sensitive }}>
                {s.sensitive ? "⚠ " : "• "}
                {s.plain}
              </li>
            )}
          </For>
        </ul>
        <div class="sentinel-reasons">
          <span>Only continue if you trust this app with these permissions.</span>
        </div>
      </div>
      <div class="sentinel-actions">
        <button class="sentinel-dismiss" onClick={() => props.onDismiss()} aria-label="Dismiss">
          Got it
        </button>
      </div>
    </div>
  );
};

export default OAuthConsentBanner;
