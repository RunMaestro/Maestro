/**
 * Tests for splitOnMatches - the shared split behind both highlighters.
 *
 * `highlightMatches` (visible marks) and `TextareaHighlightOverlay` (transparent
 * marks behind an editable textarea) both run on this, so a bug here shows up
 * as highlights landing on the wrong characters in two different surfaces.
 */

import { describe, it, expect } from 'vitest';
import { splitOnMatches } from '../../../renderer/utils/highlightMatches';

describe('splitOnMatches', () => {
	it('returns the whole string as one non-match when there is no query', () => {
		expect(splitOnMatches('pedram', '')).toEqual([{ text: 'pedram', isMatch: false, start: 0 }]);
	});

	it('splits a single hit into before / match / after', () => {
		expect(splitOnMatches('ask pedram now', 'pedram')).toEqual([
			{ text: 'ask ', isMatch: false, start: 0 },
			{ text: 'pedram', isMatch: true, start: 4 },
			{ text: ' now', isMatch: false, start: 10 },
		]);
	});

	it('matches case-insensitively but keeps the original casing', () => {
		const segments = splitOnMatches('Pedram and PEDRAM', 'pedram');
		expect(segments.filter((s) => s.isMatch).map((s) => s.text)).toEqual(['Pedram', 'PEDRAM']);
	});

	it('finds every occurrence, not just the first', () => {
		const segments = splitOnMatches('a b a b a', 'a');
		expect(segments.filter((s) => s.isMatch)).toHaveLength(3);
	});

	it('gives repeated substrings distinct offsets, so keys stay unique', () => {
		const starts = splitOnMatches('aa aa aa', 'aa')
			.filter((s) => s.isMatch)
			.map((s) => s.start);
		expect(starts).toEqual([0, 3, 6]);
		expect(new Set(starts).size).toBe(starts.length);
	});

	it('reassembles into exactly the original string', () => {
		// The overlay lays its segments out to match the textarea character for
		// character; dropping or duplicating one would shift every mark after it.
		const text = 'Line one\nline TWO with tricky $chars\n\nend';
		expect(
			splitOnMatches(text, 'line')
				.map((s) => s.text)
				.join('')
		).toBe(text);
	});

	it('treats regex metacharacters in the query as literal text', () => {
		// A user typing `a.b` or `$100` must not have it compiled as a pattern.
		const segments = splitOnMatches('cost $100 and a.b', '$100');
		expect(segments.filter((s) => s.isMatch).map((s) => s.text)).toEqual(['$100']);

		const dotted = splitOnMatches('a.b and axb', 'a.b');
		expect(dotted.filter((s) => s.isMatch).map((s) => s.text)).toEqual(['a.b']);
	});

	it('returns a single non-match run when nothing matches', () => {
		expect(splitOnMatches('hello', 'zzz')).toEqual([{ text: 'hello', isMatch: false, start: 0 }]);
	});
});
