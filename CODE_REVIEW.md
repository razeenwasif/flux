# Flux Code Review

## Scope and validation

This review covers the Rust backend, remote-page IPC, SolidJS lifecycle handling, filesystem operations, persistence, agent execution, dependencies, and CI configuration.

Validation performed:

- TypeScript checking passed.
- Frontend tests: 106 passed, 1 failed in `theme.test.ts`.
- Rust tests: 469 passed when the newline-only binding assertion was excluded.
- Reproduced the Solid cleanup failure, executable hibernation interpolation, junction escape, and concurrent persistence failure with isolated probes.
- Authorized npm audit found affected `browserslist` and `nanoid` packages.

## 1. Critical Bugs & Runtime Errors

### 1. [P1] Lazy initialization allows callers to use partially loaded stores — [Medium Effort]

**Location:** `crates/flux-core/src/trace/store.rs:183`, `TraceStore::hydrate`; `crates/flux-core/src/fsroots.rs:70`; `crates/flux-core/src/kb.rs:422`.

**Issue & impact:** `swap(true)` marks initialization complete before disk loading finishes. A second caller proceeds immediately. In the Trail, recording one visit during loading can cause the “store is empty” check to discard persisted history. In `RootsStore`, a concurrent check can see `enabled: false` and temporarily allow unrestricted file access.

**Suggested fix:** Use an initialization primitive that blocks concurrent callers until loading completes.

```rust
// Before
if self.hydrated.swap(true, Ordering::AcqRel) {
    return;
}
self.load_from_disk();

// After
self.initialized.call_once(|| {
    self.load_from_disk();
});
```

Add a regression test that pauses the initial load and verifies a second read/write waits without losing persisted records or bypassing restrictions.

### 2. [P1] Approved agent actions can execute in a different tab — [Medium Effort]

**Location:** `crates/flux-core/src/agent.rs:668`, `agent_run_action`; `apps/shell/src/AgentPanel.tsx:2597`, `approve`.

**Issue & impact:** Planning returns an action without its originating tab or document identity. Approval executes against whichever tab is active at that moment. An action planned in tab A can therefore act on tab B.

**Suggested fix:** Bind every proposal to a tab and navigation generation, then reject it if the document changed.

```rust
// Before
let tab = state.active_tab().ok_or("no active tab")?;
webview.eval(action.to_js())?;

// After
let proposal = pending.take(proposal_id)?;
ensure_document_current(proposal.tab, proposal.navigation_id)?;
eval_in_document(proposal.tab, proposal.navigation_id, proposal.action)?;
```

### 3. [P1] Pasting a folder into its descendant recursively copies the output — [Quick Win]

**Location:** `crates/flux-core/src/files.rs:1041`, `copy_recursive`; `crates/flux-core/src/files.rs:1175`, `fs_copy`; `fs_move`.

**Issue & impact:** The destination is created before enumerating the source. Copying `A` into `A/subfolder` causes traversal to discover its own output repeatedly, consuming disk. The backend also lacks the frontend’s descendant check. Move fallback currently treats every rename error as copyable.

**Suggested fix:** Canonicalize the source and destination parent, reject descendant destinations, and restrict move fallback to cross-device errors.

```rust
let source = src.canonicalize()?;
let destination = canonical_destination(&target)?;
if destination.starts_with(&source) {
    return Err("cannot copy a directory into itself".into());
}
copy_recursive(&source, &destination)?;
```

### 4. [P2] Terminal cleanup is registered outside Solid’s ownership scope — [Medium Effort]

**Location:** `apps/shell/src/TerminalView.tsx:150`, asynchronous `onMount`; cleanup at line 452.

**Issue & impact:** After the first `await`, Solid’s component owner is absent. `onCleanup` therefore does not register the teardown. Closing terminals can retain xterm/WebGL resources, observers, event subscriptions, and PTY sessions. Reactive effects created after the import have the same ownership problem.

**Suggested fix:** Register cleanup synchronously and handle disposal during initialization.

```ts
let disposed = false;
let teardown = () => {};

onCleanup(() => {
  disposed = true;
  teardown();
});

onMount(() => {
  void initialize().then((cleanup) => {
    if (disposed) cleanup();
    else teardown = cleanup;
  }).catch(reportError);
});
```

## 2. Security & Data Integrity

### 5. [P1] Hibernation state permits JavaScript execution in another tab — [Medium Effort]

**Location:** `crates/flux-core/src/hibernate.rs:75`, `hibernate_capture`; `crates/flux-core/src/webview.rs:251`, restoration.

