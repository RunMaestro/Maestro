import { useEffect, useState } from 'react';
import type { SessionActivityEvent } from '../../../shared/sessionActivity';
import { logger } from '../../utils/logger';

/**
 * Subscribes to activity from agent sessions Maestro did NOT spawn (Remote
 * Agent Visibility, Phase 4) and returns the current snapshot.
 *
 * On mount it hydrates via `listExternalSessions()`, then keeps the snapshot
 * current by subscribing to `onExternalActivity`. Returns the latest
 * `SessionActivityEvent[]` — empty until hydration resolves, and empty forever
 * in environments without the `storage` preload bridge (older builds, web
 * renderer), which the hook detects and no-ops on.
 *
 * Follows the manual subscribe/unsubscribe-in-`useEffect` pattern used by
 * `useCliActivityMonitoring` (there is no shared `useEventListener` hook).
 */
export function useExternalSessionActivity(): SessionActivityEvent[] {
	const [events, setEvents] = useState<SessionActivityEvent[]>([]);

	useEffect(() => {
		// Guard: the storage bridge may be absent (older preload, web renderer).
		if (!window.maestro?.storage) {
			return;
		}

		// `mounted` guards both the async hydration resolution and the live
		// callback against setting state after unmount.
		let mounted = true;

		window.maestro.storage
			.listExternalSessions()
			.then((initial) => {
				if (!mounted) return;
				setEvents(initial as unknown as SessionActivityEvent[]);
			})
			.catch((error: unknown) => {
				logger.error('[ExternalSessionActivity] Failed to hydrate', undefined, error);
			});

		const unsubscribe = window.maestro.storage.onExternalActivity((incoming) => {
			if (!mounted) return;
			setEvents(incoming as unknown as SessionActivityEvent[]);
		});

		return () => {
			mounted = false;
			unsubscribe();
		};
	}, []);

	return events;
}
