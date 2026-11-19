/**
 * Update detection and the update action for playbooks installed from the
 * Playbook Exchange (renderer side).
 *
 * The classification runs in main (`checkMarketplacePlaybookUpdates()`, it
 * hashes the pristine copies on whichever host holds the folder) and lands in
 * `usePlaybookUpdatesStore`. An update is the Exchange import with
 * `update: true`: the documents are re-fetched into the record's own folder,
 * the pristine copies are refreshed, and the record keeps its id and its
 * parameter answers. `maestro-cli marketplace updates` and
 * `marketplace import --update` reach the same service.
 */

import {
	describeMarketplaceImportFailures,
	type MarketplaceImportPlaybookResult,
} from '../../shared/marketplace-types';
import {
	findPlaybookUpdateStatus,
	type PlaybookUpdateStatusMap,
} from '../../shared/playbookUpdates';
import { useBatchStore } from '../stores/batchStore';
import { notifyToast } from '../stores/notificationStore';
import { usePlaybookUpdatesStore } from '../stores/playbookUpdatesStore';
import { logger } from '../utils/logger';

/** The agent whose installed playbooks are checked or updated. */
export interface PlaybookUpdateTarget {
	sessionId: string;
	/** The agent's Auto Run folder; without one nothing is installed to check. */
	autoRunFolderPath: string | undefined;
	/** Set when the Auto Run folder lives on an SSH remote. */
	sshRemoteId?: string;
}

const inFlightChecks = new Map<string, Promise<PlaybookUpdateStatusMap | null>>();

/**
 * Classify the agent's installed Exchange playbooks. Without `force`, an
 * agent already checked since the app started answers from the store, so
 * the Auto Run dropdown checks once per app start; the Exchange passes
 * `force` each time it opens. Concurrent checks of one agent share a call.
 *
 * A failed check (offline, SSH remote down) leaves the previous answer and
 * returns `null`: the pills are a hint, never a blocker.
 */
export async function checkPlaybookUpdates(
	target: PlaybookUpdateTarget,
	options: { force?: boolean } = {}
): Promise<PlaybookUpdateStatusMap | null> {
	const { sessionId, autoRunFolderPath, sshRemoteId } = target;
	if (!autoRunFolderPath) return null;
	const store = usePlaybookUpdatesStore.getState();
	if (!options.force && store.checkedSessionIds[sessionId]) {
		return store.statusesBySession[sessionId] ?? {};
	}
	const pending = inFlightChecks.get(sessionId);
	if (pending) return pending;

	const check = (async () => {
		try {
			const result = await window.maestro.marketplace.checkUpdates(
				sessionId,
				autoRunFolderPath,
				sshRemoteId
			);
			if (!result.success) {
				logger.warn('Playbook update check failed', undefined, result.error);
				return null;
			}
			const updates = result.updates ?? {};
			usePlaybookUpdatesStore.getState().setStatuses(sessionId, updates);
			return updates;
		} finally {
			inFlightChecks.delete(sessionId);
		}
	})();
	inFlightChecks.set(sessionId, check);
	return check;
}

/**
 * Update the record the agent holds for Exchange entry `marketplaceId`, then
 * re-check so the pills clear. Says how it went in a toast and returns the
 * import result (the updated record on success). Refused while the agent's
 * Auto Run is running, since the update rewrites the documents it works on.
 */
export async function updateInstalledPlaybook(
	target: PlaybookUpdateTarget,
	marketplaceId: string
): Promise<MarketplaceImportPlaybookResult> {
	const { sessionId, autoRunFolderPath, sshRemoteId } = target;
	if (!autoRunFolderPath) {
		return { success: false, error: 'This agent has no Auto Run folder' };
	}
	// An update rewrites the documents a running Auto Run is working through.
	if (useBatchStore.getState().batchRunStates[sessionId]?.isRunning) {
		const error = 'Wait for the running Auto Run to finish before updating its documents.';
		notifyToast({ color: 'yellow', title: 'Playbook not updated', message: error });
		return { success: false, error };
	}
	const store = usePlaybookUpdatesStore.getState();
	const status = findPlaybookUpdateStatus(store.statusesBySession[sessionId], marketplaceId);
	if (status) store.setUpdating(status.playbookId, true);

	let result: MarketplaceImportPlaybookResult;
	try {
		result = await window.maestro.marketplace.updatePlaybook(
			marketplaceId,
			autoRunFolderPath,
			sessionId,
			sshRemoteId
		);
	} finally {
		if (status) usePlaybookUpdatesStore.getState().setUpdating(status.playbookId, false);
	}

	const name = result.playbook?.name ?? status?.name ?? marketplaceId;
	if (!result.success) {
		notifyToast({
			color: 'red',
			title: 'Playbook update failed',
			message: result.error || 'Unknown error',
			dismissible: true,
		});
	} else {
		const failures = describeMarketplaceImportFailures(result);
		const version = result.playbook?.provenance?.sourceVersion;
		notifyToast({
			color: failures ? 'yellow' : 'green',
			title: failures ? 'Playbook updated partially' : 'Playbook updated',
			message:
				failures ??
				`${name}${version ? ` is now at ${version}` : ' was re-fetched'}. Your parameter answers were kept.`,
			dismissible: !!failures,
		});
	}
	await checkPlaybookUpdates(target, { force: true });
	return result;
}
