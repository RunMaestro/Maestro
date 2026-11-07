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

import { scopeForMode } from '../../../shared/acappella/voice-mode';
import { beginVoiceSession, useVoiceSessionStore } from '../../stores/voiceSessionStore';
import { isVoiceSessionActive } from '../../../shared/acappella/session-state';
import { useVoiceUiStore } from '../../stores/voiceUiStore';
import { resolveFocusedAiTabId } from '../../utils/panelLayout';
import { notifyVoiceStartFailed } from '../../services/voiceListening';
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
	const defaultMode = useVoiceUiStore((s) => s.defaultMode);
	const conductorFloor = useVoiceSessionStore(
		(s) => isVoiceSessionActive(s.state) && s.scope?.kind === 'conductor'
	);
	const hasComposerFloor =
		voiceActions.hasVoiceFloor || (defaultMode === 'conductor' && conductorFloor);

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
			// With a session already bound to this agent, the button brings its HUD
			// back (it may be minimized) and never ends it: only Escape on the HUD
			// closes a voice session. It used to hang up here, so minimizing the HUD
			// and reaching for the microphone again silently stopped the listening
			// the user had asked to keep.
			if (hasComposerFloor) voiceActions.showHud();
			else
				void (async () => {
					try {
						await useVoiceUiStore.getState().load();
						const scope = scopeForMode(useVoiceUiStore.getState().defaultMode, {
							scope: null,
							lastDispatch: null,
							focusedAgentId: session?.id ?? null,
							activeTabOf: () => resolveFocusedAiTabId(session),
						});
						if (!scope) throw new Error('Open an AI tab before starting Tab voice mode.');
						voiceActions.showHud();
						await beginVoiceSession(scope);
					} catch (error) {
						notifyVoiceStartFailed(error);
					}
				})();
			return;
		}
		webSpeech.toggleVoiceInput();
	}, [usesACappella, voiceActions, webSpeech, session, hasComposerFloor]);

	return {
		// A Cappella needs no browser support check: the capability gate answers
		// that question, and it answers it when the session is started rather than
		// by hiding the button and never saying why.
		voiceSupported: usesACappella || webSpeech.voiceSupported,
		isListening: usesACappella ? hasComposerFloor : webSpeech.isListening,
		toggle,
		usesACappella,
	};
}
