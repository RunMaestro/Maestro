import { startTransition, useCallback } from 'react';
import type React from 'react';
import { KEYSTROKE_TEXTAREA_MAX_HEIGHT, resizeTextareaToContent } from '../utils/textareaSizing';
import { getAtMentionTrigger, shouldOpenSlashCommand } from '../utils/inputTriggers';

interface UseInputAreaTextChangeArgs {
	isTerminalMode: boolean;
	slashCommandOpen: boolean;
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

			const textarea = e.target;
			requestAnimationFrame(() => {
				resizeTextareaToContent(textarea, KEYSTROKE_TEXTAREA_MAX_HEIGHT);
			});
		},
		[
			isTerminalMode,
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
