import { startTransition, useCallback } from 'react';
import type React from 'react';
import { KEYSTROKE_TEXTAREA_MAX_HEIGHT, resizeTextareaToContent } from '../utils/textareaSizing';
import { getAtMentionTrigger, shouldOpenSlashCommand } from '../utils/inputTriggers';

interface UseInputAreaTextChangeArgs {
	isTerminalMode: boolean;
	slashCommandOpen: boolean;
	/**
	 * Set true here (and cleared in the resize rAF) so useInputAreaAutosize skips
	 * its own synchronous resize for this keystroke - the rAF below owns it. See
	 * the comment on the ref in InputArea.tsx.
	 */
	keystrokeResizeScheduledRef: React.MutableRefObject<boolean>;
	setInputValue: (value: string) => void;
	setSlashCommandOpen: (open: boolean) => void;
	setSelectedSlashCommandIndex: (index: number) => void;
	setAtMentionOpen?: (open: boolean) => void;
	setAtMentionFilter?: (filter: string) => void;
	setAtMentionStartIndex?: (index: number) => void;
	setSelectedAtMentionIndex?: (index: number) => void;
}

export function useInputAreaTextChange({
	isTerminalMode,
	slashCommandOpen,
	keystrokeResizeScheduledRef,
	setInputValue,
	setSlashCommandOpen,
	setSelectedSlashCommandIndex,
	setAtMentionOpen,
	setAtMentionFilter,
	setAtMentionStartIndex,
	setSelectedAtMentionIndex,
}: UseInputAreaTextChangeArgs): (e: React.ChangeEvent<HTMLTextAreaElement>) => void {
	return useCallback(
		(e) => {
			const value = e.target.value;
			const cursorPosition = e.target.selectionStart || 0;

			setInputValue(value);

			startTransition(() => {
				if (shouldOpenSlashCommand(value)) {
					if (!slashCommandOpen) {
						setSelectedSlashCommandIndex(0);
					}
					setSlashCommandOpen(true);
				} else {
					setSlashCommandOpen(false);
				}

				if (
					!isTerminalMode &&
					setAtMentionOpen &&
					setAtMentionFilter &&
					setAtMentionStartIndex &&
					setSelectedAtMentionIndex
				) {
					const trigger = getAtMentionTrigger(value, cursorPosition);
					if (trigger) {
						setAtMentionOpen(true);
						setAtMentionFilter(trigger.filter);
						setAtMentionStartIndex(trigger.startIndex);
						setSelectedAtMentionIndex(0);
					} else {
						setAtMentionOpen(false);
					}
				}
			});

			// Claim the resize for this keystroke so the autosize effect (which fires
			// synchronously during commit) doesn't also reflow. Deferred to a rAF to
			// coalesce rapid keystrokes into one resize per frame, off the input-latency
			// critical path.
			const textarea = e.target;
			// When the caret is at the end of the content the user is typing at the
			// bottom of a scrolled textarea, so pin the scroll to the bottom right
			// after the resize - otherwise the height='auto' toggle leaves the view at
			// the top and the freshly typed characters stay clipped out of sight until
			// the user manually scrolls. Owning both the resize and the scroll here (in
			// one rAF) keeps them ordered; the autosize effect no longer races us.
			const caretAtEnd = (e.target.selectionStart ?? value.length) >= value.length;
			keystrokeResizeScheduledRef.current = true;
			requestAnimationFrame(() => {
				resizeTextareaToContent(textarea, KEYSTROKE_TEXTAREA_MAX_HEIGHT);
				if (caretAtEnd) {
					textarea.scrollTop = textarea.scrollHeight;
				}
				keystrokeResizeScheduledRef.current = false;
			});
		},
		[
			isTerminalMode,
			keystrokeResizeScheduledRef,
			setAtMentionFilter,
			setAtMentionOpen,
			setAtMentionStartIndex,
			setInputValue,
			setSelectedAtMentionIndex,
			setSelectedSlashCommandIndex,
			setSlashCommandOpen,
			slashCommandOpen,
		]
	);
}
