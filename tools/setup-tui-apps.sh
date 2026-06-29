#!/usr/bin/env bash
#
# setup-tui-apps.sh — install the terminal apps that pair with Flux's TUI bar (#117).
#
# Reads tools/tui-apps.json and, for each app: clones its repo (or pulls if the
# directory already exists), then runs its build command so the binary lands on
# your PATH. Homebrew formulae (e.g. lazygit) are installed via `brew`. Idempotent
# — safe to re-run to update everything. Works on macOS and Linux.
#
# Usage:
#   ./tools/setup-tui-apps.sh            # set up everything in the manifest
#   ./tools/setup-tui-apps.sh onyx kata  # only these (match by name/cmd, case-insensitive)
#
# PATH note: the build commands install to ~/.cargo/bin (Rust), $(go env GOPATH)/bin
# (Go), ~/.local/bin (BoxTube), and bun's global bin (Council). Make sure those are
# on your PATH (and the same PATH your Flux terminal shell uses).

set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
MANIFEST="$HERE/tui-apps.json"
[ -f "$MANIFEST" ] || { echo "✗ manifest not found: $MANIFEST" >&2; exit 1; }

# Parse the JSON into TAB-separated rows: name<TAB>cmd<TAB>dir<TAB>repo<TAB>pkg<TAB>build
parse_manifest() {
  if command -v node >/dev/null 2>&1; then
    node -e '
      const m = require(process.argv[1]);
      for (const a of m.apps) {
        const f = [a.name||"", a.cmd||"", a.dir||"", a.repo||"", a.pkg||"", a.build||""];
        process.stdout.write(f.join("\t") + "\n");
      }
    ' "$MANIFEST"
  elif command -v python3 >/dev/null 2>&1; then
    python3 - "$MANIFEST" <<'PY'
import json, sys
m = json.load(open(sys.argv[1]))
for a in m["apps"]:
    print("\t".join([a.get(k,"") for k in ("name","cmd","dir","repo","pkg","build")]))
PY
  else
    echo "✗ need node or python3 to parse the manifest" >&2; exit 1
  fi
}

want=("$@")
wanted() {
  [ ${#want[@]} -eq 0 ] && return 0
  local n="$1" c="$2" w
  for w in "${want[@]}"; do
    [ "$(printf '%s' "$w" | tr '[:upper:]' '[:lower:]')" = "$(printf '%s' "$n" | tr '[:upper:]' '[:lower:]')" ] && return 0
    [ "$(printf '%s' "$w" | tr '[:upper:]' '[:lower:]')" = "$(printf '%s' "$c" | tr '[:upper:]' '[:lower:]')" ] && return 0
  done
  return 1
}

ok=(); failed=(); skipped=()

while IFS=$'\t' read -r name cmd dir repo pkg build; do
  [ -z "$name" ] && continue
  wanted "$name" "$cmd" || continue
  echo
  echo "── $name ($cmd) ──────────────────────────────────────"

  # Homebrew package (third-party tools like lazygit).
  if [ -n "$pkg" ]; then
    if command -v "$cmd" >/dev/null 2>&1; then
      echo "  ✓ already installed"; ok+=("$name"); continue
    fi
    if command -v brew >/dev/null 2>&1; then
      if brew install "$pkg"; then ok+=("$name"); else failed+=("$name"); fi
    else
      echo "  ⚠ Homebrew not found — install '$pkg' with your package manager"; skipped+=("$name")
    fi
    continue
  fi

  dir="${dir/#\~/$HOME}"
  if [ -z "$dir" ]; then echo "  ⚠ no directory set — skipping"; skipped+=("$name"); continue; fi

  # Get the source: clone if missing, pull if it's already a checkout.
  if [ -d "$dir/.git" ]; then
    echo "  ↻ updating $dir"
    git -C "$dir" pull --ff-only || echo "  ⚠ pull failed (local changes?) — building what's there"
  elif [ -d "$dir" ]; then
    echo "  • using existing $dir (not a git repo)"
  elif [ -n "$repo" ]; then
    echo "  ⤓ cloning $repo → $dir"
    git clone "$repo" "$dir" || { echo "  ✗ clone failed"; failed+=("$name"); continue; }
  else
    echo "  ⚠ $dir missing and no 'repo' in the manifest — push it to a remote (or copy it over), then re-run"
    skipped+=("$name"); continue
  fi

  # Build / install.
  if [ -z "$build" ]; then echo "  • no build step"; ok+=("$name"); continue; fi
  echo "  ⚙ $build"
  if ( cd "$dir" && eval "$build" ); then
    echo "  ✓ $name ready"; ok+=("$name")
  else
    echo "  ✗ build failed — check the 'build' command in tui-apps.json"; failed+=("$name")
  fi
done < <(parse_manifest)

echo
echo "════════════════════════════════════════════════════════"
echo "  installed/updated: ${ok[*]:-none}"
[ ${#skipped[@]} -gt 0 ] && echo "  skipped:           ${skipped[*]}"
[ ${#failed[@]} -gt 0 ] && echo "  failed:            ${failed[*]}"
echo
echo "The TUI bar chips are seeded by Flux itself — open a chip to launch."
echo "If a chip says 'command not found', make sure its bin dir is on your PATH"
echo "(~/.cargo/bin, \$(go env GOPATH)/bin, ~/.local/bin, bun global bin)."
[ ${#failed[@]} -gt 0 ] && exit 1 || exit 0
