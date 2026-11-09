#!/usr/bin/env bash
# Build Flux for an iPhone and put it on one (ADR 0012). The iOS twin of
# build-apk.sh: cross-compiles here, signs with your Apple Development identity,
# and installs on a paired device over USB or Wi-Fi.
#
# Prereqs (one-time): Xcode, the iOS Rust target, xcodegen, and a paired iPhone
# with Developer Mode on (Settings → Privacy & Security → Developer Mode).
#   rustup target add aarch64-apple-ios
#   brew install xcodegen
#
# Usage:  bash scripts/build-ios.sh [--release] [--no-install] [--device NAME|UDID]
#   default is a debug build installed on the first paired iPhone.
#   APPLE_DEVELOPMENT_TEAM overrides the team taken from your certificate.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

PROFILE_FLAG="--debug"
INSTALL=1
DEVICE=""
while [ $# -gt 0 ]; do
  case "$1" in
    --release) PROFILE_FLAG="" ;;
    --no-install) INSTALL=0 ;;
    --device) DEVICE="$2"; shift ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
  shift
done

# The team comes from your Apple Development certificate (its OU), so it never
# has to be written into the repo.
if [ -z "${APPLE_DEVELOPMENT_TEAM:-}" ]; then
  APPLE_DEVELOPMENT_TEAM="$(security find-certificate -c "Apple Development" -p 2>/dev/null \
    | openssl x509 -noout -subject 2>/dev/null | grep -o 'OU=[A-Z0-9]*' | head -1 | cut -d= -f2 || true)"
fi
[ -n "$APPLE_DEVELOPMENT_TEAM" ] || {
  echo "No Apple Development certificate found. Sign in to Xcode (Settings → Accounts)" >&2
  echo "and let it create one, or export APPLE_DEVELOPMENT_TEAM." >&2
  exit 1; }
export APPLE_DEVELOPMENT_TEAM

# 1) The frontend, from the root where the npm workspaces live (see build-apk.sh).
echo "==> Building frontend (npm run shell:build)"
npm run shell:build

# 2) The Xcode project lives under crates/flux-core/gen (gitignored): scaffold it
#    on a fresh checkout.
cd "$ROOT/crates/flux-core"
if [ ! -d "gen/apple" ]; then
  echo "==> Scaffolding the Xcode project (tauri ios init)"
  npx --no-install tauri ios init --ci
fi

# The app icon: Flux's own, full-bleed and opaque as iOS wants it
# (icons/ios). Copied in every build, so a project scaffolded before the icons
# existed doesn't keep Tauri's default.
cp -f icons/ios/AppIcon-*.png gen/apple/Assets.xcassets/AppIcon.appiconset/

# The "Send to Flux" share extension (ios/ShareExtension) isn't something
# Tauri's project template knows about: add its target to the generated spec
# (once) and regenerate the Xcode project. The app embeds it under PlugIns.
SPEC=gen/apple/project.yml
if ! grep -q '^  flux-share:' "$SPEC"; then
  echo "==> Adding the share extension to the Xcode project"
  VERSION="$(python3 -c 'import json;print(json.load(open("tauri.conf.json"))["version"])')"
  python3 - "$SPEC" "$APPLE_DEVELOPMENT_TEAM" "$VERSION" <<'PY'
import sys
spec, team, version = sys.argv[1:4]
s = open(spec).read()
# The app depends on (and so embeds) the extension.
s = s.replace("    dependencies:\n      - framework: libapp.a",
              "    dependencies:\n      - target: flux-share\n      - framework: libapp.a", 1)
