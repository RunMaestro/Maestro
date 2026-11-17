// The last screen of a terminal UI, shown under a failure message.
//
// maestro-p ends a failed run with the screen claude left behind (a startup
// dialog, a crash banner, a stuck prompt). Shown under the error, it makes the
// failure explain itself. But the screen is evidence, not a diagnosis: it can
// hold any text an agent printed, including words such as "rate limit" or
// "overloaded". Anything that decides from an error's wording (retry
// classification) must read the message WITHOUT it, or the screen chooses the
// recovery. This module owns the format so the writer and the readers agree.

import { redactSecrets } from './redactSecrets';

const FAILURE_SCREEN_HEADER = 'What Claude Code last showed:';
const FAILURE_SCREEN_SEPARATOR = `\n\n${FAILURE_SCREEN_HEADER}\n\n`;

/** Characters of screen a failure message carries at most. */
export const FAILURE_SCREEN_MAX_CHARS = 3000;

/**
 * `message` with `screen` appended in a code block, redacted and bounded.
 * Returns `message` unchanged when there is no screen.
 */
export function appendFailureScreen(message: string, screen: string | undefined): string {
	const trimmed = screen?.trim() ?? '';
	if (!trimmed) return message;
	const bounded = redactSecrets(trimmed.slice(-FAILURE_SCREEN_MAX_CHARS)).text.replace(
		/```/g,
		"'''"
	);
	return `${message}${FAILURE_SCREEN_SEPARATOR}\`\`\`\n${bounded}\n\`\`\``;
}

/** `message` without a screen `appendFailureScreen()` added, for classification. */
export function withoutFailureScreen(message: string): string {
	const at = message.indexOf(FAILURE_SCREEN_SEPARATOR);
	return at < 0 ? message : message.slice(0, at);
}
