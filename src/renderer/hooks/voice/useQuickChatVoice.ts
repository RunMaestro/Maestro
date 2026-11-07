/**
 * useQuickChatVoice - what the Quick Chat window's microphone does.
 *
 * The composer microphone in the main window opens a voice session and hands it
 * to the Voice HUD, where the mode switch, the talk button and the transcript
 * live. The Quick Chat window has no HUD and wants none: it is one conversation
 * with one agent. So its microphone opens a session LOCKED to that conversation
 * (`QUICK_CHAT_VOICE_SCOPE`, rules in `shared/acappella/quick-chat-scope.ts`),
 * and this hook is the whole surface: is a session live, what state is it in,
 * what is being heard.
 *
 * One button, two gestures, the same pair the HUD's talk button and the document
 * chat's microphone use:
 *
 *   - **Tap** starts the session with the microphone open, and ends it. There is
 *     no separate close control here, so the tap is the off switch.
 *   - **Hold** is push-to-talk: the microphone is open while the button is down
 *     and the release sends what was said. The session stays for the next hold.
 *
 * It also owns this window's one subscription to the voice event stream
 * (`useVoiceSession`). The Quick Chat window boots its own renderer, so the
 * HUD's subscription in the app window does not reach its store.
 */

import { useCallback, useEffect, useState } from 'react';

import { voiceHudVisualState, type VoiceHudVisualState } from '../../../shared/acappella/hud-state';
import {
	QUICK_CHAT_VOICE_SCOPE,
	isQuickChatScope,
} from '../../../shared/acappella/quick-chat-scope';
import { isVoiceSessionActive } from '../../../shared/acappella/session-state';
import { useVoiceSession } from '../../components/ACappella/useVoiceSession';
import { closeVoiceMic, openVoiceMic } from '../../services/voiceListening';
import { selectACappellaEnabled, useSettingsStore } from '../../stores/settingsStore';
import { useVoiceSessionStore } from '../../stores/voiceSessionStore';
import { useVoiceUiStore } from '../../stores/voiceUiStore';
import { ipcErrorMessage } from '../../utils/ipcErrorMessage';

export interface QuickChatVoice {
	/** The A Cappella Encore flag. False means the window draws no microphone. */
	enabled: boolean;
	/** A live voice session is bound to Quick Chat. */
	active: boolean;
	/** What the microphone's indicator draws while {@link active}. */
	visualState: VoiceHudVisualState;
	/** What is being heard right now, or an empty string. */
	partialTranscript: string;
	/** Why the session did not start, or failed. Null when there is nothing to say. */
	error: string | null;
	/** Tap-vs-hold threshold, the one the HUD and the voice hotkey use. */
	holdThresholdMs: number;
	/** Tap: start a session with the microphone open, or end the live one. */
	toggle: () => void;
	/** Hold began: open the microphone until the release. */
	holdStart: () => void;
	/** Hold ended: shut the microphone and send what was said. */
	holdEnd: () => void;
}

export function useQuickChatVoice(): QuickChatVoice {
	const enabled = useSettingsStore(selectACappellaEnabled);
	useVoiceSession(enabled);

	// The hold threshold lives in the voice settings blob. Read once the feature
	// is on; until then the store's default is the documented default.
	useEffect(() => {
		if (enabled) void useVoiceUiStore.getState().load();
	}, [enabled]);

	const bound = useVoiceSessionStore((s) => isQuickChatScope(s.scope));
	const state = useVoiceSessionStore((s) => s.state);
	const listenPaused = useVoiceSessionStore((s) => s.listenPaused);
	const partialTranscript = useVoiceSessionStore((s) => s.partialTranscript);
	const sessionError = useVoiceSessionStore((s) => s.error);
	const holdThresholdMs = useVoiceUiStore((s) => s.holdThresholdMs);

	// Every window mirrors the one voice session, so "a session is live" is not
	// enough: one opened from the main window's composer is not this window's.
	const active = enabled && bound && isVoiceSessionActive(state);

	// A start that is refused outright (a rejected IPC call) never reaches the
	// event stream, and this window has no toast surface to catch it.
	const [startError, setStartError] = useState<string | null>(null);
	const reportStartError = useCallback((error: unknown) => {
		setStartError(ipcErrorMessage(error));
	}, []);
	useEffect(() => {
		if (active) setStartError(null);
	}, [active]);

	const toggle = useCallback(() => {
		if (!enabled) return;
		setStartError(null);
		if (active) {
			void window.maestro.voice.stop().catch(reportStartError);
			return;
		}
		void openVoiceMic({ scope: QUICK_CHAT_VOICE_SCOPE, onError: reportStartError });
	}, [active, enabled, reportStartError]);

	const holdStart = useCallback(() => {
		if (!enabled) return;
		setStartError(null);
		void openVoiceMic({ hold: true, scope: QUICK_CHAT_VOICE_SCOPE, onError: reportStartError });
	}, [enabled, reportStartError]);

	const holdEnd = useCallback(() => {
		void closeVoiceMic({ send: true });
	}, []);

	return {
		enabled,
		active,
		visualState: voiceHudVisualState(state, listenPaused),
		partialTranscript: active ? partialTranscript : '',
		// A session error names the session that carried it, so it is shown only
		// for a Quick Chat one: another window's failure is not this window's news.
		error: startError ?? (enabled && bound ? (sessionError?.message ?? null) : null),
		holdThresholdMs,
		toggle,
		holdStart,
		holdEnd,
	};
}
