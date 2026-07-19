#!/data/data/com.termux/files/usr/bin/bash
# Flux on Android — Termux + proot-distro + termux-x11 (ADR 0012, rung A).
#
# Run this INSIDE TERMUX (not inside the proot). It sets up both layers:
#   Termux layer : X11 display + proot-distro
#   Ubuntu layer : toolchains + WebKitGTK + the Flux build itself
#
# Why proot at all? Termux's native rust targets aarch64-linux-android, where
# Tauri switches to its Android/JNI mode and expects an app context a terminal
# process doesn't have. Inside a proot Ubuntu the target is ordinary
# aarch64-unknown-linux-gnu — Tauri takes the GTK path and Flux builds exactly
# like it does on WSL2. See docs/adr/0012-mobile-termux.md.
#
# Usage:
#   pkg install curl && curl -fsSL <raw-url>/scripts/install-termux.sh | bash
#   …or clone the repo in Termux and:  bash scripts/install-termux.sh
#
# After install:  flux-mobile     (starts X11 + launches Flux; open the
#                                  Termux:X11 app to see it)
set -euo pipefail

FLUX_REPO="${FLUX_REPO:-https://github.com/razeenwasif/flux.git}"
DISTRO=ubuntu

say() { printf '\033[1;35m==> %s\033[0m\n' "$*"; }

# ── Termux layer ─────────────────────────────────────────────────────────────
say "Termux packages (X11 display + proot)"
yes | pkg update >/dev/null || true
pkg install -y x11-repo >/dev/null
pkg install -y termux-x11-nightly pulseaudio proot-distro >/dev/null

if ! proot-distro list --installed 2>/dev/null | grep -q "$DISTRO"; then
  say "Installing $DISTRO (proot-distro)"
  proot-distro install "$DISTRO"
fi

# ── Ubuntu layer: everything below runs inside the proot ────────────────────
say "Provisioning the $DISTRO userland (toolchains + WebKitGTK + Flux)"
proot-distro login "$DISTRO" -- bash -euo pipefail -c '
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  # The same dep set the README lists for desktop Linux, arm64 flavor.
  apt-get install -y -qq build-essential curl wget file git pkg-config \
    libssl-dev libgtk-3-dev libwebkit2gtk-4.1-dev libayatana-appindicator3-dev \
    librsvg2-dev libxdo-dev dbus dbus-x11 nodejs npm >/dev/null

  # Rust ≥ 1.80 via rustup (Ubuntu apt rust is too old).
  if ! command -v cargo >/dev/null; then
    curl --proto "=https" --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y -q
  fi
  . "$HOME/.cargo/env"

  if [ ! -d "$HOME/Flux" ]; then
    git clone --depth 1 "'"$FLUX_REPO"'" "$HOME/Flux"
  fi
  cd "$HOME/Flux"

  echo "==> npm ci (frontend deps)"
  # proots emulated rename + a slow mobile link corrupt npm cacache mid-download
  # (ENOENT on rename of _cacache/tmp -> content-v2). Make npm patient, and on
  # failure nuke the cache + node_modules and retry from clean rather than dying.
  npm config set fetch-retries 5
  npm config set fetch-retry-mintimeout 20000
  npm config set fetch-retry-maxtimeout 120000
  npm config set fetch-timeout 300000
  npm_ci() { npm ci --no-audit --no-fund; }
  if ! npm_ci; then
    echo "==> npm ci failed (likely a corrupted cache under proot) — resetting cache and retrying"
    npm cache clean --force || true
    rm -rf "$HOME/.npm/_cacache" node_modules
    if ! npm_ci; then
      echo "==> retrying once more with cache disabled (slower, but rename-proof)"
      npm cache clean --force || true
      rm -rf "$HOME/.npm/_cacache" node_modules
      npm ci --no-audit --no-fund --prefer-online --cache "$HOME/.npm-cache-fresh"
    fi
  fi
  echo "==> Building the frontend (vite)"
  npm run shell:build
  echo "==> Building flux (release — this is the long one; a phone takes a while)"
  cargo build --release --features custom-protocol -p flux-core

  install -Dm755 target/release/flux "$HOME/.local/bin/flux"
  echo "==> flux installed to ~/.local/bin/flux (inside the proot)"
'

# ── Launcher: one command from Termux ────────────────────────────────────────
say "Writing the flux-mobile launcher"
mkdir -p "$PREFIX/bin"
cat > "$PREFIX/bin/flux-mobile" <<'EOF'
#!/data/data/com.termux/files/usr/bin/bash
# Launch Flux: start termux-x11 if needed, then run Flux inside the proot with
# the WebKitGTK-under-proot environment (no GPU → software GL, compositing off;
# WebKit wants a dbus session).
set -e
if ! pgrep -f "termux-x11 :0" >/dev/null; then
  termux-x11 :0 >/dev/null 2>&1 &
  sleep 2
fi
echo "Open the Termux:X11 app to see Flux."
exec proot-distro login ubuntu --shared-tmp -- bash -lc '
  export DISPLAY=:0
  export GDK_BACKEND=x11
  export LIBGL_ALWAYS_SOFTWARE=1
  export WEBKIT_DISABLE_COMPOSITING_MODE=1
  export NO_AT_BRIDGE=1
  exec dbus-run-session -- "$HOME/.local/bin/flux"
'
EOF
chmod +x "$PREFIX/bin/flux-mobile"

say "Done."
cat <<'EON'

  Run Flux:      flux-mobile        (then open the Termux:X11 app)
  Rebuild:       proot-distro login ubuntu  →  cd ~/Flux && git pull && \
                   npm run shell:build && cargo build --release \
                   --features custom-protocol -p flux-core && \
                   install -Dm755 target/release/flux ~/.local/bin/flux

  Optional — the local agent (CPU-only, use a small model):
    proot-distro login ubuntu
    curl -fsSL https://ollama.com/install.sh | sh
    ollama serve &   ollama pull gemma3:4b
    FLUX_MODEL=gemma3:4b flux    # or set it in the launcher

  Known class: this is the dev-grade Linux/WebKitGTK build (like WSL2).
  First on-device check that matters: open a real web page in a tab — if the
  page renders, termux-x11 positions per-tab webviews and this is a full
  browser; if not, internal pages/panels still work (see ADR 0012).
EON
