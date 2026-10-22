import React, { memo, useMemo } from 'react';
import type { Session, Group, Theme } from '../../../types';
import { resolveTabProvider } from '../../../utils/providerTabSessions';
import { getProviderDisplayName } from '../../../utils/sessionValidation';
import { useSettingsStore } from '../../../stores/settingsStore';
import { useSessionStore } from '../../../stores/sessionStore';
import { buildKnownMentionNameSet } from '../../../hooks/input/useAgentMentionCompletion';
import { KEYSTROKE_TEXTAREA_MAX_HEIGHT } from '../../../utils/textareaSizing';
import { useFixedPitchFont } from '../../../hooks/ui/useFixedPitchFont';
import {
	MENTION_OVERLAY_TYPOGRAPHY,
	MentionChipOverlay,
	useMentionChipOverlay,
} from '../../MentionChipOverlay';

interface InputTextareaProps {
	session: Session;
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

/**
 * Overlay padding. Must stay identical to the textarea's `pt-3 pr-3 pb-1 pl-3`,
 * or the chip overlay drifts off the caret. The 12px top + 4px bottom padding is
 * deliberate: it leaves exactly 160px of text inside the 176px cap, i.e. 8 whole
 * 20px rows, so bottom-snapping can never leave a partially sliced row.
 */
const OVERLAY_PADDING = '0.75rem 0.75rem 0.25rem 0.75rem';

// Stable empty references so the gated sessions/groups selectors return the same
// value on every render while the composer has no `@` - no re-render churn from
// unrelated streaming flushes.
const EMPTY_SESSIONS: Session[] = [];
const EMPTY_GROUPS: Group[] = [];

export const InputTextarea = memo(function InputTextarea({
	session,
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
		() =>
			hasMentionCandidate ? buildKnownMentionNameSet(sessions, groups, session.id) : undefined,
		[hasMentionCandidate, sessions, groups, session.id]
	);

	const mentionOverlay = useMentionChipOverlay({
		inputRef,
		value: inputValue,
		enabled: overlayEnabled,
		knownMentionNames,
	});
	const { overlayRendered } = mentionOverlay;

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

	return (
		<div className="relative flex items-start">
			{showShellPrefix && (
				<span
					className="text-sm font-bold select-none pl-3 pt-3"
					style={{ color: theme.colors.accent, fontFamily: shellFontFamily }}
					title={isCommandModeDraft ? 'Command mode: runs in the shell, not the agent' : undefined}
				>
					$
				</span>
			)}
			<MentionChipOverlay
				overlay={mentionOverlay}
				theme={theme}
				padding={OVERLAY_PADDING}
				// Track the textarea's command-mode font override exactly. The overlay
				// is enabled for everything but terminal mode, so a command-mode draft
				// containing an `@mention` puts this decoration under monospace glyphs.
				fontFamily={showShellPrefix ? shellFontFamily : undefined}
			/>
			<textarea
				ref={inputRef}
				className={`relative flex-1 bg-transparent text-sm outline-none ${showShellPrefix ? 'pl-1.5' : 'pl-3'} pt-3 pr-3 pb-1 resize-none min-h-[3.5rem] scrollbar-thin`}
				style={{
					...MENTION_OVERLAY_TYPOGRAPHY,
					// Native text is always visible. The overlay underneath contributes only
					// the mention chip decoration, never a second copy of the glyphs.
					color: theme.colors.textMain,
					caretColor: theme.colors.textMain,
					// Single source of truth with the resize logic: the CSS cap and
					// resizeTextareaToContent's clamp can never disagree.
					maxHeight: `${KEYSTROKE_TEXTAREA_MAX_HEIGHT}px`,
					// Sit above the decorative overlay so the caret + native selection win.
					zIndex: overlayRendered ? 1 : undefined,
					// Shell text is a grid, so command mode overrides the composer font
					// with a measured fixed-pitch stack. Set after MENTION_OVERLAY_TYPOGRAPHY so it
					// wins, and left undefined in agent mode so the shared value stands.
					fontFamily: showShellPrefix ? shellFontFamily : undefined,
				}}
				placeholder={
					isTerminalMode
						? 'Run shell command...'
						: awaitingAiCommand
							? 'Enter runs it - arrows choose - Esc cancels'
							: isAiCommandDraft
								? 'Describe what you want to accomplish... (Esc for Command Mode)'
								: isCommandModeDraft
									? 'Run shell command... (! for AI Command, Esc for the agent)'
									: `Talking to ${session.name} powered by ${getProviderDisplayName(
											resolveTabProvider(
												session.aiTabs.find((tab) => tab.id === session.activeTabId),
												session
											)
										)}`
				}
				value={inputValue}
				// Read-only, not disabled: a disabled textarea cannot hold focus, and
				// every key that answers the proposal is read from this element.
				readOnly={awaitingAiCommand}
				spellCheck={spellCheckEnabled}
				onFocus={onInputFocus}
				onBlur={() => {
					mentionOverlay.onBlur();
					onInputBlur?.();
				}}
				onChange={(e) => {
					mentionOverlay.onSelectionChange(e.currentTarget);
					onChange(e);
				}}
				onSelect={(e) => mentionOverlay.onSelectionChange(e.currentTarget)}
				onScroll={mentionOverlay.onScroll}
				onKeyDown={handleInputKeyDown}
				onPaste={handlePaste}
				onDrop={(e) => {
					e.stopPropagation();
					handleDrop(e);
				}}
				onDragOver={(e) => e.preventDefault()}
				rows={2}
			/>
		</div>
	);
});
