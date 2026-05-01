/**
 * Branch Hygiene Cron (#435)
 *
 * Runs `sweepMergedBranches` hourly and logs the results via the shared
 * logger infrastructure.  Wire up via `startBranchHygieneCron` once after
 * `setupIpcHandlers()` — only when the `agentDispatch` encore feature flag is
 * enabled (gating keeps this out of production for users who haven't opted in).
 */

import { sweepMergedBranches, type BranchCleanerOptions } from './branch-cleaner';
import { logger } from '../utils/logger';

const LOG_CONTEXT = '[BranchHygiene]';
const SWEEP_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

/**
 * Start a recurring hourly sweep.  Returns the interval handle so callers can
 * cancel it on app shutdown if desired.
 *
 * @param repoPath     Absolute path to the git repository root.
 * @param defaultBranch  The "main" branch against which merged-ness is checked.
 *                       Defaults to `'main'`.
 * @param opts           Forwarded to `sweepMergedBranches`.
 */
export function startBranchHygieneCron(
	repoPath: string,
	defaultBranch = 'main',
	opts: BranchCleanerOptions = {}
): NodeJS.Timeout {
	logger.info(
		`Branch hygiene cron started (repo=${repoPath}, default=${defaultBranch}, grace=${opts.graceDays ?? 14}d)`,
		LOG_CONTEXT
	);

	async function runSweep(): Promise<void> {
		logger.debug('Branch hygiene sweep running', LOG_CONTEXT, { repoPath, defaultBranch });
		try {
			const result = await sweepMergedBranches(repoPath, defaultBranch, opts);

			if (result.deleted.length > 0) {
				logger.info(
					`Branch hygiene deleted ${result.deleted.length} merged branch(es): ${result.deleted.join(', ')}`,
					LOG_CONTEXT
				);
			} else {
				logger.debug('Branch hygiene sweep: nothing to delete', LOG_CONTEXT);
			}

			if (result.skipped.length > 0) {
				logger.debug(`Branch hygiene skipped ${result.skipped.length} branch(es)`, LOG_CONTEXT, {
					skipped: result.skipped,
				});
			}
		} catch (err) {
			logger.warn(
				`Branch hygiene sweep failed: ${err instanceof Error ? err.message : String(err)}`,
				LOG_CONTEXT
			);
		}
	}

	// Run once immediately on start, then on every interval tick.
	void runSweep();
	return setInterval(() => void runSweep(), SWEEP_INTERVAL_MS);
}
