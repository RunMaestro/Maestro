/**
 * @file stats-db.integration.test.ts
 * @description Integration coverage for StatsDB lifecycle behavior with real temp files.
 *
 * The native better-sqlite3 module in this repo is built for Electron's Node ABI,
 * so Vitest cannot load it directly in this runtime. These tests mock only that
 * native driver boundary while exercising StatsDB against real filesystem state.
 */

import * as fs from 'fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import path from 'path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let tempRoot: string;
let currentVersion = 0;
let integrityResult: Array<{ integrity_check: string }> = [{ integrity_check: 'ok' }];
let integrityResultQueue: Array<Array<{ integrity_check: string }>> = [];
let metaLastVacuumValue: string | undefined = '0';
let throwOnPragmaSql: string | null = null;
let throwOnPragmaValue: unknown;
let throwOnGetSql: string | null = null;
let throwOnRunSql: string | null = null;
let throwOnRunValue: unknown;
let throwOnAllSql: string | null = null;
let earliestQuery: number | null = 300;
let earliestAutoRun: number | null = 200;
let earliestLifecycle: number | null = 400;
let throwOnOpen:
	((dbPath: string, options: Record<string, unknown> | undefined) => Error | null) | null = null;
let throwOnClose = false;
const preparedSql: string[] = [];
const pragmaSql: string[] = [];
const statementRuns: Array<{ sql: string; args: unknown[] }> = [];
const databaseOpens: Array<{ dbPath: string; options: Record<string, unknown> | undefined }> = [];
const databaseClose = vi.fn();
const renameSyncFailures: unknown[] = [];
const unlinkSyncFailures: unknown[] = [];
const copyFileSyncFailures: unknown[] = [];

