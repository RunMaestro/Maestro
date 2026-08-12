/**
 * Shared search contract for FilePreview tiers (Rich, Fast markdown, Fast text,
 * Giant). Single source of truth so every tier returns the same hit shape and
 * `useFilePreviewSearch` can route navigation uniformly.
 *
 * Why this lives in its own module:
 *   - Three tiers (markdownFast, textFast, giantPreview) each produce hits and
 *     consume an adapter. Without a shared module the interface would drift.
 *   - `useFilePreviewSearch` re-exports from here so callers don't have to
 *     decide between "is it the hook's type or the tier's type?".
 */

export interface SearchHit {
	/** Character offset in the source string where the match starts. */
	sourceOffset: number;
	/** Length of the match (always > 0). */
	length: number;
	/** Index of the block / page that contains the match (0-based). */
	blockIndex: number;
	/**
	 * Character offset of the match relative to the start of its block.
	 * Enables precise within-block scroll (find the matching text node and
	 * land on the word, not just the block top).
	 */
	offsetWithinBlock: number;
}

/** Options controlling how a query string is matched against content. */
export interface SearchHitOptions {
	/** Case-insensitive by default; opt in to exact case. */
	caseSensitive?: boolean;
	/** When true, treat the query as a raw regex source instead of a literal. */
	regex?: boolean;
}

/**
 * Pluggable search source supplied by a tier component. The hook calls
 * `findHits` once per query change and `scrollToMatch` once per navigation.
 *
 * Implementations MUST be pure with respect to `findHits` - no side effects,
 * no caching of stale state - because the hook may call it concurrently with
 * tier remounts. `scrollToMatch` is allowed (and expected) to mutate the
 * viewport. `scrollToLine` (optional) jumps the viewport to a 1-based source
 * line for the bar's line-number search mode.
 */
export interface FilePreviewSearchAdapter {
	findHits(query: string, options?: SearchHitOptions): SearchHit[];
	scrollToMatch(hit: SearchHit): void;
	scrollToLine?(line: number): void;
}
