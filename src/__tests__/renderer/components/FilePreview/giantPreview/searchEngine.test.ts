/**
 * Tests for the Giant tier's pure search engine.
 *
 * Covers empty / no-match / single / multi / overlap / case / unicode /
 * multi-line / large-doc to guard against regressions when the implementation
 * is later optimized (e.g. for files where CM6's `doc.toString()` is too
 * expensive to do per query).
 */

import { describe, it, expect } from 'vitest';
import { findAllInDoc } from '../../../../../renderer/components/FilePreview/giantPreview/searchEngine';

describe('findAllInDoc', () => {
	it('returns [] for empty query', () => {
		expect(findAllInDoc('anything', '')).toEqual([]);
	});

	it('returns [] when the query is not present', () => {
		expect(findAllInDoc('hello world', 'nope')).toEqual([]);
	});

	it('finds a single match and sets the correct source offset', () => {
		const hits = findAllInDoc('alpha beta gamma', 'beta');
		expect(hits.length).toBe(1);
		expect(hits[0].sourceOffset).toBe(6);
		expect(hits[0].length).toBe(4);
		// Giant has no block concept; offsetWithinBlock equals sourceOffset.
		expect(hits[0].blockIndex).toBe(0);
		expect(hits[0].offsetWithinBlock).toBe(6);
	});

	it('finds every occurrence in source order', () => {
		const hits = findAllInDoc('one two one two one', 'one');
		expect(hits.map((h) => h.sourceOffset)).toEqual([0, 8, 16]);
	});

	it('is case-insensitive by default', () => {
		const hits = findAllInDoc('Hello hello HELLO', 'hello');
		expect(hits.length).toBe(3);
		expect(hits.map((h) => h.sourceOffset)).toEqual([0, 6, 12]);
	});

	it('respects caseSensitive when explicitly requested', () => {
		const hits = findAllInDoc('Hello hello HELLO', 'hello', { caseSensitive: true });
		expect(hits.length).toBe(1);
		expect(hits[0].sourceOffset).toBe(6);
	});

	it('does NOT overlap matches (aa in aaaa → offsets 0, 2)', () => {
		const hits = findAllInDoc('aaaa', 'aa');
		expect(hits.map((h) => h.sourceOffset)).toEqual([0, 2]);
	});

	it('finds matches that span newline boundaries', () => {
		const hits = findAllInDoc('line one\nline two\nline three', 'line');
		expect(hits.length).toBe(3);
		expect(hits.map((h) => h.sourceOffset)).toEqual([0, 9, 18]);
	});

	it('handles a query containing newlines (multiline match)', () => {
		const hits = findAllInDoc('one\ntwo\none\ntwo', 'one\ntwo');
		expect(hits.length).toBe(2);
		expect(hits[0].sourceOffset).toBe(0);
		expect(hits[1].sourceOffset).toBe(8);
	});

	it('handles unicode strings using UTF-16 code-unit semantics (matches indexOf)', () => {
		// 'é' is one code unit in NFC. 'café' is 4 code units.
		const docText = 'café au lait';
		const hits = findAllInDoc(docText, 'lait');
		expect(hits.length).toBe(1);
		// "lait" starts at code-unit index 8 (after "café au ").
		expect(hits[0].sourceOffset).toBe(8);
	});

	it('returns [] for empty doc text', () => {
		expect(findAllInDoc('', 'anything')).toEqual([]);
	});

	it('all hits have offsetWithinBlock === sourceOffset for Giant tier', () => {
		const hits = findAllInDoc('xy xy xy', 'xy');
		expect(hits.every((h) => h.offsetWithinBlock === h.sourceOffset)).toBe(true);
	});

	it('all hits report blockIndex 0 (Giant has no blocks)', () => {
		const hits = findAllInDoc('x x x x', 'x');
		expect(hits.every((h) => h.blockIndex === 0)).toBe(true);
	});

	it('handles a query longer than the doc gracefully', () => {
		expect(findAllInDoc('short', 'much longer query')).toEqual([]);
	});

	it('matches the entire document when query equals docText', () => {
		const hits = findAllInDoc('exact', 'exact');
		expect(hits.length).toBe(1);
		expect(hits[0].sourceOffset).toBe(0);
		expect(hits[0].length).toBe(5);
	});

	it('scales to a moderately large doc with many matches', () => {
		// 10 000 occurrences of "x" in a doc of size 20 000.
		const doc = 'x.'.repeat(10000);
		const hits = findAllInDoc(doc, 'x');
		expect(hits.length).toBe(10000);
		// Confirm ascending order and step of 2 (non-overlap + each x followed by .)
		expect(hits[0].sourceOffset).toBe(0);
		expect(hits[1].sourceOffset).toBe(2);
		expect(hits.at(-1)!.sourceOffset).toBe(19998);
	});
});
