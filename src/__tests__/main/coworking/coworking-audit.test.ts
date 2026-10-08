/**
 * Redaction tests for the coworking audit trail. The invariant defended here:
 * secrets that ride in URLs (query strings, fragments), free-form navigate
 * targets, eval code and typed text must NEVER appear verbatim in an audit
 * detail line - only origins/paths and character counts survive.
 */

import { describe, it, expect, vi } from 'vitest';

vi.mock('electron', () => ({
	app: { getPath: () => '/tmp/coworking-test-userdata' },
}));

vi.mock('../../../main/utils/logger', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { redactBrowserOpDetail } from '../../../main/coworking/coworking-audit';

describe('redactBrowserOpDetail', () => {
	it('strips navigate URLs to origin+path with query/hash character counts', () => {
		const detail = redactBrowserOpDetail({
			kind: 'navigate',
			url: 'https://app.example.com/login?token=SECRET123#access=SECRET456',
		});
		// '?token=SECRET123' -> 15 query chars; '#access=SECRET456' -> 16 hash chars.
		expect(detail).toBe('url=https://app.example.com/login queryChars=15 hashChars=16');
		expect(detail).not.toContain('SECRET');
	});

	it('omits query/hash counts when the URL has neither', () => {
		expect(redactBrowserOpDetail({ kind: 'navigate', url: 'https://x.com/docs' })).toBe(
			'url=https://x.com/docs'
		);
	});

	it('reduces non-URL navigate targets to a character count, never verbatim', () => {
		const detail = redactBrowserOpDetail({ kind: 'navigate', url: 'my secret query' });
		expect(detail).toBe('url=<non-url textChars=15>');
		expect(detail).not.toContain('secret');
	});

	it('newTab redacts the URL the same way and appends the ephemeral flag', () => {
		expect(
			redactBrowserOpDetail({ kind: 'newTab', url: 'https://x.com/p?t=abc', ephemeral: true })
		).toBe('url=https://x.com/p queryChars=5 ephemeral');
		expect(redactBrowserOpDetail({ kind: 'newTab', url: 'https://x.com/p' })).toBe(
			'url=https://x.com/p'
		);
		expect(redactBrowserOpDetail({ kind: 'newTab', ephemeral: true })).toBe(
			'url=<default> ephemeral'
		);
		expect(redactBrowserOpDetail({ kind: 'newTab' })).toBe('url=<default>');
	});

	it('waitFor records the selector and timeout only when present', () => {
		expect(redactBrowserOpDetail({ kind: 'waitFor', selector: '#login', timeoutMs: 5000 })).toBe(
			'selector=#login timeoutMs=5000'
		);
		expect(redactBrowserOpDetail({ kind: 'waitFor', selector: '#login' })).toBe('selector=#login');
	});

	it('eval and type reduce free-form content to lengths, never verbatim', () => {
		const evalDetail = redactBrowserOpDetail({
			kind: 'eval',
			code: 'document.cookie = "leak"',
		});
		expect(evalDetail).toBe('codeLen=24');
		expect(evalDetail).not.toContain('cookie');
		const typeDetail = redactBrowserOpDetail({
			kind: 'type',
			selector: '#password',
			text: 'hunter2!',
		});
		expect(typeDetail).toBe('selector=#password textLen=8');
		expect(typeDetail).not.toContain('hunter2');
	});
});
