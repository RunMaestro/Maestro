import { startTransition, useCallback } from 'react';
import type React from 'react';
import { KEYSTROKE_TEXTAREA_MAX_HEIGHT, resizeTextareaToContent } from '../utils/textareaSizing';
import { getAtMentionTrigger, shouldOpenSlashCommand } from '../utils/inputTriggers';
import type { MentionCategory } from '../../../hooks/input/useMentionPicker';

interface UseInputAreaTextChangeArgs {
	isTerminalMode: boolean;
	slashCommandOpen: boolean;
	/** Current picker open state - used to detect the closed->open transition. */
	atMentionOpen?: boolean;
	setInputValue: (value: string) => void;
	setSlashCommandOpen: (open: boolean) => void;
	setSelectedSlashCommandIndex: (index: number) => void;
	setAtMentionOpen?: (open: boolean) => void;
	setAtMentionFilter?: (filter: string) => void;
	setAtMentionStartIndex?: (index: number) => void;
	setSelectedAtMentionIndex?: (index: number) => void;
	setAtMentionCategory?: (category: MentionCategory) => void;
}

export function useInputAreaTextChange({
	isTerminalMode,
	slashCommandOpen,
	atMentionOpen,
	setInputValue,
	setSlashCommandOpen,
	setSelectedSlashCommandIndex,
	setAtMentionOpen,
	setAtMentionFilter,
	setAtMentionStartIndex,
	setSelectedAtMentionIndex,
	setAtMentionCategory,
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
						// Only reset the category on the closed->open transition so
						// typing a filter inside (say) the Agents scope doesn't snap
						// back to 'all' on every keystroke.
						if (!atMentionOpen) {
							setAtMentionCategory?.('all');
						}
						setAtMentionOpen(true);
						setAtMentionFilter(trigger.filter);
						setAtMentionStartIndex(trigger.startIndex);
						setSelectedAtMentionIndex(0);
					} else {
						setAtMentionOpen(false);
					}
				}
			});

			const textarea = e.target;
			requestAnimationFrame(() => {
				resizeTextareaToContent(textarea, KEYSTROKE_TEXTAREA_MAX_HEIGHT);
			});
		},
		[
			isTerminalMode,
			atMentionOpen,
			setAtMentionCategory,
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
