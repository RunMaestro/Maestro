/**
 * @vitest-environment node
 *
 * Real-SQL tests for the Usage Dashboard reads added with stats schema v14:
 * the grouped Auto Run turns-by-hour query, the run-end tasks_total clamp, and
 * the per-shortcut usage table. Runs against `node:sqlite` behind the same thin
 * better-sqlite3-shaped adapter `migrations-repair.test.ts` uses, so the SQL
 * itself (GROUP BY on a localtime hour, MAX() in an UPDATE, the composite
 * upsert key) is what is exercised, not a mock of it.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import type Database from 'better-sqlite3';

vi.mock('../../../main/utils/logger', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { runMigrations } from '../../../main/stats/migrations';
import {
	insertAutoRunSession,
	insertAutoRunTask,
	finishAutoRunSession,
	getAutoRunSessions,
	getAutoRunTurnsByHour,
	clearAutoRunCache,
} from '../../../main/stats/auto-run';
import {
	incrementShortcutUsage,
	getShortcutUsageByShortcut,
	getShortcutUsageTotal,
	clearShortcutUsageCache,
} from '../../../main/stats/shortcut-usage';

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

let db: Database.Database;

beforeEach(() => {
	// Statement caches key on the db handle; a fresh db per test needs fresh caches.
	clearAutoRunCache();
	clearShortcutUsageCache();
	db = openDb();
	runMigrations(db);
});

function startRun(overrides: { tasksTotal?: number; startTime?: number } = {}): string {
	return insertAutoRunSession(db, {
		sessionId: 'agent-1',
		agentType: 'claude-code',
		documentPath: 'TASKS.md',
		startTime: overrides.startTime ?? Date.now(),
		duration: 0,
		tasksTotal: overrides.tasksTotal,
		projectPath: '/repo',
	});
}

describe('finishAutoRunSession', () => {
	it('stores duration and completed count, keeping the start-time total when it is larger', () => {
		const id = startRun({ tasksTotal: 10 });
		expect(finishAutoRunSession(db, id, 5000, 4)).toBe(true);

		const [run] = getAutoRunSessions(db, 'all');
		expect(run).toMatchObject({ duration: 5000, tasksCompleted: 4, tasksTotal: 10 });
	});

	it('raises tasks_total to the completed count for a looping run (never over 100%)', () => {
		const id = startRun({ tasksTotal: 3 });
		finishAutoRunSession(db, id, 5000, 9);

		const [run] = getAutoRunSessions(db, 'all');
		expect(run.tasksTotal).toBe(9);
		expect(run.tasksCompleted).toBe(9);
	});

	it('takes a caller-supplied total when it is the largest figure', () => {
		const id = startRun({ tasksTotal: 3 });
		finishAutoRunSession(db, id, 5000, 4, 12);
		expect(getAutoRunSessions(db, 'all')[0].tasksTotal).toBe(12);
	});

	it('returns false for an unknown run', () => {
		expect(finishAutoRunSession(db, 'missing', 1, 1)).toBe(false);
	});
});

describe('getAutoRunTurnsByHour', () => {
	it('always returns 24 zero-filled hours', () => {
		const hours = getAutoRunTurnsByHour(db, 'week');
		expect(hours).toHaveLength(24);
		expect(hours.every((h, i) => h.hour === i && h.count === 0 && h.successCount === 0)).toBe(true);
	});

	it('groups turns by their local start hour and counts successes', () => {
		const runId = startRun();
		const today = new Date();
		const at = (hour: number) =>
			new Date(today.getFullYear(), today.getMonth(), today.getDate(), hour, 15).getTime();
		const turn = (startTime: number, success: boolean, taskIndex: number) =>
			insertAutoRunTask(db, {
				autoRunSessionId: runId,
				sessionId: 'agent-1',
				agentType: 'claude-code',
				taskIndex,
				startTime,
				duration: 1000,
				success,
			});
		turn(at(0), true, 0);
		turn(at(0), false, 1);
		turn(at(0), true, 2);

		const hours = getAutoRunTurnsByHour(db, 'day');
		expect(hours[0]).toEqual({ hour: 0, count: 3, successCount: 2 });
		expect(hours.reduce((sum, h) => sum + h.count, 0)).toBe(3);
	});

	it('leaves out turns before the range start', () => {
		const runId = startRun();
		insertAutoRunTask(db, {
			autoRunSessionId: runId,
			sessionId: 'agent-1',
			agentType: 'claude-code',
			taskIndex: 0,
			startTime: Date.now() - 40 * 86_400_000,
			duration: 1000,
			success: true,
		});
		expect(getAutoRunTurnsByHour(db, 'week').reduce((sum, h) => sum + h.count, 0)).toBe(0);
		expect(getAutoRunTurnsByHour(db, 'all').reduce((sum, h) => sum + h.count, 0)).toBe(1);
	});
});

describe('shortcut usage by shortcut id', () => {
	it('counts each firing in the daily total and, when named, under its id', () => {
		const now = Date.now();
		incrementShortcutUsage(db, now, 'toggleSidebar');
		incrementShortcutUsage(db, now, 'toggleSidebar');
		incrementShortcutUsage(db, now, 'quickActions');
		incrementShortcutUsage(db, now);

		expect(getShortcutUsageTotal(db, 'day')).toBe(4);
		expect(getShortcutUsageByShortcut(db, 'day')).toEqual([
			{ shortcutId: 'toggleSidebar', count: 2 },
			{ shortcutId: 'quickActions', count: 1 },
		]);
	});

	it('ignores a blank id and filters by range', () => {
		const old = Date.now() - 40 * 86_400_000;
		incrementShortcutUsage(db, old, 'toggleSidebar');
		incrementShortcutUsage(db, Date.now(), '   ');

		expect(getShortcutUsageByShortcut(db, 'week')).toEqual([]);
		expect(getShortcutUsageByShortcut(db, 'all')).toEqual([
			{ shortcutId: 'toggleSidebar', count: 1 },
		]);
	});
});
