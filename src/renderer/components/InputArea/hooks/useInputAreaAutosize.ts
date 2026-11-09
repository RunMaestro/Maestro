import type React from 'react';
import { useAutosizeTextarea } from '../../../hooks/ui/useAutosizeTextarea';
import { KEYSTROKE_TEXTAREA_MAX_HEIGHT } from '../../../utils/textareaSizing';

interface UseInputAreaAutosizeArgs {
	inputRef: React.RefObject<HTMLTextAreaElement>;
	inputValue: string;
	activeTabId?: string;
	/**
	 * The phone fold. Folding unmounts the textarea, and the one an unfold mounts
	 * holds the same draft, so without this in the reset key nothing measures it
	 * and a multi-line draft reopens one row tall.
	 */
	isFolded?: boolean;
	/**
	 * When true, a keystroke has already scheduled a (deferred) resize, so the
	 * shared hook skips its own synchronous resize to avoid a second forced layout
	 * on the keystroke's critical path. See the ref comment in InputArea.tsx.
	 */
	keystrokeResizeScheduledRef?: React.MutableRefObject<boolean>;
}

/**
 * AI composer binding over {@link useAutosizeTextarea}: the composer's height
 * cap, plus the tab id and the phone fold, so switching tabs or unfolding the
 * composer re-measures the draft in the textarea that just mounted.
 */
export function useInputAreaAutosize({
	inputRef,
	inputValue,
	activeTabId,
	isFolded = false,
	keystrokeResizeScheduledRef,
}: UseInputAreaAutosizeArgs): void {
	useAutosizeTextarea({
		textareaRef: inputRef,
		value: inputValue,
		// The AI composer uses ONE cap on both paths. Two different caps between
		// this effect and the keystroke rAF is what desynced the caret row from the
		// rendered height once the box started scrolling internally (issue #1321),
		// so the external path resizes to the same 176 the keystroke path does.
		maxHeight: KEYSTROKE_TEXTAREA_MAX_HEIGHT,
		resetKey: `${activeTabId ?? ''}:${isFolded}`,
		deferredResizeRef: keystrokeResizeScheduledRef,
	});
}
