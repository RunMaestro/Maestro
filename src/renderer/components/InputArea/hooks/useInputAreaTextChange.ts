import { startTransition, useCallback } from 'react';
import type React from 'react';
import {
	TEXTAREA_MAX_HEIGHT,
	resizeTextareaToContent,
	scrollTextareaToCaretEnd,
} from '../utils/textareaSizing';
import { getAtMentionTrigger, shouldOpenSlashCommand } from '../utils/inputTriggers';
import type { MentionCategory } from '../../../hooks/input/useMentionPicker';
import {
	detectCommandModeEntry,
	nextComposerCommandMode,
	type ComposerCommandMode,
} from '../../../utils/shellCommandInput';

interface UseInputAreaTextChangeArgs {
	isTerminalMode: boolean;
	slashCommandOpen: boolean;
	/** Current picker open state - used to detect the closed->open transition. */
	atMentionOpen?: boolean;
	/** Which rung of the bang ladder the AI composer is already on. */
	commandMode: ComposerCommandMode;
	/** Climb a rung of the bang ladder (the `!` gesture). */
	setCommandMode: (commandMode: ComposerCommandMode) => void;
	/** Live draft as of before this edit, used to detect the entry gesture. */
	getPreviousValue: () => string;
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
	setAtMentionCategory?: (category: MentionCategory) => void;
}

export function useInputAreaTextChange({
	isTerminalMode,
	slashCommandOpen,
	atMentionOpen,
	commandMode,
	setCommandMode,
	getPreviousValue,
	keystrokeResizeScheduledRef,
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
			let value = e.target.value;
			const cursorPosition = e.target.selectionStart || 0;

			// The `!` gesture: typing (or pasting) a bang into an EMPTY AI composer
			// climbs one rung of the bang ladder (agent -> shell -> AI command) and
			// is consumed - the character never lands in the text. Read the previous
			// value BEFORE setInputValue below, since that is what makes "the
			// composer was empty" true. There is no rung above AI command, so a bang
			// typed there stays as text.
			let nowInCommandMode = commandMode;
			if (!isTerminalMode) {
				const nextMode = nextComposerCommandMode(commandMode);
				if (nextMode) {
					const body = detectCommandModeEntry(getPreviousValue(), value);
					if (body !== null) {
						value = body;
						nowInCommandMode = nextMode;
						setCommandMode(nextMode);
					}
				}
			}

			setInputValue(value);

			startTransition(() => {
				// Slash commands are agent commands. In command mode a leading `/` is
				// an absolute path (`/usr/bin/env`, `/etc`), so the popover must stay
				// shut - and close if the `!` gesture just switched modes under it.
				if (nowInCommandMode === 'off' && shouldOpenSlashCommand(value)) {
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
					// @-mentions inject file paths for the agent to read. In command mode
					// the draft is a shell line the agent never sees, and `@` there is
					// ordinary shell text (an scp target, an email in a commit message),
					// so suppress the popover - and close it if the `!` gesture is what
					// just switched modes out from under an open one.
					const trigger =
						nowInCommandMode === 'off' ? getAtMentionTrigger(value, cursorPosition) : null;
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

			// Claim the resize for this keystroke so the autosize effect (which fires
			// synchronously during commit) doesn't also reflow. Deferred to a rAF to
			// coalesce rapid keystrokes into one resize per frame, off the input-latency
			// critical path.
			const textarea = e.target;
			keystrokeResizeScheduledRef.current = true;
			requestAnimationFrame(() => {
				resizeTextareaToContent(textarea, TEXTAREA_MAX_HEIGHT);
				// resizeTextareaToContent resets scrollTop (via height:'auto'), so the
				// keystroke path must re-scroll to the caret or newly typed text past the
				// max height stays hidden until the user adds line breaks (issue #1169).
				scrollTextareaToCaretEnd(textarea);
				keystrokeResizeScheduledRef.current = false;
			});
		},
		[
			isTerminalMode,
			atMentionOpen,
			setAtMentionCategory,
			commandMode,
			setCommandMode,
			getPreviousValue,
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
