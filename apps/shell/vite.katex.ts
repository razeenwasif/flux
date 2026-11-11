import type { Plugin } from "vite";

/** KaTeX's stylesheet offers each face as woff2, woff and ttf, and the bundler
 *  copies all three into the app binary. WebKit and WebView2 take the woff2
 *  every time, so the other two were 876 KB never read. */
export const katexWoff2Only = (): Plugin => ({
  name: "flux-katex-woff2-only",
  enforce: "pre",
  transform(code, id) {
    if (!/[\\/]katex[\\/]dist[\\/]katex(\.min)?\.css$/.test(id)) return null;
    return code.replace(
      /,\s*url\([^)]+\.woff\)\s*format\("woff"\)\s*,\s*url\([^)]+\.ttf\)\s*format\("truetype"\)/g,
      "",
    );
  },
});
