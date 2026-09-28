/**
 * TextareaHighlightOverlay - paint search hits behind an editable `<textarea>`.
 *
 * A textarea renders plain text and nothing else, so a match inside one cannot
 * be marked up directly. The standard answer, and the one used here, is a
 * backdrop: a div holding the same text with `<mark>` runs, sitting exactly
 * under the textarea. The backdrop's own text is TRANSPARENT - the visible
 * glyphs are always the real ones the user is editing, and only the mark
 * backgrounds show through from behind. Nothing is duplicated on screen, and
 * the textarea keeps its caret, selection, undo stack, and IME intact.
 *
 * Alignment is the whole problem. The backdrop must wrap text at exactly the
 * same points as the textarea or the highlights slide off the words they
 * belong to, so its font, padding, border width, and wrap rules are COPIED
 * FROM THE LIVE COMPUTED STYLE rather than restated in CSS. Restating them
 * works right up until someone changes the textarea's rule and not this one.
 *
 * Usage - the wrapper must be `position: relative`, and the textarea must be
 * transparent so the marks behind it are visible:
 *
 * ```tsx
 * <div className="relative flex-1 flex min-h-0">
 *   <TextareaHighlightOverlay textareaRef={ref} value={text} query={q} theme={theme} />
 *   <textarea ref={ref} value={text} style={{ backgroundColor: 'transparent' }} />
 * </div>
 * ```
 */

import { useEffect, useLayoutEffect, useMemo, useRef, type RefObject } from 'react';
import type { Theme } from '../../types';
import { splitOnMatches } from '../../utils/highlightMatches';

export interface TextareaHighlightOverlayProps {
	/** The textarea to mirror. */
	textareaRef: RefObject<HTMLTextAreaElement>;
	/** Current text. Must be the same value the textarea renders. */
	value: string;
	/** Search query. Empty renders nothing at all. */
	query: string;
	theme: Theme;
	/**
	 * Background painted behind the text. The textarea above is transparent so
	 * the marks can show, which means this layer owns the editor's fill.
	 */
	backgroundColor?: string;
}

/** Style properties that must match the textarea or the highlights drift. */
const MIRRORED_STYLE_PROPS = [
	'fontFamily',
	'fontSize',
	'fontWeight',
	'fontStyle',
	'lineHeight',
	'letterSpacing',
	'wordSpacing',
	'textTransform',
	'textIndent',
	'tabSize',
	'whiteSpace',
	'wordBreak',
	'overflowWrap',
	'paddingTop',
	'paddingRight',
	'paddingBottom',
	'paddingLeft',
	'borderTopWidth',
	'borderRightWidth',
	'borderBottomWidth',
	'borderLeftWidth',
	'borderRadius',
] as const;

export function TextareaHighlightOverlay({
	textareaRef,
	value,
	query,
	theme,
	backgroundColor,
}: TextareaHighlightOverlayProps): JSX.Element | null {
	const backdropRef = useRef<HTMLDivElement | null>(null);

	const segments = useMemo(() => splitOnMatches(value, query), [value, query]);

	// Copy the textarea's box and type metrics onto the backdrop. Runs on every
	// value change because a font or padding change (theme switch, zoom) has to
	// be picked up, and reading computed style is cheap next to the paint.
	useLayoutEffect(() => {
		const textarea = textareaRef.current;
		const backdrop = backdropRef.current;
		if (!textarea || !backdrop) return;
		const computed = window.getComputedStyle(textarea);
		for (const prop of MIRRORED_STYLE_PROPS) {
			backdrop.style[prop] = computed[prop];
		}
		// A transparent border of the same width keeps the backdrop's CONTENT box
		// aligned with the textarea's, which is what the text is laid out in.
		backdrop.style.borderStyle = 'solid';
		backdrop.style.borderColor = 'transparent';
	}, [textareaRef, value, query, theme]);

	// Track the textarea's scroll. Written straight to the DOM rather than
	// through state so a fast scroll cannot lag a frame behind the text it
	// marks - the same reason `TextareaLineNumbers` does it this way.
	useEffect(() => {
		const textarea = textareaRef.current;
		if (!textarea) return;
		const sync = () => {
			const backdrop = backdropRef.current;
			if (!backdrop) return;
			backdrop.scrollTop = textarea.scrollTop;
			backdrop.scrollLeft = textarea.scrollLeft;
		};
		sync();
		textarea.addEventListener('scroll', sync);
		return () => textarea.removeEventListener('scroll', sync);
	}, [textareaRef, value, query]);

	// No query means no marks, so skip the whole layer rather than painting an
	// invisible copy of the document over the editor.
	if (!query) return null;

	return (
		<div
			ref={backdropRef}
			aria-hidden="true"
			className="dual-pane-highlight-backdrop"
			style={{ backgroundColor: backgroundColor ?? 'transparent' }}
		>
			{segments.map((segment) =>
				segment.isMatch ? (
					<mark
						key={segment.start}
						style={{
							// The glyphs on screen belong to the textarea above; this layer
							// contributes only the wash behind them.
							color: 'transparent',
							backgroundColor: `${theme.colors.accent}66`,
							borderRadius: '2px',
						}}
					>
						{segment.text}
					</mark>
				) : (
					<span key={segment.start} style={{ color: 'transparent' }}>
						{segment.text}
					</span>
				)
			)}
			{/* A document ending in a newline needs a trailing character or the last
			    line collapses and every mark below it shifts up a row. */}
			{'\n'}
		</div>
	);
}
