/**
 * Reading the agent's route safely (#175).
 *
 * One signal drives the indicator that tells the user whether what they type
 * leaves their machine. Everything about interpreting it is here, as pure
 * functions, because the failure modes are silent ones: an indicator that reads
 * "local" while requests go to Google is a privacy bug, and an indicator stuck
 * on "cloud" after a failed escalation trains the user to ignore it.
 */

/** Where the agent's next request goes. Mirrors Rust's `RouteStatus`. */
export interface Route {
  /** The user asked for cloud. */
  requested: boolean;
  /** A cloud backend is configured and usable. */
  available: boolean;
  /** The next request will leave this machine. */
  active: boolean;
}

/** The only state we are ever willing to assume. */
export const LOCAL: Route = { requested: false, available: false, active: false };

/**
 * Coerce an untrusted value (an IPC reply, a mock, `undefined` from a command
 * the backend doesn't have) into a `Route`.
 *
 * `active` is **recomputed** rather than trusted: it is the field the UI acts
 * on, and deriving it from the other two means a reply can't claim traffic is
 * local while asking for cloud, or vice versa. Anything unrecognised reads as
 * [`LOCAL`] — if the call didn't work, nothing escalated, so local is both the
 * safe answer and the true one.
 */
export function asRoute(v: unknown): Route {
  const r = v as Partial<Route> | null | undefined;
  const available = r?.available === true;
  const requested = r?.requested === true;
  return { requested, available, active: requested && available };
}

/**
 * What the model button says. The word — not the colour — carries the meaning,
 * so it survives a screenshot, a colourblind reader, and a theme change.
 */
export function routeLabel(route: Route, localModel: string, cloudModel: string): string {
  if (route.active) {
    const short = (cloudModel || "gemini").split("-")[0]!;
    return `☁ ${short} · cloud`;
  }
  return `${localModel || "gemma"} · local`;
}
