import { useEffect } from 'react';
import type React from 'react';
import {
	TEXTAREA_MAX_HEIGHT,
	resizeTextareaToContent,
	scrollTextareaToCaretEnd,
} from '../utils/textareaSizing';

interface UseInputAreaAutosizeArgs {
	inputRef: React.RefObject<HTMLTextAreaElement>;
	inputValue: string;
	activeTabId?: string;
	/**
	 * When true, a keystroke has already scheduled a (deferred) resize, so this
	 * effect skips its own synchronous resize to avoid a second forced layout on
	 * the keystroke's critical path. See the ref comment in InputArea.tsx.
	 */
	keystrokeResizeScheduledRef?: React.MutableRefObject<boolean>;
}

export function useInputAreaAutosize({
	inputRef,
	inputValue,
	activeTabId,
	keystrokeResizeScheduledRef,
}: UseInputAreaAutosizeArgs): void {
	useEffect(() => {
		const el = inputRef.current;
		if (el) {
			// Skip the resize AND the scroll when the keystroke path already owns them
			// (its rAF resizes to the unified TEXTAREA_MAX_HEIGHT and pins the scroll).
			// This effect fires synchronously in the commit phase, so doing its own
			// scroll-to-end for keystrokes would race the rAF and get clobbered (or
			// clobber it), which is what left freshly typed characters scrolled out of
			// view. It still owns both for tab switches and programmatic value changes
			// that never fire onChange (draft restore, slash/template insertion), where
			// the flag is false.
			if (!keystrokeResizeScheduledRef?.current) {
				resizeTextareaToContent(el, TEXTAREA_MAX_HEIGHT);
				// Pin the caret exactly like the keystroke path: snap to the bottom only
				// when the caret sits at the end of the new value (draft restores, slash/
				// template insertions, voice appends), and leave mid-text carets (deferred
				// @-mention placement) untouched so the view never yanks to the bottom.
				scrollTextareaToCaretEnd(el);
			}
		}
	}, [activeTabId, inputValue, inputRef, keystrokeResizeScheduledRef]);
}
