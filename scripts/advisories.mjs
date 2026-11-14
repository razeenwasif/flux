#!/usr/bin/env node
/**
 * Dependency-advisory gate (Flux Hardening Plan, Layer 6).
 *
 * Looks every locked dependency up in the OSV database (https://osv.dev), which
 * carries both RustSec and GitHub advisories, and fails when one has an advisory
 * nobody has looked at:
 *
 *   • Cargo.lock        — every crate from crates.io (path crates, such as the
 *                          vendored Tauri, have no registry entry to look up).
 *   • package-lock.json — every npm package, build tools included: a
 *                          compromised build tool reaches the release too.
 *
 * An advisory that can't be fixed yet (the fix is a breaking release, or the
 * crate is only reached on a path Flux doesn't use) goes in
 * scripts/advisories-allow.json with the reason and a date to look again. Past
 * that date the entry stops counting and the gate fails, so "accepted for now"
 * can't quietly become "accepted for good". An entry may name a `version`, and
 * then covers only that copy of the package.
 *
 * "Unmaintained" notices are printed but don't fail the gate, as with
 * `cargo audit`: they say a crate has no maintainer, not that it has a hole.
 *
 * Only package names and versions leave the machine. Nothing is installed.
 *
 * Usage:  node scripts/advisories.mjs [--json]
 * Exit code 1 for an unreviewed advisory, 2 when OSV couldn't be reached (a
 * gate that passes when it couldn't look isn't a gate).
 */
import { readFileSync, realpathSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OSV = "https://api.osv.dev/v1";
const CRATES_IO = "registry+https://github.com/rust-lang/crates.io-index";

/** Crates from crates.io in a Cargo.lock, as `{ecosystem, name, version}`. */
export function cargoPackages(lockText) {
  const found = [];
  for (const block of lockText.split("[[package]]").slice(1)) {
    const name = /^name = "([^"]+)"/m.exec(block)?.[1];
    const version = /^version = "([^"]+)"/m.exec(block)?.[1];
    const source = /^source = "([^"]+)"/m.exec(block)?.[1];
    if (name && version && source === CRATES_IO) found.push({ ecosystem: "crates.io", name, version });
  }
  return found;
}

/** Installed packages in a package-lock.json (v2 or v3), once per name and version. */
export function npmPackages(lock) {
  const seen = new Map();
  for (const [path, entry] of Object.entries(lock.packages ?? {})) {
    // "" is the project itself, and a `link` is a workspace of this repository.
    // Only what is installed from the registry: "" is the project itself, a
    // path outside node_modules is one of its workspaces, and a `link` points
    // at one.
    if (!path.includes("node_modules/") || entry.link || !entry.version) continue;
    const name = entry.name ?? path.slice(path.lastIndexOf("node_modules/") + "node_modules/".length);
    seen.set(`${name}@${entry.version}`, { ecosystem: "npm", name, version: entry.version });
  }
  return [...seen.values()];
}

/**
 * One finding per advisory per package. OSV lists the same advisory under each
 * of its ids (a RUSTSEC id and a GHSA id, say), so ids that name each other as
 * aliases are folded together.
 *
 * `hits` is `[{pkg, ids}]`; `details` maps an id to its OSV record.
 */
export function groupFindings(hits, details) {
  const findings = [];
  for (const { pkg, ids } of hits) {
    const groups = [];
    for (const id of ids) {
      const names = new Set([id, ...(details.get(id)?.aliases ?? [])]);
      const group = groups.find((g) => [...names].some((n) => g.has(n)));
      if (group) for (const n of names) group.add(n);
      else groups.push(names);
    }
    for (const group of groups) {
      const own = ids.filter((id) => group.has(id)).sort();
      const records = own.map((id) => details.get(id)).filter(Boolean);
      const affected = records.flatMap((r) => r.affected ?? []).filter((a) => a.package?.name === pkg.name);
      const kind = affected.map((a) => a.database_specific?.informational).find(Boolean) ?? "vulnerability";
      const fixed = [
        ...new Set(
          affected.flatMap((a) =>
            (a.ranges ?? []).flatMap((r) => (r.events ?? []).map((e) => e.fixed).filter(Boolean)),
          ),
        ),
      ];
      const summary = records.map((r) => r.summary).find(Boolean) ?? "";
      findings.push({ ...pkg, ids: own, kind, fixed, summary });
    }
  }
  return findings;
}

/**
 * Sort findings into what fails the gate and what doesn't.
 *
 * `allow` is the allow-list; `today` is `YYYY-MM-DD`. An allow-list entry
 * covers a finding when the ecosystem and package match and its `id` is any of
 * the finding's ids.
 */
export function judge(findings, allow, today) {
  const failures = [];
  const warnings = [];
  const allowed = [];
  const used = new Set();
  for (const finding of findings) {
    const entry = allow.find(
      (a) =>
        a.ecosystem === finding.ecosystem &&
        a.package === finding.name &&
        // An entry can be for one version: the reason a crate is acceptable
        // where one dependency pulls it in says nothing about another copy.
        (a.version === undefined || a.version === finding.version) &&
        finding.ids.includes(a.id),
    );
    if (entry) used.add(entry);
    if (finding.kind === "unmaintained" || finding.kind === "notice") {
      warnings.push({ ...finding, why: `${finding.kind} notice` });
    } else if (!entry) {
      failures.push({ ...finding, why: "not reviewed" });
    } else if (!entry.reason || !/^\d{4}-\d{2}-\d{2}$/.test(entry.review ?? "")) {
      failures.push({
        ...finding,
        why: "its allow-list entry needs a reason and a review date (YYYY-MM-DD)",
      });
    } else if (entry.review < today) {
      failures.push({ ...finding, why: `its allow-list entry was due for review on ${entry.review}` });
    } else {
      allowed.push({ ...finding, why: entry.reason, review: entry.review });
    }
  }
  const stale = allow.filter((a) => !used.has(a));
  return { failures, warnings, allowed, stale };
}

