/**
 * Stale-claim sweeper (#435).
 *
 * Runs on a configurable interval (default: 30 s). For each work item that has
 * an active claim, it checks whether `lastHeartbeat` is older than `staleMs`
 * (default: 5 min). If so, the claim is auto-released, the item status is reset
 * to "Tasks Ready", and a comment is posted on the linked GitHub issue.
 *
 * The sweeper is started once after setupIpcHandlers() in main/index.ts and
 * remains active for the lifetime of the app. Stop it by calling clearInterval
 * on the returned handle.
 *
 * This is intentionally separate from the pmAudit on-demand runner (#434):
 *   - sweeper = continuous background auto-release
 *   - audit   = on-demand multi-check health report
 */

import { getWorkGraphDB } from '../work-graph';
import { getWorkGraphItemStore } from '../work-graph';
import { DeliveryPlannerGithubSync } from '../delivery-planner/github-sync';
import { logger } from '../utils/logger';
import type { WorkItem, WorkItemStatus } from '../../shared/work-graph-types';

const LOG_CONTEXT = '[StaleSweeper]';

export interface StaleSweeperOptions {
	/** Age threshold in ms before a claimed item is considered stale. Default: 5 min. */
	staleMs?: number;
	/** How often to run the sweep. Default: 30 s. */
	intervalMs?: number;
}

/**
 * Start the stale-claim sweeper. Returns the interval handle so the caller can
 * stop it on app shutdown if needed.
 */
export function startStaleClaimSweeper(opts: StaleSweeperOptions = {}): NodeJS.Timeout {
	const staleMs = opts.staleMs ?? 5 * 60 * 1000; // 5 minutes
	const intervalMs = opts.intervalMs ?? 30 * 1000; // 30 seconds

	logger.info(
		`Stale-claim sweeper started (staleMs=${staleMs}, intervalMs=${intervalMs})`,
		LOG_CONTEXT
	);

	const handle = setInterval(() => {
		runSweep(staleMs).catch((err) => {
			logger.warn(
				`Stale-claim sweep error: ${err instanceof Error ? err.message : String(err)}`,
				LOG_CONTEXT
			);
		});
	}, intervalMs);

	// Don't block Node from exiting if the sweeper is the last thing alive.
	if (handle.unref) handle.unref();

	return handle;
}

async function runSweep(staleMs: number): Promise<void> {
	const db = getWorkGraphDB().database;
	const workGraph = getWorkGraphItemStore();
	const now = Date.now();
	const staleThreshold = new Date(now - staleMs).toISOString();

	// Find all active claims whose last_heartbeat is older than the threshold,
	// or where last_heartbeat is NULL (no heartbeat ever received).
	// We exclude items that have never had a heartbeat AND were claimed very
	// recently (within staleMs) to avoid releasing fresh claims that haven't
	// had a chance to emit their first beat.
	const staleClaimRows = db
		.prepare(
			`
			SELECT wic.work_item_id
			FROM work_item_claims wic
			WHERE wic.status = 'active'
			  AND (
			    (wic.last_heartbeat IS NOT NULL AND wic.last_heartbeat < ?)
			    OR (wic.last_heartbeat IS NULL AND wic.claimed_at < ?)
			  )
		`
		)
		.all(staleThreshold, staleThreshold) as Array<{ work_item_id: string }>;

	if (staleClaimRows.length === 0) return;

	logger.info(`Stale-claim sweep found ${staleClaimRows.length} stale claim(s)`, LOG_CONTEXT);

	for (const row of staleClaimRows) {
		await releaseStale(workGraph, row.work_item_id);
	}
}

async function releaseStale(
	workGraph: ReturnType<typeof getWorkGraphItemStore>,
	workItemId: string
): Promise<void> {
	try {
		const item = await workGraph.getItem(workItemId);
		if (!item) {
			logger.warn(`Stale sweep: work item ${workItemId} not found — skipping`, LOG_CONTEXT);
			return;
		}

		// Release the claim and reset status to "Tasks Ready" equivalent.
		// WorkItemStatus 'ready' maps to the "Tasks Ready" kanban column.
		await workGraph.releaseClaim(workItemId, {
			note: 'auto-released after agent timeout',
			actor: { type: 'system', id: 'stale-sweeper' },
			revertStatusTo: 'ready' as WorkItemStatus,
		});

		logger.info(`Stale-claim auto-released: workItem=${workItemId}`, LOG_CONTEXT);

		// Post a comment on the linked GitHub issue if one exists.
		await postStaleComment(item);
	} catch (err) {
		logger.warn(
			`Stale sweep: failed to release claim for ${workItemId}: ${
				err instanceof Error ? err.message : String(err)
			}`,
			LOG_CONTEXT
		);
	}
}

async function postStaleComment(item: WorkItem): Promise<void> {
	if (!item.github?.issueNumber) return;

	try {
		const githubSync = new DeliveryPlannerGithubSync();
		await githubSync.addProgressComment(
			item,
			'**Agent timeout** — claim auto-released after missing heartbeat. Item returned to Tasks Ready.'
		);
	} catch (err) {
		// GitHub comment failure is non-fatal — log and continue.
		logger.warn(
			`Stale sweep: GitHub comment failed for issue #${item.github?.issueNumber}: ${
				err instanceof Error ? err.message : String(err)
			}`,
			LOG_CONTEXT
		);
	}
}
