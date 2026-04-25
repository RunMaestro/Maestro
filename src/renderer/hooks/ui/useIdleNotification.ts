import { useEffect, useRef } from 'react';
import { useSessionStore, selectIsAnySessionBusy } from '../../stores/sessionStore';
import { selectHasAnyActiveBatch, useBatchStore } from '../../stores/batchStore';
import { useNotificationStore, selectConfig } from '../../stores/notificationStore';

/**
 * Watches for the transition from "any activity" to "fully idle" and fires
 * the idle notification command. Activity means any session is busy OR any
 * Auto Run batch is running. Cue tasks are explicitly excluded from this
 * check (they don't set session state to busy or create batch runs).
 *
 * The notification only fires on the *transition* to idle — not on mount,
 * not when already idle. A ref tracks the previous "was active" state to
 * detect the edge.
 */
export function useIdleNotification(): void {
	const anySessionBusy = useSessionStore(selectIsAnySessionBusy);
	const anyBatchRunning = useBatchStore(selectHasAnyActiveBatch);
	const { idleNotificationEnabled, idleNotificationCommand } = useNotificationStore(selectConfig);

	const wasActiveRef = useRef(false);

	const isActive = anySessionBusy || anyBatchRunning;

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
