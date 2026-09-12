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
it("does not equate an attached Windows interceptor with enabled blocking", () => {
  const windows = { ...webkit, backend: "webview2", request_controls: true, request_metrics: true };
  expect(protectionStatus({ ...windows, enabled: false }, true)).toContain("turned off");
  expect(protectionStatus({ ...windows, sites_off: ["example.com"] }, true, "example.com")).toContain(
    "off for this site",
  );
});
