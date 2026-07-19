#!/usr/bin/env bash
# Build the Flux Android APK on a desktop machine (ADR 0012, rung C — the native
# app, NOT the proot route in install-termux.sh). Cross-compiles here; the phone
# just downloads + installs the resulting .apk.
#
# Prereqs (one-time): Android SDK + NDK, Rust android targets, cargo-tauri v2.
#   rustup target add aarch64-linux-android
#   cargo install tauri-cli --version '^2'
#   # SDK/NDK via cmdline-tools; point ANDROID_HOME/NDK_HOME at them (below).
#
# Usage:  bash scripts/build-apk.sh [--release]
#   default is a debug APK (debug-keystore signed → sideloadable immediately).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# Toolchain locations — override by exporting these before running.
export ANDROID_HOME="${ANDROID_HOME:-$HOME/Android}"
if [ -z "${NDK_HOME:-}" ]; then
  # Newest installed NDK under $ANDROID_HOME/ndk.
  NDK_HOME="$ANDROID_HOME/ndk/$(ls -1 "$ANDROID_HOME/ndk" 2>/dev/null | sort -V | tail -1)"
  export NDK_HOME
fi
export PATH="$ANDROID_HOME/platform-tools:$ANDROID_HOME/cmdline-tools/latest/bin:$PATH"

# Gradle needs a full JDK (javac), not just a JRE. Prefer a portable Temurin JDK
# under ~/jdk (install with no root: download the tarball from adoptium.net and
# untar it there). Falls back to $JAVA_HOME / the system default if it has javac.
if [ -z "${JAVA_HOME:-}" ] || [ ! -x "${JAVA_HOME:-/nonexistent}/bin/javac" ]; then
  PORTABLE_JDK="$(find "$HOME/jdk" -maxdepth 1 -type d -name 'jdk-*' 2>/dev/null | sort -V | tail -1)"
  if [ -n "$PORTABLE_JDK" ] && [ -x "$PORTABLE_JDK/bin/javac" ]; then
    export JAVA_HOME="$PORTABLE_JDK"
  fi
fi
[ -x "${JAVA_HOME:-/nonexistent}/bin/javac" ] || {
  echo "No JDK with javac found. Install one (no root needed):" >&2
  echo "  mkdir -p ~/jdk && cd ~/jdk && curl -fsSL -o j.tgz \\" >&2
  echo "    'https://api.adoptium.net/v3/binary/latest/21/ga/linux/x64/jdk/hotspot/normal/eclipse' \\" >&2
  echo "    && tar xzf j.tgz && rm j.tgz" >&2
  exit 1; }
export PATH="$JAVA_HOME/bin:$PATH"
echo "==> JDK: $JAVA_HOME"

[ -x "$NDK_HOME/toolchains/llvm/prebuilt/linux-x86_64/bin/clang" ] || {
  echo "NDK not found at $NDK_HOME — set NDK_HOME to your Android NDK." >&2; exit 1; }

PROFILE_FLAG="--debug"
[ "${1:-}" = "--release" ] && PROFILE_FLAG=""

# 1) Build the embedded frontend FROM THE ROOT (where the npm workspaces live).
#    The android build below can't run this itself: `cargo tauri android build`
#    runs beforeBuildCommand from crates/flux-core, where `--workspace apps/shell`
#    doesn't resolve. So we build it here and empty beforeBuildCommand for the run.
echo "==> Building frontend (npm run shell:build)"
npm run shell:build

# 2) Ensure the Android Gradle project exists. It lives under crates/flux-core/gen,
#    which is gitignored (like all generated output in this repo), so scaffold it
#    on a fresh checkout. Idempotent — skipped once present.
cd "$ROOT/crates/flux-core"
if [ ! -d "gen/android" ]; then
  echo "==> Scaffolding Android project (cargo tauri android init)"
  cargo tauri android init
fi

# 3) Cross-compile + package the APK. beforeBuildCommand is overridden to empty
#    (frontend already built in step 1) so cwd doesn't matter.
echo "==> Building APK ($([ -n "$PROFILE_FLAG" ] && echo debug || echo release), arm64)"
cargo tauri android build $PROFILE_FLAG --apk --target aarch64 \
  --config '{"build":{"beforeBuildCommand":""}}'

# 4) Surface the artifact.
APK="$(find "$ROOT" -name "*.apk" -newermt "-15 minutes" 2>/dev/null | head -1)"
if [ -n "$APK" ]; then
  DEST="$ROOT/flux-arm64.apk"
  cp -f "$APK" "$DEST"
  echo "==> APK: $DEST"
  echo "    Sideload: adb install -r \"$DEST\"  (or copy it to the phone and tap it)"
else
  echo "==> Build finished but no .apk was found — check the log above." >&2
  exit 1
fi
