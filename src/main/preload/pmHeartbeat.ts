/**
 * Preload API for the pm:heartbeat IPC channel (#435).
 *
 * Exposes window.maestro.pmHeartbeat.beat(workItemId) so any renderer surface
 * (hook, component) can emit a liveness ping while an agent holds a claim.
 *
 * The handler stamps claim.lastHeartbeat in the Work Graph DB; the stale-claim
 * sweeper uses that timestamp to auto-release dead claims after 5 min.
 */

import { ipcRenderer } from 'electron';

export function createPmHeartbeatApi() {
	return {
		/**
		 * Emit a heartbeat for the agent's currently-claimed work item.
		 * Should be called every 60 s while the claim is held.
		 * Returns { success: true, data: { workItemId, lastHeartbeat } } on success,
		 * or { success: false, error: string } if the claim is gone or the feature is disabled.
		 *
		 * @param workItemId - the ID of the claimed work item
		 */
		beat: (workItemId: string) => ipcRenderer.invoke('pm:heartbeat', workItemId),
	};
}

export type PmHeartbeatApi = ReturnType<typeof createPmHeartbeatApi>;
