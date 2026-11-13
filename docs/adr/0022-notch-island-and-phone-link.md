# 0022 — The notch island, and a phone link to Flux on the Mac

Status: accepted (first build, 2026-11-14)
Date: 2026-11-14
Relates to: [0021](0021-ios-first-mobile.md) (iOS-first mobile Flux, the tab
plugin, the debug drive), [0015](0015-theming.md) (Liquid Silk).

## Context

The iPhone Flux is built and tested on has a notch (iPhone 11 Pro Max,
`iPhone12,5`), not a Dynamic Island. We wanted the same idea for the browser:
a black shape that grows out of the notch, shows what's running, and opens
into a panel of shortcuts that makes Flux quick to drive with one thumb. The
designs (a canvas of the states and an interactive prototype) were agreed
first.

Three things decided how it's built:

- **iOS draws nothing over other apps.** The island exists inside Flux only.
  iOS's own Live Activities, the only thing that outlives the app, appear on a
  notch phone's Lock Screen, not around the notch.
- **The shell's webview is above the pages but didn't draw at the top.** Tabs
  are native WKWebViews under the shell (0021). The shell's strip behind the
  status bar showed a flat colour whatever the shell drew there: iOS 26's
  scroll edge effect on the shell's scroll view. It's turned off for the shell
  (`topEdgeEffect.isHidden`), which also lets the wallpaper run up behind the
  clock on Flux's own pages.
- **The calendar and mail are on the Mac.** You use Google Calendar and Gmail,
  which Flux on the Mac already reads (the secret ICS address, IMAP with an
  app password). Copying those secrets to the phone would mean two places to
  keep them. Fairy, too, runs on the Mac.

## Decision

**1. The island is the shell's, with three native helpers.** `NotchIsland.tsx`
draws it: black, so on an OLED screen it reads as the notch itself. Its
states:

- **idle:** the notch's own size;
- **compact:** a lip under the notch with the winning activity (`island.ts`):
  a confirmation, then Fairy working, then a meeting within 15 minutes, then
  something playing in a tab you've left, then new mail;
- **open:** a card of six pages (Quick, Tabs, Calendar, Mail, Playing, Fairy),
  swiped sideways with the neighbours dimmed and shrunk.

Gestures:

- tap the lip to open its page;
- pull down from the notch to open;
- hold the lip for its own action (play/pause, join, inbox);
- hold the bare notch to ask Fairy;
- swipe up, tap outside, or tap the handle to close.

The plugin adds:

- `notch_geometry`: the notch's size by model. iOS has no API for it. The X
  family is 210 × 32 pt; other models return nothing and the island stays off
  until they're measured.
- `set_island`: where the island is, so touches there reach the shell instead
  of the page. While it's open the shell takes every touch, and the status bar
  fades out so the title and page dots can use the notch's ears.
- `haptic`, `eval_tab` (a script in a tab, in Flux's own content world, for
  media controls, the reader and the page's text), and `find_in_page` (iOS's
  find bar).

A `MediaWatch` user script posts a tab's media starting and stopping, with its
Media Session details, as a `media` event.

**2. A phone link, modelled on Fairy's.** `phonelink.rs` on the Mac is an HTTPS
server that:

- listens only on the Mac's Tailscale address, port 47617, and drops any
  connection from outside 100.64.0.0/10;
- doesn't listen at all while Tailscale is off or the setting is;
- uses a self-signed P-256 certificate made with macOS's `openssl`, with its
  key in the Keychain.

Pairing:

- Settings › Phone link › Copy pairing link makes a one-time
  `flux-browser://pair?host&port&code&pin` link (five minutes, five tries).
- The link reaches the phone by Universal Clipboard (Paste in the island) or by
  opening it on the phone (AirDrop, Messages).
- The phone trades the code for a key. The Mac keeps only the key's hash; the
  phone keeps the key in its Keychain (this device only).
- `MacLink.swift` makes every request itself, trusting only the certificate
  whose SHA-256 came in the link, so the key never reaches the shell's page.

Routes:

- `POST /v1/pair`;
- `GET /v1/glance`: this week's events, in the phone's time zone; the inbox's
  unread count and newest ten envelopes, each with a Gmail link; whether Fairy
  is installed;
- `POST /v1/fairy`: a question with the page as material. No tools, not read
  aloud; a private or Tor tab's page is never sent.

A phone can read but never change anything on the Mac. Mail stays envelope-only
and nothing is marked read, as in the mail pane.

**3. Meet links.** Google's ICS gives a Meet call as `X-GOOGLE-CONFERENCE`. The
calendar parser now shows it as the location when an event has no place of its
own, and the island offers Join for any link there.

## Consequences

- The island needs a measured notch per model: notch iPhones other than the X
  family get no island until they're added to `Notch.size`.
- Calendar, Mail and Fairy need the Mac on, Flux open, and Tailscale on both
  devices. Offline, the island keeps the last glance and says it can't reach
  the Mac.
- Downloads aren't in iOS Flux yet, so the designs' download lip has no source.
  It waits for `WKDownload` support.
- A new certificate (a new Tailscale name, or one near its 800-day end) unpairs
  every phone, since the certificate is what they trust.
