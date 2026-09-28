/**
 * Wizard Run CRUD Operations
 *
 * One row per Auto Run wizard conversation (see `wizard_runs` in schema.ts).
 * The renderer UPSERTS the same row at every milestone - opened, each exchange,
 * documents written, closed - so a run that is never closed (app quit, tab
 * closed mid-wizard) still leaves accurate counts behind instead of vanishing.
 */

import type Database from 'better-sqlite3';
import type { StatsTimeRange, WizardRun } from '../../shared/stats-types';
import { getTimeRangeStart, normalizePath, LOG_CONTEXT, StatementCache } from './utils';
import { logger } from '../utils/logger';

const stmtCache = new StatementCache();

const UPSERT_SQL = `
  INSERT OR REPLACE INTO wizard_runs
    (id, session_id, agent_type, surface, mode, outcome, started_at, ended_at, exchanges, documents, tasks, project_path)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`;

/**
 * Record (or re-record) a wizard run. OR REPLACE keyed on the caller's stable
 * run id makes every milestone flush idempotent: the row always holds the
 * latest known state of that run, and a repeated flush never double-counts.
 */
export function recordWizardRun(db: Database.Database, run: WizardRun): string {
	const stmt = stmtCache.get(db, UPSERT_SQL);
	stmt.run(
		run.id,
		run.sessionId,
		run.agentType,
		run.surface,
		run.mode,
		run.outcome,
		run.startedAt,
		run.endedAt,
		run.exchanges,
		run.documents,
		run.tasks,
		normalizePath(run.projectPath)
	);
	logger.debug(`Recorded wizard run ${run.id} (${run.outcome})`, LOG_CONTEXT);
	return run.id;
}

interface WizardRunRow {
	id: string;
	session_id: string;
	agent_type: string;
	surface: WizardRun['surface'];
	mode: WizardRun['mode'];
	outcome: WizardRun['outcome'];
	started_at: number;
	ended_at: number;
	exchanges: number;
	documents: number;
	tasks: number;
	project_path: string | null;
}

/** Get wizard runs that STARTED within the time range, newest first. */
export function getWizardRuns(db: Database.Database, range: StatsTimeRange): WizardRun[] {
	const startTime = getTimeRangeStart(range);
	const stmt = stmtCache.get(
		db,
		`
      SELECT * FROM wizard_runs
      WHERE started_at >= ?
      ORDER BY started_at DESC
    `
	);
	const rows = stmt.all(startTime) as WizardRunRow[];
	return rows.map((row) => ({
		id: row.id,
		sessionId: row.session_id,
		agentType: row.agent_type,
		surface: row.surface,
		mode: row.mode,
		outcome: row.outcome,
		startedAt: row.started_at,
		endedAt: row.ended_at,
		exchanges: row.exchanges,
		documents: row.documents,
		tasks: row.tasks,
		projectPath: row.project_path ?? undefined,
	}));
}

/** Clear the statement cache (call when database is closed). */
export function clearWizardRunsCache(): void {
	stmtCache.clear();
}
