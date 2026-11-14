import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { cargoPackages, groupFindings, judge, npmPackages } from "./advisories.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

test("cargoPackages keeps crates.io crates and leaves path crates out", () => {
  const lock = `
version = 4

[[package]]
name = "flux-core"
version = "0.3.0"
dependencies = [
 "rustls",
]

[[package]]
name = "rustls"
version = "0.23.46"
source = "registry+https://github.com/rust-lang/crates.io-index"
checksum = "abc"

[[package]]
name = "forked"
version = "1.0.0"
source = "git+https://example.com/forked#abc"
`;
  assert.deepEqual(cargoPackages(lock), [{ ecosystem: "crates.io", name: "rustls", version: "0.23.46" }]);
});

test("npmPackages reads nested and scoped names, once per version, without workspaces", () => {
  const lock = {
    packages: {
      "": { name: "flux-monorepo", version: "0.1.0" },
      "apps/shell": { name: "@flux/shell", version: "0.1.0" },
      "node_modules/@flux/shell": { resolved: "apps/shell", link: true },
      "node_modules/vite": { version: "6.4.6", dev: true },
      "node_modules/@xterm/xterm": { version: "5.5.0" },
      "node_modules/a/node_modules/ms": { version: "2.0.0" },
      "node_modules/b/node_modules/ms": { version: "2.0.0" },
    },
  };
  assert.deepEqual(
    npmPackages(lock)
      .map((p) => `${p.name}@${p.version}`)
      .sort(),
    ["@xterm/xterm@5.5.0", "ms@2.0.0", "vite@6.4.6"],
  );
});

const rustls = { ecosystem: "crates.io", name: "rustls", version: "0.23.40" };

test("groupFindings folds a RUSTSEC id and its GHSA alias into one finding", () => {
  const details = new Map([
    [
      "RUSTSEC-2026-0285",
      {
        aliases: ["GHSA-aaaa-bbbb-cccc"],
        summary: "handshake messages accepted across levels",
        affected: [
          { package: { name: "rustls" }, ranges: [{ events: [{ introduced: "0" }, { fixed: "0.23.45" }] }] },
        ],
      },
    ],
    ["GHSA-aaaa-bbbb-cccc", { aliases: ["RUSTSEC-2026-0285"], affected: [{ package: { name: "rustls" } }] }],
    ["RUSTSEC-2026-0346", { summary: "Debug exposes secrets", affected: [{ package: { name: "rustls" } }] }],
  ]);
  const findings = groupFindings(
    [{ pkg: rustls, ids: ["GHSA-aaaa-bbbb-cccc", "RUSTSEC-2026-0285", "RUSTSEC-2026-0346"] }],
    details,
  );
  assert.equal(findings.length, 2);
  assert.deepEqual(findings[0].ids, ["GHSA-aaaa-bbbb-cccc", "RUSTSEC-2026-0285"]);
  assert.deepEqual(findings[0].fixed, ["0.23.45"]);
  assert.equal(findings[0].kind, "vulnerability");
  assert.deepEqual(findings[1].ids, ["RUSTSEC-2026-0346"]);
});

test("groupFindings marks an unmaintained notice as such", () => {
  const details = new Map([
    [
      "RUSTSEC-2024-0436",
      { affected: [{ package: { name: "paste" }, database_specific: { informational: "unmaintained" } }] },
    ],
  ]);
  const [finding] = groupFindings(
    [{ pkg: { ecosystem: "crates.io", name: "paste", version: "1.0.15" }, ids: ["RUSTSEC-2024-0436"] }],
    details,
  );
  assert.equal(finding.kind, "unmaintained");
});

const finding = (over = {}) => ({
  ...rustls,
  ids: ["GHSA-aaaa-bbbb-cccc", "RUSTSEC-2026-0285"],
  kind: "vulnerability",
  fixed: [],
  summary: "",
  ...over,
});
const entry = (over = {}) => ({
  ecosystem: "crates.io",
  package: "rustls",
  id: "RUSTSEC-2026-0285",
  reason: "not reachable",
  review: "2027-01-01",
  ...over,
});

test("judge fails an advisory nobody has reviewed", () => {
  const verdict = judge([finding()], [], "2026-11-14");
  assert.equal(verdict.failures.length, 1);
  assert.equal(verdict.failures[0].why, "not reviewed");
});

test("judge accepts an advisory allowed under any of its ids, until the review date", () => {
  assert.equal(judge([finding()], [entry()], "2026-11-14").failures.length, 0);
  assert.equal(judge([finding()], [entry({ id: "GHSA-aaaa-bbbb-cccc" })], "2026-11-14").allowed.length, 1);
  assert.equal(judge([finding()], [entry()], "2027-01-01").failures.length, 0);
  assert.match(judge([finding()], [entry()], "2027-01-02").failures[0].why, /due for review/);
});

test("judge doesn't let an entry for another package or ecosystem cover a finding", () => {
  assert.equal(judge([finding()], [entry({ package: "rustls-webpki" })], "2026-11-14").failures.length, 1);
  assert.equal(judge([finding()], [entry({ ecosystem: "npm" })], "2026-11-14").failures.length, 1);
});

test("judge holds a versioned entry to that version", () => {
  assert.equal(judge([finding()], [entry({ version: "0.23.40" })], "2026-11-14").failures.length, 0);
  assert.equal(judge([finding()], [entry({ version: "0.21.0" })], "2026-11-14").failures.length, 1);
});

test("judge refuses an allow-list entry without a reason or a proper date", () => {
  assert.equal(judge([finding()], [entry({ reason: "" })], "2026-11-14").failures.length, 1);
  assert.equal(judge([finding()], [entry({ review: "soon" })], "2026-11-14").failures.length, 1);
});

test("judge reports unmaintained notices without failing, and entries that match nothing", () => {
  const verdict = judge([finding({ kind: "unmaintained" })], [entry({ package: "gone" })], "2026-11-14");
  assert.equal(verdict.failures.length, 0);
  assert.equal(verdict.warnings.length, 1);
  assert.equal(verdict.stale.length, 1);
});

test("every entry in the real allow-list has a reason and a review date", () => {
  const allow = JSON.parse(readFileSync(join(ROOT, "scripts/advisories-allow.json"), "utf8"));
  for (const item of allow) {
    assert.ok(["crates.io", "npm"].includes(item.ecosystem), `${item.id}: ecosystem`);
    assert.ok(item.package && item.id, "package and id");
    assert.ok(item.reason?.length > 20, `${item.id}: say why`);
    assert.match(item.review, /^\d{4}-\d{2}-\d{2}$/, `${item.id}: review date`);
  }
});
