/**
 * Tests for StatsDB core class, initialization, and singleton.
 *
 * Note: better-sqlite3 is a native module compiled for Electron's Node version.
 * Direct testing with the native module in vitest is not possible without
 * electron-rebuild for the vitest runtime. These tests use mocked database
 * operations to verify the logic without requiring the actual native module.
 *
 * For full integration testing of the SQLite database, use the Electron test
 * environment (e2e tests) where the native module is properly loaded.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as path from 'path';
import * as os from 'os';

// Track Database constructor calls to verify file path
let lastDbPath: string | null = null;

// Store mock references so they can be accessed in tests
const mockStatement = {
	run: vi.fn(() => ({ changes: 1 })),
	get: vi.fn(() => ({ count: 0, total_duration: 0 })),
	all: vi.fn(() => []),
};

const mockDb = {
	pragma: vi.fn(() => [{ user_version: 0 }]),
	prepare: vi.fn(() => mockStatement),
	close: vi.fn(),
	// Transaction mock that immediately executes the function
	transaction: vi.fn((fn: () => void) => {
		return () => fn();
	}),
};

// Mock better-sqlite3 as a class
vi.mock('better-sqlite3', () => {
	return {
		default: class MockDatabase {
			constructor(dbPath: string) {
				lastDbPath = dbPath;
			}
			pragma = mockDb.pragma;
			prepare = mockDb.prepare;
			close = mockDb.close;
			transaction = mockDb.transaction;
		},
	};
});

// Mock electron's app module with trackable userData path
const mockUserDataPath = path.join(os.tmpdir(), 'maestro-test-stats-db');
vi.mock('electron', () => ({
	app: {
		getPath: vi.fn((name: string) => {
			if (name === 'userData') return mockUserDataPath;
			return os.tmpdir();
		}),
	},
}));

// Track fs calls
const mockFsExistsSync = vi.fn(() => true);
const mockFsMkdirSync = vi.fn();
const mockFsCopyFileSync = vi.fn();
const mockFsUnlinkSync = vi.fn();
const mockFsRenameSync = vi.fn();
const mockFsStatSync = vi.fn(() => ({ size: 1024 }));
const mockFsReadFileSync = vi.fn(() => '0'); // Default: old timestamp (triggers vacuum check)
const mockFsWriteFileSync = vi.fn();
const mockFsReaddirSync = vi.fn(() => [] as string[]); // Default: empty directory

// Mock fs
vi.mock('fs', () => ({
	existsSync: (...args: unknown[]) => mockFsExistsSync(...args),
	mkdirSync: (...args: unknown[]) => mockFsMkdirSync(...args),
	copyFileSync: (...args: unknown[]) => mockFsCopyFileSync(...args),
	unlinkSync: (...args: unknown[]) => mockFsUnlinkSync(...args),
	renameSync: (...args: unknown[]) => mockFsRenameSync(...args),
	statSync: (...args: unknown[]) => mockFsStatSync(...args),
	readFileSync: (...args: unknown[]) => mockFsReadFileSync(...args),
	writeFileSync: (...args: unknown[]) => mockFsWriteFileSync(...args),
	readdirSync: (...args: unknown[]) => mockFsReaddirSync(...args),
}));

// Mock logger
vi.mock('../../../main/utils/logger', () => ({
	logger: {
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
	},
}));

// Import types only - we'll test the type definitions
import type {
	QueryEvent,
	AutoRunSession,
	AutoRunTask,
	SessionLifecycleEvent,
	StatsTimeRange,
	StatsFilters,
	StatsAggregation,
} from '../../../shared/stats-types';

describe('StatsDB class (mocked)', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		lastDbPath = null;
		mockDb.pragma.mockReturnValue([{ user_version: 0 }]);
		mockDb.prepare.mockReturnValue(mockStatement);
		mockStatement.run.mockReturnValue({ changes: 1 });
		mockStatement.get.mockReturnValue({ count: 0, total_duration: 0 });
		mockStatement.all.mockReturnValue([]);
		mockFsExistsSync.mockReturnValue(true);
		mockFsMkdirSync.mockClear();
	});

	afterEach(() => {
		vi.resetModules();
	});

	describe('module exports', () => {
		it('should export StatsDB class', async () => {
			const { StatsDB } = await import('../../../main/stats');
			expect(StatsDB).toBeDefined();
			expect(typeof StatsDB).toBe('function');
		});

		it('should export singleton functions', async () => {
			const { getStatsDB, initializeStatsDB, closeStatsDB } = await import('../../../main/stats');
			expect(getStatsDB).toBeDefined();
			expect(initializeStatsDB).toBeDefined();
			expect(closeStatsDB).toBeDefined();
		});
	});

	describe('StatsDB instantiation', () => {
		it('should create instance without initialization', async () => {
			const { StatsDB } = await import('../../../main/stats');
			const db = new StatsDB();

			expect(db).toBeDefined();
			expect(db.isReady()).toBe(false);
		});

		it('should return database path', async () => {
			const { StatsDB } = await import('../../../main/stats');
			const db = new StatsDB();

			expect(db.getDbPath()).toContain('stats.db');
		});
	});

	describe('initialization', () => {
		it('should initialize database and set isReady to true', async () => {
			const { StatsDB } = await import('../../../main/stats');
			const db = new StatsDB();

			db.initialize();

			expect(db.isReady()).toBe(true);
		});

		it('should enable WAL mode', async () => {
			const { StatsDB } = await import('../../../main/stats');
			const db = new StatsDB();

			db.initialize();

			expect(mockDb.pragma).toHaveBeenCalledWith('journal_mode = WAL');
		});

		it('should run v1 migration for fresh database', async () => {
			mockDb.pragma.mockImplementation((sql: string) => {
				if (sql === 'user_version') return [{ user_version: 0 }];
				return undefined;
			});

			const { StatsDB } = await import('../../../main/stats');
			const db = new StatsDB();
			db.initialize();

			// Should set user_version to 1
			expect(mockDb.pragma).toHaveBeenCalledWith('user_version = 1');
		});

		it('should skip migration for already migrated database', async () => {
			mockDb.pragma.mockImplementation((sql: string) => {
				if (sql === 'user_version') return [{ user_version: 1 }];
				return undefined;
			});

			const { StatsDB } = await import('../../../main/stats');
			const db = new StatsDB();
			db.initialize();

			// Should NOT set user_version (no migration needed)
			expect(mockDb.pragma).not.toHaveBeenCalledWith('user_version = 1');
		});

		it('should create _migrations table on initialization', async () => {
			mockDb.pragma.mockImplementation((sql: string) => {
				if (sql === 'user_version') return [{ user_version: 0 }];
				return undefined;
			});

			const { StatsDB } = await import('../../../main/stats');
			const db = new StatsDB();
			db.initialize();

			// Should have prepared the CREATE TABLE IF NOT EXISTS _migrations statement
			expect(mockDb.prepare).toHaveBeenCalledWith(
				expect.stringContaining('CREATE TABLE IF NOT EXISTS _migrations')
			);
		});

		it('should record successful migration in _migrations table', async () => {
			mockDb.pragma.mockImplementation((sql: string) => {
				if (sql === 'user_version') return [{ user_version: 0 }];
				return undefined;
			});

			const { StatsDB } = await import('../../../main/stats');
			const db = new StatsDB();
			db.initialize();

			// Should have inserted a success record into _migrations
			expect(mockDb.prepare).toHaveBeenCalledWith(
				expect.stringContaining('INSERT OR REPLACE INTO _migrations')
			);
		});

		it('should use transaction for migration atomicity', async () => {
			mockDb.pragma.mockImplementation((sql: string) => {
				if (sql === 'user_version') return [{ user_version: 0 }];
				return undefined;
			});

			const { StatsDB } = await import('../../../main/stats');
			const db = new StatsDB();
			db.initialize();

			// Should have used transaction
			expect(mockDb.transaction).toHaveBeenCalled();
		});
	});

	describe('migration system API', () => {
		beforeEach(() => {
			vi.clearAllMocks();
			mockDb.pragma.mockImplementation((sql: string) => {
				if (sql === 'user_version') return [{ user_version: 1 }];
				return undefined;
			});
			mockDb.prepare.mockReturnValue(mockStatement);
			mockStatement.run.mockReturnValue({ changes: 1 });
			mockStatement.get.mockReturnValue(null);
			mockStatement.all.mockReturnValue([]);
			mockFsExistsSync.mockReturnValue(true);
		});

		afterEach(() => {
			vi.resetModules();
		});

		it('should return current version via getCurrentVersion()', async () => {
			mockDb.pragma.mockImplementation((sql: string) => {
				if (sql === 'user_version') return [{ user_version: 1 }];
				return undefined;
			});

			const { StatsDB } = await import('../../../main/stats');
			const db = new StatsDB();
			db.initialize();

			expect(db.getCurrentVersion()).toBe(1);
		});

		it('should return target version via getTargetVersion()', async () => {
			const { StatsDB } = await import('../../../main/stats');
			const db = new StatsDB();
			db.initialize();

			// Currently we have version 3 migration (v1: initial schema, v2: is_remote column, v3: session_lifecycle table)
			expect(db.getTargetVersion()).toBe(3);
		});

		it('should return false from hasPendingMigrations() when up to date', async () => {
			mockDb.pragma.mockImplementation((sql: string) => {
				if (sql === 'user_version') return [{ user_version: 3 }];
				return undefined;
			});

			const { StatsDB } = await import('../../../main/stats');
			const db = new StatsDB();
			db.initialize();

			expect(db.hasPendingMigrations()).toBe(false);
		});

		it('should correctly identify pending migrations based on version difference', async () => {
			// This test verifies the hasPendingMigrations() logic
			// by checking current version < target version

			// Simulate a database that's already at version 3 (target version)
			let currentVersion = 3;
			mockDb.pragma.mockImplementation((sql: string) => {
				if (sql === 'user_version') return [{ user_version: currentVersion }];
				// Handle version updates from migration
				if (sql.startsWith('user_version = ')) {
					currentVersion = parseInt(sql.replace('user_version = ', ''));
				}
				return undefined;
			});

			const { StatsDB } = await import('../../../main/stats');
			const db = new StatsDB();
			db.initialize();

			// At version 3, target is 3, so no pending migrations
			expect(db.getCurrentVersion()).toBe(3);
			expect(db.getTargetVersion()).toBe(3);
			expect(db.hasPendingMigrations()).toBe(false);
		});

		it('should return empty array from getMigrationHistory() when no _migrations table', async () => {
			mockStatement.get.mockReturnValue(null); // No table exists

			const { StatsDB } = await import('../../../main/stats');
			const db = new StatsDB();
			db.initialize();

			const history = db.getMigrationHistory();
			expect(history).toEqual([]);
		});

		it('should return migration records from getMigrationHistory()', async () => {
			const mockMigrationRows = [
				{
					version: 1,
					description: 'Initial schema',
					applied_at: 1704067200000,
					status: 'success' as const,
					error_message: null,
				},
			];

			mockStatement.get.mockReturnValue({ name: '_migrations' }); // Table exists
			mockStatement.all.mockReturnValue(mockMigrationRows);

			const { StatsDB } = await import('../../../main/stats');
			const db = new StatsDB();
			db.initialize();

			const history = db.getMigrationHistory();
			expect(history).toHaveLength(1);
			expect(history[0]).toEqual({
				version: 1,
				description: 'Initial schema',
				appliedAt: 1704067200000,
				status: 'success',
				errorMessage: undefined,
			});
		});

		it('should include errorMessage in migration history for failed migrations', async () => {
			const mockMigrationRows = [
				{
					version: 2,
					description: 'Add new column',
					applied_at: 1704067200000,
					status: 'failed' as const,
					error_message: 'SQLITE_ERROR: duplicate column name',
				},
			];

			mockStatement.get.mockReturnValue({ name: '_migrations' });
			mockStatement.all.mockReturnValue(mockMigrationRows);

			const { StatsDB } = await import('../../../main/stats');
			const db = new StatsDB();
			db.initialize();

			const history = db.getMigrationHistory();
			expect(history[0].status).toBe('failed');
			expect(history[0].errorMessage).toBe('SQLITE_ERROR: duplicate column name');
		});
	});

	describe('error handling', () => {
		it('should throw when calling insertQueryEvent before initialization', async () => {
			const { StatsDB } = await import('../../../main/stats');
			const db = new StatsDB();

			expect(() =>
				db.insertQueryEvent({
					sessionId: 'test',
					agentType: 'claude-code',
					source: 'user',
					startTime: Date.now(),
					duration: 1000,
				})
			).toThrow('Database not initialized');
		});

		it('should throw when calling getQueryEvents before initialization', async () => {
			const { StatsDB } = await import('../../../main/stats');
			const db = new StatsDB();

			expect(() => db.getQueryEvents('day')).toThrow('Database not initialized');
		});

		it('should throw when calling getAggregatedStats before initialization', async () => {
			const { StatsDB } = await import('../../../main/stats');
			const db = new StatsDB();

			expect(() => db.getAggregatedStats('week')).toThrow('Database not initialized');
		});
	});

	describe('query events', () => {
		it('should insert a query event and return an id', async () => {
			const { StatsDB } = await import('../../../main/stats');
			const db = new StatsDB();
			db.initialize();

			const eventId = db.insertQueryEvent({
				sessionId: 'session-1',
				agentType: 'claude-code',
				source: 'user',
				startTime: Date.now(),
				duration: 5000,
				projectPath: '/test/project',
				tabId: 'tab-1',
			});

			expect(eventId).toBeDefined();
			expect(typeof eventId).toBe('string');
			expect(mockStatement.run).toHaveBeenCalled();
		});

		it('should retrieve query events within time range', async () => {
			mockStatement.all.mockReturnValue([
				{
					id: 'event-1',
					session_id: 'session-1',
					agent_type: 'claude-code',
					source: 'user',
					start_time: Date.now(),
					duration: 5000,
					project_path: '/test',
					tab_id: 'tab-1',
				},
			]);

			const { StatsDB } = await import('../../../main/stats');
			const db = new StatsDB();
			db.initialize();

			const events = db.getQueryEvents('day');

			expect(events).toHaveLength(1);
			expect(events[0].sessionId).toBe('session-1');
			expect(events[0].agentType).toBe('claude-code');
		});
	});

	describe('close', () => {
		it('should close the database connection', async () => {
			const { StatsDB } = await import('../../../main/stats');
			const db = new StatsDB();
			db.initialize();

			db.close();

			expect(mockDb.close).toHaveBeenCalled();
			expect(db.isReady()).toBe(false);
		});
	});
});

/**
 * Database file creation verification tests
 *
 * These tests verify that the database file is created at the correct path
 * in the user's application data directory on first launch.
 */
