/**
 * @vitest-environment node
 *
 * Real-SQL tests for stats schema v17: the playbook identity and outcome
 * columns on `auto_run_sessions`, and the `auto_run_failures` table. Runs on
 * `node:sqlite` behind the shared better-sqlite3 shim, so the CHECK
 * constraints, the COALESCE in the end UPDATE, and the migration over an
 * existing v16 file are what is exercised, not a mock of them.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';

vi.mock('../../../main/utils/logger', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { runMigrations, getCurrentVersion } from '../../../main/stats/migrations';
import {
	insertAutoRunSession,
	finishAutoRunSession,
	getAutoRunSessions,
	getAutoRunFailures,
	clearAutoRunCache,
} from '../../../main/stats/auto-run';
import { ADD_AUTO_RUN_SESSION_PLAYBOOK_COLUMNS } from '../../../main/stats/schema';
import { STATS_DB_VERSION, type AutoRunSession } from '../../../shared/stats-types';
import { bindAutoRunFailure } from '../../../shared/maestro-lib/stats/auto-run-insert';
import { canLoadNodeSqlite, openNodeSqliteDb } from '../../helpers/nodeSqlite';

function columnNames(db: Database.Database, table: string): string[] {
	return (db.pragma(`table_info(${table})`) as Array<{ name: string }>).map((row) => row.name);
}

function startRun(db: Database.Database, overrides: Partial<AutoRunSession> = {}): string {
	return insertAutoRunSession(db, {
		sessionId: 'agent-1',
		agentType: 'claude-code',
		documentPath: 'TASKS.md',
		startTime: Date.now(),
		duration: 0,
		tasksTotal: 3,
		projectPath: '/repo',
		...overrides,
	});
}

describe.skipIf(!canLoadNodeSqlite())('stats v17: playbook identity on auto_run_sessions', () => {
	let db: Database.Database;

	beforeEach(() => {
		clearAutoRunCache();
		db = openNodeSqliteDb<Database.Database>();
		runMigrations(db);
	});

	describe('migration', () => {
		it('adds every identity column and the failures table, and stamps v17', () => {
			const columns = columnNames(db, 'auto_run_sessions');
			for (const [column] of ADD_AUTO_RUN_SESSION_PLAYBOOK_COLUMNS) {
				expect(columns).toContain(column);
			}
			expect(columnNames(db, 'auto_run_failures')).toEqual([
				'id',
				'auto_run_session_id',
				'document_filename',
				'task_index',
				'kind',
				'agent_type',
				'created_at',
			]);
			expect(STATS_DB_VERSION).toBe(17);
			expect(getCurrentVersion(db)).toBe(17);
		});

		it('keeps a run recorded before v17 and reads it with no playbook and zero stalls', () => {
			const legacy = openNodeSqliteDb<Database.Database>();
			runMigrations(legacy);
			// Rebuild the v16 shape: drop what v17 added, then stamp v16.
			legacy.exec('DROP TABLE auto_run_failures');
			for (const [column] of ADD_AUTO_RUN_SESSION_PLAYBOOK_COLUMNS) {
				legacy.exec(`ALTER TABLE auto_run_sessions DROP COLUMN ${column}`);
			}
			legacy.exec(
				"INSERT INTO auto_run_sessions (id, session_id, agent_type, document_path, start_time, duration, tasks_total, tasks_completed, project_path, kind) VALUES ('old', 'agent-1', 'codex', 'A.md', 1, 500, 2, 2, '/repo', 'spec-driven')"
			);
			legacy.pragma('user_version = 16');

			runMigrations(legacy);

			expect(getCurrentVersion(legacy)).toBe(17);
			const [row] = getAutoRunSessions(legacy, 'all');
			expect(row).toMatchObject({ id: 'old', duration: 500, tasksCompleted: 2 });
			expect(row.playbookId).toBeUndefined();
			expect(row.playbookLocalId).toBeUndefined();
			expect(row.launchSource).toBeUndefined();
			expect(row.status).toBeUndefined();
			expect(row.documentsStalled).toBe(0);
		});

		it('is safe to repeat when a previous attempt added only some of the columns', () => {
			const partial = openNodeSqliteDb<Database.Database>();
			runMigrations(partial);
			partial.exec('DROP TABLE auto_run_failures');
			partial.exec('ALTER TABLE auto_run_sessions DROP COLUMN status');
			partial.exec('ALTER TABLE auto_run_sessions DROP COLUMN documents_stalled');
			partial.pragma('user_version = 16');

			expect(() => runMigrations(partial)).not.toThrow();
			expect(columnNames(partial, 'auto_run_sessions')).toEqual(
				expect.arrayContaining(['status', 'documents_stalled', 'playbook_id'])
			);
			expect(columnNames(partial, 'auto_run_failures')).toContain('kind');
		});

		it('refuses a launch source or status outside the CHECK lists', () => {
			const id = startRun(db);
			expect(() =>
				db.prepare("UPDATE auto_run_sessions SET launch_source = 'mobile' WHERE id = ?").run(id)
			).toThrow();
			expect(() =>
				db.prepare("UPDATE auto_run_sessions SET status = 'halted' WHERE id = ?").run(id)
			).toThrow();
		});
	});

	describe('insertAutoRunSession', () => {
		it('stores the playbook identity and launch source', () => {
			startRun(db, {
				playbookId: 'message-bus',
				playbookLocalId: 'local-uuid-1',
				playbookVersion: '2026-08-30',
				launchSource: 'panel',
			});

			const [row] = getAutoRunSessions(db, 'all');
			expect(row).toMatchObject({
				playbookId: 'message-bus',
				playbookLocalId: 'local-uuid-1',
				playbookVersion: '2026-08-30',
				launchSource: 'panel',
				documentsStalled: 0,
			});
			expect(row.status).toBeUndefined();
		});

		it('stores an ad-hoc run with no playbook as NULLs', () => {
			startRun(db);
			const raw = db
				.prepare('SELECT playbook_id, playbook_local_id, launch_source FROM auto_run_sessions')
				.get() as Record<string, unknown>;
			expect(raw).toEqual({ playbook_id: null, playbook_local_id: null, launch_source: null });
		});

		it('stores a launch source this build does not know as NULL rather than throwing', () => {
			startRun(db, { launchSource: 'mobile' as AutoRunSession['launchSource'] });
			const [row] = getAutoRunSessions(db, 'all');
			expect(row.launchSource).toBeUndefined();
		});
	});

	describe('finishAutoRunSession with an outcome', () => {
		it('records the status, the stalled count, and one row per failure', () => {
			const id = startRun(db);

			expect(
				finishAutoRunSession(db, id, 9000, 2, 3, {
					status: 'completed',
					documentsStalled: 1,
					failures: [
						{
							kind: 'stall',
							documentFilename: 'B.md',
							taskIndex: 1,
							agentType: 'claude-code',
							createdAt: 200,
						},
						{
							kind: 'error',
							documentFilename: 'A.md',
							taskIndex: 0,
							agentType: 'claude-code',
							createdAt: 100,
						},
					],
				})
			).toBe(true);

			const [row] = getAutoRunSessions(db, 'all');
			expect(row).toMatchObject({ duration: 9000, status: 'completed', documentsStalled: 1 });
			const failures = getAutoRunFailures(db, id);
			expect(failures.map((f) => [f.kind, f.documentFilename, f.taskIndex])).toEqual([
				['error', 'A.md', 0],
				['stall', 'B.md', 1],
			]);
			expect(failures.every((f) => f.autoRunSessionId === id)).toBe(true);
		});

		it('keeps the stored status when the outcome leaves it out', () => {
			const id = startRun(db);
			finishAutoRunSession(db, id, 1000, 1, undefined, { status: 'stopped' });
			finishAutoRunSession(db, id, 2000, 1);

			const [row] = getAutoRunSessions(db, 'all');
			expect(row).toMatchObject({ duration: 2000, status: 'stopped' });
		});

		it('drops an unknown status and an unknown failure kind instead of failing the end', () => {
			const id = startRun(db);
			expect(
				finishAutoRunSession(db, id, 1000, 0, undefined, {
					status: 'halted' as never,
					documentsStalled: -1,
					failures: [
						{ kind: 'timeout' as never, agentType: 'codex', createdAt: 1 },
						{ kind: 'halt', documentFilename: 'C.md', agentType: 'codex', createdAt: 2 },
					],
				})
			).toBe(true);

			const [row] = getAutoRunSessions(db, 'all');
			expect(row.status).toBeUndefined();
			expect(row.documentsStalled).toBe(0);
			expect(getAutoRunFailures(db, id).map((f) => f.kind)).toEqual(['halt']);
		});

		it('writes no failures for a run that does not exist', () => {
			expect(
				finishAutoRunSession(db, 'missing', 1, 0, undefined, {
					status: 'failed',
					failures: [{ kind: 'halt', agentType: 'codex', createdAt: 1 }],
				})
			).toBe(false);
			expect(
				(db.prepare('SELECT COUNT(*) AS n FROM auto_run_failures').get() as { n: number }).n
			).toBe(0);
		});
	});
});

describe('bindAutoRunFailure', () => {
	it('binds a known failure and nulls a missing document or a non-integer task index', () => {
		expect(
			bindAutoRunFailure('f1', {
				autoRunSessionId: 'run-1',
				kind: 'stall',
				taskIndex: 1.5,
				agentType: 'codex',
				createdAt: 42,
			})
		).toEqual(['f1', 'run-1', null, null, 'stall', 'codex', 42]);
	});

	it('refuses a kind outside the CHECK list', () => {
		expect(
			bindAutoRunFailure('f1', {
				autoRunSessionId: 'run-1',
				kind: 'crash' as never,
				agentType: 'codex',
				createdAt: 42,
			})
		).toBeNull();
	});
});
