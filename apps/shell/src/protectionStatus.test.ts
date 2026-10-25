import { expect, it } from "vitest";
import { protectionMetrics, protectionStatus, requestControlsHint } from "./protectionStatus";
import type { ShieldsStatus } from "./ipc";

const webkit: ShieldsStatus = {
  backend: "webkit",
  request_metrics: false,
  request_controls: false,
  attachment: "attached",
  enabled: true,
  blocked: 0,
  rules_fired: 0,
  cache_hit_pct: 0,
  cache_len: 0,
  sites_off: [],
  site_controls: false,
  element_picker: false,
  page_blocked: 0,
  page_domains: [],
  site_hidden: 0,
};
it("does not present unavailable request counters as zero blocked", () => {
  expect(protectionMetrics(webkit)).toContain("unavailable");
  expect(protectionMetrics(null)).toContain("Checking");
  expect(requestControlsHint(webkit)).toContain("fixed native rule list");
  expect(requestControlsHint({ ...webkit, backend: "unsupported" })).toContain("unavailable");
  expect(requestControlsHint(null)).toContain("could not be loaded");
});
it("distinguishes rule attachment, failure, pending and missing reports", () => {
  expect(protectionStatus(webkit, true)).toContain("attached");
  expect(protectionStatus({ ...webkit, attachment: "failed" }, true)).toContain("Close and reopen");
  expect(protectionStatus({ ...webkit, attachment: "pending" }, true)).toContain("Preparing");
  expect(protectionStatus({ ...webkit, attachment: "not_requested" }, true)).toContain("not been confirmed");
  expect(protectionStatus(webkit, false)).toContain("Open a web page");
});
it("counts WebKit's blocks without claiming which rules fired", () => {
  const mac = { ...webkit, request_metrics: true, site_controls: true, blocked: 1234, rules_fired: 0 };
  expect(protectionMetrics(mac)).toBe(`${(1234).toLocaleString()} blocked this session`);
  expect(protectionStatus({ ...mac, enabled: false }, true)).toContain("turned off");
  expect(protectionStatus({ ...mac, sites_off: ["example.com"] }, true, "example.com")).toContain(
    "off for this site",
  );
  expect(requestControlsHint(mac)).toContain("HTTPS-only");
});
it("does not equate an attached Windows interceptor with enabled blocking", () => {
  const windows = {
    ...webkit,
    backend: "webview2",
    request_controls: true,
    request_metrics: true,
    site_controls: true,
  };
  expect(protectionStatus({ ...windows, enabled: false }, true)).toContain("turned off");
  expect(protectionStatus({ ...windows, sites_off: ["example.com"] }, true, "example.com")).toContain(
    "off for this site",
  );
});
