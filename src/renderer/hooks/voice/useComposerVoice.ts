/**
 * useComposerVoice - what the composer's microphone button does.
 *
 * There are two voice stacks in Maestro and exactly one button, so this hook is
 * the seam that decides which one the button drives:
 *
 *   - **A Cappella on.** The button opens a voice session bound to this agent.
 *     That is strictly more than dictation - the utterance is routed, the reply
 *     is spoken back, and barge-in works - and it runs on the engines the user
 *     configured rather than on whatever the embedder happens to ship.
 *   - **A Cappella off.** The Web Speech path stays exactly as it was:
 *     `useVoiceInput` streams interim results into the draft and appends the
 *     final transcript. It is ungated, needs no models, and is the only voice
 *     input most users will ever have.
 *
 * The Web Speech path is deliberately NOT removed. It is the fallback for every
 * install that has not turned the Encore Feature on, which is all of them by
 * default, and deleting it would take dictation away from those users to tidy up
 * a code path.
 *
 * The two are mutually exclusive by construction: `useVoiceInput` is handed
 * `disabled` whenever A Cappella owns the button, so a stray call cannot open a
 * second microphone alongside the session's.
 */

import { useCallback } from 'react';
import { useVoiceInput } from '../utils/useVoiceInput';
import { useVoiceAgentActions } from './useVoiceAgentActions';
import type { Session } from '../../types';

export interface UseComposerVoiceOptions {
	/** The agent whose composer this is. */
	session: Session | undefined;
	/** Current draft, for the Web Speech path to append to. */
	currentValue: string;
	/** Draft setter, for the Web Speech path. */
	onTranscriptionChange: (value: string) => void;
	/** Refocused after Web Speech dictation ends. */
	focusRef?: React.RefObject<HTMLTextAreaElement | HTMLInputElement>;
	/** True in terminal mode, where neither path applies. */
	disabled?: boolean;
}

export interface UseComposerVoiceReturn {
	/** Whether to render the button at all. */
	voiceSupported: boolean;
	/** Whether the button should read as active. */
	isListening: boolean;
	/** Stable across renders. Toggles whichever stack owns the button. */
	toggle: () => void;
	/** True when A Cappella owns the button, so callers can adjust their copy. */
	usesACappella: boolean;
}

export function useComposerVoice({
	session,
	currentValue,
	onTranscriptionChange,
	focusRef,
	disabled = false,
}: UseComposerVoiceOptions): UseComposerVoiceReturn {
	const voiceActions = useVoiceAgentActions(session);
	const usesACappella = voiceActions.enabled && !disabled;

	const webSpeech = useVoiceInput({
		currentValue,
		onTranscriptionChange,
		focusRef,
		// Hard off whenever A Cappella owns the button: two microphones open on one
		// button is the failure this single seam exists to prevent.
		disabled: disabled || usesACappella,
	});

	const toggle = useCallback(() => {
		if (usesACappella) {
			void (voiceActions.hasVoiceFloor
				? voiceActions.endVoiceSession()
				: voiceActions.talkToAgent());
			return;
		}
		webSpeech.toggleVoiceInput();
	}, [usesACappella, voiceActions, webSpeech]);

	return {
		// A Cappella needs no browser support check: the capability gate answers
		// that question, and it answers it when the session is started rather than
		// by hiding the button and never saying why.
		voiceSupported: usesACappella || webSpeech.voiceSupported,
		isListening: usesACappella ? voiceActions.hasVoiceFloor : webSpeech.isListening,
		toggle,
		usesACappella,
	};
}
