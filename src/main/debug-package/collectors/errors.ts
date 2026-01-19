/**
 * Errors Collector
 *
 * Collects error states from sessions and recent error logs.
 * - Only error type and metadata, no full error messages that might contain sensitive data
 */

import Store from 'electron-store';
import { logger, LogEntry } from '../../utils/logger';

export interface ErrorsInfo {
	currentSessionErrors: Array<{
		sessionId: string;
		errorType: string;
		recoverable: boolean;
		timestamp: number;
		agentId: string;
	}>;
	recentErrorLogs: LogEntry[]; // Filtered to error level only
	errorCount24h: number;
}

/**
 * Collect error information from sessions and logs.
 */
export function collectErrors(sessionsStore: Store<any>): ErrorsInfo {
	const result: ErrorsInfo = {
		currentSessionErrors: [],
		recentErrorLogs: [],
		errorCount24h: 0,
	};

	// Get current session errors
	const sessions = sessionsStore.get('sessions', []) as any[];
	for (const session of sessions) {
		if (session.agentError) {
			result.currentSessionErrors.push({
				sessionId: session.id || 'unknown',
				errorType: session.agentError.type || 'unknown',
				recoverable: !!session.agentError.recoverable,
				timestamp: session.agentError.timestamp || Date.now(),
				agentId: session.toolType || 'unknown',
			});
		}
	}

	// Get recent error logs
	const allLogs = logger.getLogs();
	const errorLogs = allLogs.filter((log) => log.level === 'error');

	// Get last 100 error logs
	result.recentErrorLogs = errorLogs.slice(-100);

	// Count errors in last 24 hours
	const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;
	result.errorCount24h = errorLogs.filter((log) => log.timestamp > oneDayAgo).length;

	return result;
}
