/**
 * "Capture this lecture to onyx" / "save that to onyx": the two requests that
 * write into the Onyx vault directly, with no approval card in between.
 *
 * That is why they must be instructions rather than mentions. The old gates
 * looked for keywords anywhere, and "capture" sat in both of them, so "how do I
 * capture a screenshot?" filed the active page into the vault, and a bare
 * "that" anywhere ("write in onyx that my exam is friday") saved the previous,
 * unrelated answer as a note. Anything vaguer than the forms below goes to the
 * note planner (see [[noteintent]]), which shows the exact text first.
 *
 * The phrasings are quoted to the model in `FLUX_CAPABILITIES`
 * (crates/flux-agent/src/lib.rs): keep the two in step.
 */

/** Tags may sit anywhere in the request ("save that #ml to onyx"). */
const untagged = (t: string): string =>
  t
    .replace(/#[\w-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

/** A question asks how; it never writes. */
const QUESTION = /\?\s*$/;

/** "capture this lecture …", "save today's transcript …", "capture this page". */
const CAPTURE =
  /^(?:capture|save|file|add)\s+(?:\S+\s+){0,2}?(?:lecture|transcript)\b|^capture\s+(?:this|the)\s+(?:page|article)\b/i;

/** What "the last answer" may be called, in the explicit "save that to onyx" form. */
const LAST_ANSWER = String.raw`(?:that|this\s+answer|the\s+answer|your\s+answer|(?:the\s+)?last\s+answer)`;

/** "save to onyx: …", "save that to onyx/<folder>": the target follows the verb. */
const SAVE = new RegExp(
  String.raw`^(?:save|note|add|write|put)\s+(?:${LAST_ANSWER}\s+)?(?:to|in|into)\s+onyx\b`,
  "i",
);

const SAVES_LAST_ANSWER = new RegExp(
  String.raw`^(?:save|note|add|write|put)\s+${LAST_ANSWER}\s+(?:to|in|into)\s+onyx\b`,
  "i",
);

/** File the active page's text into Onyx? Expects the polite lead-in stripped. */
export const isCaptureRequest = (text: string): boolean => {
  const t = untagged(text);
  return !QUESTION.test(t) && CAPTURE.test(t);
};

/** Write a note straight into Onyx? Expects the polite lead-in stripped. */
export const isOnyxSave = (text: string): boolean => {
  const t = untagged(text);
  return !QUESTION.test(t) && SAVE.test(t);
};

/** Is the note body the previous answer, rather than text in the request? */
export const savesLastAnswer = (text: string): boolean => SAVES_LAST_ANSWER.test(untagged(text));
