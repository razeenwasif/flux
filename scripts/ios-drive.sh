#!/usr/bin/env bash
# Drive a debug build of Flux on a USB/Wi-Fi-paired iPhone from this Mac
# (ADR 0021). Debug builds carry a small hook (DebugDrive in the plugin's Swift
# package): this script copies a script into the app's Documents folder, pokes
# the app with a Darwin notification, and copies the result back.
#
#   bash scripts/ios-drive.sh js  <file.js|->   run in the shell (or a tab: first line `//tab:<id>`)
#   bash scripts/ios-drive.sh shot <out.png>    screenshot the phone
#
# Scripts run as an async function body: `await` works and `return` gives the
# result (return a string; JSON.stringify anything structured).
# FLUX_IOS_DEVICE picks the phone (name or UDID); default: the first paired iPhone.
set -euo pipefail

DEVICE="${FLUX_IOS_DEVICE:-}"
if [ -z "$DEVICE" ]; then
  DEVICE="$(xcrun devicectl list devices 2>/dev/null \
    | awk '/iPhone/ && /physical/ && (/connected/ || /available/) && !/unavailable/ { for (i=1;i<=NF;i++) if ($i ~ /^[0-9A-F]{8}-[0-9A-F]{16}$/) { print $i; exit } }')"
fi
[ -n "$DEVICE" ] || { echo "No paired iPhone is available." >&2; exit 1; }

BUNDLE=dev.flux.browser
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
dc() { xcrun devicectl "$@" -q 2>"$TMP/err" || { cat "$TMP/err" >&2; return 1; }; }

case "${1:-}" in
  shot)
    dc device capture screenshot --device "$DEVICE" --destination "${2:?out.png}"
    ;;
  js)
    SRC="${2:?file.js or -}"
    if [ "$SRC" = - ]; then cat > "$TMP/in.js"; else cp "$SRC" "$TMP/in.js"; fi
    fetch() {
      rm -f "$TMP/out.json"
      xcrun devicectl device copy from --device "$DEVICE" --domain-type appDataContainer \
        --domain-identifier "$BUNDLE" --source Documents/flux-debug/out.json \
        --destination "$TMP/out.json" -q >/dev/null 2>&1 || true
      [ -f "$TMP/out.json" ] && python3 -c 'import json,sys;print(json.load(open(sys.argv[1])).get("seq",""))' "$TMP/out.json" || echo ""
    }
    BEFORE="$(fetch)"
    dc device copy to --device "$DEVICE" --domain-type appDataContainer --domain-identifier "$BUNDLE" \
      --source "$TMP/in.js" --destination Documents/flux-debug/in.js
    dc device notification post --device "$DEVICE" --name dev.flux.debug.run
    for _ in $(seq 1 30); do
      NOW="$(fetch)"
      if [ -n "$NOW" ] && [ "$NOW" != "$BEFORE" ]; then
        python3 -c 'import json,sys;o=json.load(open(sys.argv[1]));print(o.get("ok") if "ok" in o else "ERROR: "+o.get("error",""))' "$TMP/out.json"
        exit 0
      fi
      sleep 0.5
    done
    echo "No answer from Flux. Is a debug build open and in front on the phone?" >&2
    exit 1
    ;;
  *)
    sed -n '2,13p' "$0"
    exit 2
    ;;
esac