s = s.rstrip("\n") + f"""
  flux-share:
    type: app-extension
    platform: iOS
    deploymentTarget: "16.0"
    sources:
      - path: ../../ios/ShareExtension
        excludes: [Info.plist]
    settings:
      base:
        PRODUCT_NAME: FluxShare
        PRODUCT_BUNDLE_IDENTIFIER: dev.flux.browser.share
        DEVELOPMENT_TEAM: {team}
        CODE_SIGN_STYLE: Automatic
        INFOPLIST_FILE: ../../ios/ShareExtension/Info.plist
        APPLICATION_EXTENSION_API_ONLY: YES
        SWIFT_VERSION: "5.0"
        MARKETING_VERSION: "{version}"
        CURRENT_PROJECT_VERSION: "{version}"
        TARGETED_DEVICE_FAMILY: "1,2"
        SKIP_INSTALL: YES
"""
open(spec, "w").write(s)
PY
  grep -q '      - target: flux-share' "$SPEC" || { echo "Couldn't add the share extension to $SPEC." >&2; exit 1; }
  (cd gen/apple && xcodegen generate --spec project.yml --quiet)
fi

# Tauri's CLI won't build anything for iOS until an iOS Simulator runtime is
# installed (it reads `xcrun simctl list runtimes --json`), although a device
# build never uses one. Without a runtime, answer that one query with a stand-in
# so the check passes, and hand every other xcrun call to the real one.
if ! xcrun simctl list runtimes --json 2>/dev/null | grep -q '"platform" : "iOS"'; then
  SHIM="$(mktemp -d)"
  trap 'rm -rf "$SHIM"' EXIT
  SDK_VER="$(xcrun --sdk iphoneos --show-sdk-version)"
  cat > "$SHIM/xcrun" <<SH
#!/bin/sh
if [ "\$1 \$2 \$3 \$4" = "simctl list runtimes --json" ]; then
  printf '{"runtimes":[{"platform":"iOS","identifier":"com.apple.CoreSimulator.SimRuntime.iOS-${SDK_VER//./-}","version":"$SDK_VER","buildversion":"","name":"iOS $SDK_VER","isAvailable":true,"isInternal":false,"bundlePath":"","runtimeRoot":"","supportedDeviceTypes":[]}]}\n'
  exit 0
fi
exec /usr/bin/xcrun "\$@"
SH
  chmod +x "$SHIM/xcrun"
  export PATH="$SHIM:$PATH"
  echo "==> No iOS Simulator runtime installed; building for the device only"
fi

# 3) Compile, sign and package. beforeBuildCommand is emptied: step 1 did it.
echo "==> Building for iPhone ($([ -n "$PROFILE_FLAG" ] && echo debug || echo release), arm64)"
npx --no-install tauri ios build $PROFILE_FLAG --target aarch64 --ci \
  --config '{"build":{"beforeBuildCommand":""}}'

# tauri ios build archives, then exports an .ipa; the archive holds the signed
# .app that devicectl installs.
OUT="$ROOT/crates/flux-core/gen/apple/build"
APP="$OUT/flux-core_iOS.xcarchive/Products/Applications/Flux.app"
IPA="$OUT/arm64/Flux.ipa"
[ -d "$APP" ] && [ -n "$(find "$APP" -maxdepth 0 -newermt "-60 minutes")" ] || {
  echo "==> Build finished but no fresh Flux.app was found under $OUT." >&2; exit 1; }
echo "==> Built: $IPA"

[ "$INSTALL" = 1 ] || exit 0

# 4) Install on the phone. devicectl takes a name or a UDID.
if [ -z "$DEVICE" ]; then
  DEVICE="$(xcrun devicectl list devices 2>/dev/null \
    | awk '/iPhone/ && /physical/ && (/connected/ || /available/) && !/unavailable/ { for (i=1;i<=NF;i++) if ($i ~ /^[0-9A-F]{8}-[0-9A-F]{16}$/) { print $i; exit } }')"
fi
[ -n "$DEVICE" ] || { echo "==> No paired iPhone is available. Unlock it and connect it, then rerun." >&2; exit 1; }
echo "==> Installing on $DEVICE"
xcrun devicectl device install app --device "$DEVICE" "$APP"
xcrun devicectl device process launch --device "$DEVICE" --terminate-existing dev.flux.browser || \
  echo "==> Installed. Open Flux on the phone (it may first ask you to trust the developer in Settings → General → VPN & Device Management)."
