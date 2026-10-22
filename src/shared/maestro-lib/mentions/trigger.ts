/**
 * The `@` typed into a draft: whether it opens the picker, what has been typed
 * after it, and how accepting a row rewrites the text. Shared by the desktop
 * composer and the TUI composer, so the two cannot disagree about where a
 * mention starts or what accepting one replaces.
 *
 * Pure: text and a caret in, text and a caret out.
 */

import { mentionQuoteChar } from '../../mentionPatterns';

export interface AtMentionTriggerResult {
	open: boolean;
	/**
	 * The RAW text between the `@` and the caret, including an opening quote when
	 * the user is typing a quoted mention. Kept raw because acceptance splices
	 * over it by length (`spliceMentionLiteral`); the fuzzy-search callers bare it
	 * with `stripMentionQuotes`.
	 */
	filter: string;
	startIndex: number;
}

export function getAtMentionTrigger(
	value: string,
	cursorPosition: number
): AtMentionTriggerResult | null {
	const textBeforeCursor = value.substring(0, cursorPosition);
	const lastAtPos = textBeforeCursor.lastIndexOf('@');

	if (lastAtPos === -1) {
		return null;
	}

	const isValidTrigger = lastAtPos === 0 || /\s/.test(value[lastAtPos - 1]);
	const textAfterAt = value.substring(lastAtPos + 1, cursorPosition);

	if (!isValidTrigger || textAfterAt.includes('\n')) {
		return null;
	}

	const quote = mentionQuoteChar(textAfterAt);
	if (quote) {
		// Quoted mention (`@"Meetings/MEET - Notes.md"`): spaces belong to the path,
		// so only the closing quote ends the token. Once it is closed the mention is
		// complete and the picker closes rather than filtering on finished text.
		if (textAfterAt.slice(1).includes(quote)) {
			return null;
		}
	} else if (textAfterAt.includes(' ')) {
		return null;
	}

	return {
		open: true,
		filter: textAfterAt,
		startIndex: lastAtPos,
	};
}

export interface MentionSplice {
	value: string;
	/** The caret lands immediately after the spliced literal. */
	caretPos: number;
}

/**
 * Replace the `@<filter>` span at `startIndex` with `literal`.
 *
 * Quoted mentions (paths with spaces) add one wrinkle: while drilled into a
 * quoted directory the caret sits INSIDE the quotes, so the closing quote of the
 * previous token still sits just past the filter. The accepted token brings its
 * own closing quote, so that stale one is swallowed instead of doubled.
 */
export function spliceMentionLiteral(
	inputValue: string,
	startIndex: number,
	filter: string,
	literal: string
): MentionSplice {
	const beforeAt = inputValue.substring(0, startIndex);
	let afterIndex = startIndex + 1 + filter.length;
	const openQuote = mentionQuoteChar(filter);
	if (openQuote && inputValue[afterIndex] === openQuote) afterIndex += 1;
	const afterFilter = inputValue.substring(afterIndex);
	return { value: beforeAt + literal + afterFilter, caretPos: startIndex + literal.length };
}