function createStatement(sql: string) {
	return {
		run: vi.fn((...args: unknown[]) => {
			statementRuns.push({ sql, args });
			if (throwOnRunSql && sql.includes(throwOnRunSql)) {
				throw throwOnRunValue ?? new Error(`run failed for ${throwOnRunSql}`);
			}
			if (sql.includes('DELETE FROM auto_run_tasks')) return { changes: 2 };
			if (sql.includes('DELETE FROM auto_run_sessions')) return { changes: 3 };
			if (sql.includes('DELETE FROM query_events')) return { changes: 4 };
			if (sql.includes('DELETE FROM session_lifecycle')) return { changes: 5 };
			return { changes: 1 };
		}),
		get: vi.fn(() => {
			if (throwOnGetSql && sql.includes(throwOnGetSql)) {
				throw new Error(`get failed for ${throwOnGetSql}`);
			}
			if (sql.includes("SELECT value FROM _meta WHERE key = 'last_vacuum_at'")) {
				return metaLastVacuumValue === undefined ? undefined : { value: metaLastVacuumValue };
			}
			if (sql.includes('sqlite_master') && sql.includes('_migrations')) {
				return { name: '_migrations' };
			}
			if (sql.includes('SELECT created_at FROM session_lifecycle WHERE session_id = ?')) {
				return { created_at: 1000 };
			}
			if (sql.includes('COUNT(DISTINCT session_id)')) {
				return { count: 3 };
			}
			if (sql.includes('COALESCE(AVG(duration), 0)')) {
				return { avg_duration: 1200 };
			}
			if (sql.includes('COUNT(*) as count') && sql.includes('COALESCE(SUM(duration), 0)')) {
				return { count: 2, total_duration: 3000 };
			}
			if (sql.includes('MIN(start_time)') && sql.includes('query_events')) {
				return { earliest: earliestQuery };
			}
			if (sql.includes('MIN(start_time)') && sql.includes('auto_run_sessions')) {
				return { earliest: earliestAutoRun };
			}
			if (sql.includes('MIN(created_at)') && sql.includes('session_lifecycle')) {
				return { earliest: earliestLifecycle };
			}
			return undefined;
		}),
		all: vi.fn(() => {
			if (throwOnAllSql && sql.includes(throwOnAllSql)) {
				throw new Error(`all failed for ${throwOnAllSql}`);
			}
			if (sql.includes('FROM _migrations')) {
				return [
					{
						version: 1,
						description: 'Initial schema',
						applied_at: 1778493600000,
						status: 'success',
						error_message: null,
					},
				];
			}
			if (sql.includes('SELECT * FROM query_events')) {
				return [
					{
						id: 'query-1',
						session_id: 'session-1',
						agent_type: 'claude',
						source: 'user',
						start_time: 1000,
						duration: 150,
						project_path: '/tmp/project',
						tab_id: 'tab-1',
						is_remote: 1,
					},
				];
			}
			if (sql.includes('SELECT * FROM auto_run_sessions')) {
				return [
					{
						id: 'auto-run-1',
						session_id: 'session-1',
						agent_type: 'claude',
						document_path: '/tmp/doc.md',
						start_time: 1000,
						duration: 200,
						tasks_total: 2,
						tasks_completed: 1,
						project_path: '/tmp/project',
					},
				];
			}
			if (sql.includes('SELECT * FROM auto_run_tasks')) {
				return [
					{
						id: 'task-1',
						auto_run_session_id: 'auto-run-1',
						session_id: 'session-1',
						agent_type: 'claude',
						task_index: 0,
						task_content: 'Run task',
						start_time: 1000,
						duration: 50,
						success: 1,
					},
				];
			}
			if (sql.includes('SELECT * FROM session_lifecycle')) {
				return [
					{
						id: 'lifecycle-1',
						session_id: 'session-1',
						agent_type: 'claude',
						project_path: '/tmp/project',
						created_at: 1000,
						closed_at: 2000,
						duration: 1000,
						is_remote: 0,
					},
				];
			}
			if (sql.includes('GROUP BY agent_type, date')) {
				return [{ agent_type: 'claude', date: '2026-05-26', count: 2, duration: 3000 }];
			}
			if (sql.includes('GROUP BY session_id, date')) {
				return [{ session_id: 'session-1', date: '2026-05-26', count: 2, duration: 3000 }];
			}
			if (sql.includes('FROM query_events') && sql.includes('GROUP BY agent_type')) {
				return [{ agent_type: 'claude', count: 2, duration: 3000 }];
			}
			if (sql.includes('GROUP BY source')) {
				return [
					{ source: 'user', count: 1 },
					{ source: 'auto', count: 1 },
				];
			}
			if (sql.includes('GROUP BY is_remote')) {
				return [
					{ is_remote: 1, count: 1 },
					{ is_remote: 0, count: 1 },
				];
			}
			if (sql.includes('GROUP BY date(start_time')) {
				return [{ date: '2026-05-26', count: 2, duration: 3000 }];
			}
			if (sql.includes('GROUP BY hour')) {
				return [{ hour: 10, count: 2, duration: 3000 }];
			}
			if (sql.includes('FROM session_lifecycle') && sql.includes('GROUP BY agent_type')) {
				return [{ agent_type: 'claude', count: 1 }];
			}
			if (sql.includes('GROUP BY date(created_at')) {
				return [{ date: '2026-05-26', count: 1 }];
			}
			return [];
		}),
	};
}

