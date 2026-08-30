import { useEffect, useRef } from 'react';
import {
	useSessionStore,
	selectIsAnySessionBusy,
	selectHasAnyRunnableQueuedWork,
} from '../../stores/sessionStore';
import { selectHasAnyActiveBatch, useBatchStore } from '../../stores/batchStore';
import { useNotificationStore, selectConfig } from '../../stores/notificationStore';

/**
 * Watches for the transition from "any activity" to "fully idle" and fires
 * the idle notification command. Activity means any session is busy, any
 * session still has runnable queued work, OR any Auto Run batch is running.
 * Cue tasks are explicitly excluded from this check (they don't set session
 * state to busy or create batch runs).
 *
 * The queue term is not redundant with the busy term. A turn ending does not
 * mean the work is over: the exit reducer parks the agent at `state: 'idle'`
 * while holding the queue whenever a retry is counting down, so "no turn in
 * flight" and "nothing left to do" are genuinely different questions. Without
 * it, announcing idle was the first thing the user heard while a dozen
 * messages were still lined up.
 *
 * Paused items are excluded by `selectHasAnyRunnableQueuedWork`, so a queue the
 * user has held does not keep the notification suppressed forever.
 *
 * The notification only fires on the *transition* to idle - not on mount,
 * not when already idle. A ref tracks the previous "was active" state to
 * detect the edge.
 */
export function useIdleNotification(): void {
	const anySessionBusy = useSessionStore(selectIsAnySessionBusy);
	const anyQueuedWork = useSessionStore(selectHasAnyRunnableQueuedWork);
	const anyBatchRunning = useBatchStore(selectHasAnyActiveBatch);
	const { idleNotificationEnabled, idleNotificationCommand } = useNotificationStore(selectConfig);

	const wasActiveRef = useRef(false);

	const isActive = anySessionBusy || anyQueuedWork || anyBatchRunning;

	useEffect(() => {
		if (isActive) {
			wasActiveRef.current = true;
			return;
		}

		// Transition from active → idle
		if (wasActiveRef.current) {
			wasActiveRef.current = false;

			if (idleNotificationEnabled && idleNotificationCommand) {
				window.maestro.notification
					.speak('Maestro is idle', idleNotificationCommand)
					.catch((err) => {
						console.error('[IdleNotification] Failed to execute idle command:', err);
					});
			}
		}
	}, [isActive, idleNotificationEnabled, idleNotificationCommand]);
}
