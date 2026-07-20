#!/usr/bin/env bash
# Build Flux on macOS and install BOTH:
#   • /Applications/Flux.app   — the double-clickable app (uses the Flux icon)
#   • ~/.cargo/bin/flux        — the `flux` command (on PATH), for terminal launches
#
# macOS uses the native WKWebView, so per-tab web browsing works here (unlike the
# Linux/WebKitGTK build). One honest caveat: Shields' network-level blocking +
# HTTPS-only + the download interceptor are no-ops on macOS (those native hooks
# exist only for Windows/WebView2 and Linux/WebKitGTK); cosmetic element-hiding
# still works.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

say() { printf '\033[1;35m==> %s\033[0m\n' "$*"; }
die() {
  printf '\033[1;31mflux: %s\033[0m\n' "$*" >&2
  exit 1
}

# ── Prerequisites ────────────────────────────────────────────────────────────
say "Checking prerequisites"
[ "$(uname -s)" = "Darwin" ] || die "this script is for macOS; use install-linux.sh / install-windows.ps1 elsewhere."

# Apple's C toolchain / linker (Tauri's Rust deps need it).
if ! xcode-select -p >/dev/null 2>&1; then
  die "Xcode Command Line Tools missing. Install them, then re-run:\n    xcode-select --install"
fi

command -v cargo >/dev/null 2>&1 || die "Rust (cargo) missing. Install it, then re-run:\n    curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh && source \$HOME/.cargo/env"
command -v npm >/dev/null 2>&1 || die "Node.js (npm) missing. Install it, then re-run:\n    brew install node   # or from nodejs.org"

# Rust must be ≥ 1.80 (workspace MSRV).
RUST_VER="$(cargo --version | awk '{print $2}')"
awk -v v="$RUST_VER" 'BEGIN{split(v,a,".");exit !(a[1]>1||(a[1]==1&&a[2]>=80))}' \
  || die "Rust $RUST_VER is too old — Flux needs ≥ 1.80. Update:  rustup update"

# ── Build (app bundle + CLI in one shot) ─────────────────────────────────────
if [ ! -d node_modules ]; then
  say "Installing JS dependencies (npm ci)"
  npm ci
fi

say "Building Flux.app + the flux binary (release, LTO — takes a few minutes)"
# `npm run build` == `tauri build`: it runs the frontend build itself (embeds it)
# and produces BOTH target/release/flux (the CLI, custom-protocol on) and the
# macOS bundle under target/release/bundle/macos/Flux.app.
npm run build

# ── Install the CLI ──────────────────────────────────────────────────────────
DEST="${CARGO_HOME:-$HOME/.cargo}/bin"
mkdir -p "$DEST"
install -m 755 target/release/flux "$DEST/flux"
say "Installed CLI: $DEST/flux"

# ── Install the app bundle ───────────────────────────────────────────────────
APP_SRC="target/release/bundle/macos/Flux.app"
if [ -d "$APP_SRC" ]; then
  rm -rf "/Applications/Flux.app"
  cp -R "$APP_SRC" "/Applications/Flux.app"
  # Local unsigned build: clear the quarantine flag so Gatekeeper won't block it.
  xattr -dr com.apple.quarantine "/Applications/Flux.app" 2>/dev/null || true
  say "Installed app: /Applications/Flux.app"
else
  echo "warn: $APP_SRC not found — the .app bundle didn't build; the CLI is still installed." >&2
fi

echo
if command -v flux >/dev/null 2>&1; then
  flux --version || true
  echo "Done — launch Flux.app from Applications, or run 'flux' from any directory (flux example.com · flux -t)."
else
  echo "Done. Flux.app is in /Applications. To use the 'flux' command, add ~/.cargo/bin to PATH:"
  echo "    echo 'export PATH=\"$DEST:\$PATH\"' >> ~/.zshrc && source ~/.zshrc"
fi
