import { describe, it, expect } from 'vitest';
import { findTextHits } from '../../../../../renderer/components/FilePreview/textFast/searchHits';
import { paginate } from '../../../../../renderer/components/FilePreview/textFast/pagination';

describe('findTextHits', () => {
	const content = 'Hello world\nhello again\nHELLO upper\nlast line';
	const pages = paginate(content, 2); // 2 pages: lines [0,1] and [2,3]

	it('returns no hits for an empty query', () => {
		expect(findTextHits(content, '', pages)).toEqual([]);
	});

	it('returns no hits when the query is not in the content', () => {
		expect(findTextHits(content, 'nope', pages)).toEqual([]);
	});

	it('case-insensitive by default', () => {
		const hits = findTextHits(content, 'hello', pages);
		expect(hits.length).toBe(3);
		expect(hits[0].sourceOffset).toBe(0);
	});

	it('case-sensitive when opted in', () => {
		const hits = findTextHits(content, 'hello', pages, { caseSensitive: true });
		expect(hits.length).toBe(1);
		expect(hits[0].sourceOffset).toBe('Hello world\n'.length);
	});

	it('tags each hit with the page index it falls inside', () => {
		const hits = findTextHits(content, 'hello', pages);
		// 'Hello' at offset 0 → page 0 (lines 0-1)
		// 'hello' at offset 12 → page 0 (still lines 0-1)
		// 'HELLO' at offset 24 → page 1 (lines 2-3)
		expect(hits[0].blockIndex).toBe(0);
		expect(hits[1].blockIndex).toBe(0);
		expect(hits[2].blockIndex).toBe(1);
	});

	it('annotates each hit with offsetWithinBlock relative to the containing page', () => {
		const hits = findTextHits(content, 'hello', pages);
		// page 0 starts at sourceStart=0; matches at 0 and 12 → offsets 0 and 12.
		// page 1 starts at sourceStart=24 (first char of 'HELLO'); match at 24 → offset 0.
		expect(hits[0].offsetWithinBlock).toBe(0);
		expect(hits[1].offsetWithinBlock).toBe(12);
		expect(hits[2].offsetWithinBlock).toBe(0);
	});

	it('reports length equal to the original query (preserves case)', () => {
		const hits = findTextHits(content, 'Hello', pages);
		expect(hits.every((h) => h.length === 5)).toBe(true);
	});

	it('advances past every match (no overlap, no infinite loop)', () => {
		const haystack = 'aaaa';
		const hits = findTextHits(haystack, 'aa', paginate(haystack, 10));
		expect(hits.map((h) => h.sourceOffset)).toEqual([0, 2]);
	});

	it('returns hits in source order', () => {
		const haystack = 'x'.repeat(50);
		const hits = findTextHits(haystack, 'x', paginate(haystack, 10));
		expect(hits.length).toBe(50);
		for (let i = 1; i < hits.length; i++) {
			expect(hits[i].sourceOffset).toBeGreaterThan(hits[i - 1].sourceOffset);
		}
	});

	it('handles a single-page document', () => {
		const haystack = 'one line only';
		const single = paginate(haystack, 80);
		const hits = findTextHits(haystack, 'line', single);
		expect(hits.length).toBe(1);
		expect(hits[0].blockIndex).toBe(0);
	});

	it('handles empty content', () => {
		expect(findTextHits('', 'x', [])).toEqual([]);
	});

	it('handles matches that span a page boundary (assigns to the page they START in)', () => {
		// 4 lines, 2 pages of 2: page 0 = lines 0-1, page 1 = lines 2-3.
		// The query 'two\nline' starts on line 1 (page 0) and extends into
		// line 2 (page 1), exercising the cross-page case. The hit should
		// still be tagged with the page it starts in (0).
		const haystack = 'line one\nline two\nline three\nline four';
		const ps = paginate(haystack, 2);
		const hits = findTextHits(haystack, 'two\nline', ps);
		expect(hits.length).toBe(1);
		expect(hits[0].blockIndex).toBe(0);
		// Sanity: the match's range straddles the page-0 boundary.
		expect(hits[0].sourceOffset).toBeLessThan(ps[1].sourceStart);
		expect(hits[0].sourceOffset + hits[0].length).toBeGreaterThan(ps[1].sourceStart);
	});
});
