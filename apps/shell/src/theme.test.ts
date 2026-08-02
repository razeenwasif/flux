/**
 * Stylesheet invariants that no type checker can see.
 *
 * Scrollbars in particular: since Chromium 121, setting `scrollbar-width` or
 * `scrollbar-color` to anything other than `auto` makes the engine **discard
 * every `::-webkit-scrollbar` rule for that element**. Flux ships on WebView2
 * (Chromium) *and* WebKitGTK, and WebKit has no such rule — so an element that
 * declares both gets a different scrollbar per platform, silently. That had
 * already happened to three toolbars here: they asked for `thin` *and* a hidden
 * bar, so Windows drew a scrollbar the design had removed while Linux hid it.
 *
 * These are cheap text assertions over the real stylesheet rather than a render
 * test, deliberately: headless Chromium uses overlay scrollbars with zero
 * layout width, so a browser harness reports 0px for a hardcoded 22px bar and
 * proves nothing about either engine Flux actually runs on.
 */
import { describe, expect, it } from "vitest";

// `?raw` rather than node:fs — the shell's tsconfig types are `vite/client`
// only, and the stylesheet is a build input here, not a file on disk to hunt
// for relative to the test.
import css from "./theme.css?raw";

/** Selectors carrying a `::-webkit-scrollbar*` rule of any kind. */
const webkitScrollbarSelectors = (): string[] => {
  const out = new Set<string>();
  for (const m of css.matchAll(/^([^\s@{][^{}\n]*?)::-webkit-scrollbar[\w-]*(?::\w+)?\s*(?:,|\{)/gm)) {
    out.add(m[1]!.trim());
  }
  return [...out];
};

/** The declaration block for a bare selector (first match). */
const ruleBody = (selector: string): string | null => {
  const i = css.indexOf(`\n${selector} {`);
  if (i < 0) return null;
  const start = css.indexOf("{", i);
  const end = css.indexOf("}", start);
  return end < 0 ? null : css.slice(start + 1, end);
};

describe("scrollbar styling", () => {
  it("never mixes scrollbar-width with ::-webkit-scrollbar on the same element", () => {
    // `*` is the global rule and has no base declaration block of its own.
    const offenders = webkitScrollbarSelectors()
      .filter((s) => s !== "*")
      .filter((s) => {
        const body = ruleBody(s);
        if (!body) return false;
        const m = body.match(/scrollbar-(?:width|color):\s*([^;]+);/);
        // `none` in both mechanisms is the one safe pairing: they agree, so
        // whichever the engine honours produces a hidden bar either way.
        return m != null && m[1]!.trim() !== "none" && m[1]!.trim() !== "auto";
      });
    expect(offenders).toEqual([]);
  });

  it("hides a scrollbar in both mechanisms or neither", () => {
    // Half a hide is worse than none: WebKit honours the pseudo-element and
    // Chromium honours `scrollbar-width`, so declaring one gives you a bar on
    // exactly one of the two platforms Flux ships to.
    const hidden = [...css.matchAll(/([.\w-]+)::-webkit-scrollbar\s*\{\s*display:\s*none;/g)].map(
      (m) => m[1]!,
    );
    expect(hidden.length).toBeGreaterThan(0);
    for (const sel of hidden) {
      expect(ruleBody(sel) ?? "", `${sel} hides via ::-webkit-scrollbar`).toContain("scrollbar-width: none");
    }
  });

  it("styles scrollbars once, globally, instead of per component", () => {
    // Five components had each hand-rolled the same thumb at slightly different
    // widths. One rule means one look; a component-level override should be a
    // deliberate exception, not the way you get a normal scrollbar.
    expect(css).toContain("*::-webkit-scrollbar-thumb {");
    const componentThumbs = [
      ...css.matchAll(/^([^\s@{*][^{}\n]*?)::-webkit-scrollbar-thumb\s*(?:,|\{)/gm),
    ].map((m) => m[1]!.trim());
    expect(componentThumbs).toEqual([]);
  });

  it("defines the scrollbar tokens the global rule references", () => {
    for (const token of [
      "--flux-scroll-w",
      "--flux-scroll-thumb",
      "--flux-scroll-thumb-hover",
      "--flux-scroll-thumb-active",
    ]) {
      expect(css, `${token} is declared`).toContain(`${token}:`);
    }
  });
});
