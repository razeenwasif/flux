/**
 * Explaining a pane that can't render its app (#180).
 *
 * A site that refuses framing produces the worst possible failure: the browser
 * fires `load` as normal and leaves a blank rectangle, with the only diagnostic
 * in a console the user never opens. So the pane asks first — `frame_policy`
 * reads the site's `X-Frame-Options` / `frame-ancestors` over HEAD — and shows
 * this instead of an empty window.
 *
 * The tempting frontend shortcut is worth recording as a dead end: a blocked
 * frame supposedly stays on the initial `about:blank`, which is same-origin and
 * therefore readable, so a `contentWindow.location.href` that *doesn't* throw
 * would mean "refused". Measured against Chromium, it isn't true — a frame
 * refused by `X-Frame-Options` reports as cross-origin exactly like a loaded
 * one, and the check called a plainly-blocked site "loaded". Asking the server
 * is deterministic; inferring from the DOM is not.
 */

/**
 * What to tell the user, given the host and the header that refused.
 *
 * Names the header, because that is the thing to change, and points at the
 * surface that does work — a dead end with no way forward is only marginally
 * better than the blank rectangle it replaced.
 */
export function blockedMessage(host: string, reason: string): string {
  const because = reason ? ` (${reason})` : "";
  return `${host} refuses to be embedded${because}, so it can't render in a floating pane. It works in the side panel, which is a real browser view rather than a frame. If it's your own site, allowing framing in its host config lets it float here.`;
}
