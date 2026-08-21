import type React from 'react';
import { useAutosizeTextarea } from '../../../hooks/ui/useAutosizeTextarea';
import { EXTERNAL_TEXTAREA_MAX_HEIGHT } from '../../../utils/textareaSizing';

interface UseInputAreaAutosizeArgs {
	inputRef: React.RefObject<HTMLTextAreaElement>;
	inputValue: string;
	activeTabId?: string;
	/**
	 * When true, a keystroke has already scheduled a (deferred) resize, so the
	 * shared hook skips its own synchronous resize to avoid a second forced layout
	 * on the keystroke's critical path. See the ref comment in InputArea.tsx.
	 */
	keystrokeResizeScheduledRef?: React.MutableRefObject<boolean>;
}

/**
 * AI composer binding over {@link useAutosizeTextarea}: the external (non
 * keystroke) height cap, plus the tab id so switching tabs re-measures the
 * restored draft.
 */
export function useInputAreaAutosize({
	inputRef,
	inputValue,
	activeTabId,
	keystrokeResizeScheduledRef,
}: UseInputAreaAutosizeArgs): void {
	useAutosizeTextarea({
		textareaRef: inputRef,
		value: inputValue,
		maxHeight: EXTERNAL_TEXTAREA_MAX_HEIGHT,
		resetKey: activeTabId,
		deferredResizeRef: keystrokeResizeScheduledRef,
	});
}
