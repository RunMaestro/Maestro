/**
 * Pure search-matching for the Fast tier preview.
 *
 * The Fast tier virtualizes blocks, so most of the rendered HTML is not in
 * the DOM at any given time. Cmd+F can't rely on DOM scanning - instead we
 * search the SOURCE string and map each match to the index of the block it
 * lives in. Navigation then calls `virtuoso.scrollToIndex(blockIndex)`, and
 * the `offsetWithinBlock` field lets the caller scroll precisely to the
 * matching text node (not just the block top).
 *
 * Pure (no DOM, no React) and exhaustively tested.
 */

import type { SearchHit } from '../search/types';

export type { SearchHit };

export interface BlockRange {
	/** Inclusive start offset within the source string. */
	start: number;
	/** Exclusive end offset within the source string. */
	end: number;
}

export interface FindHitsOptions {
	caseSensitive?: boolean;
}

/**
 * Locate every occurrence of `query` in `content` and tag each with the block
 * it falls inside. Empty query returns []. Matches that span block boundaries
 * are tagged with the block they START in.
 *
 * Block ranges must be sorted by `start` ascending and non-overlapping. The
 * pipeline's `buildBlocks` produces ranges that satisfy this - frontmatter
 * is at offset 0, followed by tokens in source order.
 */
export function findHits(
	content: string,
	query: string,
	blockRanges: BlockRange[],
	options: FindHitsOptions = {}
): SearchHit[] {
	if (!query) return [];

	const needle = options.caseSensitive ? query : query.toLowerCase();
	const haystack = options.caseSensitive ? content : content.toLowerCase();
	const hits: SearchHit[] = [];

	let from = 0;
	while (from <= haystack.length) {
		const idx = haystack.indexOf(needle, from);
		if (idx === -1) break;
		const blockIndex = blockIndexAtOffset(blockRanges, idx);
		// Offset relative to the block's source start, so MarkdownPreviewFast can
		// walk text nodes inside the mounted block and land on the exact match.
		// Clamp at 0 - if the offset falls before the block (only possible when
		// blockIndexAtOffset clamped to 0 for a pre-frontmatter hit), we still
		// want a non-negative within-block offset.
		const blockStart = blockRanges[blockIndex]?.start ?? 0;
		const offsetWithinBlock = Math.max(0, idx - blockStart);
		hits.push({
			sourceOffset: idx,
			length: query.length,
			blockIndex,
			offsetWithinBlock,
		});
		// Advance past the match so we don't loop on the same position. If the
		// match is empty we'd infinite-loop, but the early-return above guards
		// against query === ''.
		from = idx + Math.max(1, needle.length);
	}

	return hits;
}

/**
 * Binary-search `blockRanges` for the block containing the given source offset.
 * Returns the index of the first block whose range covers `offset`, or the
 * index of the last block when the offset is past the end (e.g. a match in
 * trailing whitespace).
 */
export function blockIndexAtOffset(blockRanges: BlockRange[], offset: number): number {
	if (blockRanges.length === 0) return 0;
	let lo = 0;
	let hi = blockRanges.length - 1;
	while (lo <= hi) {
		const mid = (lo + hi) >>> 1;
		const range = blockRanges[mid];
		if (offset < range.start) {
			hi = mid - 1;
		} else if (offset >= range.end) {
			lo = mid + 1;
		} else {
			return mid;
		}
	}
	// Offset falls outside every range. Clamp to the closest block on either
	// side so callers always get a valid scroll target.
	if (lo >= blockRanges.length) return blockRanges.length - 1;
	if (hi < 0) return 0;
	return lo;
}
