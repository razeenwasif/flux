#!/usr/bin/env bash
# Sourced by install-macos.sh and release.sh: sign Flux.app the same way for an
# install and for an update, so macOS sees one app across both.
#
# macOS remembers what it has allowed an app (Local Network, Accessibility,
# keychain items) by the app's signature. The linker's ad-hoc signature changes
# with every build, so each reinstall would be a stranger asking again; a
# certificate's doesn't. FLUX_SIGN_IDENTITY names one (a `security find-identity`
# hash or name), or "-" to keep the ad-hoc signature; by default it's the
# keychain's first Apple Development identity, if there is one. No hardened
# runtime: that's for notarising a release, and a local build doesn't need it.
sign_app() {
  local app="$1" id="${FLUX_SIGN_IDENTITY:-}"
  if [ -z "$id" ]; then
    id="$(security find-identity -v -p codesigning 2>/dev/null |
      awk '/"Apple Development: /{print $2; exit}')"
  fi
  if [ -z "$id" ] || [ "$id" = "-" ]; then
    echo "note: Flux.app keeps an ad-hoc signature, so macOS may ask again for what it allowed Flux after each install (FLUX_SIGN_IDENTITY signs it)." >&2
    return 0
  fi
  say "Signing Flux.app (macOS keeps what it has allowed Flux across rebuilds)"
  # The first time, macOS asks to let codesign use the certificate's key:
  # "Always Allow" stops it asking on every install.
  codesign --force --sign "$id" --timestamp=none "$app" ||
    echo "warn: signing failed; Flux.app keeps its ad-hoc signature." >&2
}
