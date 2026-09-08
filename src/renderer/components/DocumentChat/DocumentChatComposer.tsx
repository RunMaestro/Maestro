/**
 * The chat bubble's input: one text box, three ways to fill it.
 *
 * The mode switch is a `<SegmentedControl>` rather than a bespoke pill bar, and
 * the microphone classifies its press with `usePressAndHold` - the same hook and
 * the same `holdThresholdMs` the voice HUD's talk button uses, so a hold means
 * the same thing wherever the user does it.
 *
 * What each mode does, and why the two microphone modes are separate:
 *
 *   - **Type.** Enter sends, Shift+Enter breaks a line. No microphone.
 *   - **Push to type.** Hold the microphone and the Web Speech recogniser streams
 *     into the draft. It ends where dictation should end - in the box, with the
 *     caret in it - so the words can be fixed before they are sent. Web Speech is
 *     used rather than the A Cappella stack because dictation must work on every
 *     install: it needs no models, no Encore Feature, and no downloads.
 *   - **Push to talk.** Hold the microphone and a voice session about this
 *     document opens. The turn is routed and the reply is SPOKEN, which is a
 *     different act from dictating, so it gets its own mode instead of hiding
 *     behind a setting on the same button.
 *
 * Both microphone modes land in the SAME conversation as typing, because all
 * three end up in the one AI tab bound to this document.
 */

import React, { useCallback, useEffect, useMemo, useRef } from 'react';
import { Mic, MicOff, Send } from 'lucide-react';
import type { Theme } from '../../types';
import { SegmentedControl } from '../ui/SegmentedControl';
import { useAutosizeTextarea } from '../../hooks/ui/useAutosizeTextarea';
import { usePressAndHold } from '../../hooks/utils/usePressAndHold';
import { useVoiceInput } from '../../hooks/utils/useVoiceInput';
import { readableTextOn } from '../../../shared/colorContrast';
import {
	DOCUMENT_CHAT_MODES,
	DOCUMENT_CHAT_MODE_HINTS,
	DOCUMENT_CHAT_MODE_LABELS,
	isPushMode,
	type DocumentChatMode,
} from './modes';

interface DocumentChatComposerProps {
	theme: Theme;
	mode: DocumentChatMode;
	onModeChange: (mode: DocumentChatMode) => void;
	draft: string;
	onDraftChange: (value: string) => void;
	onSend: () => void;
	/** Tap-vs-hold threshold, mirrored from the voice control settings. */
	holdThresholdMs: number;
	/** Whether A Cappella is on. Gates push-to-talk only. */
	voiceEnabled: boolean;
	/** True while the live voice session is about this document. */
	voiceActive: boolean;
	onStartVoice: () => void;
	onStopVoice: () => void;
}

