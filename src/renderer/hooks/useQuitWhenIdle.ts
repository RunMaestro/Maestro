/**
 * useQuitWhenIdle.ts
 *
 * Watcher for the "Quit when idle" feature. When the user arms a deferred quit
 * (via the quit-confirmation modal), this hook polls every active-operation
 * source and quits the app the moment everything goes idle.
 *
 * Mounted once, near the top of the app. Does nothing until armed.
 */

import { useEffect } from 'react';
import { useQuitWhenIdleStore } from '../stores/quitWhenIdleStore';
import { collectActiveOperations } from '../utils/collectActiveOperations';

/** How often to re-check for idle while a quit is armed. */
const IDLE_POLL_INTERVAL_MS = 2000;

export function useQuitWhenIdle(): void {
	const armed = useQuitWhenIdleStore((s) => s.armed);

	useEffect(() => {
		if (!armed) {
			return;
		}

		let cancelled = false;

		const check = async (): Promise<void> => {
			const snapshot = await collectActiveOperations();
			// The user may have cancelled (or we already quit) while awaiting IPC.
			if (cancelled || !useQuitWhenIdleStore.getState().armed) {
				return;
			}
			if (!snapshot.hasActiveOperations) {
				useQuitWhenIdleStore.getState().cancel();
				window.maestro.app.confirmQuit();
			}
		};

		const interval = setInterval(() => {
			void check();
		}, IDLE_POLL_INTERVAL_MS);

		// Run an immediate check so an already-idle app quits without waiting a tick.
		void check();

		return () => {
			cancelled = true;
			clearInterval(interval);
		};
	}, [armed]);
}
