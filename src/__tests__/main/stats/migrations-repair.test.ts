/**
 * @vitest-environment node
 *
 * Regression tests for MAESTRO-113/114: `table query_events has no column named
 * input_tokens` on every query event.
 *
 * rc and main number their stats migrations differently past v7, and
 * user_version is only a number. main's v8 is the query_events token columns
 * while rc's v8 is multi_window_usage_daily; rc's token columns are v9, its
 * resilience_events v10, its wizard_runs v11, its user_name column v12, and
 * its wizard_runs.active_ms column v13 (main's v11). So a
 * database last opened by the OTHER branch reports a version that "covers" a
 * migration it never ran, the version check skips it, and every write touching
 * the missing schema fails.
 *
 * These tests are written from rc's side of that split: the skipped body is
 * whichever one rc numbers differently, so the fixture here is a main-shaped
 * database. `isApplied` is what repairs it, and each guard has to test the
 * schema ITS OWN migration creates - a guard that drifts onto its neighbour
 * (which is exactly what a naive merge of main's patch produces against rc's
 * renumbering) reports a table as present because an unrelated one is.
 *
 * These run against a real SQLite engine (`node:sqlite`) behind a thin
 * better-sqlite3-shaped adapter. The mocked DB in stats-db.test.ts answers every
 * schema question with a canned value, which is exactly the dimension this bug
 * lives in.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import type Database from 'better-sqlite3';

vi.mock('../../../main/utils/logger', () => ({
	logger: {
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
	},
}));

import { runMigrations, getCurrentVersion } from '../../../main/stats/migrations';
import { ADD_QUERY_EVENT_TOKEN_COLUMNS } from '../../../main/stats/schema';
import { INSERT_QUERY_EVENT_SQL } from '../../../main/stats/query-event-insert';
import { logger } from '../../../main/utils/logger';

/** rc's highest stats migration. Bump alongside a new entry in getMigrations(). */
const RC_TARGET_VERSION = 23;

function openDb(): Database.Database {
	const raw = new DatabaseSync(':memory:');
	return {
		prepare: (sql: string) => raw.prepare(sql),
		exec: (sql: string) => raw.exec(sql),
		pragma: (sql: string) => {
			if (sql.includes('=')) {
				raw.exec(`PRAGMA ${sql}`);
				return [];
			}
			return raw.prepare(`PRAGMA ${sql}`).all();
		},
		transaction: (fn: () => void) => () => {
			raw.exec('BEGIN');
			try {
				fn();
				raw.exec('COMMIT');
			} catch (error) {
				raw.exec('ROLLBACK');
				throw error;
			}
		},
	} as unknown as Database.Database;
}

function columnNames(db: Database.Database, table: string): string[] {
	return (db.pragma(`table_info(${table})`) as Array<{ name: string }>).map((row) => row.name);
}

function hasTable(db: Database.Database, table: string): boolean {
	return !!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?").get(table);
}

/**
 * Fully migrate, then strip whatever an install stamped `version` by the other
 * branch would not have created, and stamp that version number.
 */
function crossBranchDb(
	version: number,
	missing: {
		multiWindow?: boolean;
		tokenColumns?: boolean;
		resilience?: boolean;
		wizard?: boolean;
		wizardActiveMs?: boolean;
		localModelRuns?: boolean;
		proxyRequests?: boolean;
		proxyRoutedTo?: boolean;
		s1Decisions?: boolean;
		s1AgentColumns?: boolean;
	}
): Database.Database {
	const db = openDb();
	runMigrations(db);
	if (missing.multiWindow) db.exec('DROP TABLE multi_window_usage_daily');
	if (missing.tokenColumns) {
		for (const column of ADD_QUERY_EVENT_TOKEN_COLUMNS) {
			db.exec(`ALTER TABLE query_events DROP COLUMN ${column}`);
		}
	}
	if (missing.resilience) db.exec('DROP TABLE resilience_events');
	if (missing.wizard) db.exec('DROP TABLE wizard_runs');
	if (missing.wizardActiveMs) db.exec('ALTER TABLE wizard_runs DROP COLUMN active_ms');
	if (missing.localModelRuns) db.exec('DROP TABLE local_model_runs');
	if (missing.proxyRequests) db.exec('DROP TABLE proxy_requests');
	if (missing.proxyRoutedTo) db.exec('ALTER TABLE proxy_requests DROP COLUMN routed_to');
	if (missing.s1Decisions) db.exec('DROP TABLE s1_decisions');
	if (missing.s1AgentColumns) {
		db.exec('ALTER TABLE s1_decisions DROP COLUMN tab_id');
		db.exec('ALTER TABLE s1_decisions DROP COLUMN cached');
	}
	db.pragma(`user_version = ${version}`);
	return db;
}

