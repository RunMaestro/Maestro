import type { Theme } from '../../../constants/themes';
import type { SearchHit, SearchHitOptions } from '../search/types';

/**
 * One paginated chunk of text content emitted by the Fast tier text preview.
 *
 * Pages are the unit of virtualization: TanStack Virtual mounts and unmounts
 * pages as they scroll into view. A fixed page size lets us skip dynamic
 * measurement (every page renders at the same height regardless of content),
 * which is much faster than per-line virtualization for huge files.
 */
export interface TextPage {
	/** Stable index within a single pagination output (0-based, monotonic). */
	id: number;
	/** First line number (0-based) of this page in the original source. */
	startLine: number;
	/** First line AFTER this page (exclusive). */
	endLine: number;
	/** Raw line strings, length = endLine - startLine. */
	lines: string[];
	/** Character offset in the source where this page begins (inclusive). */
	sourceStart: number;
	/** Character offset where this page ends (exclusive). */
	sourceEnd: number;
}

/**
 * Imperative handle exposed by `TextPreviewFast`. The parent FilePreview wires
 * the handle to Cmd+F search so a match in any page (visible or not) can be
 * scrolled into view.
 */
export interface TextPreviewFastHandle {
	/** Total page count for the currently-loaded document. */
	getPageCount(): number;
	/** Find every match of `query` in the source, tagged with the page index it lives in. */
	findInContent(query: string, options?: SearchHitOptions): SearchHit[];
	/** Scroll the virtualizer to the matched page AND the matched text within it. */
	scrollToMatch(hit: SearchHit): void;
	/** 1-based source line currently at the top of the viewport. */
	getTopLine(): number;
	/** Scroll the given 1-based source line to the top of the viewport. */
	scrollToLine(line: number): void;
}

/**
 * Public props of the Fast tier text preview component.
 *
 * `language` decides whether the page contents get the lazy-Shiki treatment:
 * a recognized code language → Shiki applies on intersection; `'text'` →
 * pages render as plain monospaced lines.
 *
 * Bionify is intentionally NOT a prop here: Fast tier never runs Bionify
 * (per the Phase 3 design - incompatible with virtualization at scale). The
 * tier-override chip lets users escape to Rich tier if they need it.
 */
export interface TextPreviewFastProps {
	content: string;
	/**
	 * Syntax-highlight language hint. Common values come from
	 * `getLanguageFromFilename()` in filePreviewUtils. Use `'text'` for plain
	 * prose / log files.
	 */
	language: string;
	theme: Theme;
	/** Bridged ref so the parent's existing search hook can scope to this container. */
	containerRef: React.MutableRefObject<HTMLDivElement | null>;
	/** Optional file path (only used for stable debugging logs / keys). */
	filePath?: string;
}
