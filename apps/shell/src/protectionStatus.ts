import type { ShieldsStatus } from "./ipc";

export function protectionStatus(
  status: ShieldsStatus | null,
  webPage: boolean,
  host: string | null = null,
): string {
  if (!status) return "Protection status unavailable.";
  if (status.backend === "unsupported") return "Native request blocking is unavailable on this platform.";
  if (!webPage) return "Open a web page to check its protection.";
  if (status.attachment === "failed")
    return "Rules could not be attached. Close and reopen this tab to retry.";
  if (status.attachment === "pending") return "Preparing protection for this page…";
  if (status.attachment !== "attached") return "Protection has not been confirmed for this page.";
  if (status.request_controls && !status.enabled) return "Request blocking is turned off.";
  if (status.request_controls && host && status.sites_off.includes(host))
    return "Request blocking is turned off for this site.";
  return status.backend === "webkit"
    ? "Native blocking rules attached to this page."
    : "Request filter attached to this page.";
}

export const protectionMetrics = (status: ShieldsStatus | null): string =>
  !status
    ? "Checking protection…"
    : status.request_metrics
      ? `${status.blocked.toLocaleString()} blocked this session · ${status.rules_fired} rules matched`
      : "Blocked-request counts are unavailable on this platform.";

export const requestControlsHint = (status: ShieldsStatus | null): string =>
  !status
    ? "Protection capabilities could not be loaded."
    : status.backend === "webkit"
      ? "This platform uses a fixed native rule list. Request-blocking switches, HTTPS-only upgrades and Lean mode are not supported yet."
      : "Native request blocking, HTTPS-only upgrades and Lean mode are unavailable on this platform.";
