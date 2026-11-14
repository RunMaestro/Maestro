/**
 * Local Model Run CRUD Operations
 *
 * One row per run that reached a model other than a provider's own (see
 * `local_model_runs` in schema.ts). The task router records every call it makes
 * to a local model, the Maestro model server or an endpoint, and the System One
 * ledger records every request sent to a remote engine, success or failure, so
 * the Usage Dashboard can show what ran where and what keeps failing.
 */

import type Database from 'better-sqlite3';
import type { LocalModelRun, StatsTimeRange } from '../../shared/stats-types';
import { generateId, getTimeRangeStart, LOG_CONTEXT, StatementCache } from './utils';
import { logger } from '../utils/logger';

const stmtCache = new StatementCache();

const INSERT_SQL = `
  INSERT INTO local_model_runs
    (id, task_id, source_type, model_id, endpoint_id, started_at, duration_ms, outcome, error_code, tokens_in, tokens_out, agent_id)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`;

/** Record one run. Returns the generated id. */
export function recordLocalModelRun(db: Database.Database, run: Omit<LocalModelRun, 'id'>): string {
	const id = generateId();
	const stmt = stmtCache.get(db, INSERT_SQL);
	stmt.run(
		id,
		run.taskId,
		run.sourceType,
		run.modelId,
		run.endpointId ?? null,
		run.startedAt,
		Math.round(run.durationMs),
		run.outcome,
		run.errorCode ?? null,
		run.tokensIn ?? null,
		run.tokensOut ?? null,
		run.agentId ?? null
	);
	logger.debug(`Recorded local model run: ${run.taskId} (${run.outcome})`, LOG_CONTEXT);
	return id;
}

interface LocalModelRunRow {
	id: string;
	task_id: string;
	source_type: LocalModelRun['sourceType'];
	model_id: string;
	endpoint_id: string | null;
	started_at: number;
	duration_ms: number;
	outcome: LocalModelRun['outcome'];
	error_code: string | null;
	tokens_in: number | null;
	tokens_out: number | null;
	agent_id: string | null;
}

/** Runs that started within the time range, newest first. */
export function getLocalModelRuns(db: Database.Database, range: StatsTimeRange): LocalModelRun[] {
	const startTime = getTimeRangeStart(range);
	const stmt = stmtCache.get(
		db,
		`
      SELECT * FROM local_model_runs
      WHERE started_at >= ?
      ORDER BY started_at DESC
    `
	);
	const rows = stmt.all(startTime) as LocalModelRunRow[];
	return rows.map((row) => ({
		id: row.id,
		taskId: row.task_id,
		sourceType: row.source_type,
		modelId: row.model_id,
		...(row.endpoint_id !== null ? { endpointId: row.endpoint_id } : {}),
		startedAt: row.started_at,
		durationMs: row.duration_ms,
		outcome: row.outcome,
		...(row.error_code !== null ? { errorCode: row.error_code } : {}),
		...(row.tokens_in !== null ? { tokensIn: row.tokens_in } : {}),
		...(row.tokens_out !== null ? { tokensOut: row.tokens_out } : {}),
		...(row.agent_id !== null ? { agentId: row.agent_id } : {}),
	}));
}

/** Clear the statement cache (call when database is closed). */
export function clearLocalModelRunsCache(): void {
	stmtCache.clear();
}
