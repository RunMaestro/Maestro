import type { LogEntry } from '../types';

export const HIDDEN_PROGRESS_LOG_PREFIX = 'hidden-progress:';

export function buildHiddenProgressLogId(tabId: string): string {
	return `${HIDDEN_PROGRESS_LOG_PREFIX}${tabId}`;
}

export function isHiddenProgressLog(log: Pick<LogEntry, 'id' | 'source'>): boolean {
	return log.source === 'system' && log.id.startsWith(HIDDEN_PROGRESS_LOG_PREFIX);
}
