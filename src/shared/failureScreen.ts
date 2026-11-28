// The last screen of a terminal UI, kept as evidence beside a failure message.
//
// maestro-p ends a failed run with the screen claude left behind (a startup
// dialog, a crash banner, a stuck prompt). It makes the failure explain itself,
// but it is up to 24 rows of TUI, so it rides on its own field
// (`AgentError.failureScreen`) and is shown only where there is room for it (the
// agent error modal), never inside the one-line message every inline surface
// renders. The screen is evidence, not a diagnosis: it can hold any text an
// agent printed, including words such as "rate limit" or "overloaded", so
// nothing that decides from an error's wording may read it.

import { truncateAtWordBoundary } from './formatters';
import { redactSecrets } from './redactSecrets';
import { stripAnsiCodes } from './stringUtils';

/**
 * Separator older builds used to append the screen to the message itself.
 * Errors persisted by those builds still carry it, so `withoutFailureScreen()`
 * keeps recognizing it.
 */
const LEGACY_FAILURE_SCREEN_SEPARATOR = '\n\nWhat Claude Code last showed:\n\n';

/** Characters of screen an error carries at most. */
export const FAILURE_SCREEN_MAX_CHARS = 3000;

/**
 * `screen` cleaned for display: ANSI escapes stripped (raw and the literal
 * `\033[...m` form), bounded to its tail, secrets redacted. `undefined` when
 * nothing is left to show.
 */
export function formatFailureScreen(screen: string | undefined): string | undefined {
	if (!screen) return undefined;
	const clean = stripAnsiCodes(screen, { escapedLiterals: true })
		.split('\n')
		.map((line) => line.trimEnd())
		.join('\n')
		.replace(/^\n+|\n+$/g, '');
	if (!clean.trim()) return undefined;
	return redactSecrets(clean.slice(-FAILURE_SCREEN_MAX_CHARS)).text;
}

/** `message` without a screen an older build appended to it. */
export function withoutFailureScreen(message: string): string {
	const at = message.indexOf(LEGACY_FAILURE_SCREEN_SEPARATOR);
	return at < 0 ? message : message.slice(0, at);
}

/** Characters of an error message an inline surface (banner, toast, tooltip) shows at most. */
export const INLINE_ERROR_MAX_CHARS = 280;

/**
 * An error message as an inline surface shows it: any legacy screen dropped,
 * whitespace collapsed to one line, cut at a word near `maxChars`. Inline
 * surfaces are a line or two; the full message and the screen belong in the
 * agent error modal.
 */
export function inlineErrorText(message: string, maxChars = INLINE_ERROR_MAX_CHARS): string {
	const oneLine = withoutFailureScreen(message).replace(/\s+/g, ' ').trim();
	return truncateAtWordBoundary(oneLine, maxChars);
}
