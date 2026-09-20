/**
 * @vitest-environment node
 *
 * Regression tests for MAESTRO-113/114: `table query_events has no column named
 * input_tokens` on every query event.
 *
 * rc and main number their stats migrations differently past v7, and
 * user_version is only a number. main's v8 is the query_events token columns
 * while rc's v8 is multi_window_usage_daily; rc's token columns are v9, its
 * resilience_events v10, its wizard_runs v11, its user_name column v12. So a
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
const RC_TARGET_VERSION = 12;

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
});