async function osv(path, body) {
  let last;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await fetch(`${OSV}${path}`, {
        method: body ? "POST" : "GET",
        headers: body ? { "content-type": "application/json" } : undefined,
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok) throw new Error(`OSV answered ${response.status} for ${path}`);
      return await response.json();
    } catch (error) {
      last = error;
    }
  }
  throw last;
}

/** The advisory ids OSV holds for each package, as `[{pkg, ids}]` for those with any. */
async function lookUp(packages) {
  const hits = [];
  const query = (pkg, page_token) => ({
    package: { name: pkg.name, ecosystem: pkg.ecosystem },
    version: pkg.version,
    ...(page_token ? { page_token } : {}),
  });
  for (let start = 0; start < packages.length; start += 500) {
    const chunk = packages.slice(start, start + 500);
    const { results } = await osv("/querybatch", { queries: chunk.map((pkg) => query(pkg)) });
    // An answer for fewer packages than were asked about isn't a clean bill.
    if (!Array.isArray(results) || results.length !== chunk.length) {
      throw new Error(`OSV answered for ${results?.length ?? 0} of ${chunk.length} packages`);
    }
    for (const [i, result] of results.entries()) {
      const ids = (result.vulns ?? []).map((v) => v.id);
      // A package with more advisories than one page holds: ask for the rest.
      let token = result.next_page_token;
      while (token) {
        const more = await osv("/query", query(chunk[i], token));
        ids.push(...(more.vulns ?? []).map((v) => v.id));
        token = more.next_page_token;
      }
      if (ids.length) hits.push({ pkg: chunk[i], ids: [...new Set(ids)] });
    }
  }
  return hits;
}

async function fetchDetails(ids) {
  const details = new Map();
  const queue = [...new Set(ids)];
  await Promise.all(
    Array.from({ length: 8 }, async () => {
      for (let id = queue.pop(); id; id = queue.pop())
        details.set(id, await osv(`/vulns/${encodeURIComponent(id)}`));
    }),
  );
  return details;
}

const line = (f) =>
  `  ${f.ecosystem === "npm" ? "npm  " : "crate"} ${f.name} ${f.version}  ${f.ids.join(", ")}` +
  `${f.fixed.length ? `  (fixed in ${f.fixed.join(", ")})` : ""}\n      ${f.summary || "(no summary)"}\n      → ${f.why}`;

async function main() {
  const json = process.argv.includes("--json");
  const packages = [
    ...cargoPackages(readFileSync(join(ROOT, "Cargo.lock"), "utf8")),
    ...npmPackages(JSON.parse(readFileSync(join(ROOT, "package-lock.json"), "utf8"))),
  ];
  const allow = JSON.parse(readFileSync(join(ROOT, "scripts/advisories-allow.json"), "utf8"));
  let findings;
  try {
    const hits = await lookUp(packages);
    findings = groupFindings(hits, await fetchDetails(hits.flatMap((h) => h.ids)));
  } catch (error) {
    console.error(`advisories: couldn't reach OSV, so nothing was checked: ${error.message}`);
    process.exit(2);
  }
  const today = new Date().toISOString().slice(0, 10);
  const verdict = judge(findings, allow, today);
  if (json) {
    console.log(JSON.stringify({ checked: packages.length, ...verdict }, null, 2));
  } else {
    console.log(`advisories: ${packages.length} locked packages checked against OSV`);
    if (verdict.failures.length)
      console.log(
        `\nUNREVIEWED (${verdict.failures.length}), failing:\n${verdict.failures.map(line).join("\n")}`,
      );
    if (verdict.allowed.length)
      console.log(
        `\nAccepted for now (${verdict.allowed.length}):\n${verdict.allowed.map((f) => `${line(f)} (look again by ${f.review})`).join("\n")}`,
      );
    if (verdict.warnings.length)
      console.log(
        `\nNotices (${verdict.warnings.length}), not failing:\n${verdict.warnings.map((f) => `  ${f.name} ${f.version}  ${f.ids.join(", ")}  ${f.why}`).join("\n")}`,
      );
    if (verdict.stale.length)
      console.log(
        `\nAllow-list entries that match nothing now, remove them:\n${verdict.stale.map((a) => `  ${a.package}  ${a.id}`).join("\n")}`,
      );
    console.log(verdict.failures.length ? "\nadvisories: FAILED" : "\nadvisories: ok");
  }
  process.exit(verdict.failures.length ? 1 : 0);
}

// Run when this file is the script, through a symlinked path too (Node resolves
// the module's own URL but not argv). Imported by the tests, it only exports.
const invoked = (() => {
  try {
    return pathToFileURL(realpathSync(process.argv[1] ?? "")).href;
  } catch {
    return "";
  }
})();
if (import.meta.url === invoked) await main();
