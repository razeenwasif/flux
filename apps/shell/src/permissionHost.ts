/**
 * The host a manually added site-permission rule is stored under.
 *
 * permissions.rs keys rules by `host_of(request URI)`: a URI the engine has
 * already canonicalised (lowercase, punycode) with the userinfo, port and path
 * dropped. `permissions_set` stores whatever string it is given, so input like
 * "Meet.Example.com", "localhost:3000" or a pasted "HTTPS://example.com/call"
 * made a rule that showed in the list and never matched anything. The URL
 * parser applies the same normalisation. Returns "" for input that isn't a host.
 */
export function permissionHost(raw: string): string {
  const s = raw.trim();
  if (!s) return "";
  try {
    return new URL(/^[a-z][a-z\d+.-]*:\/\//i.test(s) ? s : `https://${s}`).hostname;
  } catch {
    return "";
  }
}
