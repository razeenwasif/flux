export const FAVORITES_KEY = "flux.launcher.favorites";
export const DEFAULT_FAVORITES = ["page:flux://notebook", "page:flux://history", "page:flux://settings"];
export function readFavorites(raw: string | null): string[] {
  if (raw === null) return [...DEFAULT_FAVORITES];
  try {
    const value: unknown = JSON.parse(raw);
    if (!Array.isArray(value)) return [...DEFAULT_FAVORITES];
    return [
      ...new Set(
        value.filter(
          (id): id is string => typeof id === "string" && /^(page:flux:\/\/|terminal:).+/.test(id),
        ),
      ),
    ].slice(0, 6);
  } catch {
    return [...DEFAULT_FAVORITES];
  }
}
export function matchesLauncher(query: string, ...fields: string[]): boolean {
  const haystack = fields.join(" ").toLocaleLowerCase();
  return query
    .trim()
    .toLocaleLowerCase()
    .split(/\s+/)
    .every((word) => haystack.includes(word));
}
