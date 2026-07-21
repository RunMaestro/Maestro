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

/**
 * How long an abort-pending mark may suppress a turn's exit.
 *
 * The mark is normally cleared by `ttsr:triggered` or `ttsr:abortCleared`, but
 * neither arrives if main dies mid-abort or the renderer stops listening (the
 * Encore flag flipped off between the two events). An entry that outlives this
 * would suppress EVERY future exit on that session id until the app reloads, so
 * it stops counting instead. The driver's own exit-wait is 5 seconds; 30 is
 * generous enough that no live abort is ever cut short.
 */
export const TTSR_ABORT_PENDING_TTL_MS = 30_000;

interface TtsrAbortPendingEntry {
	payload: TtsrAbortPendingPayload;
	/** When the mark was set, for the {@link TTSR_ABORT_PENDING_TTL_MS} check. */
	at: number;
}

interface TtsrStore {
	/** Turns currently being aborted by TTSR, keyed by process session id. */
	abortPending: Record<string, TtsrAbortPendingEntry>;
	/** Last corrective turn per process session id, for the UI marker. */
	lastTriggered: Record<string, TtsrTriggeredPayload>;
	noteAbortPending: (payload: TtsrAbortPendingPayload) => void;
	noteTriggered: (payload: TtsrTriggeredPayload) => void;
	clearAbortPending: (sessionId: string) => void;
	/** Drop every mark at once (the hook unmounting, or TTSR being turned off). */
	clearAllAbortPending: () => void;
}

export const useTtsrStore = create<TtsrStore>()((set) => ({
	abortPending: {},
	lastTriggered: {},

	noteAbortPending: (payload) =>
		set((state) => ({
			abortPending: {
				...state.abortPending,
				[payload.sessionId]: { payload, at: Date.now() },
			},
		})),

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

	clearAllAbortPending: () =>
		set((state) =>
			Object.keys(state.abortPending).length === 0 ? state : { ...state, abortPending: {} }
		),
}));

/**
 * True while TTSR is aborting this turn - i.e. the `ttsrAbortPending` flag.
 *
 * Callable outside React (exit listeners run from IPC callbacks), so it reads
 * the store directly rather than subscribing. A mark older than
 * {@link TTSR_ABORT_PENDING_TTL_MS} is treated as orphaned: it stops suppressing
 * and is dropped, so a lost `triggered`/`abortCleared` costs one turn rather
 * than every exit for the rest of the app's life.
 */
export function isTtsrAbortPending(sessionId: string): boolean {
	const entry = useTtsrStore.getState().abortPending[sessionId];
	if (!entry) return false;
	if (Date.now() - entry.at <= TTSR_ABORT_PENDING_TTL_MS) return true;
	useTtsrStore.getState().clearAbortPending(sessionId);
	return false;
}
