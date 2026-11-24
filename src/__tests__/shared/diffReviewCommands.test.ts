import { describe, it, expect } from 'vitest';
import {
	normalizeDiffReviewCommandResult,
	parseDiffReviewCommandRequest,
	parseLineSpan,
} from '../../shared/diffReviewCommands';

describe('parseLineSpan', () => {
	it('reads one line or a range, in either order', () => {
		expect(parseLineSpan('12')).toEqual({ startLine: 12, endLine: 12 });
		expect(parseLineSpan(' 12 - 14 ')).toEqual({ startLine: 12, endLine: 14 });
		expect(parseLineSpan('14-12')).toEqual({ startLine: 12, endLine: 14 });
	});

	it('refuses anything that is not one or two positive integers', () => {
		for (const bad of ['', '0', 'a', '12-', '-3', '1.5', '12,14']) {
			expect(parseLineSpan(bad), bad).toBeNull();
		}
	});
});

describe('parseDiffReviewCommandRequest', () => {
	it('requires a known action and an agent', () => {
		expect(parseDiffReviewCommandRequest({ action: 'nope', sessionId: 'a' }).ok).toBe(false);
		expect(parseDiffReviewCommandRequest({ action: 'list' }).ok).toBe(false);
		expect(parseDiffReviewCommandRequest({ action: 'list', sessionId: 'a' })).toEqual({
			ok: true,
			request: { action: 'list', sessionId: 'a' },
		});
	});

	it('validates add: path, line, side, and a non-empty comment', () => {
		const base = { action: 'add', sessionId: 'a', path: 'f.ts', startLine: 3, body: 'x' };
		expect(parseDiffReviewCommandRequest(base)).toEqual({
			ok: true,
			request: { ...base, endLine: 3, side: 'new' },
		});
		expect(parseDiffReviewCommandRequest({ ...base, side: 'old' }).ok).toBe(true);
		for (const bad of [
			{ path: '' },
			{ startLine: 0 },
			{ startLine: 1.5 },
			{ endLine: -1 },
			{ side: 'left' },
			{ body: '   ' },
		]) {
			expect(parseDiffReviewCommandRequest({ ...base, ...bad }).ok, JSON.stringify(bad)).toBe(
				false
			);
		}
	});

	it('requires a comment id for remove, and an id and text for edit', () => {
		expect(parseDiffReviewCommandRequest({ action: 'remove', sessionId: 'a' }).ok).toBe(false);
		expect(parseDiffReviewCommandRequest({ action: 'edit', sessionId: 'a', body: 'x' }).ok).toBe(
			false
		);
		expect(
			parseDiffReviewCommandRequest({ action: 'edit', sessionId: 'a', commentId: 'c', body: ' ' })
				.ok
		).toBe(false);
		expect(
			parseDiffReviewCommandRequest({
				action: 'edit',
				sessionId: 'a',
				commentId: ' c1 ',
				body: ' New. ',
			})
		).toEqual({
			ok: true,
			request: { action: 'edit', sessionId: 'a', commentId: 'c1', body: 'New.' },
		});
	});

	it('takes compose and background on send only as a literal true', () => {
		expect(
			parseDiffReviewCommandRequest({
				action: 'send',
				sessionId: 'a',
				compose: true,
				background: true,
			})
		).toEqual({
			ok: true,
			request: { action: 'send', sessionId: 'a', compose: true, background: true },
		});
		expect(
			parseDiffReviewCommandRequest({
				action: 'send',
				sessionId: 'a',
				compose: 'yes',
				background: 1,
			})
		).toEqual({ ok: true, request: { action: 'send', sessionId: 'a' } });
	});
});

describe('normalizeDiffReviewCommandResult', () => {
	it('turns a malformed reply into a failure, never a silent success', () => {
		expect(normalizeDiffReviewCommandResult(null).success).toBe(false);
		expect(normalizeDiffReviewCommandResult({ cleared: 2 })).toEqual({
			success: false,
			error: 'Diff review command failed',
		});
	});

	it('keeps the fields a success carries', () => {
		expect(
			normalizeDiffReviewCommandResult({ success: true, cwd: '/r', cleared: 2, junk: 1 })
		).toEqual({ success: true, cwd: '/r', cleared: 2 });
	});
});

describe('parseDiffReviewCommandRequest with a file (maestro-cli file-review)', () => {
	it('carries the file on every verb and drops the diff-only fields from add', () => {
		expect(
			parseDiffReviewCommandRequest({ action: 'list', sessionId: 'a', file: ' /p/x.md ' })
		).toEqual({
			ok: true,
			request: { action: 'list', sessionId: 'a', file: '/p/x.md' },
		});
		expect(
			parseDiffReviewCommandRequest({
				action: 'add',
				sessionId: 'a',
				file: '/p/x.md',
				path: 'ignored.ts',
				side: 'old',
				startLine: 4,
				endLine: 2,
				body: ' Fix. ',
			})
		).toEqual({
			ok: true,
			request: {
				action: 'add',
				sessionId: 'a',
				file: '/p/x.md',
				startLine: 2,
				endLine: 4,
				body: 'Fix.',
			},
		});
		expect(
			parseDiffReviewCommandRequest({
				action: 'send',
				sessionId: 'a',
				file: '/p/x.md',
				background: true,
			})
		).toEqual({
			ok: true,
			request: { action: 'send', sessionId: 'a', file: '/p/x.md', background: true },
		});
	});

	it('needs no path for a file add, but still a line and some text', () => {
		const base = { action: 'add', sessionId: 'a', file: '/p/x.md', startLine: 1, body: 'x' };
		expect(parseDiffReviewCommandRequest(base).ok).toBe(true);
		const noLine = parseDiffReviewCommandRequest({ ...base, startLine: 0 });
		expect(noLine).toEqual({ ok: false, error: 'file-review add requires a line number' });
		expect(parseDiffReviewCommandRequest({ ...base, body: ' ' }).ok).toBe(false);
	});

	it('passes the file back through a normalized result', () => {
		expect(
			normalizeDiffReviewCommandResult({ success: true, file: '/p/x.md', cleared: 1 })
		).toEqual({ success: true, file: '/p/x.md', cleared: 1 });
	});
});
