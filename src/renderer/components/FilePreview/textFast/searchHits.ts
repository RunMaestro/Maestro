import { pageIndexAtOffset } from './pagination';
import type { TextPage } from './types';
import type { SearchHit } from '../search/types';

/**
 * Locate every occurrence of `query` in `content` and tag each with the page
 * it falls inside. Empty query returns [].
 *
 * Mirrors the markdown Fast tier's `searchHits` module: same shape so the
 * shared `FilePreviewSearchAdapter` contract works for both tiers.
 *
 * Case-insensitive by default; `caseSensitive: true` opts in to exact match.
 */
export type TextSearchHit = SearchHit;

export interface FindTextHitsOptions {
	caseSensitive?: boolean;
}

export function findTextHits(
	content: string,
	query: string,
	pages: TextPage[],
	options: FindTextHitsOptions = {}
): TextSearchHit[] {
	if (!query) return [];

	const needle = options.caseSensitive ? query : query.toLowerCase();
	const haystack = options.caseSensitive ? content : content.toLowerCase();
	const hits: TextSearchHit[] = [];

	let from = 0;
	while (from <= haystack.length) {
		const idx = haystack.indexOf(needle, from);
		if (idx === -1) break;
		const blockIndex = pageIndexAtOffset(pages, idx);
		// Offset relative to the page's source start. Pagination guarantees
		// pages are non-overlapping and sourceStart is monotonic, so this gives
		// a stable within-page char count for precise scroll.
		const pageStart = pages[blockIndex]?.sourceStart ?? 0;
		const offsetWithinBlock = Math.max(0, idx - pageStart);
		hits.push({
			sourceOffset: idx,
			length: query.length,
			blockIndex,
			offsetWithinBlock,
		});
		// Always advance at least one char to prevent infinite loops on
		// pathological empty-needle inputs (we early-return for "" above but
		// be defensive).
		from = idx + Math.max(1, needle.length);
	}

	return hits;
}
