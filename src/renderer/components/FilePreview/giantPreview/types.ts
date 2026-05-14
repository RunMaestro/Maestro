import type { Theme } from '../../../constants/themes';

/**
 * Imperative handle exposed by `GiantPreview`. The parent FilePreview wires
 * the handle to Cmd+F so search is delegated to CodeMirror's native panel.
 *
 * `findHits` / `scrollToMatch` exist purely for parity with the Fast tier
 * search adapter contract: in Giant tier we don't enumerate every match
 * (the document is too big), so `findHits` returns a degenerate `[]` and
 * navigation happens entirely inside CM6's panel.
 */
export interface GiantPreviewHandle {
	/** Open CodeMirror's built-in search panel and focus its input. */
	openSearch(initialQuery?: string): void;
	/** Close CodeMirror's search panel. */
	closeSearch(): void;
	/** No-op placeholder kept for adapter parity with the Fast tier. */
	findInContent(query: string): Array<{
		sourceOffset: number;
		length: number;
		blockIndex: number;
	}>;
	/** No-op placeholder kept for adapter parity. */
	scrollToMatch(match: { blockIndex: number }): void;
}

/**
 * Public props of the Giant tier preview component.
 *
 * The component is intentionally read-only — Giant tier is for viewing huge
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
