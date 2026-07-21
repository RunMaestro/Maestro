/**
 * Renderer-side TTSR display cache.
 *
 * Gate B of the TTSR plan: main owns every authoritative bit of TTSR state
 * (matching, repeat policy, injected-rule records). Nothing here is a source of
 * truth - it is a cache of the last push events so the UI can render an
 * interruption marker and so exit handling can tell a TTSR abort apart from a
 * failed turn.
 */

import { create } from 'zustand';
import type { TtsrAbortPendingPayload, TtsrTriggeredPayload } from '../../shared/ttsr-types';

interface TtsrStore {
	/** Turns currently being aborted by TTSR, keyed by process session id. */
	abortPending: Record<string, TtsrAbortPendingPayload>;
	/** Last corrective turn per process session id, for the UI marker. */
	lastTriggered: Record<string, TtsrTriggeredPayload>;
	noteAbortPending: (payload: TtsrAbortPendingPayload) => void;
	noteTriggered: (payload: TtsrTriggeredPayload) => void;
	clearAbortPending: (sessionId: string) => void;
}

export const useTtsrStore = create<TtsrStore>()((set) => ({
	abortPending: {},
	lastTriggered: {},

	noteAbortPending: (payload) =>
		set((state) => ({ abortPending: { ...state.abortPending, [payload.sessionId]: payload } })),

	noteTriggered: (payload) =>
		set((state) => {
			// The abort is over the moment the corrective payload lands: the process
			// has already exited and the respawn is about to run.
			const { [payload.sessionId]: _done, ...abortPending } = state.abortPending;
			return {
				abortPending,
				lastTriggered: { ...state.lastTriggered, [payload.sessionId]: payload },
			};
		}),

	clearAbortPending: (sessionId) =>
		set((state) => {
			if (!(sessionId in state.abortPending)) return state;
			const { [sessionId]: _dropped, ...abortPending } = state.abortPending;
			return { ...state, abortPending };
		}),
}));

/**
 * True while TTSR is aborting this turn - i.e. the `ttsrAbortPending` flag.
 *
 * Callable outside React (exit listeners run from IPC callbacks), so it reads
 * the store directly rather than subscribing.
 */
export function isTtsrAbortPending(sessionId: string): boolean {
	return sessionId in useTtsrStore.getState().abortPending;
}