async function resetStatsModules() {
	tempRoot = await mkdtemp(path.join(tmpdir(), 'maestro-stats-db-integration-'));
	currentVersion = 0;
	integrityResult = [{ integrity_check: 'ok' }];
	integrityResultQueue = [];
	metaLastVacuumValue = '0';
	throwOnPragmaSql = null;
	throwOnPragmaValue = undefined;
	throwOnGetSql = null;
	throwOnRunSql = null;
	throwOnRunValue = undefined;
	throwOnAllSql = null;
	earliestQuery = 300;
	earliestAutoRun = 200;
	earliestLifecycle = 400;
	throwOnOpen = null;
	throwOnClose = false;
	preparedSql.length = 0;
	pragmaSql.length = 0;
	statementRuns.length = 0;
	databaseOpens.length = 0;
	renameSyncFailures.length = 0;
	unlinkSyncFailures.length = 0;
	copyFileSyncFailures.length = 0;
	databaseClose.mockReset();

	vi.resetModules();
	vi.doMock('fs', () => {
		const nodeFs = fs;
		return {
			...nodeFs,
			default: nodeFs,
			existsSync: nodeFs.existsSync,
			mkdirSync: nodeFs.mkdirSync,
			readdirSync: nodeFs.readdirSync,
			statSync: nodeFs.statSync,
			renameSync: (...args: Parameters<typeof fs.renameSync>) => {
				const error = renameSyncFailures.shift();
				if (error !== undefined) throw error;
				return nodeFs.renameSync(...args);
			},
			unlinkSync: (...args: Parameters<typeof fs.unlinkSync>) => {
				const error = unlinkSyncFailures.shift();
				if (error !== undefined) throw error;
				return nodeFs.unlinkSync(...args);
			},
			copyFileSync: (...args: Parameters<typeof fs.copyFileSync>) => {
				const error = copyFileSyncFailures.shift();
				if (error !== undefined) throw error;
				return nodeFs.copyFileSync(...args);
			},
		};
	});
	vi.doMock('electron', () => ({
		app: {
			getPath: vi.fn((name: string) => (name === 'userData' ? tempRoot : tmpdir())),
		},
	}));
	vi.doMock('../../main/utils/logger', () => ({
		logger: {
			debug: vi.fn(),
			error: vi.fn(),
			info: vi.fn(),
			warn: vi.fn(),
		},
	}));
	vi.doMock('better-sqlite3', () => ({
		default: class MockDatabase {
			constructor(dbPath: string, options?: Record<string, unknown>) {
				const error = throwOnOpen?.(dbPath, options);
				if (error) throw error;
				databaseOpens.push({ dbPath, options });
			}

			pragma(sql: string) {
				pragmaSql.push(sql);
				if (throwOnPragmaSql && sql.includes(throwOnPragmaSql)) {
					throw throwOnPragmaValue ?? new Error(`pragma failed for ${throwOnPragmaSql}`);
				}
				if (sql === 'user_version') {
					return [{ user_version: currentVersion }];
				}
				if (sql.startsWith('user_version = ')) {
					currentVersion = Number(sql.replace('user_version = ', ''));
					return [];
				}
				if (sql === 'integrity_check') {
					return integrityResultQueue.shift() ?? integrityResult;
				}
				return [];
			}

			prepare(sql: string) {
				preparedSql.push(sql);
				return createStatement(sql);
			}

			transaction(fn: () => void) {
				return () => fn();
			}

			close() {
				databaseClose();
				if (throwOnClose) throw new Error('close failed');
			}
		},
	}));
}

