import { useEffect, useRef } from 'react';
import type React from 'react';
import {
	EXTERNAL_TEXTAREA_MAX_HEIGHT,
	resizeTextareaToContent,
	shouldScrollTextareaToEnd,
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
	const prevInputValueRef = useRef(inputValue);

	useEffect(() => {
		const el = inputRef.current;
		if (el) {
			// Skip the resize AND the scroll when the keystroke path already owns them
			// (its rAF resizes to the keystroke max height and pins the scroll). This
			// effect fires synchronously in the commit phase, so doing its own
			// scroll-to-end for keystrokes would race the rAF and get clobbered (or
			// clobber it), which is what left freshly typed characters scrolled out of
			// view. It still owns both for tab switches and programmatic value changes
			// that never fire onChange (draft restore, slash/template insertion), where
			// the flag is false.
			if (!keystrokeResizeScheduledRef?.current) {
				resizeTextareaToContent(el, EXTERNAL_TEXTAREA_MAX_HEIGHT);

				if (
					shouldScrollTextareaToEnd(
						el.selectionEnd,
						prevInputValueRef.current.length,
						inputValue.length
					)
				) {
					el.scrollTop = el.scrollHeight;
				}
			}
		}
		prevInputValueRef.current = inputValue;
	}, [activeTabId, inputValue, inputRef, keystrokeResizeScheduledRef]);
}
