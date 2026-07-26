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
				// Pin the caret exactly like the keystroke path: scrollTextareaToCaretEnd
				// snaps to the bottom only when the caret sits at the end of the new value
				// (draft restores, slash/template insertions, voice appends) and is a no-op
				// otherwise. Caveat: the deferred caret setters (@-mention accept in
				// AtMentionPopover, template variable insertion in useTemplateAutocomplete)
				// place their caret in a requestAnimationFrame that runs AFTER this
				// commit-phase effect, so at this point selectionEnd already sits at the end
				// of the freshly assigned value - this effect cannot honor those mid-text
				// placements from here. Honoring them end to end would require those setters
				// to re-scroll after they move the caret; this effect only guarantees the
				// end-of-value case.
				scrollTextareaToCaretEnd(el);
			}
		}
	}, [activeTabId, inputValue, inputRef, keystrokeResizeScheduledRef]);
}
