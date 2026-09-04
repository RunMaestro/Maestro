/**
 * Tests for findLoginUrl - pulling the sign-in URL out of login terminal output.
 *
 * The URL is unusable by hand inside the re-auth terminal: hundreds of
 * characters, soft-wrapped across rows, and unselectable while a mouse-tracking
 * TUI owns the drag. Getting it out of the stream is what makes Copy possible.
 */

import { describe, expect, it } from 'vitest';
import { findLoginUrl } from '../../../renderer/utils/loginUrl';

describe('findLoginUrl', () => {
	it('returns null before the provider prints anything', () => {
		expect(findLoginUrl('')).toBeNull();
		expect(findLoginUrl('Starting login shell...\n$ ')).toBeNull();
	});

	it('finds a plain OAuth URL', () => {
		const url = 'https://claude.ai/oauth/authorize?client_id=abc&state=xyz';
		expect(findLoginUrl(`Open this URL to continue:\n\n  ${url}\n`)).toBe(url);
	});

	it('sees through ANSI colouring', () => {
		const url = 'https://claude.ai/oauth/authorize?code=1';
		expect(findLoginUrl(`\x1b[1;34m${url}\x1b[0m`)).toBe(url);
	});

	// The reason this helper exists: a real login URL never fits one row.
	it('rejoins a URL the terminal soft-wrapped across rows', () => {
		const wrapped =
			'https://claude.ai/oauth/authorize?client_id=9d1c&redirect_uri=http%3A%2F%2Flocal\n' +
			'host%3A45289%2Fcallback&scope=user%3Aprofile';

		expect(findLoginUrl(wrapped)).toBe(
			'https://claude.ai/oauth/authorize?client_id=9d1c&redirect_uri=http%3A%2F%2Flocalhost%3A45289%2Fcallback&scope=user%3Aprofile'
		);
	});

	it('does not glue following prose onto the URL', () => {
		const out = 'https://claude.ai/oauth/authorize?x=1\n\nPaste the code below.';
		expect(findLoginUrl(out)).toBe('https://claude.ai/oauth/authorize?x=1');
	});

	it('strips punctuation the sentence left on the end', () => {
		expect(findLoginUrl('Visit https://claude.ai/oauth/authorize?x=1.')).toBe(
			'https://claude.ai/oauth/authorize?x=1'
		);
		expect(findLoginUrl('Visit (https://claude.ai/oauth/authorize?x=1)')).toBe(
			'https://claude.ai/oauth/authorize?x=1'
		);
	});

	// The same screen prints docs and status links. Copying one of those sends
	// the user somewhere that cannot log them in, with no sign anything is wrong.
	it('ignores documentation and status links on the same screen', () => {
		const out = [
			'Docs: https://docs.anthropic.example.com/getting-started',
			'Status: https://status.example.com/',
			'Sign in: https://claude.ai/oauth/authorize?client_id=abc',
		].join('\n');

		expect(findLoginUrl(out)).toBe('https://claude.ai/oauth/authorize?client_id=abc');
	});

	it('returns nothing rather than guessing when no login URL is present', () => {
		expect(findLoginUrl('See https://example.com/help for more')).toBeNull();
	});

	// A retried login prints a fresh URL; the earlier one is spent and would
	// fail if the user copied it.
	it('prefers the most recent URL when the flow is retried', () => {
		const out = [
			'https://claude.ai/oauth/authorize?attempt=1',
			'That code expired, try again:',
			'https://claude.ai/oauth/authorize?attempt=2',
		].join('\n');

		expect(findLoginUrl(out)).toBe('https://claude.ai/oauth/authorize?attempt=2');
	});

	it('recognises device-code and provider-specific flows', () => {
		expect(findLoginUrl('https://github.com/login/device')).toBe('https://github.com/login/device');
		expect(findLoginUrl('https://auth.openai.com/authorize?x=1')).toBe(
			'https://auth.openai.com/authorize?x=1'
		);
	});

	it('ignores a bare origin with no path', () => {
		expect(findLoginUrl('https://claude.ai')).toBeNull();
	});
});
