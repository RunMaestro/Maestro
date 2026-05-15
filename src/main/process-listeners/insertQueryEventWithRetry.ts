/**
 * Shared helper that inserts a stats `query_events` row with exponential-backoff
 * retry for transient SQLite failures (busy/locked, briefly disconnected handles).
 *
 * Both ingestion paths use it:
 *  - {@link import('./stats-listener').setupStatsListener} — process-driven
 *    events from Maestro-spawned agents.
 *  - {@link import('./external-stats-ingester').ExternalStatsIngester} —
 *    file-driven events from agents Maestro did NOT spawn.
 *
 * Keeping the retry logic in one place satisfies the dedup mandate in
 * `CLAUDE.md` (no copy-pasted helpers across listeners).
 */

import type { QueryCompleteData } from '../process-manager/types';
import type { ProcessListenerDependencies } from './types';

/**
 * Maximum number of retry attempts for transient database failures.
 */
export const MAX_RETRY_ATTEMPTS = 3;

/**
 * Base delay in milliseconds for exponential backoff (doubles each retry):
 * 100ms, 200ms, 400ms between attempts.
 */
export const RETRY_BASE_DELAY_MS = 100;

/**
 * Attempts to insert a query event with retry logic for transient failures.
 *
 * Returns the generated event id on success, or `null` after `MAX_RETRY_ATTEMPTS`
 * consecutive failures (the final failure is logged at `error`; intermediate
 * failures at `warn`). Never throws — callers can treat `null` as a hard fail.
 */
export async function insertQueryEventWithRetry(
	db: ReturnType<ProcessListenerDependencies['getStatsDB']>,
	queryData: QueryCompleteData,
	logger: ProcessListenerDependencies['logger']
): Promise<string | null> {
	for (let attempt = 1; attempt <= MAX_RETRY_ATTEMPTS; attempt++) {
		try {
			const id = db.insertQueryEvent({
				sessionId: queryData.sessionId,
				agentType: queryData.agentType,
				source: queryData.source,
				startTime: queryData.startTime,
				duration: queryData.duration,
				projectPath: queryData.projectPath,
				tabId: queryData.tabId,
			});
			return id;
		} catch (error) {
			const isLastAttempt = attempt === MAX_RETRY_ATTEMPTS;

			if (isLastAttempt) {
				logger.error(
					`Failed to record query event after ${MAX_RETRY_ATTEMPTS} attempts`,
					'[Stats]',
					{
						error: String(error),
						sessionId: queryData.sessionId,
					}
				);
			} else {
				const delay = RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 1);
				logger.warn(
					`Stats DB insert failed (attempt ${attempt}/${MAX_RETRY_ATTEMPTS}), retrying in ${delay}ms`,
					'[Stats]',
					{
						error: String(error),
						sessionId: queryData.sessionId,
					}
				);
				await new Promise((resolve) => setTimeout(resolve, delay));
			}
		}
	}

	return null;
}
