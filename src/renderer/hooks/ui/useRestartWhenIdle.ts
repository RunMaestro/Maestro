import { useEffect, useRef } from 'react';
import { useSessionStore, selectIsAnySessionBusy } from '../../stores/sessionStore';
import { selectHasAnyActiveBatch, useBatchStore } from '../../stores/batchStore';
import { useRestartPendingStore } from '../../stores/restartPendingStore';

/**
 * Watches for the transition to "fully idle" while a deferred update-restart
 * is pending. When the app drops from active → idle and `pending` is true,
 * fires `updates.install()` so the app restarts and applies the downloaded
 * update without further user input.
 *
 * Activity matches `useIdleNotification`: any session busy OR any Auto Run
 * batch running. Cue tasks are intentionally excluded.
 *
 * If the flag is set while the app is *already* idle (user clicked the
 * deferred-restart button without anything running), we fire on the next
 * tick rather than waiting for a transition that will never come.
 */
export function useRestartWhenIdle(): void {
	const anySessionBusy = useSessionStore(selectIsAnySessionBusy);
	const anyBatchRunning = useBatchStore(selectHasAnyActiveBatch);
	const pending = useRestartPendingStore((s) => s.pending);
	const setPending = useRestartPendingStore((s) => s.setPending);

	const wasActiveRef = useRef(anySessionBusy || anyBatchRunning);
	const isActive = anySessionBusy || anyBatchRunning;

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
