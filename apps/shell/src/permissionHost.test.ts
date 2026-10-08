import { describe, expect, it } from "vitest";

import { permissionHost } from "./permissionHost";

/**
 * A rule is looked up by the exact host of the requesting page, so anything the
 * manual "Add" field stores has to be in that form, or the rule is listed as if
 * it worked and silently never applies.
 */
describe("permission rule host", () => {
  it("keeps a plain host as it is", () => {
    expect(permissionHost("example.com")).toBe("example.com");
    expect(permissionHost("  www.example.com  ")).toBe("www.example.com");
  });

  it("lowercases, as the engine's request URI already is", () => {
    expect(permissionHost("Meet.Example.com")).toBe("meet.example.com");
  });

  it("drops the port, userinfo and path", () => {
    expect(permissionHost("localhost:3000")).toBe("localhost");
    expect(permissionHost("http://localhost:3000/app")).toBe("localhost");
    expect(permissionHost("https://user@h.com:8443/p?q")).toBe("h.com");
  });

  it("reads a scheme in any case", () => {
    // The old lowercase-only scheme strip turned this into the key "HTTPS:".
    expect(permissionHost("HTTPS://example.com/call")).toBe("example.com");
  });

  it("uses the punycode form for an internationalised name", () => {
    expect(permissionHost("bücher.de")).toBe("xn--bcher-kva.de");
  });

  it("rejects input that isn't a host", () => {
    expect(permissionHost("")).toBe("");
    expect(permissionHost("   ")).toBe("");
    expect(permissionHost("exa mple.com")).toBe("");
    expect(permissionHost("file:///etc/hosts")).toBe("");
  });
});
