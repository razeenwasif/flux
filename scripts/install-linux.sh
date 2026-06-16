#!/usr/bin/env bash
# Build Flux and install the `flux` command to ~/.cargo/bin (on PATH), so it's
# launchable from any directory. Builds a Linux/WebKitGTK binary — fine for the
# chrome/terminal/start page, but per-tab web pages need WebView2/WKWebView (see
# README's platform note); use scripts/install-windows.ps1 for real browsing.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

echo "==> Building frontend (embedded into the binary): apps/shell/dist"
npm run build --workspace apps/shell

echo "==> Building release binary (LTO — takes a few minutes)"
cargo build --release -p flux-core

DEST="${CARGO_HOME:-$HOME/.cargo}/bin"
mkdir -p "$DEST"
install -m755 target/release/flux "$DEST/flux"
echo "==> Installed: $DEST/flux"

if command -v flux >/dev/null 2>&1; then
  flux --version
  echo "Done — run 'flux' from any directory."
else
  echo "Done, but $DEST is not on your PATH. Add it:  export PATH=\"$DEST:\$PATH\""
fi
