/**
 * When is a message about the user's calendar?
 *
 * The panel checks this before ordinary chat on every message, and the add
 * path writes an event without asking, so both have to key on something only a
 * calendar request says. The old gates didn't: "free" and "busy" sat in both of
 * the query's word lists, so "is this software free?" answered "You're free the
 * next 7 days", and a bare "on" or "next" let "add error handling on the parser"
 * become an all-day event.
 */

const DAY =
  "(?:today|tonight|tomorrow|this\\s+(?:morning|afternoon|evening|week(?:end)?)|next\\s+week|(?:on\\s+)?(?:mon|tues|wednes|thurs|fri|satur|sun)day)";

/** The user's own free/busy time: "am I free friday", "how busy am I", "busy tomorrow?". */
const MY_TIME = new RegExp(
  `\\b(?:am i|are we|i'?m)\\s+(?:free|busy)\\b|\\b(?:free|busy)\\s+(?:am i|are we)\\b|\\b(?:free|busy)\\s+${DAY}\\b`,
  "i",
);

const CAL_NOUN = /\b(?:calendar|schedule|agenda|events?|meetings?|appointments?|free\s+(?:time|slots?))\b/i;

/** …owned by the user, or asked about as the calendar itself. */
const MINE =
  /\b(?:my|do i have|today|tomorrow|this week|next week|upcoming|coming up)\b|\b(?:show|list|view)\s+(?:the\s+)?(?:calendar|agenda|schedule)\b|\bwhat'?s\s+on\s+the\s+(?:calendar|agenda|schedule)\b/i;

/** An instruction to add something: "schedule dentist tomorrow at 3pm". The verb
 *  read as the noun "schedule", and "tomorrow" as asking about the user's time, so
 *  it listed tomorrow's events instead. Not "schedule for tomorrow" or "schedule
 *  today?", which ask to see it. */
const ADDS =
  /^\s*(?:please\s+)?(?:schedule|book|plan|add|create|put|set\s*up|new)\b(?!\s*(?:for\b|today\b|tonight\b|tomorrow\b|this\s+week\b|next\s+week\b|\?|$))/i;

/** "what's on my calendar today", "am I free friday", "do I have any meetings". */
export const looksLikeCalendarQuery = (text: string): boolean =>
  !ADDS.test(text) && (MY_TIME.test(text) || (CAL_NOUN.test(text) && MINE.test(text)));
