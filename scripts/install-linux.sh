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
# custom-protocol → serve the embedded frontend (without it the app loads the
# dev server URL and shows ERR_CONNECTION_REFUSED).
cargo build --release -p flux-core --features custom-protocol

DEST="${CARGO_HOME:-$HOME/.cargo}/bin"
mkdir -p "$DEST"
# Where cargo put it: target/ unless CARGO_TARGET_DIR or a cargo config's
# build.target-dir points elsewhere.
TARGET_DIR="$(cargo metadata --format-version 1 --no-deps 2>/dev/null |
  sed -n 's/.*"target_directory":"\([^"]*\)".*/\1/p')"
[ -n "$TARGET_DIR" ] || TARGET_DIR="target"
install -m755 "$TARGET_DIR/release/flux" "$DEST/flux"
echo "==> Installed: $DEST/flux"

# A launcher entry and icon (BACKLOG #26), so Flux is in the app menu and the
# dock shows its icon rather than a generic one. Per user, under XDG_DATA_HOME;
# it runs the `flux` just installed, so a rebuild needs no new entry.
DATA="${XDG_DATA_HOME:-$HOME/.local/share}"
ICONS="crates/flux-core/icons"
install -Dm644 "$ICONS/icon.png" "$DATA/icons/hicolor/512x512/apps/dev.flux.browser.png"
install -Dm644 "$ICONS/128x128@2x.png" "$DATA/icons/hicolor/256x256/apps/dev.flux.browser.png"
install -Dm644 "$ICONS/128x128.png" "$DATA/icons/hicolor/128x128/apps/dev.flux.browser.png"
mkdir -p "$DATA/applications"
cat >"$DATA/applications/dev.flux.browser.desktop" <<DESKTOP
[Desktop Entry]
Type=Application
Name=Flux
GenericName=Web Browser
Comment=Browser, terminal and notes in one window
Exec="$DEST/flux" %U
Icon=dev.flux.browser
Terminal=false
Categories=Network;WebBrowser;
StartupWMClass=flux
Actions=new-terminal;

[Desktop Action new-terminal]
Name=New Terminal Tab
Exec="$DEST/flux" -t
DESKTOP
# Menus pick the entry up by themselves; these only make it immediate.
command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database -q "$DATA/applications" || true
command -v gtk-update-icon-cache >/dev/null 2>&1 && gtk-update-icon-cache -qt "$DATA/icons/hicolor" 2>/dev/null || true
echo "==> Added Flux to the app menu: $DATA/applications/dev.flux.browser.desktop"

if command -v flux >/dev/null 2>&1; then
  flux --version
  echo "Done — run 'flux' from any directory."
else
  echo "Done, but $DEST is not on your PATH. Add it:  export PATH=\"$DEST:\$PATH\""
fi
