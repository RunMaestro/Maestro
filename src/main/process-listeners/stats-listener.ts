/**
 * Stats listener.
 * Handles query-complete events for usage statistics tracking.
 */

import type { ProcessManager } from '../process-manager';
import type { QueryCompleteData } from '../process-manager/types';
import type { ProcessListenerDependencies } from './types';
import { insertQueryEventWithRetry } from './insertQueryEventWithRetry';

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
