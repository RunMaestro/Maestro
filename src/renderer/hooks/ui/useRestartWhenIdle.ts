import { useEffect, useRef } from 'react';
import {
	useSessionStore,
	selectIsAnySessionBusy,
	selectHasAnyRunnableQueuedWork,
} from '../../stores/sessionStore';
import { selectHasAnyActiveBatch, useBatchStore } from '../../stores/batchStore';
import { useRestartPendingStore } from '../../stores/restartPendingStore';

/**
 * Watches for the transition to "fully idle" while a deferred update-restart
 * is pending. When the app drops from active → idle and `pending` is true,
 * fires `updates.install()` so the app restarts and applies the downloaded
 * update without further user input.
 *
 * Activity matches `useIdleNotification` by reading the SAME selectors: any
 * session busy, any session with runnable queued work, or any Auto Run batch
 * running. Cue tasks are intentionally excluded. Keep the two definitions
 * sharing `selectHasAnyRunnableQueuedWork` rather than restating the condition -
 * this hook restarts the app, so a definition that drifts from the notification's
 * would relaunch Maestro in the gap between two queued turns.
 *
 * If the flag is set while the app is *already* idle (user clicked the
 * deferred-restart button without anything running), we fire on the next
 * tick rather than waiting for a transition that will never come.
 */
export function useRestartWhenIdle(): void {
	const anySessionBusy = useSessionStore(selectIsAnySessionBusy);
	const anyQueuedWork = useSessionStore(selectHasAnyRunnableQueuedWork);
	const anyBatchRunning = useBatchStore(selectHasAnyActiveBatch);
	const pending = useRestartPendingStore((s) => s.pending);
	const setPending = useRestartPendingStore((s) => s.setPending);

	const wasActiveRef = useRef(anySessionBusy || anyQueuedWork || anyBatchRunning);
	const isActive = anySessionBusy || anyQueuedWork || anyBatchRunning;

	useEffect(() => {
		if (!pending) {
			wasActiveRef.current = isActive;
			return;
		}

		if (isActive) {
			wasActiveRef.current = true;
			return;
		}

		// Idle now and a restart is pending. Fire if we just transitioned, OR
		// if the user requested deferred restart while already idle.
		setPending(false);
		wasActiveRef.current = false;
		window.maestro.updates.install();
	}, [isActive, pending, setPending]);
}
