/**
 * Emoji utilities for Maestro
 *
 * Shared functions for handling emojis in session/group names,
 * particularly for alphabetical sorting that ignores leading emojis.
 */

/**
 * Strip leading emojis from a string for proper alphabetical sorting.
 * Handles emoji characters, variation selectors, ZWJ sequences, emoji modifiers, etc.
 *
 * @param str - The string to process
 * @returns The string with leading emojis removed and trimmed
 *
 * @example
 * stripLeadingEmojis("🎉 Party") // returns "Party"
 * stripLeadingEmojis("👨‍👩‍👧‍👦 Family") // returns "Family"
 * stripLeadingEmojis("No emoji") // returns "No emoji"
 */
export const stripLeadingEmojis = (str: string): string => {
	// Match emojis at the start: emoji characters, variation selectors, ZWJ sequences, etc.
	const emojiRegex =
		/^(?:\p{Emoji_Presentation}|\p{Emoji}\uFE0F?|\p{Emoji_Modifier_Base}\p{Emoji_Modifier}?)+\s*/gu;
	return str.replace(emojiRegex, '').trim();
};

/**
 * Compare two names alphabetically, ignoring leading emojis.
 * Used for sorting sessions and groups by their text content rather than emoji codes.
 *
 * @param a - First name to compare
 * @param b - Second name to compare
 * @returns Negative if a < b, positive if a > b, zero if equal
 *
 * @example
 * compareNamesIgnoringEmojis("🍎 Apple", "🍌 Banana") // returns negative (Apple < Banana)
 * compareNamesIgnoringEmojis("🎉 Zebra", "Alpha") // returns positive (Zebra > Alpha)
 */
export const compareNamesIgnoringEmojis = (a: string, b: string): number => {
	const aStripped = stripLeadingEmojis(a);
	const bStripped = stripLeadingEmojis(b);
	return aStripped.localeCompare(bStripped);
};
