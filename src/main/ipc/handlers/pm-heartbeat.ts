/**
 * pm:heartbeat IPC handler (#435, #444).
 *
 * Agents call this channel every 60 s while they hold an active claim on a
 * work item. The handler updates lastHeartbeatAt in the in-memory ClaimTracker
 * so the stale-claim sweeper can detect dead agents.
 *
 * #444: work-graph SQLite removed. The DB column `last_heartbeat` no longer
 * exists. This handler updates the in-memory tracker only — GitHub Projects v2
 * AI Assigned Slot field is the durable truth; heartbeat is ephemeral.
 *
 * Gated by the `deliveryPlanner` encore feature flag (same gate as pm-tools).
 */

import { ipcMain } from 'electron';
import { requireEncoreFeature } from '../../utils/requireEncoreFeature';
import type { SettingsStoreInterface } from '../../stores/types';
import { getClaimTracker } from '../../agent-dispatch/claim-tracker';

const LOG_CONTEXT = '[PmHeartbeat]';

export interface PmHeartbeatHandlerDependencies {
	settingsStore: SettingsStoreInterface;
}

export function registerPmHeartbeatHandlers(deps: PmHeartbeatHandlerDependencies): void {
	ipcMain.handle('pm:heartbeat', async (_event, projectItemId: string) => {
		// Gate: encore flag must be enabled
		const gateError = requireEncoreFeature(deps.settingsStore, 'deliveryPlanner');
		if (gateError) return gateError;

		if (!projectItemId || typeof projectItemId !== 'string') {
			return { success: false, error: 'projectItemId is required' };
		}

		const now = new Date().toISOString();
		const found = getClaimTracker().renewHeartbeat(projectItemId);

		if (!found) {
			// No in-memory claim for this item — signal the agent to stop the beat loop.
			return { success: false, error: `No active claim for projectItemId: ${projectItemId}` };
		}

		console.debug(`${LOG_CONTEXT} heartbeat projectItem=${projectItemId} at=${now}`);
		return { success: true, data: { projectItemId, lastHeartbeat: now } };
	});
}
