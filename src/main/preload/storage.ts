/**
 * Preload API for agent session storage observability.
 *
 * Exposes `window.maestro.storage` — the renderer-side bridge to the
 * ExternalSessionCoordinator (Remote Agent Visibility, Phase 4):
 *
 * - `listExternalSessions()` — one-shot hydration of currently-tracked sessions.
 * - `onExternalActivity(cb)` — live subscription; `cb` receives the latest
 *   `SessionActivityEvent[]` snapshot on every coalesced transition. Returns an
 *   unsubscribe function (mirrors the `onGlobalStatsUpdate` pattern in
 *   `sessions.ts`: `ipcRenderer.on` + `removeListener` closure).
 *
 * Channel strings are inlined (not imported from the main-process handler) to
 * keep the main-process IPC modules out of the preload bundle.
 */

import { ipcRenderer } from 'electron';
import type { SessionActivityEvent } from '../../shared/sessionActivity';

export type { SessionActivityEvent } from '../../shared/sessionActivity';

/** Payload pushed over the live-activity channel. */
interface ExternalActivityPayload {
	events: SessionActivityEvent[];
}

export function createStorageApi() {
	return {
		/**
		 * Snapshot of every session the coordinator is currently tracking.
		 * Returns `[]` when the coordinator is unavailable (older builds, web
		 * renderer, or ProcessManager not ready at boot).
		 */
		listExternalSessions: (): Promise<SessionActivityEvent[]> => {
			return ipcRenderer.invoke('storage:list-external-sessions');
		},

		/**
		 * Subscribe to live activity snapshots. The callback fires with the full
		 * tracked-session array on each coalesced transition.
		 *
		 * @returns An unsubscribe function — call it on unmount.
		 */
		onExternalActivity: (callback: (events: SessionActivityEvent[]) => void): (() => void) => {
			const handler = (_: unknown, payload: ExternalActivityPayload) => {
				callback(payload?.events ?? []);
			};
			ipcRenderer.on('storage:externalActivity', handler);
			return () => ipcRenderer.removeListener('storage:externalActivity', handler);
		},
	};
}

export type StorageApi = ReturnType<typeof createStorageApi>;
