#!/usr/bin/env bash
# Publish a Flux update (BACKLOG #26): build on this Mac, sign it, and put it on
# a GitHub release that installed copies of Flux pick up (update.rs).
#
#   scripts/release.sh 0.2.0 "What changed"   bump, build, sign, tag, publish
#   scripts/release.sh --pack <Flux.app> <version> <out-dir> <base-url>
#                                              package an app already built, for
#                                              a test feed (FLUX_UPDATE_URL)
#
# Two signatures. The app is signed with your Apple Development certificate,
# exactly as install-macos.sh signs it, so macOS keeps what it allowed Flux.
# The update archive is signed with the updater key (~/.tauri/flux-updater.key,
# or FLUX_UPDATER_KEY), whose public half is in tauri.conf.json: Flux installs
# nothing that key didn't sign. Keep a copy of that key somewhere safe. Without
# it, copies of Flux already out there can't take another update.
#
# The archive is named Flux_<version>_<arch>.app.tar.gz, and the signature
# covers that name: Flux checks it against the version it's offered, so an old
# build can't be passed off as a new one.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

say() { printf '\033[1;35m==> %s\033[0m\n' "$*"; }
die() {
  printf '\033[1;31mrelease: %s\033[0m\n' "$*" >&2
  exit 1
}

REPO="razeenwasif/flux"
CONF="crates/flux-core/tauri.conf.json"
CARGO_TOML="Cargo.toml"
KEY="${FLUX_UPDATER_KEY:-$HOME/.tauri/flux-updater.key}"

[ "$(uname -s)" = "Darwin" ] || die "releases are built on macOS."
[ -f "$KEY" ] || die "no updater key at $KEY (FLUX_UPDATER_KEY names another)."

# The updater's name for this machine: darwin-aarch64 or darwin-x86_64.
case "$(uname -m)" in
  arm64) ARCH=aarch64 ;;
  x86_64) ARCH=x86_64 ;;
  *) die "unknown architecture $(uname -m)" ;;
esac

