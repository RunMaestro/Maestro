/**
 * Stats listener.
 * Handles query-complete events for usage statistics tracking.
 */

import type { ProcessManager } from '../process-manager';
import type { QueryCompleteData } from '../process-manager/types';
import type { ProcessListenerDependencies } from './types';

/**
 * Maximum number of retry attempts for transient database failures.
 */
const MAX_RETRY_ATTEMPTS = 3;

/**
 * Base delay in milliseconds for exponential backoff (doubles each retry).
 */
const RETRY_BASE_DELAY_MS = 100;

/**
 * Attempts to insert a query event with retry logic for transient failures.
 * Uses exponential backoff: 100ms, 200ms, 400ms delays between retries.
 */
async function insertQueryEventWithRetry(
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
				inputTokens: queryData.inputTokens,
				outputTokens: queryData.outputTokens,
				cacheReadTokens: queryData.cacheReadTokens,
				cacheCreationTokens: queryData.cacheCreationTokens,
				costUsd: queryData.costUsd,
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

/**
 * Sets up the query-complete listener for stats tracking.
 * Records AI query events to the stats database with retry logic for transient failures.
 */
export function setupStatsListener(
	processManager: ProcessManager,
	deps: Pick<ProcessListenerDependencies, 'safeSend' | 'getStatsDB' | 'logger'>
): void {
	const { safeSend, getStatsDB, logger } = deps;

	// Handle query-complete events for stats tracking
	// This is emitted when a batch mode AI query completes (user or auto)
	processManager.on('query-complete', (_sessionId: string, queryData: QueryCompleteData) => {
		const db = getStatsDB();
		if (!db.isReady()) {
			return;
		}

		// Use async IIFE to handle retry logic without blocking
		void (async () => {
			const id = await insertQueryEventWithRetry(db, queryData, logger);

			if (id !== null) {
				logger.debug(`Recorded query event: ${id}`, '[Stats]', {
					sessionId: queryData.sessionId,
					agentType: queryData.agentType,
					source: queryData.source,
					duration: queryData.duration,
				});
				// Broadcast stats update to renderer for real-time dashboard refresh
				safeSend('stats:updated');
			}
		})();
	});
}
