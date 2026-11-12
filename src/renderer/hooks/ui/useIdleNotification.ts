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
 * session still has RUNNABLE queued work, or any Auto Run batch is running.
 * Cue tasks are explicitly excluded from this check (they don't set session
 * state to busy or create batch runs).
 *
 * The queued-work term is what keeps a draining queue quiet. Busy alone is only
 * true while a turn is in flight, so the agent goes idle in the gap between two
 * queued turns and announced "idle" at every one of them. Paused items don't
 * count - see `selectHasAnyRunnableQueuedWork`.
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
