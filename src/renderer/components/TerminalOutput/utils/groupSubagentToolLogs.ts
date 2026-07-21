import type { LogEntry } from '../../../types';

/**
 * Result of nesting subagent tool logs under their spawning parent.
 *
 * `logs` is the flat render list with adopted children removed; `childrenByParentId`
 * maps a parent tool log's `id` to the child entries the transcript should render
 * indented beneath it.
 */
export interface SubagentToolGrouping {
	logs: LogEntry[];
	childrenByParentId: Map<string, LogEntry[]>;
}

/**
 * The listener builds tool log ids as `tool-${toolCallId}`, so a child's
 * `metadata.parentToolUseId` maps to its parent entry's id by the same rule.
 */
export const parentLogIdFor = (parentToolUseId: string): string => `tool-${parentToolUseId}`;

/**
 * Nest subagent tool logs (claude-code's Task tool) under the parent tool entry
 * that spawned them.
 *
 * A tool entry carrying `metadata.parentToolUseId` is adopted by the tool entry
 * whose id is `tool-${parentToolUseId}`, and is dropped from the flat list so it
 * renders only once, indented under that parent.
 *
 * Orphans render flat exactly as before: an entry whose parent is not in the log
 * (transcript trimmed, parser started mid-stream) keeps its own top-level slot.
 * Entries without `parentToolUseId` - every non-claude agent and every log
 * written before this field existed - are untouched.
 *
 * Nesting is one level deep: `LogItem` renders adopted children as flat badges
 * and does not recurse into their own children. claude-code subagents are not
 * given the Task tool, so a grandchild does not arise in practice; if one ever
 * did we must not adopt it under an already-adopted child, or it would be pulled
 * out of the flat list and never rendered. So adoption targets only top-level
 * tool entries: any deeper descendant keeps its own top-level slot (visible)
 * rather than vanishing.
 *
 * Pure + exported so the grouping is unit-testable independent of the component.
 */
export function groupSubagentToolLogs(logs: LogEntry[]): SubagentToolGrouping {
	// Fast path: no subagent activity in this transcript (the common case for
	// every non-claude agent), so skip the second pass and the allocations.
	const hasSubagentEntry = logs.some((log) => log.metadata?.parentToolUseId);
	if (!hasSubagentEntry) {
		return { logs, childrenByParentId: new Map() };
	}

	const toolLogIds = new Set<string>();
	for (const log of logs) {
		if (log.source === 'tool') {
			toolLogIds.add(log.id);
		}
	}

	const childrenByParentId = new Map<string, LogEntry[]>();
	const adoptedIds = new Set<string>();
	const result: LogEntry[] = [];

	for (const log of logs) {
		const parentToolUseId = log.metadata?.parentToolUseId;
		const parentLogId = parentToolUseId ? parentLogIdFor(parentToolUseId) : undefined;

		// Adopt only when the parent is a real, top-level tool entry in this log
		// AND is not the entry itself (a self-referential id would otherwise
		// vanish). Refusing to adopt under an already-adopted child keeps deeper
		// descendants in the flat list instead of dropping them (see note above);
		// logs are chronological, so a child is always seen before its own child.
		if (
			parentLogId &&
			parentLogId !== log.id &&
			toolLogIds.has(parentLogId) &&
			!adoptedIds.has(parentLogId)
		) {
			adoptedIds.add(log.id);
			const siblings = childrenByParentId.get(parentLogId);
			if (siblings) {
				siblings.push(log);
			} else {
				childrenByParentId.set(parentLogId, [log]);
			}
			continue;
		}

		result.push(log);
	}

	return { logs: result, childrenByParentId };
}
