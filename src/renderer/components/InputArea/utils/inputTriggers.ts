export interface AtMentionTriggerResult {
	open: boolean;
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
	const hasSpaceAfterAt = textAfterAt.includes(' ');

	if (!isValidTrigger || hasSpaceAfterAt) {
		return null;
	}

	return {
		open: true,
		filter: textAfterAt,
		startIndex: lastAtPos,
	};
}
