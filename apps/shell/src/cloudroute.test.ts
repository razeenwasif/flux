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

  it("recomputes `active` instead of trusting it", () => {
    // The wire claiming active-without-a-backend is exactly the bug that would
    // put prompts somewhere the indicator doesn't admit to.
    expect(asRoute({ requested: true, available: false, active: true }).active).toBe(false);
    // …and the reverse: a reply that under-reports must not hide a live route.
    expect(asRoute({ requested: true, available: true, active: false }).active).toBe(true);
  });

  it("passes through the one state that means cloud", () => {
    expect(asRoute({ requested: true, available: true, active: true })).toEqual({
      requested: true,
      available: true,
      active: true,
    });
  });

  it("distinguishes 'key stored' from 'actually escalated'", () => {
    // Storing a key must not by itself route anything — it only makes the
    // switch available.
    const keyed = asRoute({ requested: false, available: true, active: false });
    expect(keyed.available).toBe(true);
    expect(keyed.active).toBe(false);
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
