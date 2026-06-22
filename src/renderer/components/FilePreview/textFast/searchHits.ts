import { pageIndexAtOffset } from './pagination';
import type { TextPage } from './types';
import type { SearchHit } from '../search/types';
import { compileSearchRegex } from '../search/queryMatch';

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
	/** When true, treat `query` as a regex source. Invalid patterns yield []. */
	regex?: boolean;
}

/** Tag a single match (start offset + length) with the page it falls inside. */
function tagHit(pages: TextPage[], start: number, length: number): TextSearchHit {
	const blockIndex = pageIndexAtOffset(pages, start);
	// Offset relative to the page's source start. Pagination guarantees pages
	// are non-overlapping and sourceStart is monotonic, so this gives a stable
	// within-page char count for precise scroll.
	const pageStart = pages[blockIndex]?.sourceStart ?? 0;
	return {
		sourceOffset: start,
		length,
		blockIndex,
		offsetWithinBlock: Math.max(0, start - pageStart),
	};
}

export function findTextHits(
	content: string,
	query: string,
	pages: TextPage[],
	options: FindTextHitsOptions = {}
): TextSearchHit[] {
	if (!query) return [];

	if (options.regex) {
		const { regex } = compileSearchRegex(query, {
			regex: true,
			caseSensitive: options.caseSensitive,
		});
		if (!regex) return [];
		const hits: TextSearchHit[] = [];
		let match: RegExpExecArray | null;
		while ((match = regex.exec(content)) !== null) {
			// Skip zero-length matches (e.g. `a*`) so we don't emit empty hits or
			// loop forever; advance lastIndex past the empty position.
			if (match[0].length === 0) {
				regex.lastIndex++;
				continue;
			}
			hits.push(tagHit(pages, match.index, match[0].length));
		}
		return hits;
	}

	const needle = options.caseSensitive ? query : query.toLowerCase();
	const haystack = options.caseSensitive ? content : content.toLowerCase();
	const hits: TextSearchHit[] = [];

	let from = 0;
	while (from <= haystack.length) {
		const idx = haystack.indexOf(needle, from);
		if (idx === -1) break;
		hits.push(tagHit(pages, idx, query.length));
		// Always advance at least one char to prevent infinite loops on
		// pathological empty-needle inputs (we early-return for "" above but
		// be defensive).
		from = idx + Math.max(1, needle.length);
	}

	return hits;
}
