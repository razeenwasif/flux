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

  // Prefer an exact phrase match ("reject all") over a loose containment, so a
  // control merely mentioning a term doesn't win over the real button.
  let hit = null;
  for (const term of TERMS) {
    hit = clickable.find((el) => nameOf(el) === term);
    if (hit) break;
  }
  if (!hit) {
    for (const term of TERMS) {
      hit = clickable.find((el) => nameOf(el).includes(term));
      if (hit) break;
    }
  }
  if (hit) hit.click();
})();
