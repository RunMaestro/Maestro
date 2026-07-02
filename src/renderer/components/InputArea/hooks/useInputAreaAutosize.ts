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
			// Skip the synchronous resize when the keystroke path already owns it
			// (its rAF will resize to the keystroke max height). This effect still
			// resizes for tab switches and programmatic value changes that never fire
			// onChange (draft restore, slash/template insertion), where the flag is
			// false. Scroll-to-end still runs so the caret stays visible.
			if (!keystrokeResizeScheduledRef?.current) {
				resizeTextareaToContent(el, EXTERNAL_TEXTAREA_MAX_HEIGHT);
			}

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
		prevInputValueRef.current = inputValue;
	}, [activeTabId, inputValue, inputRef, keystrokeResizeScheduledRef]);
}
