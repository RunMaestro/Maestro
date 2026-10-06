import { mentionQuoteChar } from '../../../../shared/mentionPatterns';

export interface AtMentionTriggerResult {
	open: boolean;
	/**
	 * The RAW text between the `@` and the caret, including an opening quote when
	 * the user is typing a quoted mention. Kept raw because acceptance splices
	 * over it by length (`buildMentionAccept`); the fuzzy-search callers bare it
	 * with `stripMentionQuotes`.
	 */
	filter: string;
	startIndex: number;
}

export function shouldOpenSlashCommand(value: string): boolean {
	return value.startsWith('/') && !value.includes(' ') && !value.includes('\n');
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
