import { startTransition, useCallback } from 'react';
import type React from 'react';
import {
	KEYSTROKE_TEXTAREA_MAX_HEIGHT,
	resizeTextareaToContent,
} from '../../../utils/textareaSizing';
import { getAtMentionTrigger, shouldOpenSlashCommand } from '../utils/inputTriggers';
import {
	detectCommandModeEntry,
	nextComposerCommandMode,
	type ComposerCommandMode,
} from '../../../utils/shellCommandInput';

interface UseInputAreaTextChangeArgs {
	isTerminalMode: boolean;
	slashCommandOpen: boolean;
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
}

export function useInputAreaTextChange({
	isTerminalMode,
	slashCommandOpen,
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
