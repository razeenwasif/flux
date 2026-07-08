# Device audit — runtime verification checklist

Flux's build embeds the frontend and links native webviews (WebView2 on Windows,
WebKitGTK on Linux). A lot of features are **compile-verified** (they build, unit
tests pass, the IPC surface is guarded — see `crates/flux-core/tests/*.rs`) but
were never actually driven on a device. The July 2026 IPC audit proved why that
matters: **seven shipped features had never run at all** (silent `plugin:fluxtab`
404s). Static guards now stop that class of wiring bug, but only a human clicking
through can confirm behavior.

This is that pass. Work top-down; the first section is highest priority (those
flows are running for the **first time ever**). Record `PASS` / `FAIL` + a note
inline, and file any `FAIL` as a `BACKLOG.md` entry (or GitHub issue) referencing
the item.

**Build fresh first** (stale embedded frontend is the #1 false failure):
```
scripts\install-windows.ps1          # Windows: rebuild frontend + binary
scripts\install-windows.ps1 -Voice   # …with the voice feature
```
For the WSL2 section, the Linux build; note WSL2 can't position per-tab webviews
(browsing is degraded there by design — [[wsl2-webkitgtk-multiwebview]]).

---

## 1. Fixed this session — first-ever runtime test (Windows)

These were 100% broken until `bf8a3a0`; the guards ensure they're now *wired*, but
behavior is unconfirmed. Test these first.

- [ ] **#61 · Sentinel sign-up chip** — open any throwaway sign-up form.
  **Expect:** a `✦ Use a strong password` chip under the password field; clicking
  fills password + confirm and shows `Will be saved to your vault on sign-up`;
  after submitting, a chrome toast `🔑 Password for <host> saved`. **Result:** ___
- [ ] **#61 · Sentinel login fill** — open a login page for a site already in the
  vault. **Expect:** a `🔑 Fill · <user>` chip; clicking fills user + password.
  **Result:** ___
- [ ] **#61 · Credential picker** — a host with **2+** saved logins. **Expect:**
  the `🔑 Fill · user (+N)` chip expands to a username list; picking one fills that
  credential. **Result:** ___
- [ ] **#61 · Save-password prompt** — log in by **typing** a password Flux didn't
  fill (a site not in the vault). **Expect:** on submit, a `Save password for
  <host>?` bar above the page (Save / Not now / Never). Save → it appears in the
  vault; Never → no prompt on that host again. **Result:** ___
- [ ] **#48 · Panel unread badges** (`panel_badge`) — pin a web panel that shows a
  title unread count (Gmail/Discord/Proton). **Expect:** a red bubble on the rail
  icon matching the count. **Result:** ___
- [ ] **#67 · Macro click/type recording** (`macro_record_step`) — footer ⏺ →
  record → click + type on a page → stop → replay. **Expect:** the clicks/typing
  replay (not just navigations). **Result:** ___
- [ ] **#50 · Peek via right-click / Alt-click** (`peek_open`) — right-click a link
  → **Peek**, and Alt-click a link. **Expect:** a floating always-on-top peek
  window opens. **Result:** ___

## 2. Compile-verified, never runtime-tested (Windows)

- [ ] **#38 · Permission prompt** — visit a site that requests mic/camera/location
  with no remembered decision. **Expect:** a glass permission bar docks above the
  page (`site wants to use your microphone`), Allow/Block + Remember; the page
  shrinks (webview doesn't get hidden). Allow once, then reload → remembered =
  silent. **Result:** ___
- [ ] **#34 · Download controls** — start a large download. **Expect:** footer ⬇
  badge + live progress; **pause / resume / cancel** work; **open** and **show in
  folder** work after completion. **Result:** ___
- [ ] **#54 · Web capture** — address-row 📸 (or ⌘K "Capture page"). **Expect:** a
  PNG written to `app_data/screenshots` + a confirm toast. **Result:** ___
- [ ] **#50 · Peek controls + shields** — inside a peek: **⊕ Open as tab**
  (Ctrl/⌘+Enter), **📌 Pin**, **✕/Esc**; confirm a known ad/tracker is blocked
  inside the peek (shields apply). **Result:** ___
- [ ] **#61 · Import — Chrome** — Chrome → Settings → Passwords → Export (CSV) →
  vault Import pane → file path. **Expect:** `Imported N logins`; they fill on the
  right sites. **Result:** ___
- [ ] **#61 · Import — Bitwarden** — export unencrypted CSV **and** JSON from
  Bitwarden → import each. **Expect:** logins imported; an *encrypted* JSON export
  fails with a clear "re-export unencrypted" message. **Result:** ___
- [ ] **#58 · HTTPS-only + cookies** — toggle HTTPS-only (an `http://` site
  upgrades; per-site allow-HTTP recovers); clear-cookies for a site logs it out.
  **Result:** ___
- [ ] **#42 · Install as app** — ⌘K "Install this site as app". **Expect:** a
  standalone window; it persists at `flux://apps`; relaunch focuses it.
  **Result:** ___

## 3. Regression sanity (this session's IPC changes)

`bf8a3a0` moved `peek_open` to the app handler and `panel_badge` to the fluxtab
handler; `0d64826` removed the panel's `on_page_load` (dead emit). Confirm nothing
regressed:

- [ ] **Web panels still load** — pin a panel, switch tabs, reopen. **Expect:**
  loads + renders normally (the removed `panel-loaded` emit was unused).
  **Result:** ___
- [ ] **Peek from the internal link menu** (`peek_open` moved handlers) — on an
  internal page's link menu → Peek. **Expect:** opens. **Result:** ___
- [ ] **DOM-dependent features** (`dom_publish`, same handler block) — history
  records visited pages, ⌘K search finds open-tab content, clustering works.
  **Result:** ___

## 4. WSL2 / WebKitGTK (engine-level only)

Browsing is degraded in WSL2 (webviews don't position), so limit to what the
engine does regardless of layout.

- [ ] **#34 · Linux downloads** — trigger a download. **Expect:** the file lands in
  the OS Downloads dir with numbered de-dup (`file (1).zip`), live progress in the
  ⬇ popover, cancel works. **Result:** ___
- [ ] **#57/#91 · Linux content blocker** — load a tracker-heavy page. **Expect:**
  the WebKit content-blocker JSON blocks requests (shields count climbs / known
  trackers don't load). **Result:** ___
- [ ] **#20 · Single-instance WSL→Windows forward** — from a WSL shell run
  `flux <url>`. **Expect:** the URL opens as a **tab in the running Windows Flux**
  (not a second Linux window). **Result:** ___

---

## Known gaps (not bugs — don't file)

- **#38 Linux permission prompt** — the WebKitGTK `permission-request` signal is
  not wired; only WebView2 has the Flux-styled prompt. Linux falls back to engine
  default.
- **#34 pause/resume on Linux** — WebKitGTK has no pause API (cancel only).
- **#37 PiP / #54 capture on Linux** — WebView2-only paths today.
- **SPA logins that `preventDefault` + fetch** — the save-password prompt keys on a
  real `submit` event, so pure-XHR logins won't trigger it yet (#61 follow-up).
