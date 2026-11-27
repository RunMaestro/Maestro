/**
 * Tests for src/shared/safeExcerpt.ts
 *
 * The digest and the context signals both quote text a person did not write
 * (a tool's output, a model's reply, a pasted line). These tests pin what
 * "safe to show on one line" means, so the two cannot drift.
 */

import { describe, it, expect } from 'vitest';
import { EXCERPT_SCAN_CHARS, safeExcerpt } from '../../shared/safeExcerpt';

const chr = (code: number) => String.fromCharCode(code);

describe('safeExcerpt', () => {
	it('returns short plain text as it is, without a truncation flag', () => {
		expect(safeExcerpt('npm test -- -t "a b"', 80, false)).toEqual({
			text: 'npm test -- -t "a b"',
		});
	});

	it('keeps the spacing inside a line: a path with two spaces is the path', () => {
		expect(safeExcerpt('cat /tmp/a  b.txt', 80, true).text).toBe('cat /tmp/a  b.txt');
	});

	it('removes escapes, other control characters and bidirectional overrides', () => {
		const dirty = `a${chr(27)}[2Jb${chr(7)}c${chr(0x202e)}d${chr(0x2066)}e${chr(127)}f`;
		const clean = safeExcerpt(dirty, 80, false).text;
		expect(clean).toBe('a[2Jbcdef');
	});

	it('shows each line break as a marker instead of folding it into a space', () => {
		expect(safeExcerpt('one\ntwo\n\n  three', 80, false).text).toBe('one ⏎ two ⏎ three');
	});

	it('replaces a secret-shaped span, after the control characters that could hide it are gone', () => {
		const token = 'ghp_' + 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8';
		const hidden = `ghp_${chr(27)}${token.slice(4)}`;
		expect(safeExcerpt(`key ${token}`, 200, false).text).not.toContain(token);
		expect(safeExcerpt(`key ${hidden}`, 200, false).text).not.toContain(token);
	});

	it('removes backticks from tool and agent text only, so a user code span survives', () => {
		expect(safeExcerpt('run `id` now', 80, true).text).toBe("run 'id' now");
		expect(safeExcerpt('run `id` now', 80, false).text).toBe('run `id` now');
	});

	it('cuts at a word and says it did', () => {
		const cut = safeExcerpt('alpha beta gamma delta epsilon', 14, false);
		expect(cut.truncated).toBe(true);
		expect(cut.text.length).toBeLessThanOrEqual(15);
		expect('alpha beta gamma delta epsilon'.startsWith(cut.text.replace(/[…\s.]+$/, ''))).toBe(
			true
		);
	});

	it('reads only the first stretch of a very long text', () => {
		const long = `${'x'.repeat(EXCERPT_SCAN_CHARS)}SECRET-TAIL`;
		expect(safeExcerpt(long, 10_000_000, false).text).not.toContain('SECRET-TAIL');
	});

	it('returns an empty line for blank input', () => {
		expect(safeExcerpt('  \n\t ', 40, true)).toEqual({ text: '' });
	});
});
