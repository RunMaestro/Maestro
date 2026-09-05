/**
 * Resilience Event CRUD Operations
 *
 * One row per RESOLVED Agent Resilience outage (see `resilience_events` in
 * schema.ts). Recording happens from the renderer's retryStore at the moment
 * an outage leaves 'active' - recovered (the auto-resend went through) or
 * stopped (the user gave up or moved on). Live countdowns are never recorded,
 * so a quit mid-outage records nothing.
 */

import type Database from 'better-sqlite3';
import type { ResilienceEvent, StatsTimeRange } from '../../shared/stats-types';
import { getTimeRangeStart, LOG_CONTEXT, StatementCache } from './utils';
import { logger } from '../utils/logger';

const stmtCache = new StatementCache();

const INSERT_SQL = `
  INSERT OR REPLACE INTO resilience_events
    (id, session_id, agent_type, strategy, outcome, started_at, resolved_at, retries)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`;

/**
 * Record a resolved outage. `id` is the outageId, and OR REPLACE makes the
 * call idempotent: a double-resolve (settle racing a user Stop) keeps the
 * latest outcome instead of throwing or double-counting.
 */
export function recordResilienceEvent(db: Database.Database, event: ResilienceEvent): string {
	const stmt = stmtCache.get(db, INSERT_SQL);
	stmt.run(
		event.id,
		event.sessionId,
		event.agentType,
		event.strategy,
		event.outcome,
		event.startedAt,
		event.resolvedAt,
		event.retries
	);
	logger.debug(`Recorded resilience event: ${event.id} (${event.outcome})`, LOG_CONTEXT);
	return event.id;
}

interface ResilienceEventRow {
	id: string;
	session_id: string;
	agent_type: string;
	strategy: ResilienceEvent['strategy'];
	outcome: ResilienceEvent['outcome'];
	started_at: number;
	resolved_at: number;
	retries: number;
}

/** Get resolved outages whose FAILURE started within the time range. */
export function getResilienceEvents(
	db: Database.Database,
	range: StatsTimeRange
): ResilienceEvent[] {
	const startTime = getTimeRangeStart(range);
	const stmt = stmtCache.get(
		db,
		`
      SELECT * FROM resilience_events
      WHERE started_at >= ?
      ORDER BY started_at DESC
    `
	);
	const rows = stmt.all(startTime) as ResilienceEventRow[];
	return rows.map((row) => ({
		id: row.id,
		sessionId: row.session_id,
		agentType: row.agent_type,
		strategy: row.strategy,
		outcome: row.outcome,
		startedAt: row.started_at,
		resolvedAt: row.resolved_at,
		retries: row.retries,
	}));
}

/** Clear the statement cache (call when database is closed). */
export function clearResilienceCache(): void {
	stmtCache.clear();
}
