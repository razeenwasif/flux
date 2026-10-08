/**
 * Dark-pattern / consent decoder (ADR 0013, Pillar 3 M5). The pattern: "Accept
 * all" is one tap, refusing is buried behind "Manage preferences" and a dozen
 * toggles. Flux explains what accepting enables and gives the refuse button
 * back — one tap, in chrome the page can't restyle.
 *
 * The click vocabulary lives in Rust, not in the model (read != act), and only
 * runs when you press the button here.
 */
import { Show, createSignal, type Component } from "solid-js";

import { sentinelRejectConsent, type Explainer } from "./ipc";

const ConsentBanner: Component<{
  consent: Explainer;
  tabId: number;
  /** Clear the banner of `tabId`: the tab it was acted on, which by the time a
   *  delayed dismiss fires need not be the active tab any more. */
  onDismiss: (tabId: number) => void;
}> = (props) => {
  // Keyed by tab: ContentArea's <Show> isn't keyed, so this one instance is
  // reused when you switch between two tabs that both carry a consent banner.
  const [sentFor, setSentFor] = createSignal<number | null>(null);
  const sent = () => sentFor() === props.tabId;
  const reject = () => {
    const tab = props.tabId;
    void sentinelRejectConsent(tab).catch(() => {});
    setSentFor(tab);
    // No success claim: the page's own banner going away is the real feedback.
    setTimeout(() => props.onDismiss(tab), 1200);
  };
  return (
    <div class="sentinel-banner consent" role="status">
      <span class="sentinel-ico">🍪</span>
      <div class="sentinel-body">
        <div class="sentinel-title">{props.consent.summary}</div>
        <Show when={props.consent.insight}>
          <div class="sentinel-reasons">
            <span>{props.consent.insight}</span>
          </div>
        </Show>
      </div>
      <div class="sentinel-actions">
        <button class="sentinel-leave" disabled={sent()} onClick={reject}>
          {sent() ? "Refusing…" : "Refuse non-essential"}
        </button>
        <button class="sentinel-dismiss" onClick={() => props.onDismiss(props.tabId)}>
          Dismiss
        </button>
      </div>
    </div>
  );
};

export default ConsentBanner;
