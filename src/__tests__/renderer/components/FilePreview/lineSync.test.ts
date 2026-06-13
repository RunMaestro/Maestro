import { describe, it, expect } from 'vitest';
import { nthLineStartOffset } from '../../../../renderer/components/FilePreview/lineSync';

describe('nthLineStartOffset', () => {
	const text = 'alpha\nbravo\ncharlie\ndelta';
	// offsets: a=0 ... \n=5, b=6 ... \n=11, c=12 ... \n=19, d=20

	it('returns 0 for line 1 (and anything <= 1)', () => {
		expect(nthLineStartOffset(text, 1)).toBe(0);
		expect(nthLineStartOffset(text, 0)).toBe(0);
		expect(nthLineStartOffset(text, -5)).toBe(0);
	});

	it('returns the offset just after the (N-1)th newline', () => {
		expect(nthLineStartOffset(text, 2)).toBe(6); // 'bravo'
		expect(nthLineStartOffset(text, 3)).toBe(12); // 'charlie'
		expect(nthLineStartOffset(text, 4)).toBe(20); // 'delta'
	});

	it('round-trips: the substring at the offset starts with that line', () => {
		expect(text.slice(nthLineStartOffset(text, 3))).toBe('charlie\ndelta');
	});

	it('clamps past-the-end requests to the start of the last line', () => {
		expect(nthLineStartOffset(text, 99)).toBe(20);
	});

	it('handles a single-line string', () => {
		expect(nthLineStartOffset('only one line', 1)).toBe(0);
		expect(nthLineStartOffset('only one line', 5)).toBe(0);
	});

	it('handles an empty string', () => {
		expect(nthLineStartOffset('', 1)).toBe(0);
		expect(nthLineStartOffset('', 3)).toBe(0);
	});

	it('handles a trailing newline (empty final line)', () => {
		const trailing = 'a\nb\n';
		expect(nthLineStartOffset(trailing, 2)).toBe(2); // 'b'
		expect(nthLineStartOffset(trailing, 3)).toBe(4); // empty line after last \n
	});

	it('handles consecutive blank lines', () => {
		const blanks = 'a\n\n\nb';
		expect(nthLineStartOffset(blanks, 2)).toBe(2); // first blank
		expect(nthLineStartOffset(blanks, 3)).toBe(3); // second blank
		expect(nthLineStartOffset(blanks, 4)).toBe(4); // 'b'
	});
});