describe('Database file creation on first launch', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		lastDbPath = null;
		mockDb.pragma.mockReturnValue([{ user_version: 0 }]);
		mockDb.prepare.mockReturnValue(mockStatement);
		mockFsExistsSync.mockReturnValue(true);
		mockFsMkdirSync.mockClear();
	});

	afterEach(() => {
		vi.resetModules();
	});

	describe('database path computation', () => {
		it('should compute database path using electron app.getPath("userData")', async () => {
			const { StatsDB } = await import('../../../main/stats');
			const db = new StatsDB();

			const dbPath = db.getDbPath();

			// Verify the path is in the userData directory
			expect(dbPath).toContain(mockUserDataPath);
			expect(dbPath).toContain('stats.db');
		});

		it('should create database file at userData/stats.db path', async () => {
			const { StatsDB } = await import('../../../main/stats');
			const db = new StatsDB();
			db.initialize();

			// Verify better-sqlite3 was called with the correct path
			expect(lastDbPath).toBe(path.join(mockUserDataPath, 'stats.db'));
		});

		it('should use platform-appropriate userData path', async () => {
			const { StatsDB } = await import('../../../main/stats');
			const db = new StatsDB();

			// The path should be absolute and contain stats.db
			const dbPath = db.getDbPath();
			expect(path.isAbsolute(dbPath)).toBe(true);
			expect(path.basename(dbPath)).toBe('stats.db');
		});
	});

	describe('directory creation', () => {
		it('should create userData directory if it does not exist', async () => {
			// Simulate directory not existing
			mockFsExistsSync.mockReturnValue(false);

			const { StatsDB } = await import('../../../main/stats');
			const db = new StatsDB();
			db.initialize();

			// Verify mkdirSync was called with recursive option
			expect(mockFsMkdirSync).toHaveBeenCalledWith(mockUserDataPath, { recursive: true });
		});

		it('should not create directory if it already exists', async () => {
			// Simulate directory already existing
			mockFsExistsSync.mockReturnValue(true);

			const { StatsDB } = await import('../../../main/stats');
			const db = new StatsDB();
			db.initialize();

			// Verify mkdirSync was NOT called
			expect(mockFsMkdirSync).not.toHaveBeenCalled();
		});
	});

	describe('database initialization', () => {
		it('should open database connection on initialize', async () => {
			const { StatsDB } = await import('../../../main/stats');
			const db = new StatsDB();

			expect(db.isReady()).toBe(false);
			db.initialize();
			expect(db.isReady()).toBe(true);
		});

		it('should only initialize once (idempotent)', async () => {
			mockDb.pragma.mockClear();

			const { StatsDB } = await import('../../../main/stats');
			const db = new StatsDB();

			db.initialize();
			const firstCallCount = mockDb.pragma.mock.calls.length;

			db.initialize(); // Second call should be a no-op
			const secondCallCount = mockDb.pragma.mock.calls.length;

			expect(secondCallCount).toBe(firstCallCount);
		});

		it('should create all three tables on fresh database', async () => {
			const { StatsDB } = await import('../../../main/stats');
			const db = new StatsDB();
			db.initialize();

			// Verify prepare was called with CREATE TABLE statements
			const prepareCalls = mockDb.prepare.mock.calls.map((call) => call[0]);

			// Check for query_events table
			expect(
				prepareCalls.some((sql: string) => sql.includes('CREATE TABLE IF NOT EXISTS query_events'))
			).toBe(true);

			// Check for auto_run_sessions table
			expect(
				prepareCalls.some((sql: string) =>
					sql.includes('CREATE TABLE IF NOT EXISTS auto_run_sessions')
				)
			).toBe(true);

			// Check for auto_run_tasks table
			expect(
				prepareCalls.some((sql: string) =>
					sql.includes('CREATE TABLE IF NOT EXISTS auto_run_tasks')
				)
			).toBe(true);
		});

		it('should create all required indexes', async () => {
			const { StatsDB } = await import('../../../main/stats');
			const db = new StatsDB();
			db.initialize();

			const prepareCalls = mockDb.prepare.mock.calls.map((call) => call[0]);

			// Verify all 7 indexes are created
			const expectedIndexes = [
				'idx_query_start_time',
				'idx_query_agent_type',
				'idx_query_source',
				'idx_query_session',
				'idx_auto_session_start',
				'idx_task_auto_session',
				'idx_task_start',
			];

			for (const indexName of expectedIndexes) {
				expect(prepareCalls.some((sql: string) => sql.includes(indexName))).toBe(true);
			}
		});
	});

	describe('singleton pattern', () => {
		it('should return same instance from getStatsDB', async () => {
			const { getStatsDB, closeStatsDB } = await import('../../../main/stats');

			const instance1 = getStatsDB();
			const instance2 = getStatsDB();

			expect(instance1).toBe(instance2);

			// Cleanup
			closeStatsDB();
		});

		it('should initialize database via initializeStatsDB', async () => {
			const { initializeStatsDB, getStatsDB, closeStatsDB } = await import('../../../main/stats');

			initializeStatsDB();
			const db = getStatsDB();

			expect(db.isReady()).toBe(true);

			// Cleanup
			closeStatsDB();
		});

		it('should close database and reset singleton via closeStatsDB', async () => {
			const { initializeStatsDB, getStatsDB, closeStatsDB } = await import('../../../main/stats');

			initializeStatsDB();
			const dbBefore = getStatsDB();
			expect(dbBefore.isReady()).toBe(true);

			closeStatsDB();

			// After close, a new instance should be returned
			const dbAfter = getStatsDB();
			expect(dbAfter).not.toBe(dbBefore);
			expect(dbAfter.isReady()).toBe(false);
		});
	});
});

