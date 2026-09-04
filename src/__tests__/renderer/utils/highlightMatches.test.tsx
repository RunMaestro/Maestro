import React from 'react';
import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { highlightMatches, searchMatchRanges } from '../../../renderer/utils/highlightMatches';

const ACCENT = '#ff0000';

/** Render the helper's output into a container so <mark> elements can be counted. */
const renderHighlight = (text: string, query: string) => {
	const { container } = render(<div>{highlightMatches(text, query, ACCENT)}</div>);
	return container;
};

describe('highlightMatches', () => {
	it('returns the text untouched when there is no query', () => {
		expect(highlightMatches('hello', '', ACCENT)).toBe('hello');
	});

	it('returns the text untouched when nothing matches', () => {
		expect(highlightMatches('hello', 'zzz', ACCENT)).toBe('hello');
	});

	it('wraps a single match in a mark', () => {
		const container = renderHighlight('New York City', 'York');

		const marks = container.querySelectorAll('mark');
		expect(marks).toHaveLength(1);
		expect(marks[0]).toHaveTextContent('York');
		expect(container.textContent).toBe('New York City');
	});

	it('matches case-insensitively while preserving the original casing', () => {
		const container = renderHighlight('New York City', 'york');

		const marks = container.querySelectorAll('mark');
		expect(marks).toHaveLength(1);
		// The rendered text keeps the source casing, not the query's
		expect(marks[0]).toHaveTextContent('York');
	});

	it('marks every occurrence, not every other one', () => {
		// Regression: the previous implementation decided match-vs-plain with
		// regex.test() on a /g/ regex, whose lastIndex carries between calls, so
		// with 2+ hits it alternated and skipped highlights.
		const container = renderHighlight('ab ab ab ab', 'ab');

		const marks = container.querySelectorAll('mark');
		expect(marks).toHaveLength(4);
		expect(container.textContent).toBe('ab ab ab ab');
	});

	it('highlights adjacent repeated matches', () => {
		const container = renderHighlight('aaaa', 'aa');

		expect(container.querySelectorAll('mark')).toHaveLength(2);
		expect(container.textContent).toBe('aaaa');
	});

	it('treats regex metacharacters in the query as literal text', () => {
		const container = renderHighlight('cost is $5.00 (net)', '$5.00');

		const marks = container.querySelectorAll('mark');
		expect(marks).toHaveLength(1);
		expect(marks[0]).toHaveTextContent('$5.00');
		expect(container.textContent).toBe('cost is $5.00 (net)');
	});

	it('does not mark anything when a metacharacter query has no literal match', () => {
		// '.' must not behave as "any character"
		expect(highlightMatches('abc', '.', ACCENT)).toBe('abc');
	});

	it('applies the accent color to the mark background', () => {
		const container = renderHighlight('hello', 'ell');

		expect(container.querySelector('mark')).toHaveStyle({ backgroundColor: ACCENT });
	});

	it('handles a match at the start and end of the text', () => {
		const container = renderHighlight('xxmiddlexx', 'xx');

		expect(container.querySelectorAll('mark')).toHaveLength(2);
		expect(container.textContent).toBe('xxmiddlexx');
	});
});

/**
 * The byte-range form the CodeMirror editor paints its decorations from.
 *
 * A pane that offers both a rendered preview and a source editor highlights the
 * same query twice through two different mechanisms, so these assert the ranges
 * against the SAME text `highlightMatches` marks up. Anything that made the two
 * disagree would show a hit in one mode and not the other.
 */
describe('searchMatchRanges', () => {
	/** The substrings the ranges actually point at - the thing that must be right. */
	const sliced = (text: string, query: string) =>
		searchMatchRanges(text, query).map((r) => text.slice(r.from, r.to));

	it('returns nothing for an empty query', () => {
		expect(searchMatchRanges('hello', '')).toEqual([]);
	});

	it('returns nothing when the query does not appear', () => {
		expect(searchMatchRanges('hello', 'zzz')).toEqual([]);
	});

	it('points at the match, not at an offset one place off', () => {
		expect(searchMatchRanges('New York City', 'York')).toEqual([{ from: 4, to: 8 }]);
		expect(sliced('New York City', 'York')).toEqual(['York']);
	});

	it('finds every occurrence, including adjacent ones', () => {
		expect(searchMatchRanges('ab ab ab', 'ab')).toEqual([
			{ from: 0, to: 2 },
			{ from: 3, to: 5 },
			{ from: 6, to: 8 },
		]);
		expect(searchMatchRanges('aaaa', 'aa')).toEqual([
			{ from: 0, to: 2 },
			{ from: 2, to: 4 },
		]);
	});

	it('matches case-insensitively and spans the source casing', () => {
		expect(sliced('New York City', 'york')).toEqual(['York']);
	});

	it('treats regex metacharacters as literal text', () => {
		expect(sliced('cost is $5.00 (net)', '$5.00')).toEqual(['$5.00']);
		// '.' must not behave as "any character"
		expect(searchMatchRanges('abc', '.')).toEqual([]);
	});

	it('counts offsets across newlines, not per line', () => {
		// The editor addresses one flat document, so a hit on line three has to
		// carry the offsets of the lines above it.
		const doc = 'one\ntwo\nthree';
		expect(sliced(doc, 'three')).toEqual(['three']);
		expect(searchMatchRanges(doc, 'three')).toEqual([{ from: 8, to: 13 }]);
	});

	it('agrees with the rendered highlights about what is a hit', () => {
		const text = 'ab ab ab ab';
		const marks = renderHighlight(text, 'ab').querySelectorAll('mark');

		expect(searchMatchRanges(text, 'ab')).toHaveLength(marks.length);
	});
});