describe('StatsDB integration', () => {
	beforeEach(async () => {
		await resetStatsModules();
	});

	afterEach(async () => {
		vi.doUnmock('fs');
		vi.doUnmock('electron');
		vi.doUnmock('../../main/utils/logger');
		vi.doUnmock('better-sqlite3');
		vi.resetModules();
		await rm(tempRoot, { recursive: true, force: true });
	});

	it('initializes, migrates, vacuums, backs up, restores, and reports timestamps', async () => {
		const dbPath = path.join(tempRoot, 'stats.db');
		await writeFile(dbPath, 'seed stats data', 'utf-8');
		await writeFile(`${dbPath}-wal`, 'stale wal', 'utf-8');
		await writeFile(`${dbPath}-shm`, 'stale shm', 'utf-8');
		await writeFile(`${dbPath}.daily.2020-01-01`, 'old backup', 'utf-8');
		await writeFile(
			`${dbPath}.backup.${Date.parse('2025-01-01T00:00:00.000Z')}`,
			'legacy',
			'utf-8'
		);
		const { StatsDB } = await import('../../main/stats/stats-db');
		const statsDb = new StatsDB();

		expect(() => statsDb.database).toThrow('Database not initialized');
		expect(statsDb.clearOldData(30)).toMatchObject({
			success: false,
			error: 'Database not initialized',
		});

		statsDb.initialize();

		expect(statsDb.isReady()).toBe(true);
		expect(statsDb.getDbPath()).toBe(dbPath);
		const targetVersion = statsDb.getTargetVersion();
		expect(statsDb.getCurrentVersion()).toBe(targetVersion);
		expect(targetVersion).toBeGreaterThan(0);
		expect(statsDb.hasPendingMigrations()).toBe(false);
		expect(statsDb.checkIntegrity()).toEqual({ ok: true, errors: [] });
		expect(statsDb.getMigrationHistory()).toEqual([
			expect.objectContaining({
				version: 1,
				description: 'Initial schema',
				status: 'success',
			}),
		]);
		expect(statsDb.getEarliestTimestamp()).toBe(200);

		const vacuumResult = statsDb.vacuumIfNeeded(1);
		expect(vacuumResult).toMatchObject({
			vacuumed: true,
			result: { success: true },
		});
		expect(preparedSql.some((sql) => sql.includes('VACUUM'))).toBe(true);

		const backupResult = statsDb.backupDatabase();
		expect(backupResult.success).toBe(true);
		expect(statsDb.getAvailableBackups().length).toBeGreaterThanOrEqual(2);
		expect(statsDb.restoreFromBackup(backupResult.backupPath!)).toBe(true);
		expect(statsDb.isReady()).toBe(false);
		expect(pragmaSql).toContain('journal_mode = WAL');
		expect(pragmaSql).toContain('wal_checkpoint(TRUNCATE)');
	});

	it('handles fresh initialization, skipped weekly vacuum, and close cleanup', async () => {
		metaLastVacuumValue = String(Date.now());

		const { StatsDB } = await import('../../main/stats/stats-db');
		const statsDb = new StatsDB();

		expect(statsDb.vacuum()).toEqual({
			success: false,
			bytesFreed: 0,
			error: 'Database not initialized',
		});
		expect(statsDb.checkIntegrity()).toEqual({
			ok: false,
			errors: ['Database not initialized'],
		});
		expect(statsDb.getDatabaseSize()).toBe(0);

		statsDb.initialize();
		statsDb.initialize();

		expect(statsDb.isReady()).toBe(true);
		expect(databaseOpens.filter((call) => call.dbPath.endsWith('stats.db'))).toHaveLength(1);
		expect(preparedSql.some((sql) => sql.includes('last_vacuum_at'))).toBe(true);
		expect(preparedSql.some((sql) => sql.includes('VACUUM'))).toBe(false);

		statsDb.close();
		statsDb.close();

		expect(databaseClose).toHaveBeenCalledTimes(1);
		expect(statsDb.isReady()).toBe(false);
	});

	it('delegates CRUD, aggregation, cleanup, and export operations through the initialized database', async () => {
		metaLastVacuumValue = String(Date.now());
		await writeFile(path.join(tempRoot, 'stats.db'), 'seed stats data', 'utf-8');

		const { StatsDB } = await import('../../main/stats/stats-db');
		const statsDb = new StatsDB();
		statsDb.initialize();

		const queryId = statsDb.insertQueryEvent({
			sessionId: 'session-1',
			agentType: 'claude',
			source: 'user',
			startTime: 1000,
			duration: 150,
			projectPath: 'C:\\repo',
			tabId: 'tab-1',
			isRemote: true,
		});
		expect(queryId).toMatch(/^\d+-/);
		expect(
			statsDb.getQueryEvents('all', {
				agentType: 'claude',
				source: 'user',
				projectPath: 'C:\\repo',
				sessionId: 'session-1',
			})
		).toEqual([expect.objectContaining({ id: 'query-1', isRemote: true })]);

		const autoRunId = statsDb.insertAutoRunSession({
			sessionId: 'session-1',
			agentType: 'claude',
			documentPath: 'C:\\repo\\doc.md',
			startTime: 1000,
			duration: 200,
			tasksTotal: 2,
			tasksCompleted: 1,
			projectPath: 'C:\\repo',
		});
		expect(autoRunId).toMatch(/^\d+-/);
		expect(
			statsDb.updateAutoRunSession(autoRunId, {
				duration: 250,
				tasksTotal: null,
				tasksCompleted: 2,
				documentPath: 'C:\\repo\\done.md',
			})
		).toBe(true);
		expect(statsDb.updateAutoRunSession(autoRunId, {})).toBe(false);
		expect(statsDb.getAutoRunSessions('all')).toEqual([
			expect.objectContaining({ id: 'auto-run-1', tasksCompleted: 1 }),
		]);

		const taskId = statsDb.insertAutoRunTask({
			autoRunSessionId: 'auto-run-1',
			sessionId: 'session-1',
			agentType: 'claude',
			taskIndex: 0,
			taskContent: 'Run task',
			startTime: 1000,
			duration: 50,
			success: true,
		});
		expect(taskId).toMatch(/^\d+-/);
		expect(statsDb.getAutoRunTasks('auto-run-1')).toEqual([
			expect.objectContaining({ id: 'task-1', success: true }),
		]);

		const lifecycleId = statsDb.recordSessionCreated({
			sessionId: 'session-1',
			agentType: 'claude',
			projectPath: 'C:\\repo',
			createdAt: 1000,
			isRemote: false,
		});
		expect(lifecycleId).toMatch(/^\d+-/);
		expect(statsDb.recordSessionClosed('session-1', 2000)).toBe(true);
		expect(statsDb.getSessionLifecycleEvents('all')).toEqual([
			expect.objectContaining({ id: 'lifecycle-1', isRemote: false }),
		]);

		expect(statsDb.getAggregatedStats('all')).toMatchObject({
			totalQueries: 2,
			totalDuration: 3000,
			byAgent: { claude: { count: 2, duration: 3000 } },
			bySource: { user: 1, auto: 1 },
			byLocation: { local: 1, remote: 1 },
			totalSessions: 3,
		});
		expect(statsDb.clearOldData(1)).toMatchObject({
			success: true,
			deletedQueryEvents: 4,
			deletedAutoRunSessions: 3,
			deletedAutoRunTasks: 2,
			deletedSessionLifecycle: 5,
		});
		expect(statsDb.exportToCsv('all')).toContain('"query-1"');
	});

	it('reports integrity, backup, restore, and timestamp edge cases', async () => {
		const dbPath = path.join(tempRoot, 'stats.db');
		const { StatsDB } = await import('../../main/stats/stats-db');

		const missingStatsDb = new StatsDB();
		expect(missingStatsDb.backupDatabase()).toEqual({
			success: false,
			error: 'Database file does not exist',
		});

		await mkdir(dbPath);
		expect(missingStatsDb.backupDatabase()).toMatchObject({ success: false });
		await rm(dbPath, { recursive: true, force: true });

		await writeFile(dbPath, 'current', 'utf-8');
		const statsDb = new StatsDB();
		statsDb.initialize();

		integrityResult = [{ integrity_check: 'malformed page' }];
		expect(statsDb.checkIntegrity()).toEqual({
			ok: false,
			errors: ['malformed page'],
		});

		throwOnPragmaSql = 'integrity_check';
		expect(statsDb.checkIntegrity()).toEqual({
			ok: false,
			errors: ['pragma failed for integrity_check'],
		});
		throwOnPragmaValue = 'pragma failed as string';
		expect(statsDb.checkIntegrity()).toEqual({
			ok: false,
			errors: ['pragma failed as string'],
		});
		throwOnPragmaSql = null;
		throwOnPragmaValue = undefined;

		expect(statsDb.restoreFromBackup(path.join(tempRoot, 'missing-backup.db'))).toBe(false);

		const backupPath = path.join(tempRoot, 'valid-backup.db');
		await writeFile(backupPath, 'backup', 'utf-8');
		await writeFile(`${dbPath}-wal`, 'restore wal', 'utf-8');
		await writeFile(`${dbPath}-shm`, 'restore shm', 'utf-8');
		throwOnClose = true;
		expect(statsDb.restoreFromBackup(backupPath)).toBe(true);
		throwOnClose = false;
		expect(await readFile(dbPath, 'utf-8')).toBe('backup');

		const directoryBackup = path.join(tempRoot, 'backup-directory');
		await mkdir(directoryBackup);
		expect(statsDb.restoreFromBackup(directoryBackup)).toBe(false);

		await writeFile(dbPath, 'copy failure source', 'utf-8');
		copyFileSyncFailures.push('copy failed as string');
		expect(statsDb.backupDatabase()).toEqual({
			success: false,
			error: 'copy failed as string',
		});

		const inaccessibleStatsDb = new StatsDB();
		(inaccessibleStatsDb as unknown as { dbPath: string }).dbPath = path.join(
			tempRoot,
			'missing',
			'stats.db'
		);
		expect(inaccessibleStatsDb.getAvailableBackups()).toEqual([]);

		throwOnGetSql = 'MIN(start_time)';
		expect(statsDb.getEarliestTimestamp()).toBeNull();
		throwOnGetSql = null;

		await writeFile(dbPath, 'timestamp source', 'utf-8');
		const timestampStatsDb = new StatsDB();
		timestampStatsDb.initialize();
		expect(timestampStatsDb.getEarliestTimestamp()).toBe(200);
	});

	it('covers maintenance branches for directories, vacuum scheduling, and daily backups', async () => {
		const { StatsDB } = await import('../../main/stats/stats-db');
		const nestedPath = path.join(tempRoot, 'nested', 'stats.db');
		const nestedStatsDb = new StatsDB();
		(nestedStatsDb as unknown as { dbPath: string }).dbPath = nestedPath;
		metaLastVacuumValue = String(Date.now());

		nestedStatsDb.initialize();
		expect(fs.existsSync(path.dirname(nestedPath))).toBe(true);
		nestedStatsDb.close();

		const dbPath = path.join(tempRoot, 'stats.db');
		await writeFile(dbPath, 'large enough by override', 'utf-8');
		metaLastVacuumValue = '0';
		class LargeStatsDB extends StatsDB {
			override getDatabaseSize(): number {
				return 101 * 1024 * 1024;
			}
		}
		const largeStatsDb = new LargeStatsDB();
		largeStatsDb.initialize();
		expect(statementRuns.some((call) => call.sql.includes('last_vacuum_at'))).toBe(true);
		expect(preparedSql.some((sql) => sql.includes('VACUUM'))).toBe(true);
		largeStatsDb.close();

		metaLastVacuumValue = String(Date.now());
		const vacuumErrorDb = new StatsDB();
		vacuumErrorDb.initialize();
		throwOnRunSql = 'VACUUM';
		expect(vacuumErrorDb.vacuum()).toMatchObject({
			success: false,
			error: 'run failed for VACUUM',
		});
		throwOnRunValue = 'vacuum failed as string';
		expect(vacuumErrorDb.vacuum()).toMatchObject({
			success: false,
			error: 'vacuum failed as string',
		});
		throwOnRunSql = null;
		throwOnRunValue = undefined;
		vacuumErrorDb.close();

		throwOnGetSql = 'last_vacuum_at';
		const scheduleErrorDb = new StatsDB();
		scheduleErrorDb.initialize();
		throwOnGetSql = null;
		scheduleErrorDb.close();

		metaLastVacuumValue = undefined;
		const missingVacuumRowDb = new StatsDB();
		missingVacuumRowDb.initialize();
		missingVacuumRowDb.close();

		const today = new Date().toISOString().split('T')[0];
		await writeFile(dbPath, 'daily source', 'utf-8');
		await writeFile(`${dbPath}.daily.${today}`, 'already backed up', 'utf-8');
		const existingDailyDb = new StatsDB();
		existingDailyDb.initialize();
		existingDailyDb.close();

		await rm(`${dbPath}.daily.${today}`, { force: true });
		throwOnPragmaSql = 'wal_checkpoint';
		const dailyFailureDb = new StatsDB();
		dailyFailureDb.initialize();
		throwOnPragmaSql = null;
		dailyFailureDb.close();

		await mkdir(`${dbPath}.daily.2020-01-01`);
		const rotateFailureDb = new StatsDB();
		rotateFailureDb.initialize();
		rotateFailureDb.close();

		earliestQuery = null;
		earliestAutoRun = null;
		earliestLifecycle = null;
		const emptyTimestampDb = new StatsDB();
		emptyTimestampDb.initialize();
		expect(emptyTimestampDb.getEarliestTimestamp()).toBeNull();
	});

	it('covers corruption helper fallback branches', async () => {
		const { StatsDB } = await import('../../main/stats/stats-db');
		type RecoverableStatsDB = StatsDB & {
			dbPath: string;
			recoverFromCorruption: () => {
				recovered: boolean;
				restoredFromBackup?: boolean;
				error?: string;
			};
			removeStaleWalFiles: (dbFilePath: string) => void;
			openWithCorruptionHandling: () => unknown;
		};

		const missingPath = path.join(tempRoot, 'no-existing-db', 'stats.db');
		await mkdir(path.dirname(missingPath));
		const noExistingDb = new StatsDB() as RecoverableStatsDB;
		noExistingDb.dbPath = missingPath;
		expect(noExistingDb.recoverFromCorruption()).toMatchObject({
			recovered: true,
			restoredFromBackup: false,
		});

		const sidecarPath = path.join(tempRoot, 'sidecar', 'stats.db');
		await mkdir(path.dirname(sidecarPath));
		await writeFile(sidecarPath, 'corrupt', 'utf-8');
		await writeFile(`${sidecarPath}-wal`, 'wal', 'utf-8');
		await writeFile(`${sidecarPath}-shm`, 'shm', 'utf-8');
		const sidecarDb = new StatsDB() as RecoverableStatsDB;
		sidecarDb.dbPath = sidecarPath;
		expect(sidecarDb.recoverFromCorruption()).toMatchObject({ recovered: true });
		expect(fs.existsSync(`${sidecarPath}-wal`)).toBe(false);
		expect(fs.existsSync(`${sidecarPath}-shm`)).toBe(false);

		const renameFallbackPath = path.join(tempRoot, 'rename-fallback', 'stats.db');
		await mkdir(path.dirname(renameFallbackPath));
		await writeFile(renameFallbackPath, 'corrupt', 'utf-8');
		const renameFallbackDb = new StatsDB() as RecoverableStatsDB;
		renameFallbackDb.dbPath = renameFallbackPath;
		renameSyncFailures.push(new Error('rename failed'));
		expect(renameFallbackDb.recoverFromCorruption()).toMatchObject({ recovered: true });

		const outerCatchPath = path.join(tempRoot, 'outer-catch', 'stats.db');
		await mkdir(path.dirname(outerCatchPath));
		await writeFile(outerCatchPath, 'corrupt', 'utf-8');
		const outerCatchDb = new StatsDB() as RecoverableStatsDB;
		outerCatchDb.dbPath = outerCatchPath;
		renameSyncFailures.push(new Error('rename failed'));
		unlinkSyncFailures.push(new Error('unlink failed'));
		expect(outerCatchDb.recoverFromCorruption()).toMatchObject({
			recovered: false,
			error: 'unlink failed',
		});

		const outerStringCatchPath = path.join(tempRoot, 'outer-string-catch', 'stats.db');
		await mkdir(path.dirname(outerStringCatchPath));
		await writeFile(outerStringCatchPath, 'corrupt', 'utf-8');
		const outerStringCatchDb = new StatsDB() as RecoverableStatsDB;
		outerStringCatchDb.dbPath = outerStringCatchPath;
		renameSyncFailures.push(new Error('rename failed'));
		unlinkSyncFailures.push('unlink failed as string');
		expect(outerStringCatchDb.recoverFromCorruption()).toMatchObject({
			recovered: false,
			error: 'unlink failed as string',
		});

		const staleWalPath = path.join(tempRoot, 'stale-wal', 'stats.db');
		await mkdir(path.dirname(staleWalPath));
		await writeFile(`${staleWalPath}-wal`, 'wal', 'utf-8');
		const staleWalDb = new StatsDB() as RecoverableStatsDB;
		unlinkSyncFailures.push(new Error('stale unlink failed'));
		staleWalDb.removeStaleWalFiles(staleWalPath);

		const restoreFalsePath = path.join(tempRoot, 'restore-false', 'stats.db');
		await mkdir(path.dirname(restoreFalsePath));
		await writeFile(restoreFalsePath, 'corrupt', 'utf-8');
		await mkdir(`${restoreFalsePath}.daily.2026-05-25`);
		const restoreFalseDb = new StatsDB() as RecoverableStatsDB;
		restoreFalseDb.dbPath = restoreFalsePath;
		expect(restoreFalseDb.recoverFromCorruption()).toMatchObject({
			recovered: true,
			restoredFromBackup: false,
		});

		const recoveryFailedPath = path.join(tempRoot, 'recovery-failed', 'stats.db');
		await mkdir(path.dirname(recoveryFailedPath));
		await writeFile(recoveryFailedPath, 'corrupt', 'utf-8');
		integrityResultQueue = [[{ integrity_check: 'bad' }]];
		const recoveryFailedDb = new StatsDB() as RecoverableStatsDB;
		recoveryFailedDb.dbPath = recoveryFailedPath;
		recoveryFailedDb.recoverFromCorruption = () => ({ recovered: false, error: 'recovery failed' });
		expect(recoveryFailedDb.openWithCorruptionHandling()).toBeTruthy();
	});

	it('recovers a corrupted database from the newest valid backup', async () => {
		const dbPath = path.join(tempRoot, 'stats.db');
		const backupPath = `${dbPath}.daily.2026-05-25`;
		await writeFile(dbPath, 'corrupt', 'utf-8');
		await writeFile(`${dbPath}-wal`, 'wal', 'utf-8');
		await writeFile(`${dbPath}-shm`, 'shm', 'utf-8');
		await writeFile(backupPath, 'backup', 'utf-8');
		integrityResultQueue = [
			[{ integrity_check: 'database disk image is malformed' }],
			[{ integrity_check: 'ok' }],
		];

		const { StatsDB } = await import('../../main/stats/stats-db');
		const statsDb = new StatsDB();
		statsDb.initialize();

		expect(statsDb.isReady()).toBe(true);
		expect(await readFile(dbPath, 'utf-8')).toBe('backup');
		expect(databaseOpens.some((call) => call.options?.readonly === true)).toBe(true);
	});

	it('falls back to a fresh database when corrupted backups fail validation', async () => {
		const dbPath = path.join(tempRoot, 'stats.db');
		await writeFile(dbPath, 'corrupt', 'utf-8');
		await writeFile(`${dbPath}.daily.2026-05-25`, 'invalid backup', 'utf-8');
		integrityResultQueue = [
			[{ integrity_check: 'database disk image is malformed' }],
			[{ integrity_check: 'backup is malformed' }],
		];

		const { StatsDB } = await import('../../main/stats/stats-db');
		const statsDb = new StatsDB();
		statsDb.initialize();

		expect(statsDb.isReady()).toBe(true);
		expect(pragmaSql.filter((sql) => sql === 'integrity_check')).toHaveLength(2);
	});

	it('skips unreadable backups during corruption recovery', async () => {
		const dbPath = path.join(tempRoot, 'stats.db');
		await writeFile(dbPath, 'corrupt', 'utf-8');
		await writeFile(`${dbPath}.daily.2026-05-25`, 'unreadable backup', 'utf-8');
		integrityResultQueue = [[{ integrity_check: 'database disk image is malformed' }]];
		throwOnOpen = (_dbPath, options) => (options?.readonly ? new Error('backup unreadable') : null);

		const { StatsDB } = await import('../../main/stats/stats-db');
		const statsDb = new StatsDB();
		statsDb.initialize();

		expect(statsDb.isReady()).toBe(true);
	});

	it('throws when corruption recovery cannot open a replacement database', async () => {
		const dbPath = path.join(tempRoot, 'stats.db');
		await writeFile(dbPath, 'corrupt', 'utf-8');
		throwOnOpen = (openedPath) =>
			openedPath.endsWith('stats.db') ? new Error('open failed') : null;

		const { StatsDB } = await import('../../main/stats/stats-db');
		const statsDb = new StatsDB();

		expect(() => statsDb.initialize()).toThrow('Failed to open or recover database');
	});
});