describe('runMigrations repairs schema skipped by a cross-branch user_version', () => {
	beforeEach(() => {
		vi.mocked(logger.warn).mockClear();
	});

	it('migrates a fresh database to the target version without repairs', () => {
		const db = openDb();
		runMigrations(db);

		expect(getCurrentVersion(db)).toBe(RC_TARGET_VERSION);
		expect(columnNames(db, 'query_events')).toEqual(
			expect.arrayContaining([...ADD_QUERY_EVENT_TOKEN_COLUMNS])
		);
		expect(hasTable(db, 'multi_window_usage_daily')).toBe(true);
		expect(logger.warn).not.toHaveBeenCalled();
	});

	it('creates multi_window_usage_daily for a main-shaped v10 database', () => {
		// main's v10 is wizard_runs, so an install stamped 10 by main has the token
		// columns, resilience_events and wizard_runs but never ran rc's v8.
		const db = crossBranchDb(10, { multiWindow: true });
		expect(hasTable(db, 'multi_window_usage_daily')).toBe(false);

		runMigrations(db);

		expect(hasTable(db, 'multi_window_usage_daily')).toBe(true);
		expect(logger.warn).toHaveBeenCalledTimes(1);
		expect(vi.mocked(logger.warn).mock.calls[0][0]).toContain('v8');
		// Repair leaves user_version alone; the pending migrations still run.
		expect(getCurrentVersion(db)).toBe(RC_TARGET_VERSION);
	});

	it('adds the token columns back so the query event insert prepares (MAESTRO-114)', () => {
		const db = crossBranchDb(RC_TARGET_VERSION, { tokenColumns: true });
		expect(() => db.prepare(INSERT_QUERY_EVENT_SQL)).toThrow(/no column named input_tokens/);

		runMigrations(db);

		expect(columnNames(db, 'query_events')).toEqual(
			expect.arrayContaining([...ADD_QUERY_EVENT_TOKEN_COLUMNS])
		);
		expect(() => db.prepare(INSERT_QUERY_EVENT_SQL)).not.toThrow();
		expect(vi.mocked(logger.warn).mock.calls[0][0]).toContain('v9');
	});

	it('repairs several missing bodies in one pass', () => {
		const db = crossBranchDb(RC_TARGET_VERSION, { resilience: true, wizard: true });

		runMigrations(db);

		expect(hasTable(db, 'resilience_events')).toBe(true);
		expect(hasTable(db, 'wizard_runs')).toBe(true);
		expect(logger.warn).toHaveBeenCalledTimes(2);
	});

	it('leaves a database with complete schema untouched', () => {
		const db = crossBranchDb(RC_TARGET_VERSION, {});

		runMigrations(db);

		expect(getCurrentVersion(db)).toBe(RC_TARGET_VERSION);
		expect(logger.warn).not.toHaveBeenCalled();
	});

	it('adds active_ms back to a database stamped v13 without it', () => {
		// rc's v13 is wizard_runs.active_ms, which main numbers v11. A database
		// whose version covers v13 but whose wizard_runs predates the column must
		// still get it, or every wizard run insert fails.
		const db = crossBranchDb(RC_TARGET_VERSION, { wizardActiveMs: true });
		expect(columnNames(db, 'wizard_runs')).not.toContain('active_ms');

		runMigrations(db);

		expect(columnNames(db, 'wizard_runs')).toContain('active_ms');
		expect(logger.warn).toHaveBeenCalledTimes(1);
		expect(vi.mocked(logger.warn).mock.calls[0][0]).toContain('v13');
		expect(getCurrentVersion(db)).toBe(RC_TARGET_VERSION);
	});

	it('v14 creates shortcut_usage_by_id and the (start_time, session_id) query index', () => {
		const db = openDb();
		runMigrations(db);

		expect(hasTable(db, 'shortcut_usage_by_id')).toBe(true);
		expect(columnNames(db, 'shortcut_usage_by_id')).toEqual(['date', 'shortcut_id', 'count']);
		const index = db
			.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name = ?")
			.get('idx_query_start_session');
		expect(index).toBeTruthy();
	});

	it('recreates shortcut_usage_by_id for a database stamped v14 without it', () => {
		const db = openDb();
		runMigrations(db);
		db.exec('DROP TABLE shortcut_usage_by_id');

		runMigrations(db);

		expect(hasTable(db, 'shortcut_usage_by_id')).toBe(true);
		expect(vi.mocked(logger.warn).mock.calls[0][0]).toContain('v14');
	});

	it("gives an rc database stamped v14 (kind column, no shortcut_usage_by_id) main's v14", () => {
		// rc first shipped auto_run_sessions.kind as v14, the number main gave
		// shortcut_usage_by_id. Such a database must get the table by repair, and
		// v15 must not try to add kind a second time.
		const db = openDb();
		runMigrations(db);
		db.exec('DROP TABLE shortcut_usage_by_id');
		db.pragma('user_version = 14');

		runMigrations(db);

		expect(hasTable(db, 'shortcut_usage_by_id')).toBe(true);
		expect(columnNames(db, 'auto_run_sessions')).toContain('kind');
		expect(logger.warn).toHaveBeenCalledTimes(1);
		expect(vi.mocked(logger.warn).mock.calls[0][0]).toContain('v14');
		expect(getCurrentVersion(db)).toBe(RC_TARGET_VERSION);
	});

	it('adds auto_run_sessions.kind to a main database at v14', () => {
		const db = openDb();
		runMigrations(db);
		db.exec('ALTER TABLE auto_run_sessions DROP COLUMN kind');
		db.pragma('user_version = 14');

		runMigrations(db);

		expect(columnNames(db, 'auto_run_sessions')).toContain('kind');
		expect(logger.warn).not.toHaveBeenCalled();
		expect(getCurrentVersion(db)).toBe(RC_TARGET_VERSION);
	});

	it("gives an acappella database stamped v22 (kind column, no shortcut_usage_by_id) main's v14", () => {
		// acappella numbered its Local Models migrations 15-22 on top of kind at
		// v14, before rc moved kind to v15; they are 16-23 now. Such a database
		// has every table but shortcut_usage_by_id, which v14 repairs, and the
		// rest upgrades as usual.
		const db = openDb();
		runMigrations(db);
		db.exec('DROP TABLE shortcut_usage_by_id');
		db.pragma('user_version = 22');

		runMigrations(db);

		expect(hasTable(db, 'shortcut_usage_by_id')).toBe(true);
		expect(columnNames(db, 'auto_run_sessions')).toContain('kind');
		expect(hasTable(db, 'local_model_runs')).toBe(true);
		expect(logger.warn).toHaveBeenCalledTimes(1);
		expect(vi.mocked(logger.warn).mock.calls[0][0]).toContain('v14');
		expect(getCurrentVersion(db)).toBe(RC_TARGET_VERSION);
	});

	it('creates local_model_runs for a database stamped v16 without it', () => {
		// v16 declares isApplied, so if rc ships a different v16 first, an install
		// stamped 16 by that build still gets this table.
		const db = crossBranchDb(RC_TARGET_VERSION, { localModelRuns: true });
		expect(hasTable(db, 'local_model_runs')).toBe(false);

		runMigrations(db);

		expect(hasTable(db, 'local_model_runs')).toBe(true);
		expect(logger.warn).toHaveBeenCalledTimes(1);
		expect(vi.mocked(logger.warn).mock.calls[0][0]).toContain('v16');
	});

	it('creates proxy_requests for a database stamped v17 without it', () => {
		// v17 declares isApplied for the same reason v16 does.
		const db = crossBranchDb(RC_TARGET_VERSION, { proxyRequests: true });
		expect(hasTable(db, 'proxy_requests')).toBe(false);

		runMigrations(db);

		expect(hasTable(db, 'proxy_requests')).toBe(true);
		// The table is created with every column it has today, so v18 has
		// nothing left to repair.
		expect(columnNames(db, 'proxy_requests')).toContain('routed_to');
		expect(logger.warn).toHaveBeenCalledTimes(1);
		expect(vi.mocked(logger.warn).mock.calls[0][0]).toContain('v17');
	});

	it('gives a fresh proxy_requests table the routed_to column', () => {
		const db = openDb();
		runMigrations(db);

		expect(columnNames(db, 'proxy_requests')).toContain('routed_to');
	});

	it('adds routed_to to a proxy_requests table created before the column existed', () => {
		// A v17 install: the table exists, without the column v18 adds.
		const db = crossBranchDb(17, { proxyRoutedTo: true });
		expect(columnNames(db, 'proxy_requests')).not.toContain('routed_to');

		runMigrations(db);

		expect(columnNames(db, 'proxy_requests')).toContain('routed_to');
		expect(getCurrentVersion(db)).toBe(RC_TARGET_VERSION);
		// An ordinary upgrade, not a repair.
		expect(logger.warn).not.toHaveBeenCalled();
	});

	it('adds routed_to back to a database stamped v18 without it', () => {
		// v18 declares isApplied, so a database another branch stamped 18 for a
		// different migration still gets the column the insert names.
		const db = crossBranchDb(RC_TARGET_VERSION, { proxyRoutedTo: true });

		runMigrations(db);

		expect(columnNames(db, 'proxy_requests')).toContain('routed_to');
		expect(logger.warn).toHaveBeenCalledTimes(1);
		expect(vi.mocked(logger.warn).mock.calls[0][0]).toContain('v18');
	});

	it('creates s1_decisions for a database stamped v19 without it', () => {
		// v19 declares isApplied, so if rc ships a different v19 first, an install
		// stamped 19 by that build still gets the System One ledger's table.
		const db = crossBranchDb(RC_TARGET_VERSION, { s1Decisions: true });
		expect(hasTable(db, 's1_decisions')).toBe(false);

		runMigrations(db);

		expect(hasTable(db, 's1_decisions')).toBe(true);
		// The table v19 creates already has v20's columns, so v20 has nothing to repair.
		expect(columnNames(db, 's1_decisions')).toEqual(expect.arrayContaining(['tab_id', 'cached']));
		expect(logger.warn).toHaveBeenCalledTimes(1);
		expect(vi.mocked(logger.warn).mock.calls[0][0]).toContain('v19');
	});

	it('adds tab_id and cached to an s1_decisions table created before the columns existed', () => {
		const db = crossBranchDb(19, { s1AgentColumns: true });
		expect(columnNames(db, 's1_decisions')).not.toContain('tab_id');
		db.exec(
			`INSERT INTO s1_decisions (id, started_at, task_id, engine, question_ids, outcome, latency_ms)
			 VALUES ('d-1', 1, 'cue-gate', 'jev-cloud', '["proceed"]', 'ok', 200)`
		);

		runMigrations(db);

		expect(columnNames(db, 's1_decisions')).toEqual(expect.arrayContaining(['tab_id', 'cached']));
		expect(getCurrentVersion(db)).toBe(RC_TARGET_VERSION);
		// A row written before the columns reads as not cached, from no tab.
		expect(db.prepare('SELECT tab_id, cached FROM s1_decisions').get()).toEqual({
			tab_id: null,
			cached: 0,
		});
		// An ordinary upgrade, not a repair.
		expect(logger.warn).not.toHaveBeenCalled();
	});

	it('adds the s1_decisions agent columns back to a database stamped v20 without them', () => {
		const db = crossBranchDb(RC_TARGET_VERSION, { s1AgentColumns: true });

		runMigrations(db);

		expect(columnNames(db, 's1_decisions')).toEqual(expect.arrayContaining(['tab_id', 'cached']));
		expect(logger.warn).toHaveBeenCalledTimes(1);
		expect(vi.mocked(logger.warn).mock.calls[0][0]).toContain('v20');
	});
});
