import type { Theme } from '../../../constants/themes';
import type { SearchHit, SearchHitOptions } from '../search/types';

/**
 * Imperative handle exposed by `GiantPreview`. The parent FilePreview wires
 * the handle to Cmd+F so search results count + navigation flow through the
 * app's shared search bar instead of CodeMirror's native panel.
 *
 * `findInContent` enumerates every match in the loaded document; pure scan
 * over the source string is acceptable up to the Giant tier's size ceiling
 * (one full pass per query, gated by useFilePreviewSearch's count effect).
 * `scrollToMatch` selects the matched range and scrolls the CM6 viewport -
 * CM6's selection rendering paints the active match indicator for free.
 */
export interface GiantPreviewHandle {
	/** Find every occurrence of `query` in the loaded source. Empty query → []. */
	findInContent(query: string, options?: SearchHitOptions): SearchHit[];
	/** Select + scroll the matched range into view. No-op on out-of-range offsets. */
	scrollToMatch(hit: SearchHit): void;
	/** 1-based *source* line at the top of the viewport (soft-wrap aware). */
	getTopLine(): number;
	/** Scroll the given 1-based *source* line to the top of the viewport. */
	scrollToLine(line: number): void;
}

/**
 * Public props of the Giant tier preview component.
 *
 * The component is intentionally read-only - Giant tier is for viewing huge
 * files, not editing them. Edit mode in FilePreview takes precedence and
 * never routes to Giant.
 */
export interface GiantPreviewProps {
	content: string;
	/**
	 * Syntax-highlight language hint. Comes from `getLanguageFromFilename()`.
	 * Unknown / `'text'` languages mount the editor with no language extension
	 * (plain text rendering, still line-numbered and searchable).
	 */
	language: string;
	theme: Theme;
	/** Bridged ref so the parent's existing search hook can target the editor's DOM. */
	containerRef: React.MutableRefObject<HTMLDivElement | null>;
	/** Optional file path used for stable debugging logs / keys. */
	filePath?: string;
}
