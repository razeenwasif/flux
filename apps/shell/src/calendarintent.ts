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

/** A real month name or abbreviation. A bare prefix ("dec…") read "2 decimals"
 *  as 2 December, which matters now that a parsed date alone admits an add. */
const MONTH =
  "jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?";

/** "march 5", "on sept. 3rd": the month in group 1, the day in group 2. */
export const MONTH_DAY = new RegExp(`\\b(?:on\\s+)?(${MONTH})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b`, "i");

/** "5 june", "the 5th of december": the day in group 1, the month in group 2. */
export const DAY_MONTH = new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?(${MONTH})\\b`, "i");

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

/** "what's on my calendar today", "am I free friday", "do I have any meetings". */
export const looksLikeCalendarQuery = (text: string): boolean =>
  MY_TIME.test(text) || (CAL_NOUN.test(text) && MINE.test(text));
