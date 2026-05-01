/**
 * Stale-claim sweeper (#435, #444).
 *
 * Runs on a configurable interval (default: 30 s). Iterates the in-memory
 * ClaimTracker looking for claims whose lastHeartbeatAt is older than
 * staleMs (default: 5 min). If found, releases the claim on GitHub by:
 *   1. Clearing AI Assigned Slot on the project item
 *   2. Setting AI Status = "Tasks Ready"
 *   3. Posting a comment on the linked GitHub issue
 *
 * #444: work-graph SQLite removed. The sweeper uses the ClaimTracker (in-memory)
 * and GithubClient (GitHub as truth) instead of the DB.
 *
 * This is intentionally separate from the pmAudit on-demand runner (#434):
 *   - sweeper = continuous background auto-release
 *   - audit   = on-demand multi-check health report
 */

import { getClaimTracker, type ClaimInfo } from '../agent-dispatch/claim-tracker';
import { getGithubClient } from '../agent-dispatch/github-client';
import { auditLog } from '../agent-dispatch/dispatch-audit-log';
import { logger } from '../utils/logger';
import { DELIVERY_PLANNER_GITHUB_REPOSITORY } from '../delivery-planner/github-safety';

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
	const tracker = getClaimTracker();
	const staleClaims = tracker.getStaleClaims(staleMs);

	if (staleClaims.length === 0) return;

	logger.info(`Stale-claim sweep found ${staleClaims.length} stale claim(s)`, LOG_CONTEXT);

	for (const claim of staleClaims) {
		await releaseStale(claim);
	}
}

async function releaseStale(claim: ClaimInfo): Promise<void> {
	const tracker = getClaimTracker();
	const client = getGithubClient();

	try {
		// 1. Clear AI Assigned Slot and reset AI Status on GitHub
		await client.setItemFieldValue(claim.projectId, claim.projectItemId, 'AI Assigned Slot', '');
		await client.setItemFieldValue(
			claim.projectId,
			claim.projectItemId,
			'AI Status',
			'Tasks Ready'
		);

		// 2. Remove from in-memory tracker
		tracker.removeClaim(claim.agentSessionId, claim.role);

		// 3. Audit log
		auditLog('heartbeat_stale', {
			actor: 'stale-sweeper',
			workItemId: claim.projectItemId,
			reason: `Auto-released after agent timeout (agentSessionId=${claim.agentSessionId} role=${claim.role})`,
		});

		logger.info(
			`Stale-claim auto-released: projectItem=${claim.projectItemId} role=${claim.role}`,
			LOG_CONTEXT
		);

		// 4. Post a comment on the GitHub issue (best-effort)
		if (claim.issueNumber) {
			await postStaleComment(claim).catch((err) => {
				logger.warn(
					`Stale sweep: GitHub comment failed for issue #${claim.issueNumber}: ${
						err instanceof Error ? err.message : String(err)
					}`,
					LOG_CONTEXT
				);
			});
		}
	} catch (err) {
		logger.warn(
			`Stale sweep: failed to release claim for projectItem=${claim.projectItemId}: ${
				err instanceof Error ? err.message : String(err)
			}`,
			LOG_CONTEXT
		);
	}
}

async function postStaleComment(claim: ClaimInfo): Promise<void> {
	const client = getGithubClient();
	await client.addItemComment(
		claim.issueNumber,
		DELIVERY_PLANNER_GITHUB_REPOSITORY,
		'**Agent timeout** — claim auto-released after missing heartbeat. Item returned to Tasks Ready.'
	);
}
