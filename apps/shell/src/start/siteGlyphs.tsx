/**
 * Liquid Silk's home shortcuts as white line drawings (StartPage's pills): one
 * drawn mark per site you keep there, in the stroke style of Flux's own icons
 * (Icon.tsx), so the row reads as one set instead of a strip of coloured
 * favicons. A site without a drawing gets its initial, drawn the same way.
 *
 * Marks are drawn on a 24 grid with round 1.7 strokes; `fill` paths are solid.
 * They're Flux's own drawings that suggest each site, not its logo files.
 */
import { For, Show, type Component } from "solid-js";

type Glyph = { d?: string[]; fill?: string[]; c?: [number, number, number][] };

const GLYPHS: { match: (host: string) => boolean; name: string; art: Glyph }[] = [
  {
    name: "Proton Mail",
    match: (h) => h === "mail.proton.me",
    art: { d: ["M3.5 6.5h17v11h-17z", "m3.5 7 8.5 6.5L20.5 7"] },
  },
  {
    name: "Proton Drive",
    match: (h) => h === "drive.proton.me",
    art: {
      d: [
        "M3.5 7.5A1.5 1.5 0 0 1 5 6h4.5l2 2H19a1.5 1.5 0 0 1 1.5 1.5v8A1.5 1.5 0 0 1 19 19H5a1.5 1.5 0 0 1-1.5-1.5Z",
        "M3.5 11h17",
      ],
    },
  },
  {
    name: "Proton Calendar",
    match: (h) => h === "calendar.proton.me",
    art: {
      d: ["M4 6h16v14H4z", "M4 10h16", "M8.5 3.5v4M15.5 3.5v4"],
      fill: [
        "M7.4 12.6h2.2v2.2H7.4z",
        "M10.9 12.6h2.2v2.2h-2.2z",
        "M14.4 12.6h2.2v2.2h-2.2z",
        "M7.4 16h2.2v2.2H7.4z",
      ],
    },
  },
  {
    name: "daily.dev",
    match: (h) => h === "daily.dev" || h.endsWith(".daily.dev"),
    art: { d: ["M10 5 3 12l7 7", "m8.5 12 3.5-3.5", "M13.5 5 21 12l-7.5 7", "m12 15.5 3.5-3.5"] },
  },
  {
    name: "Microsoft 365",
    match: (h) => h.endsWith("office.com") || h.endsWith("microsoft365.com"),
    art: { d: ["M4 4h7v7H4z", "M13 4h7v7h-7z", "M4 13h7v7H4z", "M13 13h7v7h-7z"] },
  },
  {
    name: "Google Drive",
    match: (h) => h === "drive.google.com",
    art: { d: ["M8.2 4h7.6l6 10.4h-7.6Z", "M8.2 4 2.2 14.4 6 21l6-10.4", "M6 21h12l3.8-6.6H10"] },
  },
  {
    name: "Google Workspace",
    match: (h) => h === "workspace.google.com",
    art: { d: ["M19.6 9.5A8 8 0 1 0 20 12h-7.5"] },
  },
  {
    name: "myGov",
    match: (h) => h === "my.gov.au" || h.endsWith(".my.gov.au"),
    art: { d: ["M5 5.5 11.5 12 5 18.5", "M12.5 5.5 19 12l-6.5 6.5"] },
  },
  {
    name: "GitHub",
    match: (h) => h === "github.com" || h.endsWith(".github.com"),
    art: {
      d: [
        "M6.2 9.8c0-1.3.4-2.4 1.2-3.3L7.1 3.7l2.6 1.4a8 8 0 0 1 4.6 0l2.6-1.4-.3 2.8c.8.9 1.2 2 1.2 3.3 0 3.4-2.3 5.2-5.8 5.2s-5.8-1.8-5.8-5.2Z",
        "M10 15c-.7.7-1 1.7-1 3.2V21",
        "M14 15c.7.7 1 1.7 1 3.2V21",
        "M9 18.6c-2.2.4-3.3-.6-4-2.1",
      ],
    },
  },
  {
    name: "Amazon",
    match: (h) => /(^|\.)amazon\.[a-z.]+$/.test(h),
    art: {
      d: ["M14.6 6.6v7.2", "M4.5 16.6c4.5 2.8 10.5 2.8 15 0", "m16.9 15.7 2.7.9-.5 2.8"],
      c: [[11.4, 10.2, 3.3]],
    },
  },
  {
    name: "YouTube",
    match: (h) => h === "youtube.com" || h.endsWith(".youtube.com") || h === "youtu.be",
    art: {
      d: [
        "M3.5 8.2c0-1.6 1.2-2.9 2.8-3 3.8-.3 7.6-.3 11.4 0 1.6.1 2.8 1.4 2.8 3v7.6c0 1.6-1.2 2.9-2.8 3-3.8.3-7.6.3-11.4 0-1.6-.1-2.8-1.4-2.8-3Z",
      ],
      fill: ["M10 8.8v6.4l5.4-3.2Z"],
    },
  },
  {
    name: "Patreon",
    match: (h) => h === "patreon.com" || h.endsWith(".patreon.com"),
    art: { d: ["M5 4v16"], c: [[14.5, 9.5, 5.5]] },
  },
  {
    name: "eBay",
    match: (h) => /(^|\.)ebay\.[a-z.]+$/.test(h),
    art: { d: ["M5.5 12.5h12.8a6.4 6.4 0 1 0-1.9 4.6"] },
  },
  {
    name: "CodePen",
    match: (h) => h === "codepen.io" || h.endsWith(".codepen.io"),
    art: {
      d: [
        "M12 3.5 20.5 9v6L12 20.5 3.5 15V9Z",
        "M12 3.5V9M12 15v5.5",
        "m3.5 9 8.5 6 8.5-6",
        "m3.5 15 8.5-6 8.5 6",
      ],
    },
  },
  {
    name: "arXiv",
    match: (h) => h === "arxiv.org" || h.endsWith(".arxiv.org"),
    art: { d: ["M5.5 4c3.2 0 4.4 2.6 6.5 8s3.3 8 6.5 8", "M18.5 4 5.5 20"] },
  },
  {
    name: "LinkedIn",
    match: (h) => h === "linkedin.com" || h.endsWith(".linkedin.com"),
    art: {
      d: [
        "M6 4h12a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Z",
        "M8.5 11v5",
        "M12 16v-5M12 13.4c0-1.6 1-2.6 2.3-2.6s2.2 1 2.2 2.6V16",
      ],
      fill: ["M8.5 7.1a1 1 0 1 1 0 2 1 1 0 0 1 0-2Z"],
    },
  },
  {
    name: "Discord",
    match: (h) => h === "discord.com" || h.endsWith(".discord.com") || h === "discord.gg",
    art: {
      d: [
        "M6.8 7c1.6-.9 3.4-1.4 5.2-1.4s3.6.5 5.2 1.4c1.5 2.3 2.3 5 2.3 8.2-1.4 1.3-3 2.1-4.6 2.5L14 16",
        "M6.8 7C5.3 9.3 4.5 12 4.5 15.2c1.4 1.3 3 2.1 4.6 2.5L10 16",
        "M8.6 15.4c2.2 1 4.6 1 6.8 0",
      ],
      fill: [
        "M9.7 10.9a1.2 1.2 0 1 1 0 2.4 1.2 1.2 0 0 1 0-2.4Z",
        "M14.3 10.9a1.2 1.2 0 1 1 0 2.4 1.2 1.2 0 0 1 0-2.4Z",
      ],
    },
  },
  {
    name: "Spotify",
    match: (h) => h === "open.spotify.com" || h === "spotify.com" || h.endsWith(".spotify.com"),
    art: {
      d: ["M7.4 9.5c3.1-1 6.6-.8 9.3.8", "M8 12.6c2.6-.7 5.2-.5 7.5.8", "M8.7 15.5c1.9-.5 3.8-.3 5.4.6"],
      c: [[12, 12, 8.5]],
    },
  },
  {
    name: "Medium",
    match: (h) => h === "medium.com" || h.endsWith(".medium.com"),
    art: {
      c: [[7.5, 12, 4.8]],
      d: [
        "M15.6 7.3c1.2 0 2.1 2.1 2.1 4.7s-.9 4.7-2.1 4.7-2.1-2.1-2.1-4.7.9-4.7 2.1-4.7Z",
        "M20.6 7.8c.4 0 .7 1.9.7 4.2s-.3 4.2-.7 4.2-.7-1.9-.7-4.2.3-4.2.7-4.2Z",
      ],
    },
  },
];

const hostOf = (url: string): string => {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
};

/** The drawing for a site, and the name to show for it, if Flux has one. */
export const siteGlyph = (url: string): { name: string; art: Glyph } | null => {
  const host = hostOf(url);
  return GLYPHS.find((g) => g.match(host)) ?? null;
};

/** A site's mark in white: its drawing, or its initial when it has none. */
export const SiteGlyph: Component<{ url: string; letter: string }> = (props) => {
  const g = () => siteGlyph(props.url);
  return (
    <svg class="silk-glyph" viewBox="0 0 24 24" aria-hidden="true">
      <Show
        when={g()}
        fallback={
          <text x="12" y="16.6" text-anchor="middle" fill="currentColor" stroke="none">
            {props.letter}
          </text>
        }
      >
        {(gl) => (
          <>
            <For each={gl().art.d ?? []}>{(d) => <path d={d} />}</For>
            <For each={gl().art.c ?? []}>{([cx, cy, r]) => <circle cx={cx} cy={cy} r={r} />}</For>
            <For each={gl().art.fill ?? []}>{(d) => <path d={d} fill="currentColor" stroke="none" />}</For>
          </>
        )}
      </Show>
    </svg>
  );
};