**Issue & impact:** A remote page supplies both an arbitrary `tab_id` and an unrestricted string. That string is later interpolated into executable JavaScript when the selected tab wakes. A hostile page can overwrite another tab’s state and arrange execution in that tab’s origin.

**Suggested fix:** Derive the tab from the invoking webview, deserialize a bounded structure, and serialize it safely.

```rust
let tab = caller_tab(&webview)?;
let captured: HibernateState = serde_json::from_str(&state)?;
captured.validate_limits()?;
store.capture(tab, webview.url()?, captured);

let json = serde_json::to_string(&captured)?;
eval(format!("window.__fluxRestore&&window.__fluxRestore({json})"));
```

### 6. [P1] DOM publication trusts page-supplied identity and provenance — [Medium Effort]

**Location:** `crates/flux-core/src/dom.rs:108`, `dom_publish`.

**Issue & impact:** Any authorized remote page can submit another tab’s ID and an invented URL. This overwrites another tab’s cached context/title and poisons agent context, history, Trail records, and optional Omni ingestion.

**Suggested fix:** Obtain identity from the invoking webview, require a live tab, and validate the reported URL against native navigation state.

```rust
let tab_id = caller_tab(&webview)?;
let tab = state.tabs.get(&tab_id).ok_or("unknown tab")?;
validate_reported_url(&webview.url()?, &url)?;
let private = tab.private;
```

### 7. [P1] Autofill authorizes against stale, scheme-less tab metadata — [Medium Effort]

**Location:** `crates/flux-core/src/vault.rs:595`, `vault_fill`; `crates/flux-core/src/vault.rs:806`, `tab_host`; `apps/shell/src/App.tsx:699`.

**Issue & impact:** Credential checks use the stored tab URL, which the frontend updates only after page load finishes. After navigation from a trusted site to a hostile site, the new page can request autofill while the backend still associates the tab with the previous host. Host-only matching also allows an HTTPS credential to match an HTTP page.

**Suggested fix:** Authorize against the live native URL, require an appropriate secure origin, and recheck document identity at injection.

```rust
let current = webview.url()?;
require_secure_credential_origin(&current)?;
let credential = matching_credential(&current)?;
eval_fill_if_document_unchanged(&webview, &current, credential)?;
```

### 8. [P1] New-file writes can escape allowed roots through junctions — [Medium Effort]

**Location:** `crates/flux-core/src/fsroots.rs:126`, `resolve`; `agent_write_text_file`.

**Issue & impact:** Canonicalization fails for a nonexistent file, so the check falls back to lexical normalization. An allowed directory containing a junction or symlink to an outside directory therefore permits creation outside the allowance. This was reproduced with a temporary Windows junction.

**Suggested fix:** Resolve the existing parent for new files, reject unresolved security checks, and use the same resolved filesystem representation for authorization and access.

```rust
let parent = candidate.parent().ok_or("missing parent")?.canonicalize()?;
let resolved = parent.join(candidate.file_name().ok_or("missing name")?);
ensure_within_allowed_roots(&resolved)?;
```

For resistance to concurrent link replacement, use handle-relative filesystem operations.

### 9. [P1] Vault read/decryption failures become an empty writable vault — [Medium Effort]

**Location:** `crates/flux-core/src/vault.rs:120`, `hydrate_keychain`; `obtain_key` and `write_open`.

**Issue & impact:** A failed decryption logs an error and substitutes `Vault::default()`. The next saved credential overwrites the existing vault. A temporary keychain failure can trigger this by selecting a different file-backed key.

**Suggested fix:** Distinguish first-run absence from unreadable or undecryptable existing data. Keep the vault unavailable until its existing key/data can be recovered.

```rust
match std::fs::read(&path) {
    Ok(blob) => Vault::decrypt(&dk, &blob).map_err(load_error)?,
    Err(e) if e.kind() == std::io::ErrorKind::NotFound => Vault::default(),
    Err(e) => return Err(e.into()),
}
```

### 10. [P2] Knowledge metadata and vectors are committed independently — [Medium Effort]

**Location:** `crates/flux-core/src/kb.rs:513`, `persist`; sidecar validation at line 444.

**Issue & impact:** Metadata and vectors are written as two independent, non-atomic files. A crash between writes leaves different generations. Equal-sized generations pass the count check while pairing documents with the wrong embeddings, silently corrupting retrieval.

**Suggested fix:** Commit a generation containing both files and atomically update a manifest containing generation IDs and hashes.

```rust
let generation = write_complete_generation(json, vecs)?;
atomic_replace_manifest(generation.id, generation.hashes)?;
```

### 11. [P2] “Atomic” writes share a temporary filename within the process — [Medium Effort]

