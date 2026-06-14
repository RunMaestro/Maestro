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
}

export function useInputAreaAutosize({
	inputRef,
	inputValue,
	activeTabId,
}: UseInputAreaAutosizeArgs): void {
	const prevInputValueRef = useRef(inputValue);

	useEffect(() => {
		const el = inputRef.current;
		if (el) {
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
		prevInputValueRef.current = inputValue;
	}, [activeTabId, inputValue, inputRef]);
}
