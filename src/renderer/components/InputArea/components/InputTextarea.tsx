/**
 * InputTextarea - the AI composer's adapter over the shared ComposerTextarea.
 *
 * Owns what only the AI composer has: the mention roster read from the
 * session store (gated on the draft holding an `@`, and excluding this agent),
 * the mode-aware placeholder, and command mode's `$` prefix and fixed-pitch
 * font. It takes the agent's id, name and provider rather than the whole
 * Session, so this agent's own streaming flushes, which replace the Session
 * object, do not re-render it.
 */

import React, { memo, useCallback, useMemo } from 'react';
import type { Session, Group, Theme, ToolType } from '../../../types';
import { getProviderDisplayName } from '../../../utils/sessionValidation';
import { useSettingsStore } from '../../../stores/settingsStore';
import { useSessionStore } from '../../../stores/sessionStore';
import { buildKnownMentionNameSet } from '../../../hooks/input/useAgentMentionCompletion';
import { useFixedPitchFont } from '../../../hooks/ui/useFixedPitchFont';
import { ComposerTextarea } from '../../ChatComposer';

interface InputTextareaProps {
	/** This agent's id, left out of its own mention roster. */
	agentId: string;
	agentName: string;
	toolType: ToolType;
	theme: Theme;
	isTerminalMode: boolean;
	/**
	 * True while an AI-mode draft is a literal shell command line. Derived once
	 * by InputArea, which also uses it to gate Tab completion, so both
	 * affordances can never disagree about whether this is a shell line.
	 */
	isCommandModeDraft: boolean;
	/** True while an AI-mode draft is an AI command request (prose, not a line). */
	isAiCommandDraft: boolean;
	/**
	 * True while a suggestion is in flight or a proposal is awaiting an answer.
	 * The textarea goes read-only rather than unmounting: the caret has to stay
	 * here, because Enter / arrows / Escape all answer the card from this
	 * element's keydown handler.
	 */
	awaitingAiCommand: boolean;
	inputValue: string;
	spellCheckEnabled: boolean;
	inputRef: React.RefObject<HTMLTextAreaElement>;
	onInputFocus: () => void;
	onInputBlur?: () => void;
	onChange: (e: React.ChangeEvent<HTMLTextAreaElement>) => void;
	handleInputKeyDown: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void;
	handlePaste: (e: React.ClipboardEvent<HTMLTextAreaElement>) => void;
	handleDrop: (e: React.DragEvent<HTMLElement>) => void;
}

// Stable empty references so the gated sessions/groups selectors return the same
// value on every render while the composer has no `@` - no re-render churn from
// unrelated streaming flushes.
const EMPTY_SESSIONS: Session[] = [];
const EMPTY_GROUPS: Group[] = [];

export const InputTextarea = memo(function InputTextarea({
	agentId,
	agentName,
	toolType,
	theme,
	isTerminalMode,
	isCommandModeDraft,
	isAiCommandDraft,
	awaitingAiCommand,
	inputValue,
	spellCheckEnabled,
	inputRef,
	onInputFocus,
	onInputBlur,
	onChange,
	handleInputKeyDown,
	handlePaste,
	handleDrop,
}: InputTextareaProps) {
	// The chip overlay is an AI-mode enhancement. In terminal mode (shell
	// commands) the textarea behaves exactly as before: opaque text, no overlay.
	const overlayEnabled = !isTerminalMode;

	// The mentionable agent/group roster (from this agent's vantage point).
	// A bare `@word` only lights up when it names a known agent/group; unknown
	// words stay plain text. Excludes the current agent (can't @-mention itself).
	//
	// Only subscribe to the roster when the input actually contains an `@`.
	// `sessions` is replaced on every streaming flush from ANY agent, so gating
	// the SELECTORS (not just the derived memo) keeps an `@`-free composer from
	// re-rendering on unrelated output - the stable empty refs compare equal.
	const hasMentionCandidate = overlayEnabled && inputValue.includes('@');
	const sessions = useSessionStore((state) =>
		hasMentionCandidate ? state.sessions : EMPTY_SESSIONS
	);
	const groups = useSessionStore((state) => (hasMentionCandidate ? state.groups : EMPTY_GROUPS));
	const knownMentionNames = useMemo(
		() => (hasMentionCandidate ? buildKnownMentionNameSet(sessions, groups, agentId) : undefined),
		[hasMentionCandidate, sessions, groups, agentId]
	);

	// Command mode borrows the terminal composer's `$` affordance so the switch
	// is visible before you hit Enter. AI command mode deliberately does not: its
	// draft is a sentence, and a `$` in front of one promises a shell line.
	const showShellPrefix = isTerminalMode || isCommandModeDraft;

	// A command line is shell text, so it is typed in the same fixed-pitch face
	// the terminal and the output card use: paths and flags line up, and the
	// switch out of chat is legible before the `$` is even read. AI command mode
	// keeps the proportional font on purpose - that draft is a sentence, and the
	// command it produces gets monospace when it appears in the proposal card.
	const fontFamily = useSettingsStore((state) => state.fontFamily);
	const shellFontFamily = useFixedPitchFont(fontFamily);

	const handleTextareaDrop = useCallback(
		(e: React.DragEvent<HTMLTextAreaElement>) => {
			e.stopPropagation();
			handleDrop(e);
		},
		[handleDrop]
	);

	return (
		<ComposerTextarea
			theme={theme}
			value={inputValue}
			inputRef={inputRef}
			placeholder={
				isTerminalMode
					? 'Run shell command...'
					: awaitingAiCommand
						? 'Enter runs it - arrows choose - Esc cancels'
						: isAiCommandDraft
							? 'Describe what you want to accomplish... (Esc for Command Mode)'
							: isCommandModeDraft
								? 'Run shell command... (! for AI Command, Esc for the agent)'
								: `Talking to ${agentName} powered by ${getProviderDisplayName(toolType)}`
			}
			spellCheck={spellCheckEnabled}
			knownMentionNames={knownMentionNames}
			mentionChips={overlayEnabled}
			prefix={
				showShellPrefix ? (
					<span
						className="text-sm font-bold select-none pl-3 pt-3"
						style={{ color: theme.colors.accent, fontFamily: shellFontFamily }}
						title={
							isCommandModeDraft ? 'Command mode: runs in the shell, not the agent' : undefined
						}
					>
						$
					</span>
				) : undefined
			}
			// Shell text is a grid, so command mode types (and measures the chips)
			// in a fixed-pitch stack. A command-mode draft can hold an `@mention`,
			// which puts the chips under monospace glyphs.
			fontFamily={showShellPrefix ? shellFontFamily : undefined}
			// Read-only, not disabled: a disabled textarea cannot hold focus, and
			// every key that answers the proposal is read from this element.
			readOnly={awaitingAiCommand}
			onFocus={onInputFocus}
			onBlur={onInputBlur}
			onChange={onChange}
			onKeyDown={handleInputKeyDown}
			onPaste={handlePaste}
			onDrop={handleTextareaDrop}
		/>
	);
});