**Location:** `crates/flux-core/src/persist.rs:24`, `write_atomic`.

**Issue & impact:** The temporary filename contains only the PID. Concurrent writers to the same store can truncate or rename each other’s staging file. An isolated concurrent-write probe produced a failed write.

**Suggested fix:** Use unique temporary files and serialize each store’s snapshot-and-commit sequence.

```rust
let _commit = self.persistence_lock.lock();
let snapshot = self.snapshot();
let mut tmp = tempfile::NamedTempFile::new_in(parent)?;
write_snapshot(&mut tmp, &snapshot)?;
tmp.as_file().sync_all()?;
tmp.persist(path)?;
```

### 12. [P2] Locked build dependencies have published vulnerabilities — [Quick Win]

**Location:** `package-lock.json:2046`, Browserslist; `package-lock.json:2414`, Nano ID.

**Issue & impact:** The authorized npm audit reported:

- Browserslist 4.28.2, affected by unbounded query caching and malformed custom-stat handling; patched in 4.28.7. See [GHSA-c83g-rgw3-j3cx](https://github.com/advisories/GHSA-c83g-rgw3-j3cx) and [GHSA-73wf-gq98-2v4g](https://github.com/advisories/GHSA-73wf-gq98-2v4g).
- Nano ID 3.3.16, affected by certain zero-size custom generators looping indefinitely; patched in 3.3.18. See [GHSA-2v37-7h3g-55p8](https://github.com/advisories/GHSA-2v37-7h3g-55p8).

The observed PostCSS call uses `nanoid(6)`, so an exploitable invocation was not established for Flux.

**Suggested fix:** Refresh compatible transitive dependencies and regenerate the lockfile, then rerun the audit and build.

## 3. Performance & Resource Efficiency

### 13. [P2] Shell output is bounded only after unbounded collection — [Medium Effort]

**Location:** `crates/flux-core/src/exec.rs:147`, `run_shell`.

**Issue & impact:** `Command::output()` waits indefinitely and buffers all stdout/stderr. Truncating to 4,000 characters afterward does not limit memory. A verbose or never-ending command can exhaust memory or occupy a blocking worker indefinitely.

**Suggested fix:** Drain both pipes concurrently with bounded retained output, enforce a deadline, and kill/reap the process tree on cancellation.

```rust
let output = run_bounded(
    command,
    Duration::from_secs(60),
    OutputLimit::Bytes(64 * 1024),
    cancellation,
).await?;
```

### 14. [P2] One blocked terminal write locks every terminal session — [Medium Effort]

**Location:** `crates/flux-core/src/terminal.rs:342`, `terminal_write`.

**Issue & impact:** The global session-map mutex remains held across blocking `write_all` and `flush`. If a PTY stops consuming input, a large paste can block writes, resizing, and session removal for unrelated terminals.

**Suggested fix:** Store `Arc<Session>` values, release the map lock before I/O, and perform writes through a bounded per-session worker.

```rust
let session = {
    manager.sessions.lock().get(&id).cloned().ok_or("missing")?
};
session.input_queue.send(data).await?;
```

## 4. Architecture, Maintainability & Best Practices

### 15. [P2] Binding verification fails on unchanged Windows checkouts — [Quick Win]

**Location:** `crates/flux-core/src/bindings.rs:251`, `bindings_up_to_date`.

**Issue & impact:** The test compares raw strings, so CRLF checkout conversion produces a false schema-drift failure. The generated and checked-in contents are identical after newline normalization.

**Suggested fix:** Normalize newlines for comparison or enforce LF for generated files.

```rust
assert_eq!(
    existing.replace("\r\n", "\n"),
    generated.replace("\r\n", "\n")
);
```

### 16. [P2] CI does not run the general correctness suites — [Quick Win]

**Location:** `.github/workflows/perf.yml`.

**Issue & impact:** The workflow builds assets, checks performance budgets, tests binding generation, and runs benchmarks. It does not run the frontend unit suite, TypeScript checking, or the complete Rust tests. The currently failing frontend theme-policy test can therefore reach a green performance workflow.

**Suggested fix:** Add correctness jobs with the necessary platform dependencies.

```yaml
- run: cargo test --workspace --locked
- run: npm run typecheck --workspace apps/shell
- run: npm run test --workspace apps/shell
```

## Outstanding validation issue

The frontend suite currently has one failure in `apps/shell/src/theme.test.ts`: hardcoded backdrop-filter declarations are not covered by the test’s mobile-neutralization list. The Rust binding test failure is newline-only on Windows; normalized contents match.
