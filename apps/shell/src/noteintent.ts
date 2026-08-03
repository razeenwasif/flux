/**
 * "Did the user just ask me to write something into their notes?"
 *
 * `/note` was originally the *only* route, on the reasoning that writing is the
 * one thing the agent does to your own files and must never happen because a
 * question was misread. That reasoning was half right. The mistake was
 * conflating "don't write without asking" with "don't even offer": asking in
 * plain words did nothing at all, and the reply came back as ordinary chat — so
 * she'd answer as though she had written it.
 *
 * The approval card is what protects your notes, and planning never writes. So
 * detection can afford to be generous: a false positive costs one click on
 * Discard, a false negative costs the whole feature. What it must *not* do is
 * fire on questions **about** your notes, which are far more common than
 * requests to add to them — "what did I write about duality" must stay a
 * question.
 */

/** A verb that adds, plus a target that is the user's own notes. */
const WRITE = /\b(add|append|write|save|put|jot|record|create|start|draft|make)\b/i;
// Deliberately *not* "page": "save this page for offline" is the archive
// feature, and a web page is the commonest noun in a browser. A real request to
// add a page says which notebook.
const TARGET = /\b(note|notes|notebook|notebooks|scribe|onyx|vault)\b/i;

/**
 * Openers that mean the sentence is *asking about* content rather than asking
 * for it to be written. "What did I write about X" contains both a write verb
 * and a target, and is emphatically not a request to write.
 */
const ASKING =
  /^\s*(what|which|when|where|who|whom|whose|why|how|did|do|does|is|are|was|were|show|list|find|search|look|read|tell|summari[sz]e|explain|remind)\b/i;

/** Phrases that are about past writing, wherever they appear. */
const RETROSPECTIVE = /\b(did i|have i|i already|what i (wrote|added|saved)|the note i)\b/i;

export const looksLikeNoteWrite = (text: string): boolean => {
  const t = text.trim();
  // Slash commands route themselves; `/note` is handled before this is reached.
  if (!t || t.startsWith("/")) return false;
  if (ASKING.test(t) || RETROSPECTIVE.test(t)) return false;
  if (!WRITE.test(t) || !TARGET.test(t)) return false;
  // The verb has to come before the target: "save this to my notebook" is a
  // request, "my notebook, which I saved yesterday, says…" is not.
  const verb = t.search(WRITE);
  const target = t.search(TARGET);
  return verb >= 0 && target > verb;
};
