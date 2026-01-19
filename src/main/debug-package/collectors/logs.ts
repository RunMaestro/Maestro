/**
 * Logs Collector
 *
 * Collects recent system logs from the logger.
 * These are system/application logs, not conversation logs.
 */

import { logger, LogEntry } from '../../utils/logger';

export interface LogsInfo {
	totalEntries: number;
	includedEntries: number;
	byLevel: Record<string, number>;
	entries: LogEntry[]; // Last N entries
}

/**
 * Collect recent system logs.
 * @param limit Maximum number of log entries to include (default: 500)
 */
export function collectLogs(limit: number = 500): LogsInfo {
	const allLogs = logger.getLogs();
	const entries = allLogs.slice(-limit);

	// Count by level
	const byLevel: Record<string, number> = {};
	for (const entry of allLogs) {
		byLevel[entry.level] = (byLevel[entry.level] || 0) + 1;
	}

	return {
		totalEntries: allLogs.length,
		includedEntries: entries.length,
		byLevel,
		entries,
	};
}
