/**
 * pm:heartbeat IPC handler (#435).
 *
 * Agents call this channel every 60 s while they hold an active claim on a
 * WorkItem. The handler stamps `claim.lastHeartbeat` to the current ISO
 * timestamp so the stale-claim sweeper can detect dead agents.
 *
 * Gated by the `deliveryPlanner` encore feature flag (same gate as pm-tools).
 *
 * Ownership is not re-verified here — the caller supplies a workItemId and
 * only the active claim row is updated, so there is no cross-claim mutation
 * risk. If the item has no active claim the UPDATE is a no-op.
 */

import { ipcMain } from 'electron';
import { getWorkGraphDB } from '../../work-graph';
import { requireEncoreFeature } from '../../utils/requireEncoreFeature';
import type { SettingsStoreInterface } from '../../stores/types';

const LOG_CONTEXT = '[PmHeartbeat]';

export interface PmHeartbeatHandlerDependencies {
	settingsStore: SettingsStoreInterface;
}

export function registerPmHeartbeatHandlers(deps: PmHeartbeatHandlerDependencies): void {
	ipcMain.handle('pm:heartbeat', async (_event, workItemId: string) => {
		// Gate: encore flag must be enabled
		const gateError = requireEncoreFeature(deps.settingsStore, 'deliveryPlanner');
		if (gateError) return gateError;

		if (!workItemId || typeof workItemId !== 'string') {
			return { success: false, error: 'workItemId is required' };
		}

		try {
			const db = getWorkGraphDB().database;
			const now = new Date().toISOString();

			const result = db
				.prepare(
					`UPDATE work_item_claims SET last_heartbeat = ? WHERE work_item_id = ? AND status = 'active'`
				)
				.run(now, workItemId);

			if (result.changes === 0) {
				// No active claim on this item — return a soft error so the renderer
				// can stop the beat loop.
				return { success: false, error: `No active claim on work item: ${workItemId}` };
			}

			console.debug(`${LOG_CONTEXT} heartbeat workItem=${workItemId} at=${now}`);
			return { success: true, data: { workItemId, lastHeartbeat: now } };
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			console.error(`${LOG_CONTEXT} pm:heartbeat failed for ${workItemId}:`, message);
			return { success: false, error: message };
		}
	});
}
