import { useEffect, useRef } from 'react';
import type React from 'react';
import { resizeTextareaToContent, shouldScrollTextareaToEnd } from '../../utils/textareaSizing';

interface UseAutosizeTextareaArgs {
	textareaRef:
		| React.RefObject<HTMLTextAreaElement>
		| React.MutableRefObject<HTMLTextAreaElement | null>;
	/** The composer's current value. Drives the re-measure. */
	value: string;
	/** Height cap in pixels; past it the textarea scrolls instead of growing. */
	maxHeight: number;
	/**
	 * Extra dependency that should force a re-measure even when the value is
	 * unchanged (switching tabs, remounting a panel with a restored draft).
	 */
	resetKey?: string;
	/**
	 * Set by a caller that owns its own deferred resize for the current keystroke
	 * (see `useInputAreaTextChange`). While true this hook skips both the resize
	 * and the scroll so the two paths cannot race and clobber each other.
	 */
	deferredResizeRef?: React.MutableRefObject<boolean>;
}

/**
 * Grow a composer textarea to fit its content, up to `maxHeight`, and keep the
 * caret visible once it starts scrolling.
 *
 * The naive version of this (`height = 'auto'` then `height = scrollHeight`) is
 * why a full composer clipped its last line: the 'auto' toggle collapses the
 * internal scroll to the top, so every keystroke scrolled the freshly typed line
 * back out of view. `resizeTextareaToContent` restores the scroll position, and
 * this hook re-pins it to the bottom whenever the edit happened at the end of
 * the text (typing, dictation, paste).
 */
export function useAutosizeTextarea({
	textareaRef,
	value,
	maxHeight,
	resetKey,
	deferredResizeRef,
}: UseAutosizeTextareaArgs): void {
	const previousValueRef = useRef(value);

	useEffect(() => {
		const el = textareaRef.current;
		if (el && !deferredResizeRef?.current) {
			resizeTextareaToContent(el, maxHeight);

			if (
				shouldScrollTextareaToEnd(el.selectionEnd, previousValueRef.current.length, value.length)
			) {
				el.scrollTop = el.scrollHeight;
			}
		}
		previousValueRef.current = value;
	}, [value, resetKey, maxHeight, textareaRef, deferredResizeRef]);
}