is_version() { [[ "$1" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; }

# pack <Flux.app> <version> <out-dir> <base-url> [notes]
# Writes the archive, its signature and latest.json into <out-dir>; the archive
# is expected at <base-url>/<archive name>.
pack() {
  local app="$1" version="$2" out="$3" base="$4" notes="${5:-}"
  [ -d "$app" ] || die "no app at $app"
  is_version "$version" || die "version must look like 1.2.3, not $version"
  mkdir -p "$out"
  local name="Flux_${version}_${ARCH}.app.tar.gz"
  say "Packing $name"
  # The archive holds Flux.app itself: the updater swaps the whole bundle.
  COPYFILE_DISABLE=1 tar -czf "$out/$name" -C "$(dirname "$app")" "$(basename "$app")"
  rm -f "$out/$name.sig"
  npx --no-install tauri signer sign -f "$KEY" -p "" "$out/$name" >/dev/null
  [ -s "$out/$name.sig" ] || die "signing the archive failed"
  FLUX_PACK_VERSION="$version" FLUX_PACK_NOTES="$notes" FLUX_PACK_SIG="$(cat "$out/$name.sig")" \
    FLUX_PACK_URL="${base%/}/$name" FLUX_PACK_TARGET="darwin-$ARCH" \
    node -e '
      const e = process.env;
      const feed = {
        version: e.FLUX_PACK_VERSION,
        notes: e.FLUX_PACK_NOTES,
        pub_date: new Date().toISOString().replace(/\.\d+Z$/, "Z"),
        platforms: { [e.FLUX_PACK_TARGET]: { signature: e.FLUX_PACK_SIG, url: e.FLUX_PACK_URL } },
      };
      process.stdout.write(JSON.stringify(feed, null, 2) + "\n");
    ' >"$out/latest.json"
  say "Wrote $out/latest.json"
}

if [ "${1:-}" = "--pack" ]; then
  [ $# -ge 5 ] || die "usage: release.sh --pack <Flux.app> <version> <out-dir> <base-url> [notes]"
  pack "$2" "$3" "$4" "$5" "${6:-}"
  exit 0
fi

# ── A real release ───────────────────────────────────────────────────────────
VERSION="${1:-}"
NOTES="${2:-}"
is_version "$VERSION" || die "usage: release.sh <version, like 0.2.0> [notes]"
CURRENT="$(node -p "require('./$CONF').version")"
node -e '
  const [a, b] = process.argv.slice(1).map((v) => v.split(".").map(Number));
  const newer = a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
  process.exit(newer > 0 ? 0 : 1);
' "$VERSION" "$CURRENT" || die "$VERSION isn't newer than the current $CURRENT"

command -v gh >/dev/null 2>&1 || die "the GitHub CLI (gh) is needed to publish."
gh auth status >/dev/null 2>&1 || die "gh isn't signed in: gh auth login"
[ "$(git rev-parse --abbrev-ref HEAD)" = "main" ] || die "release from main."
git diff --quiet HEAD -- || die "commit or stash your changes first."
git fetch -q origin main
[ "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)" ] || die "main isn't in step with origin/main."
! git rev-parse -q --verify "refs/tags/v$VERSION" >/dev/null || die "tag v$VERSION already exists."

say "Flux $CURRENT → $VERSION"
# The app's version (what the updater compares) and the workspace's (flux
# --version).
node -e '
  const fs = require("fs");
  const [conf, version] = process.argv.slice(1);
  const text = fs.readFileSync(conf, "utf8");
  fs.writeFileSync(conf, text.replace(/("version":\s*")[^"]+(")/, `$1${version}$2`));
' "$CONF" "$VERSION"
sed -i '' "/^\[workspace.package\]/,/^\[/s/^version = \".*\"/version = \"$VERSION\"/" "$CARGO_TOML"
grep -q "^version = \"$VERSION\"" "$CARGO_TOML" || die "couldn't set the version in $CARGO_TOML"
cargo update -q --workspace --offline

say "Building Flux.app (release, LTO — takes a few minutes)"
npm run build -- --bundles app
TARGET_DIR="$(cargo metadata --format-version 1 --no-deps 2>/dev/null |
  sed -n 's/.*"target_directory":"\([^"]*\)".*/\1/p')"
APP="${TARGET_DIR:-target}/release/bundle/macos/Flux.app"
[ -d "$APP" ] || die "the build made no $APP"

# shellcheck source=macos-sign.sh
. "$ROOT/scripts/macos-sign.sh"
sign_app "$APP"
# An update signed ad hoc would be a stranger to macOS, which would ask again
# for everything it allowed Flux. Better no release than that.
codesign -dv "$APP" 2>&1 | grep -q "^Authority=Apple Development" ||
  die "Flux.app isn't signed with your certificate; not publishing it."

OUT="$(mktemp -d)"
pack "$APP" "$VERSION" "$OUT" "https://github.com/$REPO/releases/download/v$VERSION" "$NOTES"

say "Committing and tagging v$VERSION"
git add "$CONF" "$CARGO_TOML" Cargo.lock
git commit -q -m "release: v$VERSION"
git tag -a "v$VERSION" -m "Flux $VERSION"
git push -q origin main "v$VERSION"

say "Publishing the GitHub release"
gh release create "v$VERSION" --repo "$REPO" --title "Flux $VERSION" \
  --notes "${NOTES:-Flux $VERSION}" \
  "$OUT/Flux_${VERSION}_${ARCH}.app.tar.gz" "$OUT/Flux_${VERSION}_${ARCH}.app.tar.gz.sig" "$OUT/latest.json"
say "Published: https://github.com/$REPO/releases/tag/v$VERSION"
echo "Copies of Flux that check for updates will offer it within six hours (Settings → Updates → Check now for this one)."
