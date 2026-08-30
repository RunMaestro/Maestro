/**
 * Extract the sign-in URL a provider's login flow prints to its terminal.
 *
 * Every OAuth-style CLI login ends with "open this URL in your browser". Inside
 * Maestro's re-authentication terminal that URL is often unusable by hand: it is
 * hundreds of characters of query string, the TUI soft-wraps it across several
 * rows, and a TUI with mouse tracking on eats the drag so it cannot even be
 * selected. Pulling it out of the stream and offering one Copy button is the
 * difference between a login that finishes and one the user abandons.
 */

import { stripAnsiCodes } from '../../shared/stringUtils';

/**
 * Hosts whose URLs are worth offering. Deliberately a allowlist of the sign-in
 * hosts the supported providers use rather than "any URL": the same screen
 * prints docs links and a status-page link, and a Copy button that grabs the
 * wrong one silently sends the user somewhere that cannot log them in.
 */
const LOGIN_URL_HINTS = [
	'claude.ai',
	'anthropic.com',
	'openai.com',
	'chatgpt.com',
	'github.com/login',
	'githubcopilot.com',
	'accounts.google.com',
	'auth0.com',
	'okta.com',
	'/oauth',
	'/authorize',
	'/device',
	'/activate',
];

/** Characters a terminal is likely to put AFTER a URL rather than inside one. */
const TRAILING_JUNK = /[.,;:!?'")\]}>]+$/;

/**
 * Rejoin a URL the terminal soft-wrapped across rows.
 *
 * A wrapped URL arrives as `...&code_challenge=abc\n  def...`. Newlines that
 * fall INSIDE a URL are terminal formatting, not content, so they (and the
 * indent that follows) are removed. Blank lines are kept as real breaks, since
 * those separate the URL from surrounding prose.
 */
function unwrap(text: string): string {
	return text.replace(/\n[ \t]*(?=[^\s])/g, (match, offset: number) => {
		// Only stitch when the character before the break could continue a URL.
		// Stitching after a sentence would glue prose onto the link.
		const before = text.slice(0, offset).trimEnd().slice(-1);
		return /[A-Za-z0-9\-._~:/?#[\]@!$&'()*+,;=%]/.test(before) ? '' : match;
	});
}

/**
 * Find the most recent sign-in URL in accumulated terminal output.
 *
 * Returns the LAST match: a login flow that is retried prints a fresh URL, and
 * the earlier one is spent. Returns null when nothing matches, which is the
 * common case for the first few seconds while the shell starts.
 *
 * @param rawOutput - Terminal output as received, escape codes and all.
 */
export function findLoginUrl(rawOutput: string): string | null {
	const text = unwrap(stripAnsiCodes(rawOutput));
	const matches = text.match(/https?:\/\/[^\s<>"']+/g);
	if (!matches) return null;

	const cleaned = matches
		.map((url) => url.replace(TRAILING_JUNK, ''))
		// A bare origin cannot be a sign-in link - a real one always carries a
		// path or a query (the authorize endpoint, the device code, the state).
		.filter((url) => /^https?:\/\/[^/?#]+(\/[^\s]|\?)/.test(url));

	const loginUrls = cleaned.filter((url) => {
		const lower = url.toLowerCase();
		return LOGIN_URL_HINTS.some((hint) => lower.includes(hint));
	});

	return loginUrls.length > 0 ? loginUrls[loginUrls.length - 1] : null;
}
