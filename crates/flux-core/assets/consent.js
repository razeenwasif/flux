// Consent-banner "real reject" clicker (ADR 0013, Pillar 3 M5).
//
// The dark pattern: "Accept all" is one tap, refusing is buried behind
// "Manage preferences" and a dozen toggles. This clicks the genuine reject
// control for you.
//
// SECURITY: the phrase list is supplied by Rust (`REJECT_TERMS`) — the model
// never chooses what gets clicked. That keeps this on the right side of the
// read != act firewall: the agent may *explain* a banner, but only a fixed,
// audited vocabulary can drive a click, and only when the user asks.
(() => {
  const TERMS = __FLUX_REJECT_TERMS__;

  // The accessible name a human would read off the control.
  const nameOf = (el) =>
    (
      el.getAttribute("aria-label") ||
      el.innerText ||
      el.value ||
      el.getAttribute("title") ||
      ""
    )
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();

  const clickable = Array.from(
    document.querySelectorAll(
      'button, [role="button"], a, input[type="button"], input[type="submit"]',
    ),
  ).filter((el) => {
    // Visible only — consent banners keep hidden duplicates around.
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  });

  // The generic matches (a bare "reject"/"decline", or a label that merely
  // *contains* a term) are trusted only inside a consent banner, so a meeting
  // invite's "Decline" or a headline mentioning a term elsewhere on the page is
  // never what gets clicked. A dialog counts only when it talks about cookies.
  const BANNER =
    '[id*="consent" i],[class*="consent" i],[id*="cookie" i],[class*="cookie" i],' +
    '[id*="gdpr" i],[class*="gdpr" i],[id*="cmp" i],[class*="cmp" i]';
  const DIALOG = '[role="dialog"],[role="alertdialog"],[aria-modal="true"]';
  const inBanner = (el) => {
    if (el.closest(BANNER)) return true;
    const d = el.closest(DIALOG);
    return !!d && /cookie|consent|gdpr|privacy/i.test(d.innerText || "");
  };
  const scoped = clickable.filter(inBanner);

  // Prefer an exact phrase match ("reject all") over a loose containment, so a
  // control merely mentioning a term doesn't win over the real button. A
  // multi-word phrase is specific enough to match anywhere; a bare word only in
  // the banner. When nothing qualifies, click nothing.
  let hit = null;
  for (const term of TERMS) {
    const pool = term.includes(" ") ? clickable : scoped;
    hit = pool.find((el) => nameOf(el) === term);
    if (hit) break;
  }
  if (!hit) {
    for (const term of TERMS) {
      hit = scoped.find((el) => {
        const n = nameOf(el);
        return n.length <= term.length + 24 && n.includes(term);
      });
      if (hit) break;
    }
  }
  if (hit) hit.click();
})();
