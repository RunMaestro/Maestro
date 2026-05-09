/**
 * Helpers for cleaning up an AI tab's logs after the agent process exits.
 *
 * The `showThinking` exit contract is the cross-cutting concern here:
 * - 'off':     thinking/tool logs were never appended; nothing to do.
 * - 'on':      thinking/tool logs are scratch state for the active turn and
 *              MUST be dropped on exit.
 * - 'sticky':  thinking/tool logs persist across exits.
 *
 * Provider parsers that surface reasoning or tool-execution events MUST tag
 * their renderer logs with `source: 'thinking'` or `source: 'tool'` so this
 * filter applies uniformly. New agent integrations inherit the behaviour for
 * free as long as they follow the tagging convention.
 *
 * Kept in sync with `ThinkingMode` in `src/shared/types.ts` and the
 * inline-clearing filter in `useBatchedSessionUpdates.ts`.
 */

import type { LogEntry, ThinkingMode } from '../../../../types';
import { buildHiddenProgressLogId } from '../../../../utils/hiddenProgress';

export function removeHiddenProgressLog(logs: LogEntry[], tabId: string): LogEntry[] {
	const hiddenLogId = buildHiddenProgressLogId(tabId);
	const updatedLogs = logs.filter((log) => log.id !== hiddenLogId);
	return updatedLogs.length === logs.length ? logs : updatedLogs;
}

export function applyExitThinkingPolicy(
	logs: LogEntry[],
	tab: { showThinking?: ThinkingMode }
): LogEntry[] {
	if (tab.showThinking === 'sticky') return logs;
	const filtered = logs.filter((l) => l.source !== 'thinking' && l.source !== 'tool');
	return filtered.length === logs.length ? logs : filtered;
}

/**
 * Standard cleanup applied to a just-exited AI tab's logs:
 * removes the hidden-progress placeholder AND drops transient
 * thinking/tool entries unless the tab is in sticky mode.
 */
export function cleanupExitedTabLogs(
	logs: LogEntry[],
	tabId: string,
	tab: { showThinking?: ThinkingMode }
): LogEntry[] {
	return applyExitThinkingPolicy(removeHiddenProgressLog(logs, tabId), tab);
}
