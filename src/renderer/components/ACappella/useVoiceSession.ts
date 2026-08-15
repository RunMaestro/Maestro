/**
 * useVoiceSession - the renderer's one connection to the voice session.
 *
 * Subscribes to the `acappella:event` push stream, projects every event into
 * `voiceSessionStore`, and hands back the actions. Mounted once (by the HUD):
 * the stream is a broadcast, so a second subscriber would apply every event
 * twice.
 *
 * On the IPC subscription: `window.maestro.voice.onEvent()` already returns its
 * own unsubscribe, so this is a plain `useEffect` that returns it rather than a
 * `useEventListener()` call. That hook wraps `addEventListener`/
 * `removeEventListener` on a DOM `EventTarget`, which the preload bridge is
 * not; using it here would mean inventing a DOM event just to hop through it.
 * The rule it enforces - never hand-pair add/remove inside an effect - is
 * satisfied: nothing is paired by hand, the bridge owns the teardown.
 */

import { useCallback, useEffect } from 'react';
import type { VoiceScope } from '../../../shared/acappella/protocol';
import { useVoiceSessionStore } from '../../stores/voiceSessionStore';

export interface VoiceSessionActions {
	/** Open a session. Omit the scope for conductor scope. */
	start: (scope?: VoiceScope) => Promise<void>;
	/** End the session and return to idle. */
	stop: () => Promise<void>;
	submitUtterance: (text: string) => Promise<boolean>;
	/** Barge-in: cancel speech, keep the floor. */
	interrupt: () => Promise<boolean>;
	/** Feed the session an agent answer so it has something to speak. */
	submitAgentReply: (params: {
		agentSessionId: string;
		tabId: string;
		text: string;
	}) => Promise<boolean>;
}

/**
 * Subscribe to the voice event stream and return the session actions.
 *
 * @param enabled Mirror of the A Cappella Encore flag. False unsubscribes and
 *                clears the mirrored state, so turning the feature off cannot
 *                leave a stale session on screen.
 */
export function useVoiceSession(enabled: boolean): VoiceSessionActions {
	useEffect(() => {
		if (!enabled) {
			useVoiceSessionStore.getState().reset();
			return;
		}

		const unsubscribe = window.maestro.voice.onEvent((event) => {
			useVoiceSessionStore.getState().applyEvent(event);
		});

		// Catch-up: a window opened mid-session (or reloaded) has missed every
		// event so far, and the stream alone would leave it claiming idle.
		void window.maestro.voice
			.getState()
			.then((snapshot) => useVoiceSessionStore.getState().applySnapshot(snapshot))
			.catch(() => {
				// The one expected rejection is 'ACappellaDisabled' from a flag that
				// flipped off between the guard above and this call. There is no
				// session to show either way.
			});

		return unsubscribe;
	}, [enabled]);

	const start = useCallback(async (scope?: VoiceScope) => {
		const result = await window.maestro.voice.start(scope);
		const store = useVoiceSessionStore.getState();
		store.applySnapshot(result.snapshot);
		// A role that fell back to the mock tier has to reach the user. The
		// registry refuses to substitute silently; dropping the report here would
		// undo that at the last hop.
		store.setSubstitutions(result.substitutions);
	}, []);

	const stop = useCallback(async () => {
		await window.maestro.voice.stop();
	}, []);

	const submitUtterance = useCallback(
		(text: string) => window.maestro.voice.submitUtterance(text),
		[]
	);

	const interrupt = useCallback(() => window.maestro.voice.interrupt('client-button'), []);

	const submitAgentReply = useCallback(
		(params: { agentSessionId: string; tabId: string; text: string }) =>
			window.maestro.voice.submitAgentReply(params),
		[]
	);

	return { start, stop, submitUtterance, interrupt, submitAgentReply };
}
