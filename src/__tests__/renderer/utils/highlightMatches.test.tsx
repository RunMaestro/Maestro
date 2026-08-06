import React from 'react';
import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { highlightMatches } from '../../../renderer/utils/highlightMatches';

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
