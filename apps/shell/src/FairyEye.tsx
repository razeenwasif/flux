/**
 * Fairy's eye, drawn after her own icon (Lyra's tray and app icons): a ring
 * broken in four, around an eye with an iris ring and a pupil catching the
 * light. Takes the text colour, so it sits in a chip or a label in any theme.
 */
import type { Component } from "solid-js";

const FairyEye: Component<{ size?: number }> = (p) => (
  <svg class="fairy-eye" viewBox="0 0 24 24" width={p.size ?? 14} height={p.size ?? 14} aria-hidden="true">
    <mask id="flux-fairy-eye">
      <rect width="24" height="24" fill="#fff" />
      <circle cx="12" cy="12.4" r="4.5" fill="#000" />
      <circle cx="12" cy="12.4" r="3.1" fill="#fff" />
      <circle cx="13.3" cy="11.2" r="1.1" fill="#000" />
    </mask>
    <circle
      cx="12"
      cy="12"
      r="10.4"
      fill="none"
      stroke="currentColor"
      stroke-width="1.7"
      stroke-linecap="round"
      stroke-dasharray="11.6 4.74"
      transform="rotate(-34 12 12)"
    />
    <circle cx="12" cy="12" r="7" fill="currentColor" mask="url(#flux-fairy-eye)" />
  </svg>
);

export default FairyEye;
