/**
 * Sensitive-site containerization offer (ADR 0013, Pillar 2 M4). Banking,
 * health, and government sessions carry the highest-value cookies on the web —
 * a tracker in another tab has no business sharing a jar with them. Flux already
 * has multi-account containers (#59, isolated cookie/storage jars); this offers
 * one at the moment it's worth having.
 *
 * Not a warning: nothing is wrong with the site. It's a one-tap privacy upgrade,
 * and waving it off is remembered per host so it never becomes a nag.
 */
import { type Component } from "solid-js";

import type { SensitiveSite } from "./ipc";
import { containers, createContainer, openTabInContainer } from "./store";

/** The container we route sensitive sessions into — reused across sites so the
 *  user ends up with one "Secure" jar, not one per bank. */
const SECURE = "Secure";

const SensitiveSiteBanner: Component<{
  site: SensitiveSite;
  url: string;
  onDismiss: () => void;
}> = (props) => {
  const isolate = async () => {
    const existing = containers().find((c) => c.name === SECURE);
    const id = existing ? existing.id : await createContainer(SECURE);
    if (id) await openTabInContainer(id, props.url);
    props.onDismiss();
  };
  return (
    <div class="sentinel-banner secure" role="status">
      <span class="sentinel-ico">🛡</span>
      <div class="sentinel-body">
        <div class="sentinel-title">
          This is {props.site.label} — open it in an isolated container?
        </div>
        <div class="sentinel-reasons">
          <span>
            A separate cookie jar, so trackers and other tabs can't reach this session.
          </span>
        </div>
      </div>
      <div class="sentinel-actions">
        <button class="sentinel-leave" onClick={() => void isolate()}>
          Open isolated
        </button>
        <button class="sentinel-dismiss" onClick={() => props.onDismiss()}>
          Not now
        </button>
      </div>
    </div>
  );
};

export default SensitiveSiteBanner;
