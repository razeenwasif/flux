/**
 * Parsing for the agent loop's step vocabulary (#159).
 *
 * The loop's steps are written by a model and read by regexes, and every bug in
 * that seam so far has been a quiet one — a step that didn't match fell through
 * to chat and looked like an answer. So the parsing that decides what a step
 * *is* lives here, where it can be tested against the forms the planner prompt
 * actually teaches.
 */

/** `summarise <path> into <destination>` — read one document and draft a note
 *  for it, rather than accumulating a folder and writing once at the end. */
export interface SummariseStep {
  path: string;
  dest: string;
}

/**
 * Matches `summarise <path> into <where>`, both spellings, with optional quotes.
 *
 * The destination is deliberately free text ("my Optimization notebook",
 * "onyx under 00 - Optimization"): it's handed to the note planner, which
 * already resolves names against the vault's real folders, so constraining the
 * grammar here would only reject phrasings that work.
 *
 * `into` is matched as the LAST occurrence, so a path containing the word — and
 * `~/Courses/Intro to Optimization/` is exactly that — doesn't split in the
 * wrong place.
 */
export function parseSummarise(raw: string): SummariseStep | null {
  const m = /^\s*summari[sz]e\s+([\s\S]+)$/i.exec(raw.trim());
  if (!m) return null;
  const rest = m[1]!;
  const at = rest.toLowerCase().lastIndexOf(" into ");
  if (at < 0) return null;
  const unquote = (s: string) =>
    s
      .trim()
      .replace(/^["']|["']$/g, "")
      .trim();
  const path = unquote(rest.slice(0, at));
  const dest = unquote(rest.slice(at + " into ".length));
  if (!path || !dest) return null;
  return { path, dest };
}

/**
 * The request handed to the note planner for one document.
 *
 * Says explicitly to append when the note already exists: the first document
 * creates it and every later one has to land in the same place, or a folder of
 * lectures becomes a folder of one-lecture notes. The planner sees the vault's
 * existing notes on each call, so by the second document the target is there to
 * be found — it just has to be told to prefer it.
 */
export function summariseRequest(name: string, dest: string): string {
  return (
    `Summarise the document "${name}" and add it to ${dest}. ` +
    `If a note for ${dest} already exists, APPEND a section for "${name}" to it rather than ` +
    `creating a second note. Head the section with the document's name so the note reads as a ` +
    `series of summaries. Summarise only this one document — the others are handled separately.`
  );
}
