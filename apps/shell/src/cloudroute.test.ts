import { describe, expect, it } from "vitest";

import { LOCAL, asRoute, routeLabel } from "./cloudroute";

describe("agent route", () => {
  it("treats anything unrecognised as local", () => {
    // A command the backend doesn't have resolves to undefined; a mock may
    // return a partial. None of those may render as "your words are leaving".
    for (const bad of [undefined, null, {}, "cloud", 1, [], { active: true }]) {
      expect(asRoute(bad), String(JSON.stringify(bad))).toEqual(LOCAL);
    }
  });

  it("never shows cloud without a request behind it", () => {
    // Only Rust knows whether a backend is live, so `active` is trusted — but it
    // is gated on `requested`, so no reply can flip the indicator on its own.
    expect(asRoute({ requested: false, available: true, active: true }).active).toBe(false);
    expect(asRoute({ requested: true, available: true, active: true }).active).toBe(true);
  });

  it("believes Rust when it says a request isn't routing", () => {
    // `available` means "a key exists", not "a backend is live" — so deriving
    // `active` from it would claim escalation that hasn't happened.
    expect(asRoute({ requested: true, available: true, active: false }).active).toBe(false);
  });

  it("offers escalation from a stored key alone", () => {
    // Regression: `available` used to mean "a backend is installed", which only
    // becomes true *after* escalating — so the escalate button never appeared and
    // a freshly saved key was reported as missing.
    const keyed = asRoute({ requested: false, available: true, active: false });
    expect(keyed.available).toBe(true);
    expect(keyed.active).toBe(false);
  });

  it("passes through the one state that means cloud", () => {
    expect(asRoute({ requested: true, available: true, active: true })).toEqual({
      requested: true,
      available: true,
      active: true,
    });
  });

  it("says which side it's on in words, not just colour", () => {
    expect(routeLabel(LOCAL, "gemma4", "")).toContain("local");
    const live = { requested: true, available: true, active: true };
    const label = routeLabel(live, "gemma4", "gemini-2.5-pro");
    expect(label).toContain("cloud");
    expect(label).toContain("gemini");
    expect(label).not.toContain("local");
  });

  it("falls back to sensible names when a model is unset", () => {
    expect(routeLabel(LOCAL, "", "")).toContain("gemma");
    expect(routeLabel({ requested: true, available: true, active: true }, "", "")).toContain("gemini");
  });
});
