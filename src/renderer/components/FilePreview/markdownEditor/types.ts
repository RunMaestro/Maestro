import type { Theme } from '../../../constants/themes';

/**
 * Imperative handle exposed by `MarkdownEditor`.
 *
 * The shape is dictated by what FilePreview used to do directly against the
 * raw `<textarea>` it replaces: focus, scroll-percent sync between preview
 * and edit modes, deep-link "jump to line N", and search-driven selection.
 * Everything below is what those call sites need to keep working - there's
 * no extra surface area for hypothetical future consumers.
 */
export interface MarkdownEditorHandle {
	focus(): void;
	/**
	 * Logical-line based jump used by `maestro://file/...#L<n>` deep links and
	 * the preview ⇄ edit toggle. By default the target line is also selected
	 * (deep-link behavior); pass `{ select: false }` to scroll the line to the
	 * top without disturbing the cursor (used when syncing from the preview).
	 */
	scrollToLine(line: number, opts?: { select?: boolean }): void;
	/** 1-based source line currently at the top of the editor viewport. */
	getTopLine(): number;
	/** Vertical scroll percent (0..1) of the editor's scroller. */
	getScrollPercent(): number;
	setScrollPercent(percent: number): void;
	/** Set the editor selection to [from, to) and optionally reveal it. */
	setSelection(from: number, to: number, scrollIntoView?: boolean): void;
	/** Character offset of the cursor (the selection head). */
	getCaret(): number;
	/**
	 * Where `pos` sits on screen, in the coordinate space of the editor's own
	 * host element. `top` is the BOTTOM of that line plus a small gap, so a
	 * popup placed there hangs under the caret instead of over it.
	 *
	 * Null before mount, or when the position is scrolled out of view and CM6
	 * therefore has no coordinates for it.
	 */
	coordsAtPos(pos: number): { top: number; left: number } | null;
	/** Replace [from, to) with `text` and leave the cursor after the insert. */
	replaceRange(from: number, to: number, text: string): void;
	/**
	 * Replace the painted search-match decorations. `currentIndex` paints the
	 * one "active" match in a stronger color. Pass an empty array to clear.
	 */
	setSearchMatches(matches: { from: number; to: number }[], currentIndex: number): void;
	/** The CM6 `.cm-content` element - needed by the deep-link tooling that
	 *  walks the rendered DOM. May be `null` before mount. */
	getContentEl(): HTMLElement | null;
}

export interface MarkdownEditorProps {
	value: string;
	onChange: (value: string) => void;
	/** Syntax-highlight language hint from `getLanguageFromFilename()`. */
	language: string;
	theme: Theme;
	/** Native browser spellcheck (red squiggles on prose). */
	spellCheck?: boolean;
	/** Show the document without allowing edits (comparison / reference views). */
	readOnly?: boolean;
	/** When true, lines soft-wrap at whitespace; when false, scrolls horizontally. */
	wrap?: boolean;
	/** Render a line-number gutter on the left. */
	showLineNumbers?: boolean;
	/** Right-click on a gutter line number - receives 1-based line and event. */
	onLineNumberContextMenu?: (lineNumber: number, event: MouseEvent) => void;
	/**
	 * Forwarded to the editor's content element so Cmd+S etc. still fire. Runs
	 * before CodeMirror's own keymap; return `true` to swallow the key (used by
	 * a host-owned autocomplete popup that needs the arrow keys).
	 */
	onKeyDown?: (event: KeyboardEvent) => boolean | void;
	/** Reader font zoom (1 = unzoomed), applied to the CM6 theme. */
	fontScale?: number;
	/**
	 * Resolved File Editor font. CM6 owns `.cm-scroller`'s font, so it cannot
	 * inherit the pane's. Undefined keeps the built-in monospace stack.
	 */
	fontFamily?: string;
	/** File Editor size setting in px, before the pane's own zoom. */
	baseFontPx?: number;
	className?: string;
}
