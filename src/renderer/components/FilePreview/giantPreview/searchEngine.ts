/**
 * Pure search engine for the Giant tier preview.
 *
 * Why this exists:
 *   Phase 4 originally shipped Giant tier with CodeMirror's built-in search
 *   panel, which kept the match count and navigation entirely inside CM6.
 *   The app's own search bar above the preview saw "0 of 0" and the user
 *   ended up with two competing UIs for the same action.
 *
 *   This module replaces the panel-based flow. Given the doc text (CM6's
 *   `Text.toString()` is the supported way to slice the whole document) and
 *   a query, it returns every match as a `SearchHit`. The GiantPreview
 *   component then dispatches a CM6 transaction to select + scroll the
 *   current match — CM6's selection rendering paints the active match for
 *   free.
 *
 *   Trade-offs vs the panel:
 *     + Single coherent search UI across all three tiers
 *     + Match count visible in the app bar (chip-style)
 *     − No regex / case-sensitive toggle / replace (panel had these)
 *
 *   The trade is intentional per the search-hardening plan. Regex etc. can
 *   be added to the shared bar later if needed.
 *
 * Pure (no DOM, no CM6 view), exhaustively tested.
 */

import type { SearchHit } from '../search/types';

export interface FindAllInDocOptions {
	caseSensitive?: boolean;
}

/**
 * Locate every occurrence of `query` in `docText`. Empty query returns [].
 *
 * Non-overlapping semantics (matches CM6's `SearchCursor` default and JS's
 * `String.prototype.match` with a `g` flag). For example `'aa'` inside
 * `'aaaa'` returns matches at offsets 0 and 2, not 0/1/2.
 *
 * Case-insensitive by default (matches the Fast tier convention so the app's
 * search bar feels the same regardless of which tier is active).
 *
 * Giant tier has no logical "block" boundary — the whole doc is one stream —
 * so every hit reports `blockIndex: 0` and `offsetWithinBlock === sourceOffset`.
 * Keeping the shared shape means `useFilePreviewSearch` and the adapter
 * contract require no Giant-specific branching.
 */
export function findAllInDoc(
	docText: string,
	query: string,
	options: FindAllInDocOptions = {}
): SearchHit[] {
	if (!query) return [];

	const needle = options.caseSensitive ? query : query.toLowerCase();
	const haystack = options.caseSensitive ? docText : docText.toLowerCase();
	const hits: SearchHit[] = [];

	let from = 0;
	while (from <= haystack.length) {
		const idx = haystack.indexOf(needle, from);
		if (idx === -1) break;
		hits.push({
			sourceOffset: idx,
			length: query.length,
			blockIndex: 0,
			offsetWithinBlock: idx,
		});
		// Always advance by at least one char so a degenerate empty match
		// (already guarded by the early return for empty query) can't loop.
		from = idx + Math.max(1, needle.length);
	}

	return hits;
}
