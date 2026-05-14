import { useEffect, useState } from 'react';
import type { SessionActivityEvent } from '../../../shared/sessionActivity';

/**
 * Subscribes to externally-driven agent session activity surfaced by
 * {@link ExternalSessionCoordinator} (main process), via the
 * `window.maestro.storage` preload bridge.
 *
 * On mount: hydrates with `listExternalSessions()` then subscribes to
 * `onExternalActivity` for live coalesced state-changes. The returned array
 * is the current snapshot — consumers should use the `isActive(event)` helper
 * from `shared/sessionActivity` to decide whether to render a thinking pill.
 */
export function useExternalSessionActivity(): SessionActivityEvent[] {
	const [events, setEvents] = useState<SessionActivityEvent[]>([]);

	useEffect(() => {
		// Guard: storage API may be absent in older preload builds or non-Electron
		// environments (e.g., the web renderer). Treat as "no external activity".
		if (!window.maestro?.storage) {
			return;
		}

		let mounted = true;

		// The preload bridge types `agentId` as `string` (see global.d.ts ambient
		// declaration), but the coordinator only emits events for ToolType-backed
		// storage classes — safe to widen at this boundary.
		window.maestro.storage
			.listExternalSessions()
			.then((initial) => {
				if (mounted) {
					setEvents(initial as SessionActivityEvent[]);
				}
			})
			.catch((error) => {
				console.error('[useExternalSessionActivity] Failed to hydrate:', error);
			});

		const unsubscribe = window.maestro.storage.onExternalActivity((next) => {
			if (mounted) {
				setEvents(next as SessionActivityEvent[]);
			}
		});

		return () => {
			mounted = false;
			unsubscribe();
		};
	}, []);

	return events;
}
