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
const RC_TARGET_VERSION = 17;

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

	it("gives a main database stamped v15 (token_speed_hourly, no kind column) rc's v15", () => {
		// main ships token_speed_hourly as v15, the number rc gave the `kind`
		// column. Such a database must get `kind` by repair, and v16 must leave the
		// existing token_speed_hourly table in place.
		const db = openDb();
		runMigrations(db);
		db.exec('ALTER TABLE auto_run_sessions DROP COLUMN kind');
		db.exec(
			"INSERT INTO token_speed_hourly (hour_start, agent_type, model, calls, input_tokens, output_tokens, duration_ms) VALUES (0, 'opencode', 'm', 1, 10, 20, 1000)"
		);
		db.pragma('user_version = 15');

		runMigrations(db);

		expect(columnNames(db, 'auto_run_sessions')).toContain('kind');
		expect(logger.warn).toHaveBeenCalledTimes(1);
		expect(vi.mocked(logger.warn).mock.calls[0][0]).toContain('v15');
		expect(
			(db.prepare('SELECT COUNT(*) AS n FROM token_speed_hourly').get() as { n: number }).n
		).toBe(1);
		expect(getCurrentVersion(db)).toBe(RC_TARGET_VERSION);
	});
});
