#!/usr/bin/env bash
# Build Flux and install the `flux` command to ~/.cargo/bin (on PATH), so it's
# launchable from any directory. macOS uses the native WKWebView, so per-tab web
# browsing works here (unlike the Linux/WebKitGTK build). One honest caveat:
# Shields' network-level blocking + HTTPS-only + the download interceptor are
# no-ops on macOS (those native hooks exist only for Windows/WebView2 and
# Linux/WebKitGTK); cosmetic element-hiding still works.
#
# For a double-clickable app bundle instead of the CLI, run `npm run build`
# (= tauri build) → target/release/bundle/macos/Flux.app (+ a .dmg).
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

# ── Build ────────────────────────────────────────────────────────────────────
if [ ! -d node_modules ]; then
  say "Installing JS dependencies (npm ci)"
  npm ci
fi

say "Building frontend (embedded into the binary): apps/shell/dist"
npm run build --workspace apps/shell

say "Building release binary (LTO — takes a few minutes)"
# custom-protocol → serve the embedded frontend (without it the app loads the
# dev server URL and shows ERR_CONNECTION_REFUSED).
cargo build --release -p flux-core --features custom-protocol

# ── Install ──────────────────────────────────────────────────────────────────
DEST="${CARGO_HOME:-$HOME/.cargo}/bin"
mkdir -p "$DEST"
install -m 755 target/release/flux "$DEST/flux"
say "Installed: $DEST/flux"

if command -v flux >/dev/null 2>&1; then
  flux --version || true
  echo "Done — run 'flux' from any directory (flux example.com · flux -t)."
else
  echo "Done, but $DEST is not on your PATH. Add it to your shell profile:"
  echo "    echo 'export PATH=\"$DEST:\$PATH\"' >> ~/.zshrc && source ~/.zshrc"
fi
