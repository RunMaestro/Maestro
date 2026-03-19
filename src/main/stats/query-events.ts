/**
 * Query Event CRUD Operations
 *
 * Handles insertion and retrieval of individual AI query/response cycle records.
 */

import type Database from 'better-sqlite3';
import type { QueryEvent, StatsTimeRange, StatsFilters } from '../../shared/stats-types';
import { generateId, getTimeRangeStart, normalizePath, LOG_CONTEXT } from './utils';
import { mapQueryEventRow, type QueryEventRow } from './row-mappers';
import { StatementCache } from './utils';
import { logger } from '../utils/logger';

const stmtCache = new StatementCache();

const INSERT_SQL = `
  INSERT INTO query_events (id, session_id, agent_type, source, start_time, duration, project_path, tab_id, is_remote, account_id, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, cost_usd)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`;

/**
 * Insert a new query event
 */
export function insertQueryEvent(db: Database.Database, event: Omit<QueryEvent, 'id'>): string {
	const id = generateId();
	const stmt = stmtCache.get(db, INSERT_SQL);

	stmt.run(
		id,
		event.sessionId,
		event.agentType,
		event.source,
		event.startTime,
		event.duration,
		normalizePath(event.projectPath),
		event.tabId ?? null,
		event.isRemote !== undefined ? (event.isRemote ? 1 : 0) : null,
		event.accountId ?? null,
		event.inputTokens ?? 0,
		event.outputTokens ?? 0,
		event.cacheReadTokens ?? 0,
		event.cacheCreationTokens ?? 0,
		event.costUsd ?? 0
	);

	logger.debug(`Inserted query event ${id}`, LOG_CONTEXT);
	return id;
}

/**
 * Get query events within a time range with optional filters
 */
export function getQueryEvents(
	db: Database.Database,
	range: StatsTimeRange,
	filters?: StatsFilters
): QueryEvent[] {
	const startTime = getTimeRangeStart(range);
	let sql = 'SELECT * FROM query_events WHERE start_time >= ?';
	const params: (string | number)[] = [startTime];

	if (filters?.agentType) {
		sql += ' AND agent_type = ?';
		params.push(filters.agentType);
	}
	if (filters?.source) {
		sql += ' AND source = ?';
		params.push(filters.source);
	}
	if (filters?.projectPath) {
		sql += ' AND project_path = ?';
		// Normalize filter path to match stored format
		params.push(normalizePath(filters.projectPath) ?? '');
	}
	if (filters?.sessionId) {
		sql += ' AND session_id = ?';
		params.push(filters.sessionId);
	}

	sql += ' ORDER BY start_time DESC';

	const stmt = db.prepare(sql);
	const rows = stmt.all(...params) as QueryEventRow[];

	return rows.map(mapQueryEventRow);
}

/**
 * Clear the statement cache (call when database is closed)
 */
export function clearQueryEventCache(): void {
	stmtCache.clear();
}
