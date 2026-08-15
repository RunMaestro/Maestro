/**
 * Preload API for A Cappella (voice sessions).
 *
 * Provides the `window.maestro.voice` namespace. Every channel is gated in the
 * main process on the `aCappella` Encore flag; when it is off they reject with
 * 'ACappellaDisabled', which callers treat as "feature off" rather than "no
 * session". `stop()` is the one exception and always works, so a client can
 * release the floor even after the flag is turned off mid-session.
 *
 * `onEvent` is the whole protocol: state, transcript, routing, dispatch, and
 * speech all arrive as `VoiceEvent`s on one ordered stream, so a client renders
 * from the stream rather than from the return values of these calls.
 */

import { ipcRenderer } from 'electron';
import type { RosterAgent, VoiceEvent, VoiceScope } from '../../shared/acappella/protocol';
import type { VoiceSessionSnapshot } from '../acappella';
import type { VoiceStartSessionResult } from '../ipc/handlers/acappella';

/**
 * Creates the A Cappella voice API object for contextBridge exposure.
 */
export function createVoiceApi() {
	return {
		/**
		 * Open a voice session. Omit the scope for conductor scope. Any live
		 * session is replaced rather than stacked.
		 *
		 * Returns the snapshot plus any provider substitutions: a role that fell
		 * back to the mock tier is reported here, never applied silently.
		 */
		start: (scope?: VoiceScope): Promise<VoiceStartSessionResult> =>
			ipcRenderer.invoke('acappella:start-session', scope),

		/** End the session and return to idle. Safe to call when already idle. */
		stop: (): Promise<void> => ipcRenderer.invoke('acappella:stop-session'),

		/**
		 * Hand the service a settled utterance. This is the same seam a real STT
		 * final transcript lands on, so the dev harness and a microphone are
		 * indistinguishable downstream.
		 *
		 * @returns false when the session cannot take an utterance right now.
		 */
		submitUtterance: (text: string): Promise<boolean> =>
			ipcRenderer.invoke('acappella:submit-utterance', text),

		/**
		 * Barge-in: cancel speech and KEEP the floor. Distinct from {@link stopWord}
		 * on purpose - talking over the assistant must not hang up on it.
		 *
		 * @returns false when nothing was speaking.
		 */
		interrupt: (source: 'voice' | 'client-button' = 'client-button'): Promise<boolean> =>
			ipcRenderer.invoke('acappella:interrupt', source),

		/** The stop word: end the session from any state. */
		stopWord: (payload?: { phrase?: string; source?: 'voice' | 'client-button' }): Promise<void> =>
			ipcRenderer.invoke('acappella:stop-word', payload),

		/** Current agents and their AI tabs, as the Brain sees them. */
		getRoster: (): Promise<RosterAgent[]> => ipcRenderer.invoke('acappella:get-roster'),

		/**
		 * Catch-up snapshot. Null when no session service exists yet (nothing is
		 * constructed until the first `start`), which a client reads as idle.
		 */
		getState: (): Promise<VoiceSessionSnapshot | null> => ipcRenderer.invoke('acappella:get-state'),

		/**
		 * Subscribe to the protocol event stream. Events carry a monotonic `seq`
		 * per voice session, so a gap means events were lost.
		 *
		 * @returns Cleanup function to unsubscribe.
		 */
		onEvent: (handler: (event: VoiceEvent) => void): (() => void) => {
			const wrappedHandler = (_event: Electron.IpcRendererEvent, voiceEvent: VoiceEvent) =>
				handler(voiceEvent);
			ipcRenderer.on('acappella:event', wrappedHandler);
			return () => ipcRenderer.removeListener('acappella:event', wrappedHandler);
		},
	};
}

/**
 * TypeScript type for the A Cappella voice API.
 */
export type VoiceApi = ReturnType<typeof createVoiceApi>;
