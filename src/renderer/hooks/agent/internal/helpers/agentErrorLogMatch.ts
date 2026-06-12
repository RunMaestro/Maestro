/**
 * Helpers for matching and removing per-tab agent-error log entries.
 *
 * When `onAgentError` fires we append a log entry tagged with the agent
 * error tuple. When the next `onData` chunk arrives, we want to remove the
 * MOST RECENT matching entry (since the user has visibly recovered) without
 * disturbing earlier history. These helpers encapsulate the tuple-equality
 * rule so listener hooks don't reinvent it.
 */

import type { LogEntry, AgentError } from '../../../../types';

export function isMatchingAgentErrorLog(log: LogEntry, agentError: AgentError): boolean {
	if (log.source !== 'error' || !log.agentError) {
		return false;
	}

	return (
		log.agentError.timestamp === agentError.timestamp &&
		log.agentError.type === agentError.type &&
		log.agentError.message === agentError.message &&
		log.agentError.agentId === agentError.agentId
	);
}

export function removeMatchingAgentErrorLog(logs: LogEntry[], agentError: AgentError): LogEntry[] {
	for (let index = logs.length - 1; index >= 0; index -= 1) {
		if (isMatchingAgentErrorLog(logs[index], agentError)) {
			return [...logs.slice(0, index), ...logs.slice(index + 1)];
		}
	}

	return logs;
}
