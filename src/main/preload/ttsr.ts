/**
 * Preload API for Time-Traveling Stream Rules (TTSR).
 *
 * TTSR is main-authoritative (Gate B): matching, repeat policy and the abort
 * all happen in main with no renderer round-trip. The renderer only listens,
 * so this namespace is push-events only - there is nothing to invoke.
 *
 * - `ttsr:abortPending` - a turn is being signalled; the exit that follows is a
 *   TTSR abort, not a failure.
 * - `ttsr:triggered` - the aborted turn has exited; here is the corrective
 *   prompt to respawn it with.
 * - `ttsr:matched` - observability only (a rule matched, interrupting or not).
 */

import { ipcRenderer } from 'electron';
import type {
	TtsrAbortPendingPayload,
	TtsrMatchedPayload,
	TtsrTriggeredPayload,
} from '../../shared/ttsr-types';

export type {
	TtsrAbortPendingPayload,
	TtsrMatchedPayload,
	TtsrRuleRef,
	TtsrTriggeredPayload,
} from '../../shared/ttsr-types';

/**
 * Creates the TTSR API object for preload exposure.
 */
export function createTtsrApi() {
	return {
		// A TTSR abort was just signalled for this turn. Arrives BEFORE the
		// process exit, so exit handling can suppress the normal failure path.
		onAbortPending: (callback: (payload: TtsrAbortPendingPayload) => void): (() => void) => {
			const handler = (_e: unknown, payload: TtsrAbortPendingPayload) => callback(payload);
			ipcRenderer.on('ttsr:abortPending', handler);
			return () => {
				ipcRenderer.removeListener('ttsr:abortPending', handler);
			};
		},

		// The aborted turn has exited; the payload carries everything needed to
		// spawn the corrective turn (injection prompt, resume mode, provider id).
		onTriggered: (callback: (payload: TtsrTriggeredPayload) => void): (() => void) => {
			const handler = (_e: unknown, payload: TtsrTriggeredPayload) => callback(payload);
			ipcRenderer.on('ttsr:triggered', handler);
			return () => {
				ipcRenderer.removeListener('ttsr:triggered', handler);
			};
		},

		// Observability: a rule matched. Non-interrupting matches only ever
		// surface here (they become deferred reminders on the next prompt).
		onMatched: (callback: (payload: TtsrMatchedPayload) => void): (() => void) => {
			const handler = (_e: unknown, payload: TtsrMatchedPayload) => callback(payload);
			ipcRenderer.on('ttsr:matched', handler);
			return () => {
				ipcRenderer.removeListener('ttsr:matched', handler);
			};
		},
	};
}

export type TtsrApi = ReturnType<typeof createTtsrApi>;