export const DocumentChatComposer = React.memo(function DocumentChatComposer({
	theme,
	mode,
	onModeChange,
	draft,
	onDraftChange,
	onSend,
	holdThresholdMs,
	voiceEnabled,
	voiceActive,
	onStartVoice,
	onStopVoice,
}: DocumentChatComposerProps) {
	const textareaRef = useRef<HTMLTextAreaElement>(null);
	useAutosizeTextarea({ textareaRef, value: draft, maxHeight: 120 });

	// Dictation for push-to-type. Hard off in every other mode, so a stray call
	// can never open a microphone the user did not ask for - the same rule
	// `useComposerVoice` enforces between the two voice stacks.
	const dictation = useVoiceInput({
		currentValue: draft,
		onTranscriptionChange: onDraftChange,
		focusRef: textareaRef,
		disabled: mode !== 'push-to-type',
	});

	const options = useMemo(
		() =>
			DOCUMENT_CHAT_MODES.map((value) => ({
				value,
				label: DOCUMENT_CHAT_MODE_LABELS[value],
				title: DOCUMENT_CHAT_MODE_HINTS[value],
			})),
		[]
	);

	// Leaving a push mode must release whatever it was holding. Without this,
	// switching to Type mid-hold leaves the recogniser running against a box the
	// user is now typing into, or the voice floor open with no button to close it.
	useEffect(() => {
		if (mode !== 'push-to-type') dictation.stopVoiceInput();
		// `stopVoiceInput` has a stable identity, so this fires on a mode change
		// rather than on every keystroke.
	}, [mode, dictation.stopVoiceInput]);

	const isTalkMode = mode === 'push-to-conversation';

	const onHoldStart = useCallback(() => {
		if (isTalkMode) {
			if (!voiceActive) onStartVoice();
			return;
		}
		dictation.startVoiceInput();
	}, [isTalkMode, voiceActive, onStartVoice, dictation.startVoiceInput]);

	const onHoldEnd = useCallback(() => {
		if (isTalkMode) {
			onStopVoice();
			return;
		}
		dictation.stopVoiceInput();
	}, [isTalkMode, onStopVoice, dictation.stopVoiceInput]);

	// A tap toggles, which is what a tap has always meant on the voice hotkey and
	// on the HUD's talk button: someone having a conversation taps once and
	// forgets about it, and forcing them to hold for a whole spoken paragraph is
	// the fight this pairing exists to avoid.
	const onTap = useCallback(() => {
		if (isTalkMode) {
			if (voiceActive) onStopVoice();
			else onStartVoice();
			return;
		}
		if (dictation.isListening) dictation.stopVoiceInput();
		else dictation.startVoiceInput();
	}, [
		isTalkMode,
		voiceActive,
		onStartVoice,
		onStopVoice,
		dictation.isListening,
		dictation.startVoiceInput,
		dictation.stopVoiceInput,
	]);

	// Push-to-talk needs the Encore Feature; push-to-type needs a recogniser in
	// this build. Either missing disables the button rather than hiding it, so
	// the tooltip can say WHY instead of leaving a mode that appears to do
	// nothing.
	const pushUnavailable = isTalkMode ? !voiceEnabled : !dictation.voiceSupported;
	const listening = isTalkMode ? voiceActive : dictation.isListening;

	const { holding, beginPress, endPress } = usePressAndHold({
		holdThresholdMs,
		onHoldStart,
		onHoldEnd,
		onTap,
		disabled: pushUnavailable,
	});

	const handleKeyDown = useCallback(
		(event: React.KeyboardEvent<HTMLTextAreaElement>) => {
			if (event.key !== 'Enter' || event.shiftKey) return;
			event.preventDefault();
			onSend();
		},
		[onSend]
	);

	const pushLabel = pushUnavailable
		? isTalkMode
			? 'Turn A Cappella on in Settings to talk'
			: 'This build has no speech recogniser'
		: holding
			? 'Release to stop'
			: listening
				? 'Stop'
				: isTalkMode
					? 'Hold to talk, or tap to start'
					: 'Hold to dictate, or tap to start';

	const onAccent = readableTextOn(theme.colors.accentForeground, [theme.colors.accent]);

	return (
		<div
			className="flex-shrink-0 border-t px-2 py-2 flex flex-col gap-2"
			style={{ borderColor: theme.colors.border }}
		>
			<SegmentedControl
				value={mode}
				onChange={onModeChange}
				options={options}
				theme={theme}
				ariaLabel="Chat input mode"
				testId="document-chat-mode"
			/>

			<div className="flex items-end gap-1.5">
				{isPushMode(mode) && (
					<button
						type="button"
						data-testid="document-chat-push"
						aria-label={pushLabel}
						aria-pressed={listening}
						title={pushLabel}
						disabled={pushUnavailable}
						onPointerDown={(event) => {
							if (event.button !== 0) return;
							beginPress();
						}}
						onPointerUp={endPress}
						// Keyboard users get the plain toggle. Holding a key needs a keyup
						// this button does not reliably receive once focus moves, and a
						// push-to-talk that sometimes fails to release is worse than a toggle.
						onKeyDown={(event) => {
							if (event.key !== 'Enter' && event.key !== ' ') return;
							event.preventDefault();
							onTap();
						}}
						className="flex-shrink-0 p-1.5 rounded-full transition-colors focus:outline-none focus-visible:ring-2 disabled:opacity-40 disabled:cursor-not-allowed"
						style={{
							backgroundColor: listening ? theme.colors.accent : 'transparent',
							color: listening ? onAccent : theme.colors.textDim,
							border: `1px solid ${listening ? theme.colors.accent : theme.colors.border}`,
						}}
					>
						{listening ? <Mic className="w-4 h-4" /> : <MicOff className="w-4 h-4" />}
					</button>
				)}

				<textarea
					ref={textareaRef}
					data-testid="document-chat-input"
					value={draft}
					onChange={(event) => onDraftChange(event.target.value)}
					onKeyDown={handleKeyDown}
					rows={1}
					placeholder={mode === 'type' ? 'Ask about this document...' : 'Speak, or type here...'}
					aria-label="Message about this document"
					className="flex-1 min-w-0 resize-none rounded px-2 py-1.5 text-xs outline-none focus:ring-1"
					style={{
						backgroundColor: theme.colors.bgMain,
						border: `1px solid ${theme.colors.border}`,
						color: theme.colors.textMain,
					}}
				/>

				<button
					type="button"
					data-testid="document-chat-send"
					aria-label="Send message"
					title="Send message (Enter)"
					disabled={draft.trim().length === 0}
					onClick={onSend}
					className="flex-shrink-0 p-1.5 rounded transition-colors focus:outline-none focus-visible:ring-2 disabled:opacity-40 disabled:cursor-not-allowed hover:bg-white/10"
					style={{ color: theme.colors.accent }}
				>
					<Send className="w-4 h-4" />
				</button>
			</div>
		</div>
	);
});

export default DocumentChatComposer;
