# ADR 0009 — Password manager, autofill & vault security model

| | |
|---|---|
| **Status** | Accepted — implemented: `flux-vault` (model + AES-GCM + Proton import), OS-keychain key (`keyring`, file fallback), flux-core commands, same-origin autofill injection, footer 🔑 vault UI. Follow-ups: save-password prompt, more importers, optional master password. |
| **Date** | 2026-06-16 |
| **Deciders** | Flux Core Team |
| **Relates to** | BACKLOG #61 (this). Builds on the JS-injection substrate (capture.js / agent injection, ADR 0007) and the session store (#19). |

## Context

Users want their logins **in** Flux with autofill. The headline ask is Proton
Pass — but Proton Pass ships only as a **WebExtension**, and Flux renders pages
in **native webviews** (WebView2 / WebKitGTK) that cannot run WebExtensions
(the premise of ADR 0008). Proton also exposes **no public API/CLI** for live
sync. So we cannot run or live-bridge Proton Pass. What we *can* do: own a
native vault and **import** Proton's export, then autofill via Flux's existing
injection path. (Same path serves Chrome / Bitwarden / 1Password importers.)

## Decision

**A local-first, native vault** (`flux-vault` crate) — never synced anywhere by
default (E2E sync is a separate item, #62).

### Storage & crypto
- The vault is a JSON document of credentials, **sealed with AES-256-GCM** to a
  single blob (`nonce ‖ ciphertext`); a fresh random 96-bit nonce per write.
- The 256-bit **data key lives in the OS keychain** (`keyring`: Windows
  Credential Manager/DPAPI, macOS Keychain, Linux Secret Service). The encrypted
  blob lives at `app_data_dir/vault/vault.bin`. So at rest the file is useless
  without the OS-user-protected key.
- Decrypted plaintext + secrets are held in `Zeroizing` buffers and wiped on
  drop; secrets are never logged.
- **Future hardening (not v1):** an optional master password (Argon2id-derived
  key wrapping the data key) for at-rest protection independent of OS login, and
  auto-lock on idle.

### Threat model (explicit)
- **In scope:** disk theft / file exfiltration (file is encrypted; key is in the
  OS store), accidental logging/sync (never logged, never auto-synced).
- **Out of scope (v1):** malware running as the logged-in user — the OS keychain
  releases the key to that user. This matches every OS-keychain password manager
  without a master password; the master-password option above closes it later.

### Autofill (next increment)
- Matched by **registrable host**; fill only into the **top-level same-origin**
  document (never blindly into cross-origin iframes — anti-clickjacking).
- Fill on **explicit user action** (click an affordance / pick an entry), never
  silent auto-submit.
- Implemented over the same JS-injection path Flux already uses (`eval` into the
  tab webview), gated like other privileged surfaces.

### Passkeys / WebAuthn
- **Handled by the native webview + OS platform authenticator** — Flux does not
  reimplement WebAuthn. The vault stores passwords/TOTP, not passkeys.

### Import
- **Proton Pass — every format it exports:** CSV, ZIP (JSON/CSV inside),
  PGP-encrypted (decrypted with the user's passphrase via the pure-rust `pgp`
  crate), and raw JSON. Format is auto-detected from magic bytes + filename. The
  JSON/CSV parsers tolerate Proton's schema quirks (the `username` vs
  `itemUsername`/`itemEmail` split, header-name column mapping) and skip trashed
  + non-login items. Flux **never stores the raw export**; the user deletes it
  after import. Chrome/Bitwarden/1Password importers slot in behind the same
  `Credential` model.

## Consequences
- Autofill works offline and is engine-agnostic (injection, not an extension).
- Proton data is a **snapshot**: re-export to resync until/unless Proton offers
  an API. Documented in the import UI.
- Crypto + keychain are platform/runtime surfaces (verified by compile + the
  pure crypto/import unit tests here; behavioral verification on Windows).
