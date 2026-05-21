import { describe, it, expect } from 'vitest';
import {
	blockIndexAtOffset,
	findHits,
	type BlockRange,
} from '../../../../../renderer/components/FilePreview/markdownFast/searchHits';

const RANGES: BlockRange[] = [
	{ start: 0, end: 10 },
	{ start: 10, end: 30 },
	{ start: 30, end: 60 },
];

describe('blockIndexAtOffset', () => {
	it('returns 0 when ranges are empty', () => {
		expect(blockIndexAtOffset([], 5)).toBe(0);
	});

	it('returns the first block for offset 0', () => {
		expect(blockIndexAtOffset(RANGES, 0)).toBe(0);
	});

	it('returns the correct block for an offset in the middle of a range', () => {
		expect(blockIndexAtOffset(RANGES, 5)).toBe(0);
		expect(blockIndexAtOffset(RANGES, 15)).toBe(1);
		expect(blockIndexAtOffset(RANGES, 50)).toBe(2);
	});

	it('treats range.end as exclusive (start of next range)', () => {
		expect(blockIndexAtOffset(RANGES, 10)).toBe(1);
		expect(blockIndexAtOffset(RANGES, 30)).toBe(2);
	});

	it('clamps to the last block when offset is past the end', () => {
		expect(blockIndexAtOffset(RANGES, 100)).toBe(2);
	});

	it('clamps to the first block for negative offset (defensive)', () => {
		expect(blockIndexAtOffset(RANGES, -5)).toBe(0);
	});

	it('works correctly with a single range', () => {
		const single: BlockRange[] = [{ start: 0, end: 100 }];
		expect(blockIndexAtOffset(single, 50)).toBe(0);
		expect(blockIndexAtOffset(single, 100)).toBe(0);
	});
});

describe('findHits', () => {
	const content = 'Hello world, hello again, HELLO upper';
	const ranges: BlockRange[] = [
		{ start: 0, end: 12 }, // "Hello world,"
		{ start: 12, end: 25 }, // " hello again,"
		{ start: 25, end: content.length }, // " HELLO upper"
	];

	it('returns no hits for an empty query', () => {
		expect(findHits(content, '', ranges)).toEqual([]);
	});

	it('returns no hits when the query is not in the content', () => {
		expect(findHits(content, 'nope', ranges)).toEqual([]);
	});

	it('case-insensitive by default', () => {
		const hits = findHits(content, 'hello', ranges);
		expect(hits.length).toBe(3);
		expect(hits[0]).toEqual({
			sourceOffset: 0,
			length: 5,
			blockIndex: 0,
			offsetWithinBlock: 0,
		});
		expect(hits[1].sourceOffset).toBe(13);
		expect(hits[2].sourceOffset).toBe(26);
	});

	it('annotates each hit with its offset relative to the containing block', () => {
		const hits = findHits(content, 'hello', ranges);
		// Block 0 starts at 0 → match at 0 is offset 0.
		// Block 1 starts at 12 → match at 13 is offset 1.
		// Block 2 starts at 25 → match at 26 is offset 1.
		expect(hits.map((h) => h.offsetWithinBlock)).toEqual([0, 1, 1]);
	});

	it('clamps offsetWithinBlock to 0 when match precedes the resolved block start', () => {
		// Defensive: if blockIndexAtOffset clamps a hit before block 0's start
		// (theoretically impossible with sorted ranges starting at 0, but the
		// helper is structurally robust), offsetWithinBlock must not go negative.
		const hits = findHits('hello', 'hello', [{ start: 10, end: 20 }]);
		expect(hits[0].offsetWithinBlock).toBe(0);
	});

	it('case-sensitive when explicitly requested', () => {
		const hits = findHits(content, 'hello', ranges, { caseSensitive: true });
		expect(hits.length).toBe(1);
		expect(hits[0].sourceOffset).toBe(13);
	});

	it('annotates each hit with the block it falls inside', () => {
		const hits = findHits(content, 'hello', ranges);
		expect(hits.map((h) => h.blockIndex)).toEqual([0, 1, 2]);
	});

	it('reports length equal to the original query (preserves case for downstream display)', () => {
		const hits = findHits(content, 'Hello', ranges);
		expect(hits.every((h) => h.length === 5)).toBe(true);
	});

	it('finds overlapping-ish matches by advancing past each match', () => {
		const hits = findHits('aaaa', 'aa', [{ start: 0, end: 4 }]);
		// Greedy-non-overlapping: starts at 0 and 2.
		expect(hits.map((h) => h.sourceOffset)).toEqual([0, 2]);
	});

	it('does not infinite-loop on empty content', () => {
		expect(findHits('', 'x', ranges)).toEqual([]);
	});

	it('clamps blockIndex to the last block when content extends past the last range', () => {
		const hits = findHits(content, 'upper', [
			{ start: 0, end: 5 },
			{ start: 5, end: 10 },
		]);
		expect(hits.length).toBe(1);
		expect(hits[0].blockIndex).toBe(1);
	});

	it('returns hits in source order even when the query repeats many times', () => {
		const haystack = 'x'.repeat(100);
		const hits = findHits(haystack, 'x', [{ start: 0, end: 100 }]);
		expect(hits.length).toBe(100);
		for (let i = 1; i < hits.length; i++) {
			expect(hits[i].sourceOffset).toBeGreaterThan(hits[i - 1].sourceOffset);
		}
	});
});
