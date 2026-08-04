/**
 * "Did the user just ask me to *do* something, rather than answer something?"
 *
 * The agent has real tools — list a directory, read a file, run a command,
 * propose an edit, draft a note — but they only ran behind `/task` and `/fix`.
 * A plain sentence went to ordinary chat, which has **no tools at all**, and the
 * model didn't know that. So a request like
 *
 *     "in /home/me/slides/ you'll find some lecture PDFs. Go through all of them
 *      and summarize them into my Optimization notebook"
 *
 * produced a confident plan ("I will list the files, then read them, then use
 * /note…"), then an offer to begin, then the same offer again — a narration
 * loop, because narrating was the only thing it could actually do. The user has
 * to already know a slash command exists to get the capability that exists.
 *
 * This closes that gap the same way [[noteintent]] closed it for writing: detect
 * the intent and route to the loop. It can afford to be generous for the same
 * reason — **every side-effecting step in the loop asks first**. Shell commands
 * get a Run card, edits get a diff, notes get the exact text. A false positive
 * costs a visible plan the user can stop; a false negative costs the feature and
 * produces the loop above.
 *
 * What it must NOT fire on is a *question*, which is the overwhelmingly common
 * case: "what's in that folder", "how do I read a PDF in Rust", "summarise this
 * page". Those are chat, and chat answers them well.
 */

/** Verbs that ask for work to happen, not for information to come back. */
const DO =
  /\b(go through|read|open|list|scan|check|look through|summari[sz]e|extract|convert|rename|move|copy|delete|create|generate|build|run|execute|install|fix|refactor|update|write|add|append|save|organi[sz]e|sort|index|process|compile|test)\b/i;

/**
 * Something concrete to act ON. Without this, "summarise this" is just chat
 * about the current page — which is a real feature and must keep working.
 *
 * Three separate patterns rather than one alternation: a path has to start at a
 * word boundary (or a bare `/` matches inside "and/or"), while a filename must
 * NOT be anchored that way, or `src/kb.rs` never matches — the `/` before it
 * isn't whitespace.
 */
const PATH = /(^|\s)(~?\/[\w.\-/]+|[A-Za-z]:\\[\w.\-\\]+)/;
const FILE = /\b[\w-][\w.-]*\.(?:pdf|md|txt|rs|ts|tsx|js|py|json|toml|yaml|yml|csv|html|css|sh)\b/i;
// Deliberately NOT "notebook"/"notes": those are where work *ends up*, not work
// to be done. "save this into my Convex notebook" is a one-shot note write and
// belongs to [[noteintent]], not to a multi-step loop.
const NOUN =
  /\b(?:folder|directory|dir|files?|pdfs?|slides?|repo|repository|codebase|terminal|tests?|test suite|build)\b/i;
const hasObject = (t: string): boolean => PATH.test(t) || FILE.test(t) || NOUN.test(t);

/** Phrasing that only makes sense across several items or several steps. */
const MULTI =
  /\b(all of them|each of them|each one|every (?:file|one|pdf|slide|note)|one by one|for each|then|after that|and then|go through)\b/i;

/**
 * Openers that make the sentence a question. Checked first and hard — a
 * question that happens to name a path ("what's in /etc/hosts?") is still a
 * question.
 */
const ASKING =
  /^\s*(what|which|when|where|who|whom|whose|why|how|is|are|was|were|do|does|did|can|could|should|would|will|shall|may|might|have|has|explain|tell me (?:about|what)|any\b)/i;

/**
 * A trailing question mark means it's a question no matter how it opens —
 * "go through the folder and tell me what's there?" is a request for an answer.
 * Only when there is no imperative multi-step framing, though, since users do
 * write "can you go through all of them and summarise them?" and mean it.
 */
const looksInterrogative = (t: string): boolean => ASKING.test(t) && !MULTI.test(t);

/** Requests the panel already routes elsewhere; this must not steal them. */
const ALREADY_ROUTED = /^\s*\/(?:task|fix|auto|iterate|note|act|do|pac|run|exec|shell|terminal)\b/i;

export const looksAgentic = (text: string): boolean => {
  const t = text.trim();
  if (!t || ALREADY_ROUTED.test(t)) return false;
  // Very short messages are conversational ("do it", "yes", "go on"). The loop
  // needs a goal it can re-plan against, and three words is never that.
  if (t.split(/\s+/).length < 5) return false;
  if (looksInterrogative(t)) return false;
  if (!DO.test(t)) return false;
  // Needs *either* a concrete object (a path, a file, a folder) or explicit
  // multi-step framing. One alone is enough; neither means it's chat.
  return hasObject(t) || MULTI.test(t);
};