/**
 * Daily backup system tests
 */
describe('Daily backup system', () => {
	const mockFsReaddirSync = vi.fn();

	beforeEach(() => {
		vi.clearAllMocks();
		lastDbPath = null;
		mockDb.pragma.mockReturnValue([{ user_version: 3 }]);
		mockDb.prepare.mockReturnValue(mockStatement);
		mockStatement.run.mockReturnValue({ changes: 1 });
		mockStatement.get.mockReturnValue({ value: '0' }); // Old vacuum timestamp
		mockStatement.all.mockReturnValue([]);
		mockFsExistsSync.mockReturnValue(true);
		mockFsReaddirSync.mockReturnValue([]);

		// Mock readdirSync in the fs mock
		vi.doMock('fs', () => ({
			existsSync: (...args: unknown[]) => mockFsExistsSync(...args),
			mkdirSync: (...args: unknown[]) => mockFsMkdirSync(...args),
			copyFileSync: (...args: unknown[]) => mockFsCopyFileSync(...args),
			unlinkSync: (...args: unknown[]) => mockFsUnlinkSync(...args),
			renameSync: (...args: unknown[]) => mockFsRenameSync(...args),
			statSync: (...args: unknown[]) => mockFsStatSync(...args),
			readFileSync: (...args: unknown[]) => mockFsReadFileSync(...args),
			writeFileSync: (...args: unknown[]) => mockFsWriteFileSync(...args),
			readdirSync: (...args: unknown[]) => mockFsReaddirSync(...args),
		}));
	});

	afterEach(() => {
		vi.resetModules();
	});

	describe('getAvailableBackups', () => {
		it('should return empty array when no backups exist', async () => {
			mockFsReaddirSync.mockReturnValue([]);

			const { StatsDB } = await import('../../../main/stats');
			const db = new StatsDB();
			db.initialize();

			const backups = db.getAvailableBackups();
			expect(backups).toEqual([]);
		});

		it('should detect daily backup files (stats.db.daily.YYYY-MM-DD)', async () => {
			mockFsReaddirSync.mockReturnValue([
				'stats.db.daily.2026-02-01',
				'stats.db.daily.2026-02-02',
				'stats.db.daily.2026-02-03',
			]);

			const { StatsDB } = await import('../../../main/stats');
			const db = new StatsDB();
			db.initialize();

			const backups = db.getAvailableBackups();
			expect(backups).toHaveLength(3);
			expect(backups[0].date).toBe('2026-02-03'); // Newest first
			expect(backups[1].date).toBe('2026-02-02');
			expect(backups[2].date).toBe('2026-02-01');
		});

		it('should detect legacy timestamp backup files (stats.db.backup.TIMESTAMP)', async () => {
			// Timestamp for 2026-02-03
			const timestamp = new Date('2026-02-03').getTime();
			mockFsReaddirSync.mockReturnValue([`stats.db.backup.${timestamp}`]);

			const { StatsDB } = await import('../../../main/stats');
			const db = new StatsDB();
			db.initialize();

			const backups = db.getAvailableBackups();
			expect(backups).toHaveLength(1);
			expect(backups[0].date).toBe('2026-02-03');
		});

		it('should sort backups by date descending (newest first)', async () => {
			mockFsReaddirSync.mockReturnValue([
				'stats.db.daily.2026-01-15',
				'stats.db.daily.2026-02-01',
				'stats.db.daily.2026-01-20',
			]);

			const { StatsDB } = await import('../../../main/stats');
			const db = new StatsDB();
			db.initialize();

			const backups = db.getAvailableBackups();
			expect(backups[0].date).toBe('2026-02-01');
			expect(backups[1].date).toBe('2026-01-20');
			expect(backups[2].date).toBe('2026-01-15');
		});
	});

	describe('restoreFromBackup', () => {
		it('should return false when backup file does not exist', async () => {
			mockFsExistsSync.mockImplementation((p: unknown) => {
				if (typeof p === 'string' && p.includes('nonexistent')) return false;
				return true;
			});

			const { StatsDB } = await import('../../../main/stats');
			const db = new StatsDB();
			db.initialize();

			const result = db.restoreFromBackup('/path/to/nonexistent/backup');
			expect(result).toBe(false);
		});

		it('should close database before restoring', async () => {
			const { StatsDB } = await import('../../../main/stats');
			const db = new StatsDB();
			db.initialize();

			db.restoreFromBackup('/path/to/backup');

			expect(mockDb.close).toHaveBeenCalled();
		});

		it('should copy backup file to main database path', async () => {
			const { StatsDB } = await import('../../../main/stats');
			const db = new StatsDB();
			db.initialize();

			db.restoreFromBackup('/path/to/backup.db');

			expect(mockFsCopyFileSync).toHaveBeenCalledWith(
				'/path/to/backup.db',
				expect.stringContaining('stats.db')
			);
		});

		it('should remove WAL and SHM files before restoring', async () => {
			const { StatsDB } = await import('../../../main/stats');
			const db = new StatsDB();
			db.initialize();

			db.restoreFromBackup('/path/to/backup.db');

			// Should attempt to unlink WAL and SHM files
			expect(mockFsUnlinkSync).toHaveBeenCalled();
		});
	});

	describe('daily backup creation on initialize', () => {
		it('should attempt to create daily backup on initialization', async () => {
			const { StatsDB } = await import('../../../main/stats');
			const db = new StatsDB();
			db.initialize();

			// Should have attempted to copy the database for backup
			expect(mockFsCopyFileSync).toHaveBeenCalled();
		});

		it('should skip backup creation if today backup already exists', async () => {
			const today = new Date().toISOString().split('T')[0];
			mockFsExistsSync.mockImplementation((p: unknown) => {
				if (typeof p === 'string' && p.includes(`daily.${today}`)) return true;
				return true;
			});

			const { StatsDB } = await import('../../../main/stats');
			const db = new StatsDB();
			db.initialize();

			// copyFileSync should not be called for daily backup (might be called for other reasons)
			const dailyBackupCalls = mockFsCopyFileSync.mock.calls.filter(
				(call) => typeof call[1] === 'string' && call[1].includes('daily')
			);
			expect(dailyBackupCalls).toHaveLength(0);
		});
	});
});

/**
 * Auto Run session and task recording tests
 */
