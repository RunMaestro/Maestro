/**
 * Emoji utilities for Maestro
 *
 * Shared functions for handling emojis in session/group names,
 * particularly for alphabetical sorting that ignores leading emojis.
 */

/**
 * Characters that belong to an emoji cluster but are never letters or digits.
 *
 * Deliberately does NOT use `\p{Emoji}` or `\p{Emoji_Component}`: both match the
 * ASCII digits, `#` and `*`, so an agent named "0DIN Loki" had its leading "0"
 * eaten and sorted under "D". The explicit members below (ZWJ, the two variation
 * selectors, the combining keycap, skin-tone modifiers, regional indicators) are
 * what glue multi-codepoint sequences such as "🧑‍💼" together - without them the
 * old pattern stopped at the ZWJ and left "‍💼 A&C Overlord" as the sort key.
 */
const EMOJI_CLUSTER_CHARS = '\\p{Extended_Pictographic}\\p{Emoji_Modifier}\\p{Regional_Indicator}';

/**
 * The joiners and selectors, kept as alternatives rather than class members:
 * they are combining characters, and a character class holding them reads as a
 * misleading class to ESLint (and to humans).
 */
const EMOJI_JOINERS = '\\u200D|\\uFE0E|\\uFE0F|\\u20E3';

/** A run of emoji-cluster characters and whitespace at the start of a string. */
const LEADING_EMOJI_RUN = new RegExp(`^(?:[${EMOJI_CLUSTER_CHARS}]|${EMOJI_JOINERS}|\\s)+`, 'u');

/** Everything before the first letter or digit, in any script. */
const LEADING_NON_ALPHANUMERIC = /^[^\p{L}\p{N}]+/u;

/**
 * Strip leading emojis from a string.
 *
 * @param str - The string to process
 * @returns The string with leading emojis removed and trimmed
 *
 * @example
 * stripLeadingEmojis("🎉 Party") // returns "Party"
 * stripLeadingEmojis("👨‍👩‍👧‍👦 Family") // returns "Family"
 * stripLeadingEmojis("No emoji") // returns "No emoji"
 */
export const stripLeadingEmojis = (str: string): string =>
	str.replace(LEADING_EMOJI_RUN, '').trim();

/**
 * The key a name is alphabetized by: the name from its first alphanumeric
 * character onward. Emojis, punctuation, and whitespace ahead of that character
 * never influence the ordering, so "🧑‍💼 A&C Overlord" files under "A", not
 * somewhere above "0DIN Loki".
 *
 * Names made entirely of symbols (no letter or digit anywhere) fall back to the
 * emoji-stripped name so "🎉 @#$%" still sorts as "@#$%" rather than collapsing
 * to an empty key.
 *
 * @param str - The name to build a sort key for
 * @returns The comparable portion of the name
 */
export const nameSortKey = (str: string): string =>
	str.replace(LEADING_NON_ALPHANUMERIC, '').trim() || stripLeadingEmojis(str);

/**
 * Compare two names alphabetically, ignoring anything before the first
 * alphanumeric character (emojis, punctuation, whitespace).
 *
 * @param a - First name to compare
 * @param b - Second name to compare
 * @returns Negative if a < b, positive if a > b, zero if equal
 *
 * @example
 * compareNamesIgnoringEmojis("🍎 Apple", "🍌 Banana") // returns negative (Apple < Banana)
 * compareNamesIgnoringEmojis("🎉 Zebra", "Alpha") // returns positive (Zebra > Alpha)
 */
export const compareNamesIgnoringEmojis = (a: string, b: string): number =>
	nameSortKey(a).localeCompare(nameSortKey(b));
