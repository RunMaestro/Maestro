/**
 * Preload API for on-disk session storage activity.
 *
 * Bridges the {@link ExternalSessionCoordinator}'s `'state-changed'` stream
 * to the renderer. The renderer hydrates with `listExternalSessions()` and
 * then subscribes via `onExternalActivity()` for live updates.
 */

import { ipcRenderer } from 'electron';
import type { SessionActivityEvent } from '../../shared/sessionActivity';

/** IPC channel used to forward coalesced coordinator state changes. */
export const EXTERNAL_ACTIVITY_CHANNEL = 'storage:externalActivity';

/**
 * Creates the storage API object exposed as `window.maestro.storage`.
 */
export function createStorageApi() {
	return {
		listExternalSessions: (): Promise<SessionActivityEvent[]> =>
			ipcRenderer.invoke('storage:list-external-sessions'),

		onExternalActivity: (callback: (events: SessionActivityEvent[]) => void) => {
			const handler = (_: unknown, payload: { events: SessionActivityEvent[] }) =>
				callback(payload.events);
			ipcRenderer.on(EXTERNAL_ACTIVITY_CHANNEL, handler);
			return () => ipcRenderer.removeListener(EXTERNAL_ACTIVITY_CHANNEL, handler);
		},
	};
}

export type StorageApi = ReturnType<typeof createStorageApi>;
export type { SessionActivityEvent } from '../../shared/sessionActivity';
