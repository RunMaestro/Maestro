/**
 * The single definition of how a query event becomes a row.
 *
 * There are two insert paths - the buffered one on the hot path
 * (`query-events-buffer.ts`) and the direct one (`query-events.ts`) - and they
 * had already drifted: the buffered statement, which is the one production
 * actually uses, was missing `is_worktree`, so every interactive turn wrote
 * NULL there while the direct path wrote the real flag. Worktree attribution on
 * `query_events` was silently empty as a result.
 *
 * Keeping the column list and the value binding in one place makes that class
 * of drift impossible: adding a column means editing one array and one mapper,
 * and both paths pick it up.
 */

import type { QueryEvent } from '../../shared/stats-types';
import { normalizePath } from './utils';

/** Columns written by every insert path, in bind order. */
const QUERY_EVENT_COLUMNS = [
	'id',
	'session_id',
	'agent_type',
	'source',
	'start_time',
	'duration',
	'project_path',
	'tab_id',
	'is_remote',
	'is_worktree',
	'input_tokens',
	'output_tokens',
	'cache_read_tokens',
	'cache_creation_tokens',
	'cost_usd',
] as const;

/** `INSERT INTO query_events (...) VALUES (?, ?, ...)` for the columns above. */
export const INSERT_QUERY_EVENT_SQL = `
  INSERT INTO query_events (${QUERY_EVENT_COLUMNS.join(', ')})
  VALUES (${QUERY_EVENT_COLUMNS.map(() => '?').join(', ')})
`;

/**
 * Bind values for one event, in the order `INSERT_QUERY_EVENT_SQL` expects.
 *
 * Undefined becomes NULL rather than 0 throughout. For the token columns that
 * distinction carries meaning - a turn whose provider reported no usage is not
 * a turn that cost nothing - and the aggregation relies on it to count priced
 * queries separately.
 */
export function bindQueryEvent(
	id: string,
	event: Omit<QueryEvent, 'id'>
): Array<string | number | null> {
	return [
		id,
		event.sessionId,
		event.agentType,
		event.source,
		event.startTime,
		event.duration,
		normalizePath(event.projectPath),
		event.tabId ?? null,
		event.isRemote !== undefined ? (event.isRemote ? 1 : 0) : null,
		event.isWorktree !== undefined ? (event.isWorktree ? 1 : 0) : null,
		event.inputTokens ?? null,
		event.outputTokens ?? null,
		event.cacheReadTokens ?? null,
		event.cacheCreationTokens ?? null,
		event.costUsd ?? null,
	];
}
