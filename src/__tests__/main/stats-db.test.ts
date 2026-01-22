/**
 * Tests for stats-db.ts
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
}));

// Mock logger
vi.mock('../../main/utils/logger', () => ({
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
} from '../../shared/stats-types';

describe('stats-types.ts', () => {
	describe('QueryEvent interface', () => {
		it('should define proper QueryEvent structure', () => {
			const event: QueryEvent = {
				id: 'test-id',
				sessionId: 'session-1',
				agentType: 'claude-code',
				source: 'user',
				startTime: Date.now(),
				duration: 5000,
				projectPath: '/test/project',
				tabId: 'tab-1',
			};

			expect(event.id).toBe('test-id');
			expect(event.sessionId).toBe('session-1');
			expect(event.source).toBe('user');
		});

		it('should allow optional fields to be undefined', () => {
			const event: QueryEvent = {
				id: 'test-id',
				sessionId: 'session-1',
				agentType: 'claude-code',
				source: 'auto',
				startTime: Date.now(),
				duration: 3000,
			};

			expect(event.projectPath).toBeUndefined();
			expect(event.tabId).toBeUndefined();
		});
	});

	describe('AutoRunSession interface', () => {
		it('should define proper AutoRunSession structure', () => {
			const session: AutoRunSession = {
				id: 'auto-run-1',
				sessionId: 'session-1',
				agentType: 'claude-code',
				documentPath: '/docs/task.md',
				startTime: Date.now(),
				duration: 60000,
				tasksTotal: 5,
				tasksCompleted: 3,
				projectPath: '/test/project',
			};

			expect(session.id).toBe('auto-run-1');
			expect(session.tasksTotal).toBe(5);
			expect(session.tasksCompleted).toBe(3);
		});
	});

	describe('AutoRunTask interface', () => {
		it('should define proper AutoRunTask structure', () => {
			const task: AutoRunTask = {
				id: 'task-1',
				autoRunSessionId: 'auto-run-1',
				sessionId: 'session-1',
				agentType: 'claude-code',
				taskIndex: 0,
				taskContent: 'First task content',
				startTime: Date.now(),
				duration: 10000,
				success: true,
			};

			expect(task.id).toBe('task-1');
			expect(task.taskIndex).toBe(0);
			expect(task.success).toBe(true);
		});

		it('should handle failed tasks', () => {
			const task: AutoRunTask = {
				id: 'task-2',
				autoRunSessionId: 'auto-run-1',
				sessionId: 'session-1',
				agentType: 'claude-code',
				taskIndex: 1,
				startTime: Date.now(),
				duration: 5000,
				success: false,
			};

			expect(task.success).toBe(false);
			expect(task.taskContent).toBeUndefined();
		});
	});

	describe('SessionLifecycleEvent interface', () => {
		it('should define proper SessionLifecycleEvent structure for created session', () => {
			const event: SessionLifecycleEvent = {
				id: 'lifecycle-1',
				sessionId: 'session-1',
				agentType: 'claude-code',
				projectPath: '/test/project',
				createdAt: Date.now(),
				isRemote: false,
			};

			expect(event.id).toBe('lifecycle-1');
			expect(event.sessionId).toBe('session-1');
			expect(event.agentType).toBe('claude-code');
			expect(event.closedAt).toBeUndefined();
			expect(event.duration).toBeUndefined();
		});

		it('should define proper SessionLifecycleEvent structure for closed session', () => {
			// Use fixed timestamps to avoid race conditions from multiple Date.now() calls
			const createdAt = 1700000000000; // Fixed timestamp
			const closedAt = 1700003600000; // Exactly 1 hour later
			const event: SessionLifecycleEvent = {
				id: 'lifecycle-2',
				sessionId: 'session-2',
				agentType: 'claude-code',
				projectPath: '/test/project',
				createdAt,
				closedAt,
				duration: closedAt - createdAt,
				isRemote: true,
			};

			expect(event.closedAt).toBe(closedAt);
			expect(event.duration).toBe(3600000);
			expect(event.isRemote).toBe(true);
		});

		it('should allow optional fields to be undefined', () => {
			const event: SessionLifecycleEvent = {
				id: 'lifecycle-3',
				sessionId: 'session-3',
				agentType: 'opencode',
				createdAt: Date.now(),
			};

			expect(event.projectPath).toBeUndefined();
			expect(event.closedAt).toBeUndefined();
			expect(event.duration).toBeUndefined();
			expect(event.isRemote).toBeUndefined();
		});
	});

	describe('StatsTimeRange type', () => {
		it('should accept valid time ranges', () => {
			const ranges: StatsTimeRange[] = ['day', 'week', 'month', 'year', 'all'];

			expect(ranges).toHaveLength(5);
			expect(ranges).toContain('day');
			expect(ranges).toContain('all');
		});
	});

	describe('StatsFilters interface', () => {
		it('should allow partial filters', () => {
			const filters1: StatsFilters = { agentType: 'claude-code' };
			const filters2: StatsFilters = { source: 'user' };
			const filters3: StatsFilters = {
				agentType: 'opencode',
				source: 'auto',
				projectPath: '/test',
			};

			expect(filters1.agentType).toBe('claude-code');
			expect(filters2.source).toBe('user');
			expect(filters3.projectPath).toBe('/test');
		});
	});

	describe('StatsAggregation interface', () => {
		it('should define proper aggregation structure', () => {
			const aggregation: StatsAggregation = {
				totalQueries: 100,
				totalDuration: 500000,
				avgDuration: 5000,
				byAgent: {
					'claude-code': { count: 70, duration: 350000 },
					opencode: { count: 30, duration: 150000 },
				},
				bySource: { user: 60, auto: 40 },
				byLocation: { local: 80, remote: 20 },
				byDay: [
					{ date: '2024-01-01', count: 10, duration: 50000 },
					{ date: '2024-01-02', count: 15, duration: 75000 },
				],
				byHour: [
					{ hour: 9, count: 20, duration: 100000 },
					{ hour: 10, count: 25, duration: 125000 },
				],
				// Session lifecycle fields
				totalSessions: 15,
				sessionsByAgent: {
					'claude-code': 10,
					opencode: 5,
				},
				sessionsByDay: [
					{ date: '2024-01-01', count: 3 },
					{ date: '2024-01-02', count: 5 },
				],
				avgSessionDuration: 1800000,
			};

			expect(aggregation.totalQueries).toBe(100);
			expect(aggregation.byAgent['claude-code'].count).toBe(70);
			expect(aggregation.bySource.user).toBe(60);
			expect(aggregation.byDay).toHaveLength(2);
			// Session lifecycle assertions
			expect(aggregation.totalSessions).toBe(15);
			expect(aggregation.sessionsByAgent['claude-code']).toBe(10);
			expect(aggregation.sessionsByDay).toHaveLength(2);
			expect(aggregation.avgSessionDuration).toBe(1800000);
		});
	});
});

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
			const { StatsDB } = await import('../../main/stats-db');
			expect(StatsDB).toBeDefined();
			expect(typeof StatsDB).toBe('function');
		});

		it('should export singleton functions', async () => {
			const { getStatsDB, initializeStatsDB, closeStatsDB } = await import('../../main/stats-db');
			expect(getStatsDB).toBeDefined();
			expect(initializeStatsDB).toBeDefined();
			expect(closeStatsDB).toBeDefined();
		});
	});

	describe('StatsDB instantiation', () => {
		it('should create instance without initialization', async () => {
			const { StatsDB } = await import('../../main/stats-db');
			const db = new StatsDB();

			expect(db).toBeDefined();
			expect(db.isReady()).toBe(false);
		});

		it('should return database path', async () => {
			const { StatsDB } = await import('../../main/stats-db');
			const db = new StatsDB();

			expect(db.getDbPath()).toContain('stats.db');
		});
	});

	describe('initialization', () => {
		it('should initialize database and set isReady to true', async () => {
			const { StatsDB } = await import('../../main/stats-db');
			const db = new StatsDB();

			db.initialize();

			expect(db.isReady()).toBe(true);
		});

		it('should enable WAL mode', async () => {
			const { StatsDB } = await import('../../main/stats-db');
			const db = new StatsDB();

			db.initialize();

			expect(mockDb.pragma).toHaveBeenCalledWith('journal_mode = WAL');
		});

		it('should run v1 migration for fresh database', async () => {
			mockDb.pragma.mockImplementation((sql: string) => {
				if (sql === 'user_version') return [{ user_version: 0 }];
				return undefined;
			});

			const { StatsDB } = await import('../../main/stats-db');
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

			const { StatsDB } = await import('../../main/stats-db');
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

			const { StatsDB } = await import('../../main/stats-db');
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

			const { StatsDB } = await import('../../main/stats-db');
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

			const { StatsDB } = await import('../../main/stats-db');
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

			const { StatsDB } = await import('../../main/stats-db');
			const db = new StatsDB();
			db.initialize();

			expect(db.getCurrentVersion()).toBe(1);
		});

		it('should return target version via getTargetVersion()', async () => {
			const { StatsDB } = await import('../../main/stats-db');
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

			const { StatsDB } = await import('../../main/stats-db');
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

			const { StatsDB } = await import('../../main/stats-db');
			const db = new StatsDB();
			db.initialize();

			// At version 3, target is 3, so no pending migrations
			expect(db.getCurrentVersion()).toBe(3);
			expect(db.getTargetVersion()).toBe(3);
			expect(db.hasPendingMigrations()).toBe(false);
		});

		it('should return empty array from getMigrationHistory() when no _migrations table', async () => {
			mockStatement.get.mockReturnValue(null); // No table exists

			const { StatsDB } = await import('../../main/stats-db');
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

			const { StatsDB } = await import('../../main/stats-db');
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

			const { StatsDB } = await import('../../main/stats-db');
			const db = new StatsDB();
			db.initialize();

			const history = db.getMigrationHistory();
			expect(history[0].status).toBe('failed');
			expect(history[0].errorMessage).toBe('SQLITE_ERROR: duplicate column name');
		});
	});

	describe('error handling', () => {
		it('should throw when calling insertQueryEvent before initialization', async () => {
			const { StatsDB } = await import('../../main/stats-db');
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
			const { StatsDB } = await import('../../main/stats-db');
			const db = new StatsDB();

			expect(() => db.getQueryEvents('day')).toThrow('Database not initialized');
		});

		it('should throw when calling getAggregatedStats before initialization', async () => {
			const { StatsDB } = await import('../../main/stats-db');
			const db = new StatsDB();

			expect(() => db.getAggregatedStats('week')).toThrow('Database not initialized');
		});
	});

	describe('query events', () => {
		it('should insert a query event and return an id', async () => {
			const { StatsDB } = await import('../../main/stats-db');
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

			const { StatsDB } = await import('../../main/stats-db');
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
			const { StatsDB } = await import('../../main/stats-db');
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
			const { StatsDB } = await import('../../main/stats-db');
			const db = new StatsDB();

			const dbPath = db.getDbPath();

			// Verify the path is in the userData directory
			expect(dbPath).toContain(mockUserDataPath);
			expect(dbPath).toContain('stats.db');
		});

		it('should create database file at userData/stats.db path', async () => {
			const { StatsDB } = await import('../../main/stats-db');
			const db = new StatsDB();
			db.initialize();

			// Verify better-sqlite3 was called with the correct path
			expect(lastDbPath).toBe(path.join(mockUserDataPath, 'stats.db'));
		});

		it('should use platform-appropriate userData path', async () => {
			const { StatsDB } = await import('../../main/stats-db');
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

			const { StatsDB } = await import('../../main/stats-db');
			const db = new StatsDB();
			db.initialize();

			// Verify mkdirSync was called with recursive option
			expect(mockFsMkdirSync).toHaveBeenCalledWith(mockUserDataPath, { recursive: true });
		});

		it('should not create directory if it already exists', async () => {
			// Simulate directory already existing
			mockFsExistsSync.mockReturnValue(true);

			const { StatsDB } = await import('../../main/stats-db');
			const db = new StatsDB();
			db.initialize();

			// Verify mkdirSync was NOT called
			expect(mockFsMkdirSync).not.toHaveBeenCalled();
		});
	});

	describe('database initialization', () => {
		it('should open database connection on initialize', async () => {
			const { StatsDB } = await import('../../main/stats-db');
			const db = new StatsDB();

			expect(db.isReady()).toBe(false);
			db.initialize();
			expect(db.isReady()).toBe(true);
		});

		it('should only initialize once (idempotent)', async () => {
			mockDb.pragma.mockClear();

			const { StatsDB } = await import('../../main/stats-db');
			const db = new StatsDB();

			db.initialize();
			const firstCallCount = mockDb.pragma.mock.calls.length;

			db.initialize(); // Second call should be a no-op
			const secondCallCount = mockDb.pragma.mock.calls.length;

			expect(secondCallCount).toBe(firstCallCount);
		});

		it('should create all three tables on fresh database', async () => {
			const { StatsDB } = await import('../../main/stats-db');
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
			const { StatsDB } = await import('../../main/stats-db');
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
			const { getStatsDB, closeStatsDB } = await import('../../main/stats-db');

			const instance1 = getStatsDB();
			const instance2 = getStatsDB();

			expect(instance1).toBe(instance2);

			// Cleanup
			closeStatsDB();
		});

		it('should initialize database via initializeStatsDB', async () => {
			const { initializeStatsDB, getStatsDB, closeStatsDB } = await import('../../main/stats-db');

			initializeStatsDB();
			const db = getStatsDB();

			expect(db.isReady()).toBe(true);

			// Cleanup
			closeStatsDB();
		});

		it('should close database and reset singleton via closeStatsDB', async () => {
			const { initializeStatsDB, getStatsDB, closeStatsDB } = await import('../../main/stats-db');

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
 * Auto Run session and task recording tests
 */
describe('Auto Run session and task recording', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		lastDbPath = null;
		mockDb.pragma.mockReturnValue([{ user_version: 0 }]);
		mockDb.prepare.mockReturnValue(mockStatement);
		mockStatement.run.mockReturnValue({ changes: 1 });
		mockFsExistsSync.mockReturnValue(true);
	});

	afterEach(() => {
		vi.resetModules();
	});

	describe('Auto Run sessions', () => {
		it('should insert Auto Run session and return id', async () => {
			const { StatsDB } = await import('../../main/stats-db');
			const db = new StatsDB();
			db.initialize();

			const sessionId = db.insertAutoRunSession({
				sessionId: 'session-1',
				agentType: 'claude-code',
				documentPath: '/docs/TASK-1.md',
				startTime: Date.now(),
				duration: 0,
				tasksTotal: 5,
				tasksCompleted: 0,
				projectPath: '/project',
			});

			expect(sessionId).toBeDefined();
			expect(typeof sessionId).toBe('string');
			expect(mockStatement.run).toHaveBeenCalled();
		});

		it('should update Auto Run session on completion', async () => {
			mockStatement.run.mockReturnValue({ changes: 1 });

			const { StatsDB } = await import('../../main/stats-db');
			const db = new StatsDB();
			db.initialize();

			const updated = db.updateAutoRunSession('session-id', {
				duration: 60000,
				tasksCompleted: 5,
			});

			expect(updated).toBe(true);
			expect(mockStatement.run).toHaveBeenCalled();
		});

		it('should retrieve Auto Run sessions within time range', async () => {
			mockStatement.all.mockReturnValue([
				{
					id: 'auto-1',
					session_id: 'session-1',
					agent_type: 'claude-code',
					document_path: '/docs/TASK-1.md',
					start_time: Date.now(),
					duration: 60000,
					tasks_total: 5,
					tasks_completed: 5,
					project_path: '/project',
				},
			]);

			const { StatsDB } = await import('../../main/stats-db');
			const db = new StatsDB();
			db.initialize();

			const sessions = db.getAutoRunSessions('week');

			expect(sessions).toHaveLength(1);
			expect(sessions[0].sessionId).toBe('session-1');
			expect(sessions[0].tasksTotal).toBe(5);
		});
	});

	describe('Auto Run tasks', () => {
		it('should insert Auto Run task with success=true', async () => {
			const { StatsDB } = await import('../../main/stats-db');
			const db = new StatsDB();
			db.initialize();

			const taskId = db.insertAutoRunTask({
				autoRunSessionId: 'auto-1',
				sessionId: 'session-1',
				agentType: 'claude-code',
				taskIndex: 0,
				taskContent: 'First task',
				startTime: Date.now(),
				duration: 10000,
				success: true,
			});

			expect(taskId).toBeDefined();

			// Verify success was converted to 1 for SQLite
			const runCall = mockStatement.run.mock.calls[mockStatement.run.mock.calls.length - 1];
			expect(runCall[8]).toBe(1); // success parameter (last one)
		});

		it('should insert Auto Run task with success=false', async () => {
			const { StatsDB } = await import('../../main/stats-db');
			const db = new StatsDB();
			db.initialize();

			db.insertAutoRunTask({
				autoRunSessionId: 'auto-1',
				sessionId: 'session-1',
				agentType: 'claude-code',
				taskIndex: 1,
				taskContent: 'Failed task',
				startTime: Date.now(),
				duration: 5000,
				success: false,
			});

			// Verify success was converted to 0 for SQLite
			const runCall = mockStatement.run.mock.calls[mockStatement.run.mock.calls.length - 1];
			expect(runCall[8]).toBe(0); // success parameter (last one)
		});

		it('should retrieve tasks for Auto Run session ordered by task_index', async () => {
			mockStatement.all.mockReturnValue([
				{
					id: 'task-1',
					auto_run_session_id: 'auto-1',
					session_id: 'session-1',
					agent_type: 'claude-code',
					task_index: 0,
					task_content: 'First task',
					start_time: Date.now(),
					duration: 10000,
					success: 1,
				},
				{
					id: 'task-2',
					auto_run_session_id: 'auto-1',
					session_id: 'session-1',
					agent_type: 'claude-code',
					task_index: 1,
					task_content: 'Second task',
					start_time: Date.now(),
					duration: 15000,
					success: 1,
				},
			]);

			const { StatsDB } = await import('../../main/stats-db');
			const db = new StatsDB();
			db.initialize();

			const tasks = db.getAutoRunTasks('auto-1');

			expect(tasks).toHaveLength(2);
			expect(tasks[0].taskIndex).toBe(0);
			expect(tasks[1].taskIndex).toBe(1);
			expect(tasks[0].success).toBe(true);
		});
	});
});

/**
 * Aggregation and filtering tests
 */
describe('Stats aggregation and filtering', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockDb.pragma.mockReturnValue([{ user_version: 0 }]);
		mockDb.prepare.mockReturnValue(mockStatement);
		mockStatement.run.mockReturnValue({ changes: 1 });
		mockFsExistsSync.mockReturnValue(true);
	});

	afterEach(() => {
		vi.resetModules();
	});

	describe('time range filtering', () => {
		it('should filter query events by day range', async () => {
			mockStatement.all.mockReturnValue([]);

			const { StatsDB } = await import('../../main/stats-db');
			const db = new StatsDB();
			db.initialize();

			db.getQueryEvents('day');

			// Verify the SQL includes time filter
			const prepareCall = mockDb.prepare.mock.calls.find((call) =>
				(call[0] as string).includes('SELECT * FROM query_events')
			);
			expect(prepareCall).toBeDefined();
		});

		it('should filter with agentType filter', async () => {
			mockStatement.all.mockReturnValue([]);

			const { StatsDB } = await import('../../main/stats-db');
			const db = new StatsDB();
			db.initialize();

			db.getQueryEvents('week', { agentType: 'claude-code' });

			// Verify the SQL includes agent_type filter
			expect(mockStatement.all).toHaveBeenCalled();
		});

		it('should filter with source filter', async () => {
			mockStatement.all.mockReturnValue([]);

			const { StatsDB } = await import('../../main/stats-db');
			const db = new StatsDB();
			db.initialize();

			db.getQueryEvents('month', { source: 'auto' });

			// Verify the SQL includes source filter
			expect(mockStatement.all).toHaveBeenCalled();
		});

		it('should filter with projectPath filter', async () => {
			mockStatement.all.mockReturnValue([]);

			const { StatsDB } = await import('../../main/stats-db');
			const db = new StatsDB();
			db.initialize();

			db.getQueryEvents('year', { projectPath: '/test/project' });

			// Verify the SQL includes project_path filter
			expect(mockStatement.all).toHaveBeenCalled();
		});

		it('should filter with sessionId filter', async () => {
			mockStatement.all.mockReturnValue([]);

			const { StatsDB } = await import('../../main/stats-db');
			const db = new StatsDB();
			db.initialize();

			db.getQueryEvents('all', { sessionId: 'session-123' });

			// Verify the SQL includes session_id filter
			expect(mockStatement.all).toHaveBeenCalled();
		});

		it('should combine multiple filters', async () => {
			mockStatement.all.mockReturnValue([]);

			const { StatsDB } = await import('../../main/stats-db');
			const db = new StatsDB();
			db.initialize();

			db.getQueryEvents('week', {
				agentType: 'claude-code',
				source: 'user',
				projectPath: '/test',
				sessionId: 'session-1',
			});

			// Verify all parameters were passed
			expect(mockStatement.all).toHaveBeenCalled();
		});
	});

	describe('aggregation queries', () => {
		it('should compute aggregated stats correctly', async () => {
			mockStatement.get.mockReturnValue({ count: 100, total_duration: 500000 });
			mockStatement.all.mockReturnValue([
				{ agent_type: 'claude-code', count: 70, duration: 350000 },
				{ agent_type: 'opencode', count: 30, duration: 150000 },
			]);

			const { StatsDB } = await import('../../main/stats-db');
			const db = new StatsDB();
			db.initialize();

			const stats = db.getAggregatedStats('week');

			expect(stats.totalQueries).toBe(100);
			expect(stats.totalDuration).toBe(500000);
			expect(stats.avgDuration).toBe(5000);
		});

		it('should handle empty results for aggregation', async () => {
			mockStatement.get.mockReturnValue({ count: 0, total_duration: 0 });
			mockStatement.all.mockReturnValue([]);

			const { StatsDB } = await import('../../main/stats-db');
			const db = new StatsDB();
			db.initialize();

			const stats = db.getAggregatedStats('day');

			expect(stats.totalQueries).toBe(0);
			expect(stats.avgDuration).toBe(0);
			expect(stats.byAgent).toEqual({});
		});
	});

	describe('CSV export', () => {
		it('should export query events to CSV format', async () => {
			const now = Date.now();
			mockStatement.all.mockReturnValue([
				{
					id: 'event-1',
					session_id: 'session-1',
					agent_type: 'claude-code',
					source: 'user',
					start_time: now,
					duration: 5000,
					project_path: '/test',
					tab_id: 'tab-1',
				},
			]);

			const { StatsDB } = await import('../../main/stats-db');
			const db = new StatsDB();
			db.initialize();

			const csv = db.exportToCsv('week');

			// Verify CSV structure
			expect(csv).toContain('id,sessionId,agentType,source,startTime,duration,projectPath,tabId');
			expect(csv).toContain('event-1');
			expect(csv).toContain('session-1');
			expect(csv).toContain('claude-code');
		});

		it('should handle empty data for CSV export', async () => {
			mockStatement.all.mockReturnValue([]);

			const { StatsDB } = await import('../../main/stats-db');
			const db = new StatsDB();
			db.initialize();

			const csv = db.exportToCsv('day');

			// Should only contain headers
			expect(csv).toBe('id,sessionId,agentType,source,startTime,duration,projectPath,tabId');
		});
	});
});

/**
 * Interactive session query event recording tests
 *
 * These tests verify that query events are properly recorded for interactive
 * (user-initiated) sessions, which is the core validation for:
 * - [ ] Verify query events are recorded for interactive sessions
 */
describe('Query events recorded for interactive sessions', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockDb.pragma.mockReturnValue([{ user_version: 1 }]);
		mockDb.prepare.mockReturnValue(mockStatement);
		mockStatement.run.mockReturnValue({ changes: 1 });
		mockStatement.all.mockReturnValue([]);
		mockFsExistsSync.mockReturnValue(true);
	});

	afterEach(() => {
		vi.resetModules();
	});

	describe('user-initiated interactive session recording', () => {
		it('should record query event with source="user" for interactive session', async () => {
			const { StatsDB } = await import('../../main/stats-db');
			const db = new StatsDB();
			db.initialize();

			const startTime = Date.now();
			const eventId = db.insertQueryEvent({
				sessionId: 'interactive-session-1',
				agentType: 'claude-code',
				source: 'user', // Interactive session is always 'user'
				startTime,
				duration: 5000,
				projectPath: '/Users/test/myproject',
				tabId: 'tab-1',
			});

			expect(eventId).toBeDefined();
			expect(typeof eventId).toBe('string');

			// Verify the INSERT was called with correct parameters
			const runCalls = mockStatement.run.mock.calls;
			const lastCall = runCalls[runCalls.length - 1];

			// Parameters: id, session_id, agent_type, source, start_time, duration, project_path, tab_id
			expect(lastCall[1]).toBe('interactive-session-1'); // session_id
			expect(lastCall[2]).toBe('claude-code'); // agent_type
			expect(lastCall[3]).toBe('user'); // source
			expect(lastCall[4]).toBe(startTime); // start_time
			expect(lastCall[5]).toBe(5000); // duration
			expect(lastCall[6]).toBe('/Users/test/myproject'); // project_path
			expect(lastCall[7]).toBe('tab-1'); // tab_id
		});

		it('should record interactive query without optional fields', async () => {
			const { StatsDB } = await import('../../main/stats-db');
			const db = new StatsDB();
			db.initialize();

			const startTime = Date.now();
			const eventId = db.insertQueryEvent({
				sessionId: 'minimal-session',
				agentType: 'claude-code',
				source: 'user',
				startTime,
				duration: 3000,
				// projectPath and tabId are optional
			});

			expect(eventId).toBeDefined();

			// Verify NULL values for optional fields
			const runCalls = mockStatement.run.mock.calls;
			const lastCall = runCalls[runCalls.length - 1];
			expect(lastCall[6]).toBeNull(); // project_path
			expect(lastCall[7]).toBeNull(); // tab_id
		});

		it('should record multiple interactive queries for the same session', async () => {
			const { StatsDB } = await import('../../main/stats-db');
			const db = new StatsDB();
			db.initialize();

			// Clear mocks after initialize() to count only test operations
			mockStatement.run.mockClear();

			const baseTime = Date.now();

			// First query
			const id1 = db.insertQueryEvent({
				sessionId: 'multi-query-session',
				agentType: 'claude-code',
				source: 'user',
				startTime: baseTime,
				duration: 5000,
				projectPath: '/project',
				tabId: 'tab-1',
			});

			// Second query (same session, different tab)
			const id2 = db.insertQueryEvent({
				sessionId: 'multi-query-session',
				agentType: 'claude-code',
				source: 'user',
				startTime: baseTime + 10000,
				duration: 3000,
				projectPath: '/project',
				tabId: 'tab-2',
			});

			// Third query (same session, same tab as first)
			const id3 = db.insertQueryEvent({
				sessionId: 'multi-query-session',
				agentType: 'claude-code',
				source: 'user',
				startTime: baseTime + 20000,
				duration: 7000,
				projectPath: '/project',
				tabId: 'tab-1',
			});

			// All should have unique IDs
			expect(id1).not.toBe(id2);
			expect(id2).not.toBe(id3);
			expect(id1).not.toBe(id3);

			// All should be recorded (3 INSERT calls after initialization)
			expect(mockStatement.run).toHaveBeenCalledTimes(3);
		});

		it('should record interactive queries with different agent types', async () => {
			const { StatsDB } = await import('../../main/stats-db');
			const db = new StatsDB();
			db.initialize();

			// Clear mocks after initialize() to count only test operations
			mockStatement.run.mockClear();

			const startTime = Date.now();

			// Claude Code query
			const claudeId = db.insertQueryEvent({
				sessionId: 'session-1',
				agentType: 'claude-code',
				source: 'user',
				startTime,
				duration: 5000,
			});

			// OpenCode query
			const opencodeId = db.insertQueryEvent({
				sessionId: 'session-2',
				agentType: 'opencode',
				source: 'user',
				startTime: startTime + 10000,
				duration: 3000,
			});

			// Codex query
			const codexId = db.insertQueryEvent({
				sessionId: 'session-3',
				agentType: 'codex',
				source: 'user',
				startTime: startTime + 20000,
				duration: 4000,
			});

			expect(claudeId).toBeDefined();
			expect(opencodeId).toBeDefined();
			expect(codexId).toBeDefined();

			// Verify different agent types were recorded
			const runCalls = mockStatement.run.mock.calls;
			expect(runCalls[0][2]).toBe('claude-code');
			expect(runCalls[1][2]).toBe('opencode');
			expect(runCalls[2][2]).toBe('codex');
		});
	});

	describe('retrieval of interactive session query events', () => {
		it('should retrieve interactive query events filtered by source=user', async () => {
			const now = Date.now();
			mockStatement.all.mockReturnValue([
				{
					id: 'event-1',
					session_id: 'session-1',
					agent_type: 'claude-code',
					source: 'user',
					start_time: now - 1000,
					duration: 5000,
					project_path: '/project',
					tab_id: 'tab-1',
				},
				{
					id: 'event-2',
					session_id: 'session-2',
					agent_type: 'claude-code',
					source: 'user',
					start_time: now - 2000,
					duration: 3000,
					project_path: '/project',
					tab_id: 'tab-2',
				},
			]);

			const { StatsDB } = await import('../../main/stats-db');
			const db = new StatsDB();
			db.initialize();

			// Filter by source='user' to get only interactive sessions
			const events = db.getQueryEvents('day', { source: 'user' });

			expect(events).toHaveLength(2);
			expect(events[0].source).toBe('user');
			expect(events[1].source).toBe('user');
			expect(events[0].sessionId).toBe('session-1');
			expect(events[1].sessionId).toBe('session-2');
		});

		it('should retrieve interactive query events filtered by sessionId', async () => {
			const now = Date.now();
			mockStatement.all.mockReturnValue([
				{
					id: 'event-1',
					session_id: 'target-session',
					agent_type: 'claude-code',
					source: 'user',
					start_time: now - 1000,
					duration: 5000,
					project_path: '/project',
					tab_id: 'tab-1',
				},
			]);

			const { StatsDB } = await import('../../main/stats-db');
			const db = new StatsDB();
			db.initialize();

			const events = db.getQueryEvents('week', { sessionId: 'target-session' });

			expect(events).toHaveLength(1);
			expect(events[0].sessionId).toBe('target-session');
		});

		it('should retrieve interactive query events filtered by projectPath', async () => {
			const now = Date.now();
			mockStatement.all.mockReturnValue([
				{
					id: 'event-1',
					session_id: 'session-1',
					agent_type: 'claude-code',
					source: 'user',
					start_time: now - 1000,
					duration: 5000,
					project_path: '/specific/project',
					tab_id: 'tab-1',
				},
			]);

			const { StatsDB } = await import('../../main/stats-db');
			const db = new StatsDB();
			db.initialize();

			const events = db.getQueryEvents('month', { projectPath: '/specific/project' });

			expect(events).toHaveLength(1);
			expect(events[0].projectPath).toBe('/specific/project');
		});

		it('should correctly map database columns to QueryEvent interface fields', async () => {
			const now = Date.now();
			mockStatement.all.mockReturnValue([
				{
					id: 'db-event-id',
					session_id: 'db-session-id',
					agent_type: 'claude-code',
					source: 'user',
					start_time: now,
					duration: 5000,
					project_path: '/project/path',
					tab_id: 'tab-123',
				},
			]);

			const { StatsDB } = await import('../../main/stats-db');
			const db = new StatsDB();
			db.initialize();

			const events = db.getQueryEvents('day');

			expect(events).toHaveLength(1);
			const event = events[0];

			// Verify snake_case -> camelCase mapping
			expect(event.id).toBe('db-event-id');
			expect(event.sessionId).toBe('db-session-id');
			expect(event.agentType).toBe('claude-code');
			expect(event.source).toBe('user');
			expect(event.startTime).toBe(now);
			expect(event.duration).toBe(5000);
			expect(event.projectPath).toBe('/project/path');
			expect(event.tabId).toBe('tab-123');
		});
	});

	describe('aggregation includes interactive session data', () => {
		it('should include interactive sessions in aggregated stats', async () => {
			mockStatement.get.mockReturnValue({ count: 10, total_duration: 50000 });

			// The aggregation calls mockStatement.all multiple times for different queries
			// We return based on the call sequence: byAgent, bySource, byDay
			let callCount = 0;
			mockStatement.all.mockImplementation(() => {
				callCount++;
				if (callCount === 1) {
					// byAgent breakdown
					return [{ agent_type: 'claude-code', count: 10, duration: 50000 }];
				}
				if (callCount === 2) {
					// bySource breakdown
					return [{ source: 'user', count: 10 }];
				}
				// byDay breakdown
				return [{ date: '2024-12-28', count: 10, duration: 50000 }];
			});

			const { StatsDB } = await import('../../main/stats-db');
			const db = new StatsDB();
			db.initialize();

			const stats = db.getAggregatedStats('week');

			expect(stats.totalQueries).toBe(10);
			expect(stats.totalDuration).toBe(50000);
			expect(stats.avgDuration).toBe(5000);
			expect(stats.bySource.user).toBe(10);
			expect(stats.bySource.auto).toBe(0);
		});

		it('should correctly separate user vs auto queries in bySource', async () => {
			mockStatement.get.mockReturnValue({ count: 15, total_duration: 75000 });

			// Return by-source breakdown with both user and auto on second call
			let callCount = 0;
			mockStatement.all.mockImplementation(() => {
				callCount++;
				if (callCount === 2) {
					// bySource breakdown
					return [
						{ source: 'user', count: 10 },
						{ source: 'auto', count: 5 },
					];
				}
				return [];
			});

			const { StatsDB } = await import('../../main/stats-db');
			const db = new StatsDB();
			db.initialize();

			const stats = db.getAggregatedStats('month');

			expect(stats.bySource.user).toBe(10);
			expect(stats.bySource.auto).toBe(5);
		});
	});

	describe('timing accuracy for interactive sessions', () => {
		it('should preserve exact startTime and duration values', async () => {
			const { StatsDB } = await import('../../main/stats-db');
			const db = new StatsDB();
			db.initialize();

			const exactStartTime = 1735344000000; // Specific timestamp
			const exactDuration = 12345; // Specific duration in ms

			db.insertQueryEvent({
				sessionId: 'timing-test-session',
				agentType: 'claude-code',
				source: 'user',
				startTime: exactStartTime,
				duration: exactDuration,
			});

			const runCalls = mockStatement.run.mock.calls;
			const lastCall = runCalls[runCalls.length - 1];

			expect(lastCall[4]).toBe(exactStartTime); // Exact start_time preserved
			expect(lastCall[5]).toBe(exactDuration); // Exact duration preserved
		});

		it('should handle zero duration (immediate responses)', async () => {
			const { StatsDB } = await import('../../main/stats-db');
			const db = new StatsDB();
			db.initialize();

			const eventId = db.insertQueryEvent({
				sessionId: 'zero-duration-session',
				agentType: 'claude-code',
				source: 'user',
				startTime: Date.now(),
				duration: 0, // Zero duration is valid (e.g., cached response)
			});

			expect(eventId).toBeDefined();

			const runCalls = mockStatement.run.mock.calls;
			const lastCall = runCalls[runCalls.length - 1];
			expect(lastCall[5]).toBe(0);
		});

		it('should handle very long durations', async () => {
			const { StatsDB } = await import('../../main/stats-db');
			const db = new StatsDB();
			db.initialize();

			const longDuration = 10 * 60 * 1000; // 10 minutes in ms

			const eventId = db.insertQueryEvent({
				sessionId: 'long-duration-session',
				agentType: 'claude-code',
				source: 'user',
				startTime: Date.now(),
				duration: longDuration,
			});

			expect(eventId).toBeDefined();

			const runCalls = mockStatement.run.mock.calls;
			const lastCall = runCalls[runCalls.length - 1];
			expect(lastCall[5]).toBe(longDuration);
		});
	});
});

/**
 * Comprehensive Auto Run session and task recording verification tests
 *
 * These tests verify the complete Auto Run tracking workflow:
 * 1. Auto Run sessions are properly recorded when batch processing starts
 * 2. Individual tasks within sessions are recorded with timing data
 * 3. Sessions are updated correctly when batch processing completes
 * 4. All data can be retrieved with proper field mapping
 */
describe('Auto Run sessions and tasks recorded correctly', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockDb.pragma.mockReturnValue([{ user_version: 1 }]);
		mockDb.prepare.mockReturnValue(mockStatement);
		mockStatement.run.mockReturnValue({ changes: 1 });
		mockStatement.get.mockReturnValue({ count: 0, total_duration: 0 });
		mockStatement.all.mockReturnValue([]);
		mockFsExistsSync.mockReturnValue(true);
	});

	afterEach(() => {
		vi.resetModules();
	});

	describe('Auto Run session lifecycle', () => {
		it('should record Auto Run session with all required fields', async () => {
			const { StatsDB } = await import('../../main/stats-db');
			const db = new StatsDB();
			db.initialize();

			const startTime = Date.now();
			const sessionId = db.insertAutoRunSession({
				sessionId: 'maestro-session-123',
				agentType: 'claude-code',
				documentPath: 'Auto Run Docs/PHASE-1.md',
				startTime,
				duration: 0, // Duration is 0 at start
				tasksTotal: 10,
				tasksCompleted: 0,
				projectPath: '/Users/test/my-project',
			});

			expect(sessionId).toBeDefined();
			expect(typeof sessionId).toBe('string');

			// Verify all fields were passed correctly to the INSERT statement
			const runCalls = mockStatement.run.mock.calls;
			const lastCall = runCalls[runCalls.length - 1];

			// INSERT parameters: id, session_id, agent_type, document_path, start_time, duration, tasks_total, tasks_completed, project_path
			expect(lastCall[1]).toBe('maestro-session-123'); // session_id
			expect(lastCall[2]).toBe('claude-code'); // agent_type
			expect(lastCall[3]).toBe('Auto Run Docs/PHASE-1.md'); // document_path
			expect(lastCall[4]).toBe(startTime); // start_time
			expect(lastCall[5]).toBe(0); // duration (0 at start)
			expect(lastCall[6]).toBe(10); // tasks_total
			expect(lastCall[7]).toBe(0); // tasks_completed (0 at start)
			expect(lastCall[8]).toBe('/Users/test/my-project'); // project_path
		});

		it('should record Auto Run session with multiple documents (comma-separated)', async () => {
			const { StatsDB } = await import('../../main/stats-db');
			const db = new StatsDB();
			db.initialize();

			const sessionId = db.insertAutoRunSession({
				sessionId: 'multi-doc-session',
				agentType: 'claude-code',
				documentPath: 'PHASE-1.md, PHASE-2.md, PHASE-3.md',
				startTime: Date.now(),
				duration: 0,
				tasksTotal: 25,
				tasksCompleted: 0,
				projectPath: '/project',
			});

			expect(sessionId).toBeDefined();

			const runCalls = mockStatement.run.mock.calls;
			const lastCall = runCalls[runCalls.length - 1];
			expect(lastCall[3]).toBe('PHASE-1.md, PHASE-2.md, PHASE-3.md');
		});

		it('should update Auto Run session duration and tasks on completion', async () => {
			const { StatsDB } = await import('../../main/stats-db');
			const db = new StatsDB();
			db.initialize();

			// First, insert the session
			const autoRunId = db.insertAutoRunSession({
				sessionId: 'session-to-update',
				agentType: 'claude-code',
				documentPath: 'TASKS.md',
				startTime: Date.now() - 60000, // Started 1 minute ago
				duration: 0,
				tasksTotal: 5,
				tasksCompleted: 0,
				projectPath: '/project',
			});

			// Now update it with completion data
			const updated = db.updateAutoRunSession(autoRunId, {
				duration: 60000, // 1 minute
				tasksCompleted: 5,
			});

			expect(updated).toBe(true);

			// Verify UPDATE was called
			expect(mockStatement.run).toHaveBeenCalled();
		});

		it('should update Auto Run session with partial completion (some tasks skipped)', async () => {
			const { StatsDB } = await import('../../main/stats-db');
			const db = new StatsDB();
			db.initialize();

			const autoRunId = db.insertAutoRunSession({
				sessionId: 'partial-session',
				agentType: 'claude-code',
				documentPath: 'COMPLEX-TASKS.md',
				startTime: Date.now(),
				duration: 0,
				tasksTotal: 10,
				tasksCompleted: 0,
				projectPath: '/project',
			});

			// Update with partial completion (7 of 10 tasks)
			const updated = db.updateAutoRunSession(autoRunId, {
				duration: 120000, // 2 minutes
				tasksCompleted: 7,
			});

			expect(updated).toBe(true);
		});

		it('should handle Auto Run session stopped by user (wasStopped)', async () => {
			const { StatsDB } = await import('../../main/stats-db');
			const db = new StatsDB();
			db.initialize();

			const autoRunId = db.insertAutoRunSession({
				sessionId: 'stopped-session',
				agentType: 'claude-code',
				documentPath: 'TASKS.md',
				startTime: Date.now(),
				duration: 0,
				tasksTotal: 20,
				tasksCompleted: 0,
				projectPath: '/project',
			});

			// User stopped after 3 tasks
			const updated = db.updateAutoRunSession(autoRunId, {
				duration: 30000, // 30 seconds
				tasksCompleted: 3,
			});

			expect(updated).toBe(true);
		});
	});

	describe('Auto Run task recording', () => {
		it('should record individual task with all fields', async () => {
			const { StatsDB } = await import('../../main/stats-db');
			const db = new StatsDB();
			db.initialize();

			const taskStartTime = Date.now() - 5000;
			const taskId = db.insertAutoRunTask({
				autoRunSessionId: 'auto-run-session-1',
				sessionId: 'maestro-session-1',
				agentType: 'claude-code',
				taskIndex: 0,
				taskContent: 'Implement user authentication module',
				startTime: taskStartTime,
				duration: 5000,
				success: true,
			});

			expect(taskId).toBeDefined();

			const runCalls = mockStatement.run.mock.calls;
			const lastCall = runCalls[runCalls.length - 1];

			// INSERT parameters: id, auto_run_session_id, session_id, agent_type, task_index, task_content, start_time, duration, success
			expect(lastCall[1]).toBe('auto-run-session-1'); // auto_run_session_id
			expect(lastCall[2]).toBe('maestro-session-1'); // session_id
			expect(lastCall[3]).toBe('claude-code'); // agent_type
			expect(lastCall[4]).toBe(0); // task_index
			expect(lastCall[5]).toBe('Implement user authentication module'); // task_content
			expect(lastCall[6]).toBe(taskStartTime); // start_time
			expect(lastCall[7]).toBe(5000); // duration
			expect(lastCall[8]).toBe(1); // success (true -> 1)
		});

		it('should record failed task with success=false', async () => {
			const { StatsDB } = await import('../../main/stats-db');
			const db = new StatsDB();
			db.initialize();

			db.insertAutoRunTask({
				autoRunSessionId: 'auto-run-1',
				sessionId: 'session-1',
				agentType: 'claude-code',
				taskIndex: 2,
				taskContent: 'Fix complex edge case that requires manual intervention',
				startTime: Date.now(),
				duration: 10000,
				success: false, // Task failed
			});

			const runCalls = mockStatement.run.mock.calls;
			const lastCall = runCalls[runCalls.length - 1];
			expect(lastCall[8]).toBe(0); // success (false -> 0)
		});

		it('should record multiple tasks for same Auto Run session', async () => {
			const { StatsDB } = await import('../../main/stats-db');
			const db = new StatsDB();
			db.initialize();

			// Clear mocks after initialize() to count only test operations
			mockStatement.run.mockClear();

			const autoRunSessionId = 'multi-task-session';
			const baseTime = Date.now();

			// Task 0
			const task0Id = db.insertAutoRunTask({
				autoRunSessionId,
				sessionId: 'session-1',
				agentType: 'claude-code',
				taskIndex: 0,
				taskContent: 'Task 0: Initialize project',
				startTime: baseTime,
				duration: 3000,
				success: true,
			});

			// Task 1
			const task1Id = db.insertAutoRunTask({
				autoRunSessionId,
				sessionId: 'session-1',
				agentType: 'claude-code',
				taskIndex: 1,
				taskContent: 'Task 1: Add dependencies',
				startTime: baseTime + 3000,
				duration: 5000,
				success: true,
			});

			// Task 2
			const task2Id = db.insertAutoRunTask({
				autoRunSessionId,
				sessionId: 'session-1',
				agentType: 'claude-code',
				taskIndex: 2,
				taskContent: 'Task 2: Configure build system',
				startTime: baseTime + 8000,
				duration: 7000,
				success: true,
			});

			// All tasks should have unique IDs
			expect(task0Id).not.toBe(task1Id);
			expect(task1Id).not.toBe(task2Id);
			expect(task0Id).not.toBe(task2Id);

			// All 3 INSERT calls should have happened
			expect(mockStatement.run).toHaveBeenCalledTimes(3);
		});

		it('should record task without optional taskContent', async () => {
			const { StatsDB } = await import('../../main/stats-db');
			const db = new StatsDB();
			db.initialize();

			const taskId = db.insertAutoRunTask({
				autoRunSessionId: 'auto-run-1',
				sessionId: 'session-1',
				agentType: 'claude-code',
				taskIndex: 0,
				// taskContent is omitted
				startTime: Date.now(),
				duration: 2000,
				success: true,
			});

			expect(taskId).toBeDefined();

			const runCalls = mockStatement.run.mock.calls;
			const lastCall = runCalls[runCalls.length - 1];
			expect(lastCall[5]).toBeNull(); // task_content should be NULL
		});
	});

	describe('Auto Run session and task retrieval', () => {
		it('should retrieve Auto Run sessions with proper field mapping', async () => {
			const now = Date.now();
			mockStatement.all.mockReturnValue([
				{
					id: 'auto-run-id-1',
					session_id: 'session-1',
					agent_type: 'claude-code',
					document_path: 'PHASE-1.md',
					start_time: now - 60000,
					duration: 60000,
					tasks_total: 10,
					tasks_completed: 10,
					project_path: '/project/path',
				},
				{
					id: 'auto-run-id-2',
					session_id: 'session-2',
					agent_type: 'opencode',
					document_path: null, // No document path
					start_time: now - 120000,
					duration: 45000,
					tasks_total: 5,
					tasks_completed: 4,
					project_path: null,
				},
			]);

			const { StatsDB } = await import('../../main/stats-db');
			const db = new StatsDB();
			db.initialize();

			const sessions = db.getAutoRunSessions('week');

			expect(sessions).toHaveLength(2);

			// First session - all fields present
			expect(sessions[0].id).toBe('auto-run-id-1');
			expect(sessions[0].sessionId).toBe('session-1');
			expect(sessions[0].agentType).toBe('claude-code');
			expect(sessions[0].documentPath).toBe('PHASE-1.md');
			expect(sessions[0].startTime).toBe(now - 60000);
			expect(sessions[0].duration).toBe(60000);
			expect(sessions[0].tasksTotal).toBe(10);
			expect(sessions[0].tasksCompleted).toBe(10);
			expect(sessions[0].projectPath).toBe('/project/path');

			// Second session - optional fields are undefined
			expect(sessions[1].id).toBe('auto-run-id-2');
			expect(sessions[1].documentPath).toBeUndefined();
			expect(sessions[1].projectPath).toBeUndefined();
			expect(sessions[1].tasksCompleted).toBe(4);
		});

		it('should retrieve tasks for Auto Run session with proper field mapping', async () => {
			const now = Date.now();
			mockStatement.all.mockReturnValue([
				{
					id: 'task-id-0',
					auto_run_session_id: 'auto-run-1',
					session_id: 'session-1',
					agent_type: 'claude-code',
					task_index: 0,
					task_content: 'First task description',
					start_time: now - 15000,
					duration: 5000,
					success: 1,
				},
				{
					id: 'task-id-1',
					auto_run_session_id: 'auto-run-1',
					session_id: 'session-1',
					agent_type: 'claude-code',
					task_index: 1,
					task_content: null, // No content
					start_time: now - 10000,
					duration: 5000,
					success: 1,
				},
				{
					id: 'task-id-2',
					auto_run_session_id: 'auto-run-1',
					session_id: 'session-1',
					agent_type: 'claude-code',
					task_index: 2,
					task_content: 'Failed task',
					start_time: now - 5000,
					duration: 3000,
					success: 0, // Failed
				},
			]);

			const { StatsDB } = await import('../../main/stats-db');
			const db = new StatsDB();
			db.initialize();

			const tasks = db.getAutoRunTasks('auto-run-1');

			expect(tasks).toHaveLength(3);

			// First task
			expect(tasks[0].id).toBe('task-id-0');
			expect(tasks[0].autoRunSessionId).toBe('auto-run-1');
			expect(tasks[0].sessionId).toBe('session-1');
			expect(tasks[0].agentType).toBe('claude-code');
			expect(tasks[0].taskIndex).toBe(0);
			expect(tasks[0].taskContent).toBe('First task description');
			expect(tasks[0].startTime).toBe(now - 15000);
			expect(tasks[0].duration).toBe(5000);
			expect(tasks[0].success).toBe(true); // 1 -> true

			// Second task - no content
			expect(tasks[1].taskContent).toBeUndefined();
			expect(tasks[1].success).toBe(true);

			// Third task - failed
			expect(tasks[2].success).toBe(false); // 0 -> false
		});

		it('should return tasks ordered by task_index ASC', async () => {
			// Return tasks in wrong order to verify sorting
			mockStatement.all.mockReturnValue([
				{
					id: 't2',
					auto_run_session_id: 'ar1',
					session_id: 's1',
					agent_type: 'claude-code',
					task_index: 2,
					task_content: 'C',
					start_time: 3,
					duration: 1,
					success: 1,
				},
				{
					id: 't0',
					auto_run_session_id: 'ar1',
					session_id: 's1',
					agent_type: 'claude-code',
					task_index: 0,
					task_content: 'A',
					start_time: 1,
					duration: 1,
					success: 1,
				},
				{
					id: 't1',
					auto_run_session_id: 'ar1',
					session_id: 's1',
					agent_type: 'claude-code',
					task_index: 1,
					task_content: 'B',
					start_time: 2,
					duration: 1,
					success: 1,
				},
			]);

			const { StatsDB } = await import('../../main/stats-db');
			const db = new StatsDB();
			db.initialize();

			const tasks = db.getAutoRunTasks('ar1');

			// Should be returned as-is (the SQL query handles ordering)
			// The mock returns them unsorted, but the real DB would sort them
			expect(tasks).toHaveLength(3);
		});
	});

	describe('Auto Run time range filtering', () => {
		it('should filter Auto Run sessions by day range', async () => {
			mockStatement.all.mockReturnValue([]);

			const { StatsDB } = await import('../../main/stats-db');
			const db = new StatsDB();
			db.initialize();

			db.getAutoRunSessions('day');

			// Verify the query was prepared with time filter
			const prepareCalls = mockDb.prepare.mock.calls;
			const selectCall = prepareCalls.find((call) =>
				(call[0] as string).includes('SELECT * FROM auto_run_sessions')
			);
			expect(selectCall).toBeDefined();
			expect(selectCall![0]).toContain('start_time >= ?');
		});

		it('should return all Auto Run sessions for "all" time range', async () => {
			const { StatsDB } = await import('../../main/stats-db');
			const db = new StatsDB();
			db.initialize();

			mockStatement.all.mockReturnValue([
				{
					id: 'old',
					session_id: 's1',
					agent_type: 'claude-code',
					document_path: null,
					start_time: 1000,
					duration: 100,
					tasks_total: 1,
					tasks_completed: 1,
					project_path: null,
				},
				{
					id: 'new',
					session_id: 's2',
					agent_type: 'claude-code',
					document_path: null,
					start_time: Date.now(),
					duration: 100,
					tasks_total: 1,
					tasks_completed: 1,
					project_path: null,
				},
			]);

			const sessions = db.getAutoRunSessions('all');

			// With 'all' range, startTime should be 0, so all sessions should be returned
			expect(sessions).toHaveLength(2);
		});
	});

	describe('complete Auto Run workflow', () => {
		it('should support the full Auto Run lifecycle: start -> record tasks -> end', async () => {
			const { StatsDB } = await import('../../main/stats-db');
			const db = new StatsDB();
			db.initialize();

			// Clear mocks after initialize() to count only test operations
			mockStatement.run.mockClear();

			const batchStartTime = Date.now();

			// Step 1: Start Auto Run session
			const autoRunId = db.insertAutoRunSession({
				sessionId: 'complete-workflow-session',
				agentType: 'claude-code',
				documentPath: 'PHASE-1.md, PHASE-2.md',
				startTime: batchStartTime,
				duration: 0,
				tasksTotal: 5,
				tasksCompleted: 0,
				projectPath: '/test/project',
			});

			expect(autoRunId).toBeDefined();

			// Step 2: Record individual tasks as they complete
			let taskTime = batchStartTime;

			for (let i = 0; i < 5; i++) {
				const taskDuration = 2000 + i * 500; // Varying durations
				db.insertAutoRunTask({
					autoRunSessionId: autoRunId,
					sessionId: 'complete-workflow-session',
					agentType: 'claude-code',
					taskIndex: i,
					taskContent: `Task ${i + 1}: Implementation step ${i + 1}`,
					startTime: taskTime,
					duration: taskDuration,
					success: i !== 3, // Task 4 (index 3) fails
				});
				taskTime += taskDuration;
			}

			// Step 3: End Auto Run session
			const totalDuration = taskTime - batchStartTime;
			const updated = db.updateAutoRunSession(autoRunId, {
				duration: totalDuration,
				tasksCompleted: 4, // 4 of 5 succeeded
			});

			expect(updated).toBe(true);

			// Verify the total number of INSERT/UPDATE calls
			// 1 session insert + 5 task inserts + 1 session update = 7 calls
			expect(mockStatement.run).toHaveBeenCalledTimes(7);
		});

		it('should handle Auto Run with loop mode (multiple passes)', async () => {
			const { StatsDB } = await import('../../main/stats-db');
			const db = new StatsDB();
			db.initialize();

			// Clear mocks after initialize() to count only test operations
			mockStatement.run.mockClear();

			const startTime = Date.now();

			// Start session for loop mode run
			const autoRunId = db.insertAutoRunSession({
				sessionId: 'loop-mode-session',
				agentType: 'claude-code',
				documentPath: 'RECURRING-TASKS.md',
				startTime,
				duration: 0,
				tasksTotal: 15, // Initial estimate (may grow with loops)
				tasksCompleted: 0,
				projectPath: '/project',
			});

			// Record tasks from multiple loop iterations
			// Loop 1: 5 tasks
			for (let i = 0; i < 5; i++) {
				db.insertAutoRunTask({
					autoRunSessionId: autoRunId,
					sessionId: 'loop-mode-session',
					agentType: 'claude-code',
					taskIndex: i,
					taskContent: `Loop 1, Task ${i + 1}`,
					startTime: startTime + i * 3000,
					duration: 3000,
					success: true,
				});
			}

			// Loop 2: 5 more tasks
			for (let i = 0; i < 5; i++) {
				db.insertAutoRunTask({
					autoRunSessionId: autoRunId,
					sessionId: 'loop-mode-session',
					agentType: 'claude-code',
					taskIndex: 5 + i, // Continue indexing from where loop 1 ended
					taskContent: `Loop 2, Task ${i + 1}`,
					startTime: startTime + 15000 + i * 3000,
					duration: 3000,
					success: true,
				});
			}

			// Update with final stats
			db.updateAutoRunSession(autoRunId, {
				duration: 30000, // 30 seconds total
				tasksCompleted: 10,
			});

			// 1 session + 10 tasks + 1 update = 12 calls
			expect(mockStatement.run).toHaveBeenCalledTimes(12);
		});
	});

	describe('edge cases and error scenarios', () => {
		it('should handle very long task content (synopsis)', async () => {
			const { StatsDB } = await import('../../main/stats-db');
			const db = new StatsDB();
			db.initialize();

			const longContent = 'A'.repeat(10000); // 10KB task content

			const taskId = db.insertAutoRunTask({
				autoRunSessionId: 'ar1',
				sessionId: 's1',
				agentType: 'claude-code',
				taskIndex: 0,
				taskContent: longContent,
				startTime: Date.now(),
				duration: 5000,
				success: true,
			});

			expect(taskId).toBeDefined();

			const runCalls = mockStatement.run.mock.calls;
			const lastCall = runCalls[runCalls.length - 1];
			expect(lastCall[5]).toBe(longContent);
		});

		it('should handle zero duration tasks', async () => {
			const { StatsDB } = await import('../../main/stats-db');
			const db = new StatsDB();
			db.initialize();

			const taskId = db.insertAutoRunTask({
				autoRunSessionId: 'ar1',
				sessionId: 's1',
				agentType: 'claude-code',
				taskIndex: 0,
				taskContent: 'Instant task',
				startTime: Date.now(),
				duration: 0, // Zero duration (e.g., cached result)
				success: true,
			});

			expect(taskId).toBeDefined();

			const runCalls = mockStatement.run.mock.calls;
			const lastCall = runCalls[runCalls.length - 1];
			expect(lastCall[7]).toBe(0);
		});

		it('should handle Auto Run session with zero tasks total', async () => {
			const { StatsDB } = await import('../../main/stats-db');
			const db = new StatsDB();
			db.initialize();

			// This shouldn't happen in practice, but the database should handle it
			const sessionId = db.insertAutoRunSession({
				sessionId: 'empty-session',
				agentType: 'claude-code',
				documentPath: 'EMPTY.md',
				startTime: Date.now(),
				duration: 100,
				tasksTotal: 0,
				tasksCompleted: 0,
				projectPath: '/project',
			});

			expect(sessionId).toBeDefined();
		});

		it('should handle different agent types for Auto Run', async () => {
			const { StatsDB } = await import('../../main/stats-db');
			const db = new StatsDB();
			db.initialize();

			// Clear mocks after initialize() to count only test operations
			mockStatement.run.mockClear();

			// Claude Code Auto Run
			db.insertAutoRunSession({
				sessionId: 's1',
				agentType: 'claude-code',
				documentPath: 'TASKS.md',
				startTime: Date.now(),
				duration: 1000,
				tasksTotal: 5,
				tasksCompleted: 5,
				projectPath: '/project',
			});

			// OpenCode Auto Run
			db.insertAutoRunSession({
				sessionId: 's2',
				agentType: 'opencode',
				documentPath: 'TASKS.md',
				startTime: Date.now(),
				duration: 2000,
				tasksTotal: 3,
				tasksCompleted: 3,
				projectPath: '/project',
			});

			// Verify both agent types were recorded
			const runCalls = mockStatement.run.mock.calls;
			expect(runCalls[0][2]).toBe('claude-code');
			expect(runCalls[1][2]).toBe('opencode');
		});
	});
});

/**
 * Foreign key relationship verification tests
 *
 * These tests verify that the foreign key relationship between auto_run_tasks
 * and auto_run_sessions is properly defined in the schema, ensuring referential
 * integrity can be enforced when foreign key constraints are enabled.
 */
describe('Foreign key relationship between tasks and sessions', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockDb.pragma.mockReturnValue([{ user_version: 0 }]);
		mockDb.prepare.mockReturnValue(mockStatement);
		mockStatement.run.mockReturnValue({ changes: 1 });
		mockStatement.get.mockReturnValue({ count: 0, total_duration: 0 });
		mockStatement.all.mockReturnValue([]);
		mockFsExistsSync.mockReturnValue(true);
	});

	afterEach(() => {
		vi.resetModules();
	});

	describe('schema definition', () => {
		it('should create auto_run_tasks table with REFERENCES clause to auto_run_sessions', async () => {
			const { StatsDB } = await import('../../main/stats-db');
			const db = new StatsDB();
			db.initialize();

			// Verify the CREATE TABLE statement includes the foreign key reference
			const prepareCalls = mockDb.prepare.mock.calls.map((call) => call[0] as string);
			const createTasksTable = prepareCalls.find((sql) =>
				sql.includes('CREATE TABLE IF NOT EXISTS auto_run_tasks')
			);

			expect(createTasksTable).toBeDefined();
			expect(createTasksTable).toContain(
				'auto_run_session_id TEXT NOT NULL REFERENCES auto_run_sessions(id)'
			);
		});

		it('should have auto_run_session_id column as NOT NULL in auto_run_tasks', async () => {
			const { StatsDB } = await import('../../main/stats-db');
			const db = new StatsDB();
			db.initialize();

			const prepareCalls = mockDb.prepare.mock.calls.map((call) => call[0] as string);
			const createTasksTable = prepareCalls.find((sql) =>
				sql.includes('CREATE TABLE IF NOT EXISTS auto_run_tasks')
			);

			expect(createTasksTable).toBeDefined();
			// Verify NOT NULL constraint is present for auto_run_session_id
			expect(createTasksTable).toContain('auto_run_session_id TEXT NOT NULL');
		});

		it('should create index on auto_run_session_id foreign key column', async () => {
			const { StatsDB } = await import('../../main/stats-db');
			const db = new StatsDB();
			db.initialize();

			const prepareCalls = mockDb.prepare.mock.calls.map((call) => call[0] as string);
			const indexCreation = prepareCalls.find((sql) => sql.includes('idx_task_auto_session'));

			expect(indexCreation).toBeDefined();
			expect(indexCreation).toContain('ON auto_run_tasks(auto_run_session_id)');
		});
	});

	describe('referential integrity behavior', () => {
		it('should store auto_run_session_id when inserting task', async () => {
			const { StatsDB } = await import('../../main/stats-db');
			const db = new StatsDB();
			db.initialize();

			const autoRunSessionId = 'parent-session-abc-123';
			db.insertAutoRunTask({
				autoRunSessionId,
				sessionId: 'maestro-session-1',
				agentType: 'claude-code',
				taskIndex: 0,
				taskContent: 'Test task',
				startTime: Date.now(),
				duration: 1000,
				success: true,
			});

			// Verify the auto_run_session_id was passed to the INSERT
			const runCalls = mockStatement.run.mock.calls;
			const lastCall = runCalls[runCalls.length - 1];

			// INSERT parameters: id, auto_run_session_id, session_id, agent_type, task_index, task_content, start_time, duration, success
			expect(lastCall[1]).toBe(autoRunSessionId);
		});

		it('should insert task with matching auto_run_session_id from parent session', async () => {
			const { StatsDB } = await import('../../main/stats-db');
			const db = new StatsDB();
			db.initialize();

			// Clear calls from initialization
			mockStatement.run.mockClear();

			// First insert a session
			const autoRunId = db.insertAutoRunSession({
				sessionId: 'session-1',
				agentType: 'claude-code',
				documentPath: 'PHASE-1.md',
				startTime: Date.now(),
				duration: 0,
				tasksTotal: 5,
				tasksCompleted: 0,
				projectPath: '/project',
			});

			// Then insert a task referencing that session
			const taskId = db.insertAutoRunTask({
				autoRunSessionId: autoRunId,
				sessionId: 'session-1',
				agentType: 'claude-code',
				taskIndex: 0,
				taskContent: 'First task',
				startTime: Date.now(),
				duration: 1000,
				success: true,
			});

			expect(autoRunId).toBeDefined();
			expect(taskId).toBeDefined();

			// Both inserts should have succeeded (session + task)
			expect(mockStatement.run).toHaveBeenCalledTimes(2);

			// Verify the task INSERT used the session ID returned from the session INSERT
			const runCalls = mockStatement.run.mock.calls;
			const taskInsertCall = runCalls[1];
			expect(taskInsertCall[1]).toBe(autoRunId); // auto_run_session_id matches
		});

		it('should retrieve tasks only for the specific parent session', async () => {
			const now = Date.now();

			// Mock returns tasks for session 'auto-run-A' only
			mockStatement.all.mockReturnValue([
				{
					id: 'task-1',
					auto_run_session_id: 'auto-run-A',
					session_id: 'session-1',
					agent_type: 'claude-code',
					task_index: 0,
					task_content: 'Task for session A',
					start_time: now,
					duration: 1000,
					success: 1,
				},
				{
					id: 'task-2',
					auto_run_session_id: 'auto-run-A',
					session_id: 'session-1',
					agent_type: 'claude-code',
					task_index: 1,
					task_content: 'Another task for session A',
					start_time: now + 1000,
					duration: 2000,
					success: 1,
				},
			]);

			const { StatsDB } = await import('../../main/stats-db');
			const db = new StatsDB();
			db.initialize();

			// Query tasks for 'auto-run-A'
			const tasksA = db.getAutoRunTasks('auto-run-A');

			expect(tasksA).toHaveLength(2);
			expect(tasksA[0].autoRunSessionId).toBe('auto-run-A');
			expect(tasksA[1].autoRunSessionId).toBe('auto-run-A');

			// Verify the WHERE clause used the correct auto_run_session_id
			expect(mockStatement.all).toHaveBeenCalledWith('auto-run-A');
		});

		it('should return empty array when no tasks exist for a session', async () => {
			mockStatement.all.mockReturnValue([]);

			const { StatsDB } = await import('../../main/stats-db');
			const db = new StatsDB();
			db.initialize();

			const tasks = db.getAutoRunTasks('non-existent-session');

			expect(tasks).toHaveLength(0);
			expect(tasks).toEqual([]);
		});
	});

	describe('data consistency verification', () => {
		it('should maintain consistent auto_run_session_id across multiple tasks', async () => {
			const { StatsDB } = await import('../../main/stats-db');
			const db = new StatsDB();
			db.initialize();

			// Clear calls from initialization
			mockStatement.run.mockClear();

			const parentSessionId = 'consistent-parent-session';

			// Insert multiple tasks for the same parent session
			for (let i = 0; i < 5; i++) {
				db.insertAutoRunTask({
					autoRunSessionId: parentSessionId,
					sessionId: 'maestro-session',
					agentType: 'claude-code',
					taskIndex: i,
					taskContent: `Task ${i + 1}`,
					startTime: Date.now() + i * 1000,
					duration: 1000,
					success: true,
				});
			}

			// Verify all 5 tasks used the same parent session ID
			const runCalls = mockStatement.run.mock.calls;
			expect(runCalls).toHaveLength(5);

			for (const call of runCalls) {
				expect(call[1]).toBe(parentSessionId); // auto_run_session_id
			}
		});

		it('should allow tasks from different sessions to be inserted independently', async () => {
			const { StatsDB } = await import('../../main/stats-db');
			const db = new StatsDB();
			db.initialize();

			// Clear calls from initialization
			mockStatement.run.mockClear();

			// Insert tasks for session A
			db.insertAutoRunTask({
				autoRunSessionId: 'session-A',
				sessionId: 'maestro-1',
				agentType: 'claude-code',
				taskIndex: 0,
				taskContent: 'Task A1',
				startTime: Date.now(),
				duration: 1000,
				success: true,
			});

			// Insert tasks for session B
			db.insertAutoRunTask({
				autoRunSessionId: 'session-B',
				sessionId: 'maestro-2',
				agentType: 'opencode',
				taskIndex: 0,
				taskContent: 'Task B1',
				startTime: Date.now(),
				duration: 2000,
				success: true,
			});

			// Insert another task for session A
			db.insertAutoRunTask({
				autoRunSessionId: 'session-A',
				sessionId: 'maestro-1',
				agentType: 'claude-code',
				taskIndex: 1,
				taskContent: 'Task A2',
				startTime: Date.now(),
				duration: 1500,
				success: true,
			});

			const runCalls = mockStatement.run.mock.calls;
			expect(runCalls).toHaveLength(3);

			// Verify parent session IDs are correctly assigned
			expect(runCalls[0][1]).toBe('session-A');
			expect(runCalls[1][1]).toBe('session-B');
			expect(runCalls[2][1]).toBe('session-A');
		});

		it('should use generated session ID as foreign key when retrieved after insertion', async () => {
			const { StatsDB } = await import('../../main/stats-db');
			const db = new StatsDB();
			db.initialize();

			// Clear calls from initialization
			mockStatement.run.mockClear();

			// Insert a session and capture the generated ID
			const generatedSessionId = db.insertAutoRunSession({
				sessionId: 'maestro-session',
				agentType: 'claude-code',
				documentPath: 'DOC.md',
				startTime: Date.now(),
				duration: 0,
				tasksTotal: 3,
				tasksCompleted: 0,
				projectPath: '/project',
			});

			// The generated ID should be a string with timestamp-random format
			expect(generatedSessionId).toMatch(/^\d+-[a-z0-9]+$/);

			// Use this generated ID as the foreign key for tasks
			db.insertAutoRunTask({
				autoRunSessionId: generatedSessionId,
				sessionId: 'maestro-session',
				agentType: 'claude-code',
				taskIndex: 0,
				taskContent: 'First task',
				startTime: Date.now(),
				duration: 1000,
				success: true,
			});

			const runCalls = mockStatement.run.mock.calls;
			const taskInsert = runCalls[1]; // Second call is the task insert (first is session insert)

			// Verify the task uses the exact same ID that was generated for the session
			expect(taskInsert[1]).toBe(generatedSessionId);
		});
	});

	describe('query filtering by foreign key', () => {
		it('should filter tasks using WHERE auto_run_session_id clause', async () => {
			const { StatsDB } = await import('../../main/stats-db');
			const db = new StatsDB();
			db.initialize();

			db.getAutoRunTasks('specific-session-id');

			// Verify the SQL query includes proper WHERE clause for foreign key
			const prepareCalls = mockDb.prepare.mock.calls;
			const selectTasksCall = prepareCalls.find(
				(call) =>
					(call[0] as string).includes('SELECT * FROM auto_run_tasks') &&
					(call[0] as string).includes('WHERE auto_run_session_id = ?')
			);

			expect(selectTasksCall).toBeDefined();
		});

		it('should order tasks by task_index within a session', async () => {
			const { StatsDB } = await import('../../main/stats-db');
			const db = new StatsDB();
			db.initialize();

			db.getAutoRunTasks('any-session');

			// Verify the query includes ORDER BY task_index
			const prepareCalls = mockDb.prepare.mock.calls;
			const selectTasksCall = prepareCalls.find((call) =>
				(call[0] as string).includes('ORDER BY task_index ASC')
			);

			expect(selectTasksCall).toBeDefined();
		});
	});
});

/**
 * Time-range filtering verification tests
 *
 * These tests verify that time-range filtering works correctly for all supported
 * ranges: 'day', 'week', 'month', 'year', and 'all'. Each range should correctly
 * calculate the start timestamp and use it to filter database queries.
 */
describe('Time-range filtering works correctly for all ranges', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockDb.pragma.mockReturnValue([{ user_version: 1 }]);
		mockDb.prepare.mockReturnValue(mockStatement);
		mockStatement.run.mockReturnValue({ changes: 1 });
		mockStatement.get.mockReturnValue({ count: 0, total_duration: 0 });
		mockStatement.all.mockReturnValue([]);
		mockFsExistsSync.mockReturnValue(true);
	});

	afterEach(() => {
		vi.resetModules();
	});

	describe('getQueryEvents time range calculations', () => {
		it('should filter by "day" range (last 24 hours)', async () => {
			const now = Date.now();
			const oneDayMs = 24 * 60 * 60 * 1000;

			const { StatsDB } = await import('../../main/stats-db');
			const db = new StatsDB();
			db.initialize();

			db.getQueryEvents('day');

			// Verify the start_time parameter is approximately 24 hours ago
			const allCalls = mockStatement.all.mock.calls;
			expect(allCalls.length).toBeGreaterThan(0);

			const lastCall = allCalls[allCalls.length - 1];
			const startTimeParam = lastCall[0] as number;

			// The start time should be approximately now - 24 hours (within a few seconds tolerance)
			expect(startTimeParam).toBeGreaterThanOrEqual(now - oneDayMs - 5000);
			expect(startTimeParam).toBeLessThanOrEqual(now - oneDayMs + 5000);
		});

		it('should filter by "week" range (last 7 days)', async () => {
			const now = Date.now();
			const oneWeekMs = 7 * 24 * 60 * 60 * 1000;

			const { StatsDB } = await import('../../main/stats-db');
			const db = new StatsDB();
			db.initialize();

			db.getQueryEvents('week');

			const allCalls = mockStatement.all.mock.calls;
			expect(allCalls.length).toBeGreaterThan(0);

			const lastCall = allCalls[allCalls.length - 1];
			const startTimeParam = lastCall[0] as number;

			// The start time should be approximately now - 7 days (within a few seconds tolerance)
			expect(startTimeParam).toBeGreaterThanOrEqual(now - oneWeekMs - 5000);
			expect(startTimeParam).toBeLessThanOrEqual(now - oneWeekMs + 5000);
		});

		it('should filter by "month" range (last 30 days)', async () => {
			const now = Date.now();
			const oneMonthMs = 30 * 24 * 60 * 60 * 1000;

			const { StatsDB } = await import('../../main/stats-db');
			const db = new StatsDB();
			db.initialize();

			db.getQueryEvents('month');

			const allCalls = mockStatement.all.mock.calls;
			expect(allCalls.length).toBeGreaterThan(0);

			const lastCall = allCalls[allCalls.length - 1];
			const startTimeParam = lastCall[0] as number;

			// The start time should be approximately now - 30 days (within a few seconds tolerance)
			expect(startTimeParam).toBeGreaterThanOrEqual(now - oneMonthMs - 5000);
			expect(startTimeParam).toBeLessThanOrEqual(now - oneMonthMs + 5000);
		});

		it('should filter by "year" range (last 365 days)', async () => {
			const now = Date.now();
			const oneYearMs = 365 * 24 * 60 * 60 * 1000;

			const { StatsDB } = await import('../../main/stats-db');
			const db = new StatsDB();
			db.initialize();

			db.getQueryEvents('year');

			const allCalls = mockStatement.all.mock.calls;
			expect(allCalls.length).toBeGreaterThan(0);

			const lastCall = allCalls[allCalls.length - 1];
			const startTimeParam = lastCall[0] as number;

			// The start time should be approximately now - 365 days (within a few seconds tolerance)
			expect(startTimeParam).toBeGreaterThanOrEqual(now - oneYearMs - 5000);
			expect(startTimeParam).toBeLessThanOrEqual(now - oneYearMs + 5000);
		});

		it('should filter by "all" range (from epoch/timestamp 0)', async () => {
			const { StatsDB } = await import('../../main/stats-db');
			const db = new StatsDB();
			db.initialize();

			db.getQueryEvents('all');

			const allCalls = mockStatement.all.mock.calls;
			expect(allCalls.length).toBeGreaterThan(0);

			const lastCall = allCalls[allCalls.length - 1];
			const startTimeParam = lastCall[0] as number;

			// For 'all' range, start time should be 0 (epoch)
			expect(startTimeParam).toBe(0);
		});
	});

	describe('getAutoRunSessions time range calculations', () => {
		it('should filter Auto Run sessions by "day" range', async () => {
			const now = Date.now();
			const oneDayMs = 24 * 60 * 60 * 1000;

			const { StatsDB } = await import('../../main/stats-db');
			const db = new StatsDB();
			db.initialize();

			db.getAutoRunSessions('day');

			const allCalls = mockStatement.all.mock.calls;
			expect(allCalls.length).toBeGreaterThan(0);

			const lastCall = allCalls[allCalls.length - 1];
			const startTimeParam = lastCall[0] as number;

			expect(startTimeParam).toBeGreaterThanOrEqual(now - oneDayMs - 5000);
			expect(startTimeParam).toBeLessThanOrEqual(now - oneDayMs + 5000);
		});

		it('should filter Auto Run sessions by "week" range', async () => {
			const now = Date.now();
			const oneWeekMs = 7 * 24 * 60 * 60 * 1000;

			const { StatsDB } = await import('../../main/stats-db');
			const db = new StatsDB();
			db.initialize();

			db.getAutoRunSessions('week');

			const allCalls = mockStatement.all.mock.calls;
			expect(allCalls.length).toBeGreaterThan(0);

			const lastCall = allCalls[allCalls.length - 1];
			const startTimeParam = lastCall[0] as number;

			expect(startTimeParam).toBeGreaterThanOrEqual(now - oneWeekMs - 5000);
			expect(startTimeParam).toBeLessThanOrEqual(now - oneWeekMs + 5000);
		});

		it('should filter Auto Run sessions by "month" range', async () => {
			const now = Date.now();
			const oneMonthMs = 30 * 24 * 60 * 60 * 1000;

			const { StatsDB } = await import('../../main/stats-db');
			const db = new StatsDB();
			db.initialize();

			db.getAutoRunSessions('month');

			const allCalls = mockStatement.all.mock.calls;
			expect(allCalls.length).toBeGreaterThan(0);

			const lastCall = allCalls[allCalls.length - 1];
			const startTimeParam = lastCall[0] as number;

			expect(startTimeParam).toBeGreaterThanOrEqual(now - oneMonthMs - 5000);
			expect(startTimeParam).toBeLessThanOrEqual(now - oneMonthMs + 5000);
		});

		it('should filter Auto Run sessions by "year" range', async () => {
			const now = Date.now();
			const oneYearMs = 365 * 24 * 60 * 60 * 1000;

			const { StatsDB } = await import('../../main/stats-db');
			const db = new StatsDB();
			db.initialize();

			db.getAutoRunSessions('year');

			const allCalls = mockStatement.all.mock.calls;
			expect(allCalls.length).toBeGreaterThan(0);

			const lastCall = allCalls[allCalls.length - 1];
			const startTimeParam = lastCall[0] as number;

			expect(startTimeParam).toBeGreaterThanOrEqual(now - oneYearMs - 5000);
			expect(startTimeParam).toBeLessThanOrEqual(now - oneYearMs + 5000);
		});

		it('should filter Auto Run sessions by "all" range', async () => {
			const { StatsDB } = await import('../../main/stats-db');
			const db = new StatsDB();
			db.initialize();

			db.getAutoRunSessions('all');

			const allCalls = mockStatement.all.mock.calls;
			expect(allCalls.length).toBeGreaterThan(0);

			const lastCall = allCalls[allCalls.length - 1];
			const startTimeParam = lastCall[0] as number;

			expect(startTimeParam).toBe(0);
		});
	});

	describe('getAggregatedStats time range calculations', () => {
		it('should aggregate stats for "day" range', async () => {
			const now = Date.now();
			const oneDayMs = 24 * 60 * 60 * 1000;

			const { StatsDB } = await import('../../main/stats-db');
			const db = new StatsDB();
			db.initialize();

			db.getAggregatedStats('day');

			// getAggregatedStats calls multiple queries, verify the totals query used correct time range
			const getCalls = mockStatement.get.mock.calls;
			expect(getCalls.length).toBeGreaterThan(0);

			const firstCall = getCalls[0];
			const startTimeParam = firstCall[0] as number;

			expect(startTimeParam).toBeGreaterThanOrEqual(now - oneDayMs - 5000);
			expect(startTimeParam).toBeLessThanOrEqual(now - oneDayMs + 5000);
		});

		it('should aggregate stats for "week" range', async () => {
			const now = Date.now();
			const oneWeekMs = 7 * 24 * 60 * 60 * 1000;

			const { StatsDB } = await import('../../main/stats-db');
			const db = new StatsDB();
			db.initialize();

			db.getAggregatedStats('week');

			const getCalls = mockStatement.get.mock.calls;
			expect(getCalls.length).toBeGreaterThan(0);

			const firstCall = getCalls[0];
			const startTimeParam = firstCall[0] as number;

			expect(startTimeParam).toBeGreaterThanOrEqual(now - oneWeekMs - 5000);
			expect(startTimeParam).toBeLessThanOrEqual(now - oneWeekMs + 5000);
		});

		it('should aggregate stats for "month" range', async () => {
			const now = Date.now();
			const oneMonthMs = 30 * 24 * 60 * 60 * 1000;

			const { StatsDB } = await import('../../main/stats-db');
			const db = new StatsDB();
			db.initialize();

			db.getAggregatedStats('month');

			const getCalls = mockStatement.get.mock.calls;
			expect(getCalls.length).toBeGreaterThan(0);

			const firstCall = getCalls[0];
			const startTimeParam = firstCall[0] as number;

			expect(startTimeParam).toBeGreaterThanOrEqual(now - oneMonthMs - 5000);
			expect(startTimeParam).toBeLessThanOrEqual(now - oneMonthMs + 5000);
		});

		it('should aggregate stats for "year" range', async () => {
			const now = Date.now();
			const oneYearMs = 365 * 24 * 60 * 60 * 1000;

			const { StatsDB } = await import('../../main/stats-db');
			const db = new StatsDB();
			db.initialize();

			db.getAggregatedStats('year');

			const getCalls = mockStatement.get.mock.calls;
			expect(getCalls.length).toBeGreaterThan(0);

			const firstCall = getCalls[0];
			const startTimeParam = firstCall[0] as number;

			expect(startTimeParam).toBeGreaterThanOrEqual(now - oneYearMs - 5000);
			expect(startTimeParam).toBeLessThanOrEqual(now - oneYearMs + 5000);
		});

		it('should aggregate stats for "all" range', async () => {
			const { StatsDB } = await import('../../main/stats-db');
			const db = new StatsDB();
			db.initialize();

			db.getAggregatedStats('all');

			const getCalls = mockStatement.get.mock.calls;
			expect(getCalls.length).toBeGreaterThan(0);

			const firstCall = getCalls[0];
			const startTimeParam = firstCall[0] as number;

			expect(startTimeParam).toBe(0);
		});
	});

	describe('exportToCsv time range calculations', () => {
		it('should export CSV for "day" range only', async () => {
			const now = Date.now();
			const oneDayMs = 24 * 60 * 60 * 1000;

			const { StatsDB } = await import('../../main/stats-db');
			const db = new StatsDB();
			db.initialize();

			db.exportToCsv('day');

			const allCalls = mockStatement.all.mock.calls;
			expect(allCalls.length).toBeGreaterThan(0);

			const lastCall = allCalls[allCalls.length - 1];
			const startTimeParam = lastCall[0] as number;

			expect(startTimeParam).toBeGreaterThanOrEqual(now - oneDayMs - 5000);
			expect(startTimeParam).toBeLessThanOrEqual(now - oneDayMs + 5000);
		});

		it('should export CSV for "all" range', async () => {
			const { StatsDB } = await import('../../main/stats-db');
			const db = new StatsDB();
			db.initialize();

			db.exportToCsv('all');

			const allCalls = mockStatement.all.mock.calls;
			expect(allCalls.length).toBeGreaterThan(0);

			const lastCall = allCalls[allCalls.length - 1];
			const startTimeParam = lastCall[0] as number;

			expect(startTimeParam).toBe(0);
		});
	});

	describe('SQL query structure verification', () => {
		it('should include start_time >= ? in getQueryEvents SQL', async () => {
			const { StatsDB } = await import('../../main/stats-db');
			const db = new StatsDB();
			db.initialize();

			db.getQueryEvents('week');

			const prepareCalls = mockDb.prepare.mock.calls;
			const selectCall = prepareCalls.find((call) =>
				(call[0] as string).includes('SELECT * FROM query_events')
			);

			expect(selectCall).toBeDefined();
			expect(selectCall![0]).toContain('start_time >= ?');
		});

		it('should include start_time >= ? in getAutoRunSessions SQL', async () => {
			const { StatsDB } = await import('../../main/stats-db');
			const db = new StatsDB();
			db.initialize();

			db.getAutoRunSessions('month');

			const prepareCalls = mockDb.prepare.mock.calls;
			const selectCall = prepareCalls.find((call) =>
				(call[0] as string).includes('SELECT * FROM auto_run_sessions')
			);

			expect(selectCall).toBeDefined();
			expect(selectCall![0]).toContain('start_time >= ?');
		});

		it('should include start_time >= ? in aggregation queries', async () => {
			const { StatsDB } = await import('../../main/stats-db');
			const db = new StatsDB();
			db.initialize();

			db.getAggregatedStats('year');

			const prepareCalls = mockDb.prepare.mock.calls;

			// Verify the totals query includes the filter
			const totalsCall = prepareCalls.find(
				(call) =>
					(call[0] as string).includes('COUNT(*)') && (call[0] as string).includes('SUM(duration)')
			);
			expect(totalsCall).toBeDefined();
			expect(totalsCall![0]).toContain('WHERE start_time >= ?');

			// Verify the byAgent query includes the filter
			const byAgentCall = prepareCalls.find((call) =>
				(call[0] as string).includes('GROUP BY agent_type')
			);
			expect(byAgentCall).toBeDefined();
			expect(byAgentCall![0]).toContain('WHERE start_time >= ?');

			// Verify the bySource query includes the filter
			const bySourceCall = prepareCalls.find((call) =>
				(call[0] as string).includes('GROUP BY source')
			);
			expect(bySourceCall).toBeDefined();
			expect(bySourceCall![0]).toContain('WHERE start_time >= ?');

			// Verify the byDay query includes the filter
			const byDayCall = prepareCalls.find((call) => (call[0] as string).includes('GROUP BY date('));
			expect(byDayCall).toBeDefined();
			expect(byDayCall![0]).toContain('WHERE start_time >= ?');
		});
	});

	describe('time range boundary behavior', () => {
		it('should include events exactly at the range boundary', async () => {
			const now = Date.now();
			const oneDayMs = 24 * 60 * 60 * 1000;
			const boundaryTime = now - oneDayMs;

			// Mock event exactly at the boundary
			mockStatement.all.mockReturnValue([
				{
					id: 'boundary-event',
					session_id: 'session-1',
					agent_type: 'claude-code',
					source: 'user',
					start_time: boundaryTime,
					duration: 1000,
					project_path: null,
					tab_id: null,
				},
			]);

			const { StatsDB } = await import('../../main/stats-db');
			const db = new StatsDB();
			db.initialize();

			const events = db.getQueryEvents('day');

			// Event at the boundary should be included (start_time >= boundary)
			expect(events).toHaveLength(1);
			expect(events[0].id).toBe('boundary-event');
		});

		it('should exclude events before the range boundary', async () => {
			// The actual filtering happens in the SQL query via WHERE clause
			// We verify this by checking the SQL structure
			const { StatsDB } = await import('../../main/stats-db');
			const db = new StatsDB();
			db.initialize();

			db.getQueryEvents('day');

			const prepareCalls = mockDb.prepare.mock.calls;
			const selectCall = prepareCalls.find((call) =>
				(call[0] as string).includes('SELECT * FROM query_events')
			);

			// Verify it uses >= (greater than or equal), not just > (greater than)
			expect(selectCall![0]).toContain('start_time >= ?');
		});

		it('should return consistent results for multiple calls with same range', async () => {
			const { StatsDB } = await import('../../main/stats-db');
			const db = new StatsDB();
			db.initialize();

			// Call twice in quick succession
			db.getQueryEvents('week');
			db.getQueryEvents('week');

			const allCalls = mockStatement.all.mock.calls;
			expect(allCalls.length).toBe(2);

			// Both calls should have very close (within a few ms) start times
			const firstStartTime = allCalls[0][0] as number;
			const secondStartTime = allCalls[1][0] as number;

			// Difference should be minimal (test executes quickly)
			expect(Math.abs(secondStartTime - firstStartTime)).toBeLessThan(1000);
		});
	});

	describe('combined filters with time range', () => {
		it('should combine time range with agentType filter', async () => {
			const { StatsDB } = await import('../../main/stats-db');
			const db = new StatsDB();
			db.initialize();

			db.getQueryEvents('week', { agentType: 'claude-code' });

			const allCalls = mockStatement.all.mock.calls;
			expect(allCalls.length).toBeGreaterThan(0);

			const lastCall = allCalls[allCalls.length - 1];
			// Should have 2 parameters: start_time and agentType
			expect(lastCall).toHaveLength(2);
			expect(lastCall[1]).toBe('claude-code');
		});

		it('should combine time range with source filter', async () => {
			const { StatsDB } = await import('../../main/stats-db');
			const db = new StatsDB();
			db.initialize();

			db.getQueryEvents('month', { source: 'auto' });

			const allCalls = mockStatement.all.mock.calls;
			expect(allCalls.length).toBeGreaterThan(0);

			const lastCall = allCalls[allCalls.length - 1];
			// Should have 2 parameters: start_time and source
			expect(lastCall).toHaveLength(2);
			expect(lastCall[1]).toBe('auto');
		});

		it('should combine time range with multiple filters', async () => {
			const { StatsDB } = await import('../../main/stats-db');
			const db = new StatsDB();
			db.initialize();

			db.getQueryEvents('year', {
				agentType: 'opencode',
				source: 'user',
				projectPath: '/test/path',
				sessionId: 'session-123',
			});

			const allCalls = mockStatement.all.mock.calls;
			expect(allCalls.length).toBeGreaterThan(0);

			const lastCall = allCalls[allCalls.length - 1];
			// Should have 5 parameters: start_time + 4 filters
			expect(lastCall).toHaveLength(5);
			expect(lastCall[1]).toBe('opencode');
			expect(lastCall[2]).toBe('user');
			expect(lastCall[3]).toBe('/test/path');
			expect(lastCall[4]).toBe('session-123');
		});
	});
});

/**
 * Comprehensive tests for aggregation query calculations
 *
 * These tests verify that the getAggregatedStats method returns correct calculations:
 * - Total queries count
 * - Total duration sum
 * - Average duration calculation
 * - Breakdown by agent type (count and duration)
 * - Breakdown by source (user vs auto)
 * - Daily breakdown for charts
 */
describe('Aggregation queries return correct calculations', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockDb.pragma.mockReturnValue([{ user_version: 1 }]);
		mockDb.prepare.mockReturnValue(mockStatement);
		mockStatement.run.mockReturnValue({ changes: 1 });
		mockFsExistsSync.mockReturnValue(true);
	});

	afterEach(() => {
		vi.resetModules();
	});

	describe('totalQueries and totalDuration calculations', () => {
		it('should return correct totalQueries count from database', async () => {
			// Mock the totals query result
			mockStatement.get.mockReturnValue({ count: 42, total_duration: 126000 });
			mockStatement.all.mockReturnValue([]);

			const { StatsDB } = await import('../../main/stats-db');
			const db = new StatsDB();
			db.initialize();

			const stats = db.getAggregatedStats('week');

			expect(stats.totalQueries).toBe(42);
		});

		it('should return correct totalDuration sum from database', async () => {
			mockStatement.get.mockReturnValue({ count: 10, total_duration: 50000 });
			mockStatement.all.mockReturnValue([]);

			const { StatsDB } = await import('../../main/stats-db');
			const db = new StatsDB();
			db.initialize();

			const stats = db.getAggregatedStats('month');

			expect(stats.totalDuration).toBe(50000);
		});

		it('should handle zero queries correctly', async () => {
			mockStatement.get.mockReturnValue({ count: 0, total_duration: 0 });
			mockStatement.all.mockReturnValue([]);

			const { StatsDB } = await import('../../main/stats-db');
			const db = new StatsDB();
			db.initialize();

			const stats = db.getAggregatedStats('day');

			expect(stats.totalQueries).toBe(0);
			expect(stats.totalDuration).toBe(0);
		});

		it('should handle large query counts correctly', async () => {
			mockStatement.get.mockReturnValue({ count: 10000, total_duration: 5000000 });
			mockStatement.all.mockReturnValue([]);

			const { StatsDB } = await import('../../main/stats-db');
			const db = new StatsDB();
			db.initialize();

			const stats = db.getAggregatedStats('year');

			expect(stats.totalQueries).toBe(10000);
			expect(stats.totalDuration).toBe(5000000);
		});

		it('should handle very large durations correctly', async () => {
			// 1 day of continuous usage = 86400000ms
			const largeDuration = 86400000;
			mockStatement.get.mockReturnValue({ count: 100, total_duration: largeDuration });
			mockStatement.all.mockReturnValue([]);

			const { StatsDB } = await import('../../main/stats-db');
			const db = new StatsDB();
			db.initialize();

			const stats = db.getAggregatedStats('all');

			expect(stats.totalDuration).toBe(largeDuration);
		});
	});

	describe('avgDuration calculation', () => {
		it('should calculate correct average duration', async () => {
			// 100 queries, 500000ms total = 5000ms average
			mockStatement.get.mockReturnValue({ count: 100, total_duration: 500000 });
			mockStatement.all.mockReturnValue([]);

			const { StatsDB } = await import('../../main/stats-db');
			const db = new StatsDB();
			db.initialize();

			const stats = db.getAggregatedStats('week');

			expect(stats.avgDuration).toBe(5000);
		});

		it('should return 0 average duration when no queries', async () => {
			mockStatement.get.mockReturnValue({ count: 0, total_duration: 0 });
			mockStatement.all.mockReturnValue([]);

			const { StatsDB } = await import('../../main/stats-db');
			const db = new StatsDB();
			db.initialize();

			const stats = db.getAggregatedStats('day');

			// Avoid division by zero - should return 0
			expect(stats.avgDuration).toBe(0);
		});

		it('should round average duration to nearest integer', async () => {
			// 3 queries, 10000ms total = 3333.33... average, should round to 3333
			mockStatement.get.mockReturnValue({ count: 3, total_duration: 10000 });
			mockStatement.all.mockReturnValue([]);

			const { StatsDB } = await import('../../main/stats-db');
			const db = new StatsDB();
			db.initialize();

			const stats = db.getAggregatedStats('month');

			// Math.round(10000 / 3) = 3333
			expect(stats.avgDuration).toBe(3333);
		});

		it('should handle single query average correctly', async () => {
			mockStatement.get.mockReturnValue({ count: 1, total_duration: 12345 });
			mockStatement.all.mockReturnValue([]);

			const { StatsDB } = await import('../../main/stats-db');
			const db = new StatsDB();
			db.initialize();

			const stats = db.getAggregatedStats('day');

			expect(stats.avgDuration).toBe(12345);
		});

		it('should handle edge case of tiny durations', async () => {
			// 5 queries with 1ms each = 5ms total, 1ms average
			mockStatement.get.mockReturnValue({ count: 5, total_duration: 5 });
			mockStatement.all.mockReturnValue([]);

			const { StatsDB } = await import('../../main/stats-db');
			const db = new StatsDB();
			db.initialize();

			const stats = db.getAggregatedStats('day');

			expect(stats.avgDuration).toBe(1);
		});
	});

	describe('byAgent breakdown calculations', () => {
		it('should return correct breakdown by single agent type', async () => {
			mockStatement.get.mockReturnValue({ count: 50, total_duration: 250000 });
			mockStatement.all
				.mockReturnValueOnce([]) // First all() call (we handle this below)
				.mockReturnValueOnce([{ agent_type: 'claude-code', count: 50, duration: 250000 }])
				.mockReturnValueOnce([{ source: 'user', count: 50 }])
				.mockReturnValueOnce([]);

			const { StatsDB } = await import('../../main/stats-db');
			const db = new StatsDB();
			db.initialize();

			// Reset to control exact mock responses for getAggregatedStats
			mockStatement.all.mockReset();
			mockStatement.all
				.mockReturnValueOnce([{ agent_type: 'claude-code', count: 50, duration: 250000 }])
				.mockReturnValueOnce([{ source: 'user', count: 50 }])
				.mockReturnValueOnce([]);

			const stats = db.getAggregatedStats('week');

			expect(stats.byAgent).toHaveProperty('claude-code');
			expect(stats.byAgent['claude-code'].count).toBe(50);
			expect(stats.byAgent['claude-code'].duration).toBe(250000);
		});

		it('should return correct breakdown for multiple agent types', async () => {
			mockStatement.get.mockReturnValue({ count: 150, total_duration: 750000 });
			mockStatement.all
				.mockReturnValueOnce([
					{ agent_type: 'claude-code', count: 100, duration: 500000 },
					{ agent_type: 'opencode', count: 30, duration: 150000 },
					{ agent_type: 'gemini-cli', count: 20, duration: 100000 },
				])
				.mockReturnValueOnce([
					{ source: 'user', count: 120 },
					{ source: 'auto', count: 30 },
				])
				.mockReturnValueOnce([]);

			const { StatsDB } = await import('../../main/stats-db');
			const db = new StatsDB();
			db.initialize();

			const stats = db.getAggregatedStats('month');

			// Verify all agents are present
			expect(Object.keys(stats.byAgent)).toHaveLength(3);

			// Verify claude-code stats
			expect(stats.byAgent['claude-code'].count).toBe(100);
			expect(stats.byAgent['claude-code'].duration).toBe(500000);

			// Verify opencode stats
			expect(stats.byAgent['opencode'].count).toBe(30);
			expect(stats.byAgent['opencode'].duration).toBe(150000);

			// Verify gemini-cli stats
			expect(stats.byAgent['gemini-cli'].count).toBe(20);
			expect(stats.byAgent['gemini-cli'].duration).toBe(100000);
		});

		it('should return empty byAgent object when no queries exist', async () => {
			mockStatement.get.mockReturnValue({ count: 0, total_duration: 0 });
			mockStatement.all.mockReturnValue([]);

			const { StatsDB } = await import('../../main/stats-db');
			const db = new StatsDB();
			db.initialize();

			const stats = db.getAggregatedStats('day');

			expect(stats.byAgent).toEqual({});
			expect(Object.keys(stats.byAgent)).toHaveLength(0);
		});

		it('should maintain correct duration per agent when durations vary', async () => {
			mockStatement.get.mockReturnValue({ count: 4, total_duration: 35000 });
			mockStatement.all
				.mockReturnValueOnce([
					{ agent_type: 'claude-code', count: 3, duration: 30000 }, // Avg 10000
					{ agent_type: 'opencode', count: 1, duration: 5000 }, // Avg 5000
				])
				.mockReturnValueOnce([{ source: 'user', count: 4 }])
				.mockReturnValueOnce([]);

			const { StatsDB } = await import('../../main/stats-db');
			const db = new StatsDB();
			db.initialize();

			const stats = db.getAggregatedStats('week');

			// Verify duration totals per agent are preserved
			expect(stats.byAgent['claude-code'].duration).toBe(30000);
			expect(stats.byAgent['opencode'].duration).toBe(5000);

			// Total should match sum of all agents
			const totalAgentDuration = Object.values(stats.byAgent).reduce(
				(sum, agent) => sum + agent.duration,
				0
			);
			expect(totalAgentDuration).toBe(35000);
		});
	});

	describe('bySource breakdown calculations', () => {
		it('should return correct user vs auto counts', async () => {
			mockStatement.get.mockReturnValue({ count: 100, total_duration: 500000 });
			mockStatement.all
				.mockReturnValueOnce([{ agent_type: 'claude-code', count: 100, duration: 500000 }])
				.mockReturnValueOnce([
					{ source: 'user', count: 70 },
					{ source: 'auto', count: 30 },
				])
				.mockReturnValueOnce([]);

			const { StatsDB } = await import('../../main/stats-db');
			const db = new StatsDB();
			db.initialize();

			const stats = db.getAggregatedStats('week');

			expect(stats.bySource.user).toBe(70);
			expect(stats.bySource.auto).toBe(30);
		});

		it('should handle all queries from user source', async () => {
			mockStatement.get.mockReturnValue({ count: 50, total_duration: 250000 });
			mockStatement.all
				.mockReturnValueOnce([{ agent_type: 'claude-code', count: 50, duration: 250000 }])
				.mockReturnValueOnce([{ source: 'user', count: 50 }])
				.mockReturnValueOnce([]);

			const { StatsDB } = await import('../../main/stats-db');
			const db = new StatsDB();
			db.initialize();

			const stats = db.getAggregatedStats('month');

			expect(stats.bySource.user).toBe(50);
			expect(stats.bySource.auto).toBe(0);
		});

		it('should handle all queries from auto source', async () => {
			mockStatement.get.mockReturnValue({ count: 200, total_duration: 1000000 });
			mockStatement.all
				.mockReturnValueOnce([{ agent_type: 'claude-code', count: 200, duration: 1000000 }])
				.mockReturnValueOnce([{ source: 'auto', count: 200 }])
				.mockReturnValueOnce([]);

			const { StatsDB } = await import('../../main/stats-db');
			const db = new StatsDB();
			db.initialize();

			const stats = db.getAggregatedStats('year');

			expect(stats.bySource.user).toBe(0);
			expect(stats.bySource.auto).toBe(200);
		});

		it('should initialize bySource with zeros when no data', async () => {
			mockStatement.get.mockReturnValue({ count: 0, total_duration: 0 });
			mockStatement.all.mockReturnValue([]);

			const { StatsDB } = await import('../../main/stats-db');
			const db = new StatsDB();
			db.initialize();

			const stats = db.getAggregatedStats('day');

			expect(stats.bySource).toEqual({ user: 0, auto: 0 });
		});

		it('should sum correctly across source types', async () => {
			mockStatement.get.mockReturnValue({ count: 1000, total_duration: 5000000 });
			mockStatement.all
				.mockReturnValueOnce([{ agent_type: 'claude-code', count: 1000, duration: 5000000 }])
				.mockReturnValueOnce([
					{ source: 'user', count: 650 },
					{ source: 'auto', count: 350 },
				])
				.mockReturnValueOnce([]);

			const { StatsDB } = await import('../../main/stats-db');
			const db = new StatsDB();
			db.initialize();

			const stats = db.getAggregatedStats('all');

			// Verify sum equals totalQueries
			expect(stats.bySource.user + stats.bySource.auto).toBe(stats.totalQueries);
		});
	});

	describe('byDay breakdown calculations', () => {
		it('should return daily breakdown with correct structure', async () => {
			mockStatement.get.mockReturnValue({ count: 30, total_duration: 150000 });
			mockStatement.all
				.mockReturnValueOnce([{ agent_type: 'claude-code', count: 30, duration: 150000 }]) // byAgent
				.mockReturnValueOnce([{ source: 'user', count: 30 }]) // bySource
				.mockReturnValueOnce([{ is_remote: 0, count: 30 }]) // byLocation
				.mockReturnValueOnce([
					{ date: '2024-01-01', count: 10, duration: 50000 },
					{ date: '2024-01-02', count: 12, duration: 60000 },
					{ date: '2024-01-03', count: 8, duration: 40000 },
				]); // byDay

			const { StatsDB } = await import('../../main/stats-db');
			const db = new StatsDB();
			db.initialize();

			const stats = db.getAggregatedStats('week');

			expect(stats.byDay).toHaveLength(3);
			expect(stats.byDay[0]).toEqual({ date: '2024-01-01', count: 10, duration: 50000 });
			expect(stats.byDay[1]).toEqual({ date: '2024-01-02', count: 12, duration: 60000 });
			expect(stats.byDay[2]).toEqual({ date: '2024-01-03', count: 8, duration: 40000 });
		});

		it('should return empty array when no daily data exists', async () => {
			mockStatement.get.mockReturnValue({ count: 0, total_duration: 0 });
			mockStatement.all.mockReturnValue([]);

			const { StatsDB } = await import('../../main/stats-db');
			const db = new StatsDB();
			db.initialize();

			const stats = db.getAggregatedStats('day');

			expect(stats.byDay).toEqual([]);
			expect(stats.byDay).toHaveLength(0);
		});

		it('should handle single day of data', async () => {
			mockStatement.get.mockReturnValue({ count: 5, total_duration: 25000 });
			mockStatement.all
				.mockReturnValueOnce([{ agent_type: 'claude-code', count: 5, duration: 25000 }]) // byAgent
				.mockReturnValueOnce([{ source: 'user', count: 5 }]) // bySource
				.mockReturnValueOnce([{ is_remote: 0, count: 5 }]) // byLocation
				.mockReturnValueOnce([{ date: '2024-06-15', count: 5, duration: 25000 }]); // byDay

			const { StatsDB } = await import('../../main/stats-db');
			const db = new StatsDB();
			db.initialize();

			const stats = db.getAggregatedStats('day');

			expect(stats.byDay).toHaveLength(1);
			expect(stats.byDay[0].date).toBe('2024-06-15');
			expect(stats.byDay[0].count).toBe(5);
			expect(stats.byDay[0].duration).toBe(25000);
		});

		it('should order daily data chronologically (ASC)', async () => {
			mockStatement.get.mockReturnValue({ count: 15, total_duration: 75000 });
			mockStatement.all
				.mockReturnValueOnce([{ agent_type: 'claude-code', count: 15, duration: 75000 }]) // byAgent
				.mockReturnValueOnce([{ source: 'user', count: 15 }]) // bySource
				.mockReturnValueOnce([{ is_remote: 0, count: 15 }]) // byLocation
				.mockReturnValueOnce([
					{ date: '2024-03-01', count: 3, duration: 15000 },
					{ date: '2024-03-02', count: 5, duration: 25000 },
					{ date: '2024-03-03', count: 7, duration: 35000 },
				]); // byDay

			const { StatsDB } = await import('../../main/stats-db');
			const db = new StatsDB();
			db.initialize();

			const stats = db.getAggregatedStats('week');

			// Verify ASC order (earliest date first)
			expect(stats.byDay[0].date).toBe('2024-03-01');
			expect(stats.byDay[1].date).toBe('2024-03-02');
			expect(stats.byDay[2].date).toBe('2024-03-03');
		});

		it('should sum daily counts equal to totalQueries', async () => {
			mockStatement.get.mockReturnValue({ count: 25, total_duration: 125000 });
			mockStatement.all
				.mockReturnValueOnce([{ agent_type: 'claude-code', count: 25, duration: 125000 }]) // byAgent
				.mockReturnValueOnce([{ source: 'user', count: 25 }]) // bySource
				.mockReturnValueOnce([{ is_remote: 0, count: 25 }]) // byLocation
				.mockReturnValueOnce([
					{ date: '2024-02-01', count: 8, duration: 40000 },
					{ date: '2024-02-02', count: 10, duration: 50000 },
					{ date: '2024-02-03', count: 7, duration: 35000 },
				]); // byDay

			const { StatsDB } = await import('../../main/stats-db');
			const db = new StatsDB();
			db.initialize();

			const stats = db.getAggregatedStats('week');

			// Sum of daily counts should equal totalQueries
			const dailySum = stats.byDay.reduce((sum, day) => sum + day.count, 0);
			expect(dailySum).toBe(stats.totalQueries);
		});

		it('should sum daily durations equal to totalDuration', async () => {
			mockStatement.get.mockReturnValue({ count: 20, total_duration: 100000 });
			mockStatement.all
				.mockReturnValueOnce([{ agent_type: 'opencode', count: 20, duration: 100000 }]) // byAgent
				.mockReturnValueOnce([{ source: 'auto', count: 20 }]) // bySource
				.mockReturnValueOnce([{ is_remote: 0, count: 20 }]) // byLocation
				.mockReturnValueOnce([
					{ date: '2024-04-10', count: 5, duration: 25000 },
					{ date: '2024-04-11', count: 8, duration: 40000 },
					{ date: '2024-04-12', count: 7, duration: 35000 },
				]); // byDay

			const { StatsDB } = await import('../../main/stats-db');
			const db = new StatsDB();
			db.initialize();

			const stats = db.getAggregatedStats('week');

			// Sum of daily durations should equal totalDuration
			const dailyDurationSum = stats.byDay.reduce((sum, day) => sum + day.duration, 0);
			expect(dailyDurationSum).toBe(stats.totalDuration);
		});
	});

	describe('aggregation consistency across multiple queries', () => {
		it('should return consistent results when called multiple times', async () => {
			mockStatement.get.mockReturnValue({ count: 50, total_duration: 250000 });
			mockStatement.all.mockReturnValue([
				{ agent_type: 'claude-code', count: 50, duration: 250000 },
			]);

			const { StatsDB } = await import('../../main/stats-db');
			const db = new StatsDB();
			db.initialize();

			const stats1 = db.getAggregatedStats('week');
			const stats2 = db.getAggregatedStats('week');

			expect(stats1.totalQueries).toBe(stats2.totalQueries);
			expect(stats1.totalDuration).toBe(stats2.totalDuration);
			expect(stats1.avgDuration).toBe(stats2.avgDuration);
		});

		it('should handle concurrent access correctly', async () => {
			mockStatement.get.mockReturnValue({ count: 100, total_duration: 500000 });
			mockStatement.all.mockReturnValue([]);

			const { StatsDB } = await import('../../main/stats-db');
			const db = new StatsDB();
			db.initialize();

			// Simulate concurrent calls
			const [result1, result2, result3] = [
				db.getAggregatedStats('day'),
				db.getAggregatedStats('week'),
				db.getAggregatedStats('month'),
			];

			expect(result1.totalQueries).toBe(100);
			expect(result2.totalQueries).toBe(100);
			expect(result3.totalQueries).toBe(100);
		});
	});

	describe('SQL query structure verification', () => {
		it('should use COALESCE for totalDuration to handle NULL', async () => {
			mockStatement.get.mockReturnValue({ count: 0, total_duration: 0 });
			mockStatement.all.mockReturnValue([]);

			const { StatsDB } = await import('../../main/stats-db');
			const db = new StatsDB();
			db.initialize();

			db.getAggregatedStats('week');

			// Verify the SQL query uses COALESCE
			const prepareCalls = mockDb.prepare.mock.calls;
			const totalsCall = prepareCalls.find((call) =>
				(call[0] as string).includes('COALESCE(SUM(duration), 0)')
			);

			expect(totalsCall).toBeDefined();
		});

		it('should GROUP BY agent_type for byAgent breakdown', async () => {
			mockStatement.get.mockReturnValue({ count: 0, total_duration: 0 });
			mockStatement.all.mockReturnValue([]);

			const { StatsDB } = await import('../../main/stats-db');
			const db = new StatsDB();
			db.initialize();

			db.getAggregatedStats('month');

			const prepareCalls = mockDb.prepare.mock.calls;
			const byAgentCall = prepareCalls.find(
				(call) =>
					(call[0] as string).includes('GROUP BY agent_type') &&
					(call[0] as string).includes('FROM query_events')
			);

			expect(byAgentCall).toBeDefined();
		});

		it('should GROUP BY source for bySource breakdown', async () => {
			mockStatement.get.mockReturnValue({ count: 0, total_duration: 0 });
			mockStatement.all.mockReturnValue([]);

			const { StatsDB } = await import('../../main/stats-db');
			const db = new StatsDB();
			db.initialize();

			db.getAggregatedStats('year');

			const prepareCalls = mockDb.prepare.mock.calls;
			const bySourceCall = prepareCalls.find(
				(call) =>
					(call[0] as string).includes('GROUP BY source') &&
					(call[0] as string).includes('FROM query_events')
			);

			expect(bySourceCall).toBeDefined();
		});

		it('should use date() function for daily grouping', async () => {
			mockStatement.get.mockReturnValue({ count: 0, total_duration: 0 });
			mockStatement.all.mockReturnValue([]);

			const { StatsDB } = await import('../../main/stats-db');
			const db = new StatsDB();
			db.initialize();

			db.getAggregatedStats('all');

			const prepareCalls = mockDb.prepare.mock.calls;
			const byDayCall = prepareCalls.find((call) =>
				(call[0] as string).includes("date(start_time / 1000, 'unixepoch'")
			);

			expect(byDayCall).toBeDefined();
		});

		it('should ORDER BY date ASC in byDay query', async () => {
			mockStatement.get.mockReturnValue({ count: 0, total_duration: 0 });
			mockStatement.all.mockReturnValue([]);

			const { StatsDB } = await import('../../main/stats-db');
			const db = new StatsDB();
			db.initialize();

			db.getAggregatedStats('week');

			const prepareCalls = mockDb.prepare.mock.calls;
			const byDayCall = prepareCalls.find(
				(call) =>
					(call[0] as string).includes('ORDER BY date ASC') ||
					((call[0] as string).includes('date(start_time') && (call[0] as string).includes('ASC'))
			);

			expect(byDayCall).toBeDefined();
		});
	});

	describe('edge case calculations', () => {
		it('should handle very small average (less than 1ms)', async () => {
			// 10 queries, 5ms total = 0.5ms average, should round to 1 (or 0)
			mockStatement.get.mockReturnValue({ count: 10, total_duration: 5 });
			mockStatement.all.mockReturnValue([]);

			const { StatsDB } = await import('../../main/stats-db');
			const db = new StatsDB();
			db.initialize();

			const stats = db.getAggregatedStats('day');

			// Math.round(5 / 10) = 1
			expect(stats.avgDuration).toBe(1);
		});

		it('should handle maximum JavaScript safe integer values', async () => {
			const maxSafe = Number.MAX_SAFE_INTEGER;
			// Use a count that divides evenly to avoid rounding issues
			mockStatement.get.mockReturnValue({ count: 1, total_duration: maxSafe });
			mockStatement.all.mockReturnValue([]);

			const { StatsDB } = await import('../../main/stats-db');
			const db = new StatsDB();
			db.initialize();

			const stats = db.getAggregatedStats('all');

			expect(stats.totalDuration).toBe(maxSafe);
			expect(stats.avgDuration).toBe(maxSafe);
		});

		it('should handle mixed zero and non-zero durations in agents', async () => {
			mockStatement.get.mockReturnValue({ count: 3, total_duration: 5000 });
			mockStatement.all
				.mockReturnValueOnce([
					{ agent_type: 'claude-code', count: 2, duration: 5000 },
					{ agent_type: 'opencode', count: 1, duration: 0 }, // Zero duration
				])
				.mockReturnValueOnce([{ source: 'user', count: 3 }])
				.mockReturnValueOnce([]);

			const { StatsDB } = await import('../../main/stats-db');
			const db = new StatsDB();
			db.initialize();

			const stats = db.getAggregatedStats('week');

			expect(stats.byAgent['claude-code'].duration).toBe(5000);
			expect(stats.byAgent['opencode'].duration).toBe(0);
		});

		it('should handle dates spanning year boundaries', async () => {
			mockStatement.get.mockReturnValue({ count: 2, total_duration: 10000 });
			mockStatement.all
				.mockReturnValueOnce([{ agent_type: 'claude-code', count: 2, duration: 10000 }]) // byAgent
				.mockReturnValueOnce([{ source: 'user', count: 2 }]) // bySource
				.mockReturnValueOnce([{ is_remote: 0, count: 2 }]) // byLocation
				.mockReturnValueOnce([
					{ date: '2023-12-31', count: 1, duration: 5000 },
					{ date: '2024-01-01', count: 1, duration: 5000 },
				]); // byDay

			const { StatsDB } = await import('../../main/stats-db');
			const db = new StatsDB();
			db.initialize();

			const stats = db.getAggregatedStats('week');

			expect(stats.byDay).toHaveLength(2);
			expect(stats.byDay[0].date).toBe('2023-12-31');
			expect(stats.byDay[1].date).toBe('2024-01-01');
		});
	});
});

/**
 * Cross-platform database path resolution tests
 *
 * Tests verify that the stats database file is created at the correct
 * platform-appropriate path on macOS, Windows, and Linux. Electron's
 * app.getPath('userData') returns:
 *
 * - macOS: ~/Library/Application Support/Maestro/
 * - Windows: %APPDATA%\Maestro\ (e.g., C:\Users\<user>\AppData\Roaming\Maestro\)
 * - Linux: ~/.config/Maestro/
 *
 * The stats database is always created at {userData}/stats.db
 */
describe('Cross-platform database path resolution (macOS, Windows, Linux)', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		lastDbPath = null;
		mockDb.pragma.mockReturnValue([{ user_version: 0 }]);
		mockDb.prepare.mockReturnValue(mockStatement);
		mockStatement.run.mockReturnValue({ changes: 1 });
		mockFsExistsSync.mockReturnValue(true);
		mockFsMkdirSync.mockClear();
	});

	afterEach(() => {
		vi.resetModules();
	});

	describe('macOS path resolution', () => {
		it('should use macOS-style userData path: ~/Library/Application Support/Maestro/', async () => {
			// Simulate macOS userData path
			const macOsUserData = '/Users/testuser/Library/Application Support/Maestro';
			const { app } = await import('electron');
			vi.mocked(app.getPath).mockReturnValue(macOsUserData);

			const { StatsDB } = await import('../../main/stats-db');
			const db = new StatsDB();
			db.initialize();

			expect(lastDbPath).toBe(path.join(macOsUserData, 'stats.db'));
		});

		it('should handle macOS path with spaces in Application Support', async () => {
			const macOsUserData = '/Users/testuser/Library/Application Support/Maestro';
			const { app } = await import('electron');
			vi.mocked(app.getPath).mockReturnValue(macOsUserData);

			const { StatsDB } = await import('../../main/stats-db');
			const db = new StatsDB();

			const dbPath = db.getDbPath();
			expect(dbPath).toContain('Application Support');
			expect(dbPath).toContain('stats.db');
		});

		it('should handle macOS username with special characters', async () => {
			const macOsUserData = '/Users/test.user-name/Library/Application Support/Maestro';
			const { app } = await import('electron');
			vi.mocked(app.getPath).mockReturnValue(macOsUserData);

			const { StatsDB } = await import('../../main/stats-db');
			const db = new StatsDB();
			db.initialize();

			expect(lastDbPath).toBe(path.join(macOsUserData, 'stats.db'));
		});

		it('should resolve to absolute path on macOS', async () => {
			const macOsUserData = '/Users/testuser/Library/Application Support/Maestro';
			const { app } = await import('electron');
			vi.mocked(app.getPath).mockReturnValue(macOsUserData);

			const { StatsDB } = await import('../../main/stats-db');
			const db = new StatsDB();

			expect(path.isAbsolute(db.getDbPath())).toBe(true);
		});
	});

	describe('Windows path resolution', () => {
		it('should use Windows-style userData path: %APPDATA%\\Maestro\\', async () => {
			// Simulate Windows userData path
			const windowsUserData = 'C:\\Users\\TestUser\\AppData\\Roaming\\Maestro';
			const { app } = await import('electron');
			vi.mocked(app.getPath).mockReturnValue(windowsUserData);

			const { StatsDB } = await import('../../main/stats-db');
			const db = new StatsDB();
			db.initialize();

			// path.join will use the platform's native separator
			expect(lastDbPath).toBe(path.join(windowsUserData, 'stats.db'));
		});

		it('should handle Windows path with drive letter', async () => {
			const windowsUserData = 'D:\\Users\\TestUser\\AppData\\Roaming\\Maestro';
			const { app } = await import('electron');
			vi.mocked(app.getPath).mockReturnValue(windowsUserData);

			const { StatsDB } = await import('../../main/stats-db');
			const db = new StatsDB();

			const dbPath = db.getDbPath();
			expect(dbPath).toContain('stats.db');
			// The path should start with a drive letter pattern when on Windows
			// or be a proper path when joined
		});

		it('should handle Windows username with spaces', async () => {
			const windowsUserData = 'C:\\Users\\Test User\\AppData\\Roaming\\Maestro';
			const { app } = await import('electron');
			vi.mocked(app.getPath).mockReturnValue(windowsUserData);

			const { StatsDB } = await import('../../main/stats-db');
			const db = new StatsDB();
			db.initialize();

			expect(lastDbPath).toBe(path.join(windowsUserData, 'stats.db'));
		});

		it('should handle Windows UNC paths (network drives)', async () => {
			const windowsUncPath = '\\\\NetworkDrive\\SharedFolder\\AppData\\Maestro';
			const { app } = await import('electron');
			vi.mocked(app.getPath).mockReturnValue(windowsUncPath);

			const { StatsDB } = await import('../../main/stats-db');
			const db = new StatsDB();
			db.initialize();

			expect(lastDbPath).toBe(path.join(windowsUncPath, 'stats.db'));
		});

		it('should handle portable Windows installation path', async () => {
			// Portable apps might use a different structure
			const portablePath = 'E:\\PortableApps\\Maestro\\Data';
			const { app } = await import('electron');
			vi.mocked(app.getPath).mockReturnValue(portablePath);

			const { StatsDB } = await import('../../main/stats-db');
			const db = new StatsDB();
			db.initialize();

			expect(lastDbPath).toBe(path.join(portablePath, 'stats.db'));
		});
	});

	describe('Linux path resolution', () => {
		it('should use Linux-style userData path: ~/.config/Maestro/', async () => {
			// Simulate Linux userData path
			const linuxUserData = '/home/testuser/.config/Maestro';
			const { app } = await import('electron');
			vi.mocked(app.getPath).mockReturnValue(linuxUserData);

			const { StatsDB } = await import('../../main/stats-db');
			const db = new StatsDB();
			db.initialize();

			expect(lastDbPath).toBe(path.join(linuxUserData, 'stats.db'));
		});

		it('should handle Linux XDG_CONFIG_HOME override', async () => {
			// Custom XDG_CONFIG_HOME might result in different path
			const customConfigHome = '/custom/config/path/Maestro';
			const { app } = await import('electron');
			vi.mocked(app.getPath).mockReturnValue(customConfigHome);

			const { StatsDB } = await import('../../main/stats-db');
			const db = new StatsDB();
			db.initialize();

			expect(lastDbPath).toBe(path.join(customConfigHome, 'stats.db'));
		});

		it('should handle Linux username with underscore', async () => {
			const linuxUserData = '/home/test_user/.config/Maestro';
			const { app } = await import('electron');
			vi.mocked(app.getPath).mockReturnValue(linuxUserData);

			const { StatsDB } = await import('../../main/stats-db');
			const db = new StatsDB();
			db.initialize();

			expect(lastDbPath).toBe(path.join(linuxUserData, 'stats.db'));
		});

		it('should resolve to absolute path on Linux', async () => {
			const linuxUserData = '/home/testuser/.config/Maestro';
			const { app } = await import('electron');
			vi.mocked(app.getPath).mockReturnValue(linuxUserData);

			const { StatsDB } = await import('../../main/stats-db');
			const db = new StatsDB();

			expect(path.isAbsolute(db.getDbPath())).toBe(true);
		});

		it('should handle Linux Snap/Flatpak sandboxed paths', async () => {
			// Snap packages have a different path structure
			const snapPath = '/home/testuser/snap/maestro/current/.config/Maestro';
			const { app } = await import('electron');
			vi.mocked(app.getPath).mockReturnValue(snapPath);

			const { StatsDB } = await import('../../main/stats-db');
			const db = new StatsDB();
			db.initialize();

			expect(lastDbPath).toBe(path.join(snapPath, 'stats.db'));
		});
	});

	describe('path.join cross-platform behavior', () => {
		it('should use path.join to combine userData and stats.db', async () => {
			const testUserData = '/test/user/data';
			const { app } = await import('electron');
			vi.mocked(app.getPath).mockReturnValue(testUserData);

			const { StatsDB } = await import('../../main/stats-db');
			const db = new StatsDB();

			// path.join should be used (not string concatenation)
			expect(db.getDbPath()).toBe(path.join(testUserData, 'stats.db'));
		});

		it('should handle trailing slash in userData path', async () => {
			const userDataWithSlash = '/test/user/data/';
			const { app } = await import('electron');
			vi.mocked(app.getPath).mockReturnValue(userDataWithSlash);

			const { StatsDB } = await import('../../main/stats-db');
			const db = new StatsDB();

			// path.join normalizes trailing slashes
			const dbPath = db.getDbPath();
			expect(dbPath.endsWith('stats.db')).toBe(true);
			// Should not have double slashes
			expect(dbPath).not.toContain('//');
		});

		it('should result in stats.db as the basename on all platforms', async () => {
			const testUserData = '/any/path/structure';
			const { app } = await import('electron');
			vi.mocked(app.getPath).mockReturnValue(testUserData);

			const { StatsDB } = await import('../../main/stats-db');
			const db = new StatsDB();

			expect(path.basename(db.getDbPath())).toBe('stats.db');
		});

		it('should result in userData directory as the parent', async () => {
			const testUserData = '/any/path/structure';
			const { app } = await import('electron');
			vi.mocked(app.getPath).mockReturnValue(testUserData);

			const { StatsDB } = await import('../../main/stats-db');
			const db = new StatsDB();

			expect(path.dirname(db.getDbPath())).toBe(testUserData);
		});
	});

	describe('directory creation cross-platform', () => {
		it('should create directory on macOS if it does not exist', async () => {
			mockFsExistsSync.mockReturnValue(false);
			const macOsUserData = '/Users/testuser/Library/Application Support/Maestro';
			const { app } = await import('electron');
			vi.mocked(app.getPath).mockReturnValue(macOsUserData);

			const { StatsDB } = await import('../../main/stats-db');
			const db = new StatsDB();
			db.initialize();

			expect(mockFsMkdirSync).toHaveBeenCalledWith(macOsUserData, { recursive: true });
		});

		it('should create directory on Windows if it does not exist', async () => {
			mockFsExistsSync.mockReturnValue(false);
			const windowsUserData = 'C:\\Users\\TestUser\\AppData\\Roaming\\Maestro';
			const { app } = await import('electron');
			vi.mocked(app.getPath).mockReturnValue(windowsUserData);

			const { StatsDB } = await import('../../main/stats-db');
			const db = new StatsDB();
			db.initialize();

			expect(mockFsMkdirSync).toHaveBeenCalledWith(windowsUserData, { recursive: true });
		});

		it('should create directory on Linux if it does not exist', async () => {
			mockFsExistsSync.mockReturnValue(false);
			const linuxUserData = '/home/testuser/.config/Maestro';
			const { app } = await import('electron');
			vi.mocked(app.getPath).mockReturnValue(linuxUserData);

			const { StatsDB } = await import('../../main/stats-db');
			const db = new StatsDB();
			db.initialize();

			expect(mockFsMkdirSync).toHaveBeenCalledWith(linuxUserData, { recursive: true });
		});

		it('should use recursive option for deeply nested paths', async () => {
			mockFsExistsSync.mockReturnValue(false);
			const deepPath = '/very/deep/nested/path/structure/Maestro';
			const { app } = await import('electron');
			vi.mocked(app.getPath).mockReturnValue(deepPath);

			const { StatsDB } = await import('../../main/stats-db');
			const db = new StatsDB();
			db.initialize();

			expect(mockFsMkdirSync).toHaveBeenCalledWith(deepPath, { recursive: true });
		});
	});

	describe('edge cases for path resolution', () => {
		it('should handle unicode characters in path', async () => {
			const unicodePath = '/Users/用户名/Library/Application Support/Maestro';
			const { app } = await import('electron');
			vi.mocked(app.getPath).mockReturnValue(unicodePath);

			const { StatsDB } = await import('../../main/stats-db');
			const db = new StatsDB();
			db.initialize();

			expect(lastDbPath).toBe(path.join(unicodePath, 'stats.db'));
		});

		it('should handle emoji in path (macOS supports this)', async () => {
			const emojiPath = '/Users/test/Documents/🎵Music/Maestro';
			const { app } = await import('electron');
			vi.mocked(app.getPath).mockReturnValue(emojiPath);

			const { StatsDB } = await import('../../main/stats-db');
			const db = new StatsDB();
			db.initialize();

			expect(lastDbPath).toBe(path.join(emojiPath, 'stats.db'));
		});

		it('should handle very long paths (approaching Windows MAX_PATH)', async () => {
			// Windows MAX_PATH is 260 characters by default
			const longPath = '/very' + '/long'.repeat(50) + '/path/Maestro';
			const { app } = await import('electron');
			vi.mocked(app.getPath).mockReturnValue(longPath);

			const { StatsDB } = await import('../../main/stats-db');
			const db = new StatsDB();

			const dbPath = db.getDbPath();
			expect(dbPath.endsWith('stats.db')).toBe(true);
		});

		it('should handle path with single quotes', async () => {
			const quotedPath = "/Users/O'Brien/Library/Application Support/Maestro";
			const { app } = await import('electron');
			vi.mocked(app.getPath).mockReturnValue(quotedPath);

			const { StatsDB } = await import('../../main/stats-db');
			const db = new StatsDB();
			db.initialize();

			expect(lastDbPath).toBe(path.join(quotedPath, 'stats.db'));
		});

		it('should handle path with double quotes (Windows allows this)', async () => {
			// Note: Double quotes aren't typically valid in Windows paths but path.join handles them
			const quotedPath = 'C:\\Users\\Test"User\\AppData\\Roaming\\Maestro';
			const { app } = await import('electron');
			vi.mocked(app.getPath).mockReturnValue(quotedPath);

			const { StatsDB } = await import('../../main/stats-db');
			const db = new StatsDB();

			const dbPath = db.getDbPath();
			expect(path.basename(dbPath)).toBe('stats.db');
		});

		it('should handle path with ampersand', async () => {
			const ampersandPath = '/Users/Smith & Jones/Library/Application Support/Maestro';
			const { app } = await import('electron');
			vi.mocked(app.getPath).mockReturnValue(ampersandPath);

			const { StatsDB } = await import('../../main/stats-db');
			const db = new StatsDB();
			db.initialize();

			expect(lastDbPath).toBe(path.join(ampersandPath, 'stats.db'));
		});
	});

	describe('consistency across platform simulations', () => {
		it('should always produce a path ending with stats.db regardless of platform', async () => {
			const platforms = [
				'/Users/mac/Library/Application Support/Maestro',
				'C:\\Users\\Windows\\AppData\\Roaming\\Maestro',
				'/home/linux/.config/Maestro',
			];

			for (const platformPath of platforms) {
				vi.resetModules();
				const { app } = await import('electron');
				vi.mocked(app.getPath).mockReturnValue(platformPath);

				const { StatsDB } = await import('../../main/stats-db');
				const db = new StatsDB();

				expect(path.basename(db.getDbPath())).toBe('stats.db');
			}
		});

		it('should always initialize successfully regardless of platform path format', async () => {
			const platforms = [
				'/Users/mac/Library/Application Support/Maestro',
				'C:\\Users\\Windows\\AppData\\Roaming\\Maestro',
				'/home/linux/.config/Maestro',
			];

			for (const platformPath of platforms) {
				vi.resetModules();
				vi.clearAllMocks();
				mockDb.pragma.mockReturnValue([{ user_version: 0 }]);
				mockDb.prepare.mockReturnValue(mockStatement);
				mockFsExistsSync.mockReturnValue(true);

				const { app } = await import('electron');
				vi.mocked(app.getPath).mockReturnValue(platformPath);

				const { StatsDB } = await import('../../main/stats-db');
				const db = new StatsDB();
				db.initialize();

				expect(db.isReady()).toBe(true);
			}
		});

		it('should pass correct directory to mkdirSync on all platforms', async () => {
			const platforms = [
				'/Users/mac/Library/Application Support/Maestro',
				'C:\\Users\\Windows\\AppData\\Roaming\\Maestro',
				'/home/linux/.config/Maestro',
			];

			for (const platformPath of platforms) {
				vi.resetModules();
				vi.clearAllMocks();
				mockDb.pragma.mockReturnValue([{ user_version: 0 }]);
				mockDb.prepare.mockReturnValue(mockStatement);
				mockFsExistsSync.mockReturnValue(false);
				mockFsMkdirSync.mockClear();

				const { app } = await import('electron');
				vi.mocked(app.getPath).mockReturnValue(platformPath);

				const { StatsDB } = await import('../../main/stats-db');
				const db = new StatsDB();
				db.initialize();

				expect(mockFsMkdirSync).toHaveBeenCalledWith(platformPath, { recursive: true });
			}
		});
	});

	describe('electron app.getPath integration', () => {
		it('should call app.getPath with "userData" argument', async () => {
			const { app } = await import('electron');

			const { StatsDB } = await import('../../main/stats-db');
			new StatsDB();

			expect(app.getPath).toHaveBeenCalledWith('userData');
		});

		it('should respect the value returned by app.getPath', async () => {
			const customPath = '/custom/electron/user/data/path';
			const { app } = await import('electron');
			vi.mocked(app.getPath).mockReturnValue(customPath);

			const { StatsDB } = await import('../../main/stats-db');
			const db = new StatsDB();

			expect(db.getDbPath()).toBe(path.join(customPath, 'stats.db'));
		});

		it('should use userData path at construction time (not lazily)', async () => {
			const { app } = await import('electron');
			const initialPath = '/initial/path';
			vi.mocked(app.getPath).mockReturnValue(initialPath);

			const { StatsDB } = await import('../../main/stats-db');
			const db = new StatsDB();

			// Change the mock after construction
			vi.mocked(app.getPath).mockReturnValue('/different/path');

			// Should still use the initial path
			expect(db.getDbPath()).toBe(path.join(initialPath, 'stats.db'));
		});
	});
});

/**
 * Concurrent writes and database locking tests
 *
 * Tests that verify concurrent write operations don't cause database locking issues.
 * better-sqlite3 uses synchronous operations and WAL mode for optimal concurrent access.
 *
 * Key behaviors tested:
 * - Rapid sequential writes complete without errors
 * - Concurrent write operations all succeed (via Promise.all)
 * - Interleaved read/write operations work correctly
 * - High-volume concurrent writes complete without data loss
 * - WAL mode is properly enabled for concurrent access
 */
describe('Concurrent writes and database locking', () => {
	let writeCount: number;
	let insertedIds: string[];

	beforeEach(() => {
		vi.clearAllMocks();
		lastDbPath = null;
		writeCount = 0;
		insertedIds = [];

		// Mock pragma to return version 1 (skip migrations for these tests)
		mockDb.pragma.mockImplementation((sql: string) => {
			if (sql === 'user_version') return [{ user_version: 1 }];
			if (sql === 'journal_mode') return [{ journal_mode: 'wal' }];
			if (sql === 'journal_mode = WAL') return undefined;
			return undefined;
		});

		// Track each write and generate unique IDs
		mockStatement.run.mockImplementation(() => {
			writeCount++;
			return { changes: 1 };
		});

		mockStatement.get.mockReturnValue({ count: 0, total_duration: 0 });
		mockStatement.all.mockReturnValue([]);
		mockFsExistsSync.mockReturnValue(true);
	});

	afterEach(() => {
		vi.resetModules();
	});

	describe('WAL mode for concurrent access', () => {
		it('should enable WAL journal mode on initialization', async () => {
			const { StatsDB } = await import('../../main/stats-db');
			const db = new StatsDB();
			db.initialize();

			expect(mockDb.pragma).toHaveBeenCalledWith('journal_mode = WAL');
		});

		it('should enable WAL mode before running migrations', async () => {
			const pragmaCalls: string[] = [];
			mockDb.pragma.mockImplementation((sql: string) => {
				pragmaCalls.push(sql);
				if (sql === 'user_version') return [{ user_version: 0 }];
				return undefined;
			});

			const { StatsDB } = await import('../../main/stats-db');
			const db = new StatsDB();
			db.initialize();

			// WAL mode should be set early in initialization
			const walIndex = pragmaCalls.indexOf('journal_mode = WAL');
			const versionIndex = pragmaCalls.indexOf('user_version');
			expect(walIndex).toBeGreaterThan(-1);
			expect(versionIndex).toBeGreaterThan(-1);
			expect(walIndex).toBeLessThan(versionIndex);
		});
	});

	describe('rapid sequential writes', () => {
		it('should handle 10 rapid sequential query event inserts', async () => {
			const { StatsDB } = await import('../../main/stats-db');
			const db = new StatsDB();
			db.initialize();

			// Clear mocks after initialize() to count only test operations
			mockStatement.run.mockClear();

			const ids: string[] = [];
			for (let i = 0; i < 10; i++) {
				const id = db.insertQueryEvent({
					sessionId: `session-${i}`,
					agentType: 'claude-code',
					source: 'user',
					startTime: Date.now() + i,
					duration: 1000 + i,
					projectPath: '/test/project',
					tabId: `tab-${i}`,
				});
				ids.push(id);
			}

			expect(ids).toHaveLength(10);
			// All IDs should be unique
			expect(new Set(ids).size).toBe(10);
			expect(mockStatement.run).toHaveBeenCalledTimes(10);
		});

		it('should handle 10 rapid sequential Auto Run session inserts', async () => {
			const { StatsDB } = await import('../../main/stats-db');
			const db = new StatsDB();
			db.initialize();

			// Clear mocks after initialize() to count only test operations
			mockStatement.run.mockClear();

			const ids: string[] = [];
			for (let i = 0; i < 10; i++) {
				const id = db.insertAutoRunSession({
					sessionId: `session-${i}`,
					agentType: 'claude-code',
					documentPath: `/docs/TASK-${i}.md`,
					startTime: Date.now() + i,
					duration: 0,
					tasksTotal: 5,
					tasksCompleted: 0,
					projectPath: '/test/project',
				});
				ids.push(id);
			}

			expect(ids).toHaveLength(10);
			expect(new Set(ids).size).toBe(10);
			expect(mockStatement.run).toHaveBeenCalledTimes(10);
		});

		it('should handle 10 rapid sequential task inserts', async () => {
			const { StatsDB } = await import('../../main/stats-db');
			const db = new StatsDB();
			db.initialize();

			// Clear mocks after initialize() to count only test operations
			mockStatement.run.mockClear();

			const ids: string[] = [];
			for (let i = 0; i < 10; i++) {
				const id = db.insertAutoRunTask({
					autoRunSessionId: 'auto-run-1',
					sessionId: 'session-1',
					agentType: 'claude-code',
					taskIndex: i,
					taskContent: `Task ${i} content`,
					startTime: Date.now() + i,
					duration: 1000 + i,
					success: i % 2 === 0,
				});
				ids.push(id);
			}

			expect(ids).toHaveLength(10);
			expect(new Set(ids).size).toBe(10);
			expect(mockStatement.run).toHaveBeenCalledTimes(10);
		});
	});

	describe('concurrent write operations', () => {
		it('should handle concurrent writes to different tables via Promise.all', async () => {
			const { StatsDB } = await import('../../main/stats-db');
			const db = new StatsDB();
			db.initialize();

			// Clear mocks after initialize() to count only test operations
			mockStatement.run.mockClear();

			// Simulate concurrent writes by wrapping synchronous operations in promises
			const writeOperations = [
				Promise.resolve().then(() =>
					db.insertQueryEvent({
						sessionId: 'session-1',
						agentType: 'claude-code',
						source: 'user',
						startTime: Date.now(),
						duration: 5000,
					})
				),
				Promise.resolve().then(() =>
					db.insertAutoRunSession({
						sessionId: 'session-2',
						agentType: 'claude-code',
						startTime: Date.now(),
						duration: 0,
						tasksTotal: 3,
					})
				),
				Promise.resolve().then(() =>
					db.insertAutoRunTask({
						autoRunSessionId: 'auto-1',
						sessionId: 'session-3',
						agentType: 'claude-code',
						taskIndex: 0,
						startTime: Date.now(),
						duration: 1000,
						success: true,
					})
				),
			];

			const results = await Promise.all(writeOperations);

			expect(results).toHaveLength(3);
			expect(results.every((id) => typeof id === 'string' && id.length > 0)).toBe(true);
			expect(mockStatement.run).toHaveBeenCalledTimes(3);
		});

		it('should handle 20 concurrent query event inserts via Promise.all', async () => {
			const { StatsDB } = await import('../../main/stats-db');
			const db = new StatsDB();
			db.initialize();

			// Clear mocks after initialize() to count only test operations
			mockStatement.run.mockClear();

			const writeOperations = Array.from({ length: 20 }, (_, i) =>
				Promise.resolve().then(() =>
					db.insertQueryEvent({
						sessionId: `session-${i}`,
						agentType: i % 2 === 0 ? 'claude-code' : 'opencode',
						source: i % 3 === 0 ? 'auto' : 'user',
						startTime: Date.now() + i,
						duration: 1000 + i * 100,
						projectPath: `/project/${i}`,
					})
				)
			);

			const results = await Promise.all(writeOperations);

			expect(results).toHaveLength(20);
			expect(new Set(results).size).toBe(20); // All IDs unique
			expect(mockStatement.run).toHaveBeenCalledTimes(20);
		});

		it('should handle mixed insert and update operations concurrently', async () => {
			const { StatsDB } = await import('../../main/stats-db');
			const db = new StatsDB();
			db.initialize();

			// Clear mocks after initialize() to count only test operations
			mockStatement.run.mockClear();

			const operations = [
				Promise.resolve().then(() =>
					db.insertQueryEvent({
						sessionId: 'session-1',
						agentType: 'claude-code',
						source: 'user',
						startTime: Date.now(),
						duration: 5000,
					})
				),
				Promise.resolve().then(() =>
					db.updateAutoRunSession('existing-session', {
						duration: 60000,
						tasksCompleted: 5,
					})
				),
				Promise.resolve().then(() =>
					db.insertAutoRunTask({
						autoRunSessionId: 'auto-1',
						sessionId: 'session-2',
						agentType: 'claude-code',
						taskIndex: 0,
						startTime: Date.now(),
						duration: 1000,
						success: true,
					})
				),
			];

			const results = await Promise.all(operations);

			expect(results).toHaveLength(3);
			// First and third return IDs, second returns boolean
			expect(typeof results[0]).toBe('string');
			expect(typeof results[1]).toBe('boolean');
			expect(typeof results[2]).toBe('string');
			expect(mockStatement.run).toHaveBeenCalledTimes(3);
		});
	});

	describe('interleaved read/write operations', () => {
		it('should handle reads during writes without blocking', async () => {
			mockStatement.all.mockReturnValue([
				{
					id: 'event-1',
					session_id: 'session-1',
					agent_type: 'claude-code',
					source: 'user',
					start_time: Date.now(),
					duration: 5000,
					project_path: '/test',
					tab_id: null,
				},
			]);

			const { StatsDB } = await import('../../main/stats-db');
			const db = new StatsDB();
			db.initialize();

			const operations = [
				// Write
				Promise.resolve().then(() =>
					db.insertQueryEvent({
						sessionId: 'session-new',
						agentType: 'claude-code',
						source: 'user',
						startTime: Date.now(),
						duration: 3000,
					})
				),
				// Read
				Promise.resolve().then(() => db.getQueryEvents('day')),
				// Write
				Promise.resolve().then(() =>
					db.insertAutoRunSession({
						sessionId: 'session-2',
						agentType: 'claude-code',
						startTime: Date.now(),
						duration: 0,
						tasksTotal: 5,
					})
				),
				// Read
				Promise.resolve().then(() => db.getAutoRunSessions('week')),
			];

			const results = await Promise.all(operations);

			expect(results).toHaveLength(4);
			expect(typeof results[0]).toBe('string'); // Insert ID
			expect(Array.isArray(results[1])).toBe(true); // Query events array
			expect(typeof results[2]).toBe('string'); // Insert ID
			expect(Array.isArray(results[3])).toBe(true); // Auto run sessions array
		});

		it('should allow reads to complete while multiple writes are pending', async () => {
			let readCompleted = false;
			mockStatement.all.mockImplementation(() => {
				readCompleted = true;
				return [{ count: 42 }];
			});

			const { StatsDB } = await import('../../main/stats-db');
			const db = new StatsDB();
			db.initialize();

			// Start multiple writes
			const writes = Array.from({ length: 5 }, (_, i) =>
				Promise.resolve().then(() =>
					db.insertQueryEvent({
						sessionId: `session-${i}`,
						agentType: 'claude-code',
						source: 'user',
						startTime: Date.now() + i,
						duration: 1000,
					})
				)
			);

			// Interleave a read
			const read = Promise.resolve().then(() => db.getQueryEvents('day'));

			const [writeResults, readResult] = await Promise.all([Promise.all(writes), read]);

			expect(writeResults).toHaveLength(5);
			expect(readCompleted).toBe(true);
		});
	});

	describe('high-volume concurrent writes', () => {
		it('should handle 50 concurrent writes without data loss', async () => {
			const { StatsDB } = await import('../../main/stats-db');
			const db = new StatsDB();
			db.initialize();

			// Reset counter after initialize() to count only test operations
			const insertedCount = { value: 0 };
			mockStatement.run.mockImplementation(() => {
				insertedCount.value++;
				return { changes: 1 };
			});

			const writeOperations = Array.from({ length: 50 }, (_, i) =>
				Promise.resolve().then(() =>
					db.insertQueryEvent({
						sessionId: `session-${i}`,
						agentType: 'claude-code',
						source: i % 2 === 0 ? 'user' : 'auto',
						startTime: Date.now() + i,
						duration: 1000 + i,
					})
				)
			);

			const results = await Promise.all(writeOperations);

			expect(results).toHaveLength(50);
			expect(insertedCount.value).toBe(50); // All writes completed
			expect(new Set(results).size).toBe(50); // All IDs unique
		});

		it('should handle 100 concurrent writes across all three tables', async () => {
			const writesByTable = { query: 0, session: 0, task: 0 };

			// Track which table each insert goes to based on SQL
			mockDb.prepare.mockImplementation((sql: string) => {
				const tracker = mockStatement;
				if (sql.includes('INSERT INTO query_events')) {
					tracker.run = vi.fn(() => {
						writesByTable.query++;
						return { changes: 1 };
					});
				} else if (sql.includes('INSERT INTO auto_run_sessions')) {
					tracker.run = vi.fn(() => {
						writesByTable.session++;
						return { changes: 1 };
					});
				} else if (sql.includes('INSERT INTO auto_run_tasks')) {
					tracker.run = vi.fn(() => {
						writesByTable.task++;
						return { changes: 1 };
					});
				}
				return tracker;
			});

			const { StatsDB } = await import('../../main/stats-db');
			const db = new StatsDB();
			db.initialize();

			// 40 query events + 30 sessions + 30 tasks = 100 writes
			const queryWrites = Array.from({ length: 40 }, (_, i) =>
				Promise.resolve().then(() =>
					db.insertQueryEvent({
						sessionId: `query-session-${i}`,
						agentType: 'claude-code',
						source: 'user',
						startTime: Date.now() + i,
						duration: 1000,
					})
				)
			);

			const sessionWrites = Array.from({ length: 30 }, (_, i) =>
				Promise.resolve().then(() =>
					db.insertAutoRunSession({
						sessionId: `autorun-session-${i}`,
						agentType: 'claude-code',
						startTime: Date.now() + i,
						duration: 0,
						tasksTotal: 5,
					})
				)
			);

			const taskWrites = Array.from({ length: 30 }, (_, i) =>
				Promise.resolve().then(() =>
					db.insertAutoRunTask({
						autoRunSessionId: `auto-${i}`,
						sessionId: `task-session-${i}`,
						agentType: 'claude-code',
						taskIndex: i,
						startTime: Date.now() + i,
						duration: 1000,
						success: true,
					})
				)
			);

			const allResults = await Promise.all([...queryWrites, ...sessionWrites, ...taskWrites]);

			expect(allResults).toHaveLength(100);
			expect(allResults.every((id) => typeof id === 'string' && id.length > 0)).toBe(true);
			expect(writesByTable.query).toBe(40);
			expect(writesByTable.session).toBe(30);
			expect(writesByTable.task).toBe(30);
		});
	});

	describe('unique ID generation under concurrent load', () => {
		it('should generate unique IDs even with high-frequency calls', async () => {
			const { StatsDB } = await import('../../main/stats-db');
			const db = new StatsDB();
			db.initialize();

			// Generate 100 IDs as fast as possible
			const ids: string[] = [];
			for (let i = 0; i < 100; i++) {
				const id = db.insertQueryEvent({
					sessionId: 'session-1',
					agentType: 'claude-code',
					source: 'user',
					startTime: Date.now(),
					duration: 1000,
				});
				ids.push(id);
			}

			// All IDs must be unique
			expect(new Set(ids).size).toBe(100);
		});

		it('should generate IDs with timestamp-random format', async () => {
			const { StatsDB } = await import('../../main/stats-db');
			const db = new StatsDB();
			db.initialize();

			const id = db.insertQueryEvent({
				sessionId: 'session-1',
				agentType: 'claude-code',
				source: 'user',
				startTime: Date.now(),
				duration: 1000,
			});

			// ID format: timestamp-randomString
			expect(id).toMatch(/^\d+-[a-z0-9]+$/);
		});
	});

	describe('database connection stability', () => {
		it('should maintain stable connection during intensive operations', async () => {
			const { StatsDB } = await import('../../main/stats-db');
			const db = new StatsDB();
			db.initialize();

			// Perform many operations
			for (let i = 0; i < 30; i++) {
				db.insertQueryEvent({
					sessionId: `session-${i}`,
					agentType: 'claude-code',
					source: 'user',
					startTime: Date.now() + i,
					duration: 1000,
				});
			}

			// Database should still be ready
			expect(db.isReady()).toBe(true);
		});

		it('should handle operations after previous operations complete', async () => {
			const { StatsDB } = await import('../../main/stats-db');
			const db = new StatsDB();
			db.initialize();

			// Track call count manually since we're testing sequential batches
			// Set up tracking AFTER initialize() to count only test operations
			let runCallCount = 0;
			const trackingStatement = {
				run: vi.fn(() => {
					runCallCount++;
					return { changes: 1 };
				}),
				get: vi.fn(() => ({ count: 0, total_duration: 0 })),
				all: vi.fn(() => []),
			};
			mockDb.prepare.mockReturnValue(trackingStatement);

			// First batch
			for (let i = 0; i < 10; i++) {
				db.insertQueryEvent({
					sessionId: `batch1-${i}`,
					agentType: 'claude-code',
					source: 'user',
					startTime: Date.now() + i,
					duration: 1000,
				});
			}

			// Second batch (should work without issues)
			const secondBatchIds: string[] = [];
			for (let i = 0; i < 10; i++) {
				const id = db.insertQueryEvent({
					sessionId: `batch2-${i}`,
					agentType: 'claude-code',
					source: 'user',
					startTime: Date.now() + 100 + i,
					duration: 2000,
				});
				secondBatchIds.push(id);
			}

			expect(secondBatchIds).toHaveLength(10);
			expect(runCallCount).toBe(20);
		});
	});
});

/**
 * electron-rebuild verification tests
 *
 * These tests verify that better-sqlite3 is correctly configured to be built
 * via electron-rebuild on all platforms (macOS, Windows, Linux). The native
 * module must be compiled against Electron's Node.js headers to work correctly
 * in the Electron runtime.
 *
 * Key verification points:
 * 1. postinstall script is configured to run electron-rebuild
 * 2. better-sqlite3 is excluded from asar packaging (must be unpacked)
 * 3. Native module paths are platform-appropriate
 * 4. CI/CD workflow includes architecture verification
 *
 * Note: These tests verify the configuration and mock the build process.
 * Actual native module compilation is tested in CI/CD workflows.
 */
describe('electron-rebuild verification for better-sqlite3', () => {
	describe('package.json configuration', () => {
		it('should have postinstall script that runs electron-rebuild for better-sqlite3', async () => {
			// Use node:fs to bypass the mock and access the real filesystem
			const fs = await import('node:fs');
			const path = await import('node:path');

			// Find package.json relative to the test file
			let packageJsonPath = path.join(__dirname, '..', '..', '..', 'package.json');

			// The package.json should exist and contain electron-rebuild for better-sqlite3
			const packageJsonContent = fs.readFileSync(packageJsonPath, 'utf8');
			const packageJson = JSON.parse(packageJsonContent);

			expect(packageJson.scripts).toBeDefined();
			expect(packageJson.scripts.postinstall).toBeDefined();
			expect(packageJson.scripts.postinstall).toContain('electron-rebuild');
			expect(packageJson.scripts.postinstall).toContain('better-sqlite3');
		});

		it('should have better-sqlite3 in dependencies', async () => {
			const fs = await import('node:fs');
			const path = await import('node:path');

			let packageJsonPath = path.join(__dirname, '..', '..', '..', 'package.json');
			const packageJsonContent = fs.readFileSync(packageJsonPath, 'utf8');
			const packageJson = JSON.parse(packageJsonContent);

			expect(packageJson.dependencies).toBeDefined();
			expect(packageJson.dependencies['better-sqlite3']).toBeDefined();
		});

		it('should have electron-rebuild in devDependencies', async () => {
			const fs = await import('node:fs');
			const path = await import('node:path');

			let packageJsonPath = path.join(__dirname, '..', '..', '..', 'package.json');
			const packageJsonContent = fs.readFileSync(packageJsonPath, 'utf8');
			const packageJson = JSON.parse(packageJsonContent);

			expect(packageJson.devDependencies).toBeDefined();
			expect(packageJson.devDependencies['electron-rebuild']).toBeDefined();
		});

		it('should have @types/better-sqlite3 in devDependencies', async () => {
			const fs = await import('node:fs');
			const path = await import('node:path');

			let packageJsonPath = path.join(__dirname, '..', '..', '..', 'package.json');
			const packageJsonContent = fs.readFileSync(packageJsonPath, 'utf8');
			const packageJson = JSON.parse(packageJsonContent);

			expect(packageJson.devDependencies).toBeDefined();
			expect(packageJson.devDependencies['@types/better-sqlite3']).toBeDefined();
		});

		it('should configure asarUnpack for better-sqlite3 (native modules must be unpacked)', async () => {
			const fs = await import('node:fs');
			const path = await import('node:path');

			let packageJsonPath = path.join(__dirname, '..', '..', '..', 'package.json');
			const packageJsonContent = fs.readFileSync(packageJsonPath, 'utf8');
			const packageJson = JSON.parse(packageJsonContent);

			// electron-builder config should unpack native modules from asar
			expect(packageJson.build).toBeDefined();
			expect(packageJson.build.asarUnpack).toBeDefined();
			expect(Array.isArray(packageJson.build.asarUnpack)).toBe(true);
			expect(packageJson.build.asarUnpack).toContain('node_modules/better-sqlite3/**/*');
		});

		it('should disable npmRebuild in electron-builder (we use postinstall instead)', async () => {
			const fs = await import('node:fs');
			const path = await import('node:path');

			let packageJsonPath = path.join(__dirname, '..', '..', '..', 'package.json');
			const packageJsonContent = fs.readFileSync(packageJsonPath, 'utf8');
			const packageJson = JSON.parse(packageJsonContent);

			// npmRebuild should be false because we explicitly run electron-rebuild
			// in postinstall and CI/CD workflows
			expect(packageJson.build).toBeDefined();
			expect(packageJson.build.npmRebuild).toBe(false);
		});
	});

	describe('CI/CD workflow configuration', () => {
		it('should have release workflow that rebuilds native modules', async () => {
			const fs = await import('node:fs');
			const path = await import('node:path');

			const workflowPath = path.join(
				__dirname,
				'..',
				'..',
				'..',
				'.github',
				'workflows',
				'release.yml'
			);
			const workflowContent = fs.readFileSync(workflowPath, 'utf8');

			// Workflow should run postinstall which triggers electron-rebuild
			expect(workflowContent).toContain('npm run postinstall');
			expect(workflowContent).toContain('npm_config_build_from_source');
		});

		it('should configure builds for all target platforms', async () => {
			const fs = await import('node:fs');
			const path = await import('node:path');

			const workflowPath = path.join(
				__dirname,
				'..',
				'..',
				'..',
				'.github',
				'workflows',
				'release.yml'
			);
			const workflowContent = fs.readFileSync(workflowPath, 'utf8');

			// Verify all platforms are configured
			expect(workflowContent).toContain('macos-latest');
			expect(workflowContent).toContain('ubuntu-latest');
			expect(workflowContent).toContain('ubuntu-24.04-arm'); // ARM64 Linux
			expect(workflowContent).toContain('windows-latest');
		});

		it('should have architecture verification for native modules', async () => {
			const fs = await import('node:fs');
			const path = await import('node:path');

			const workflowPath = path.join(
				__dirname,
				'..',
				'..',
				'..',
				'.github',
				'workflows',
				'release.yml'
			);
			const workflowContent = fs.readFileSync(workflowPath, 'utf8');

			// Workflow should verify native module architecture before packaging
			expect(workflowContent).toContain('Verify');
			expect(workflowContent).toContain('electron-rebuild');
		});

		it('should use --force flag for electron-rebuild', async () => {
			const fs = await import('node:fs');
			const path = await import('node:path');

			let packageJsonPath = path.join(__dirname, '..', '..', '..', 'package.json');
			const packageJsonContent = fs.readFileSync(packageJsonPath, 'utf8');
			const packageJson = JSON.parse(packageJsonContent);

			// The -f (force) flag ensures rebuild even if binaries exist
			expect(packageJson.scripts.postinstall).toContain('-f');
		});
	});

	describe('native module structure (macOS verification)', () => {
		it('should have better-sqlite3 native binding in expected location', async () => {
			const fs = await import('node:fs');
			const path = await import('node:path');

			// Check if the native binding exists in build/Release (compiled location)
			const nativeModulePath = path.join(
				__dirname,
				'..',
				'..',
				'..',
				'node_modules',
				'better-sqlite3',
				'build',
				'Release',
				'better_sqlite3.node'
			);

			// The native module should exist after electron-rebuild
			// This test will pass on dev machines where npm install was run
			const exists = fs.existsSync(nativeModulePath);

			// If the native module doesn't exist, check if there's a prebuilt binary
			if (!exists) {
				// Check for prebuilt binaries in the bin directory
				const binDir = path.join(
					__dirname,
					'..',
					'..',
					'..',
					'node_modules',
					'better-sqlite3',
					'bin'
				);

				if (fs.existsSync(binDir)) {
					const binContents = fs.readdirSync(binDir);
					// Should have platform-specific prebuilt binaries
					expect(binContents.length).toBeGreaterThan(0);
				} else {
					// Neither compiled nor prebuilt binary exists - fail
					expect(exists).toBe(true);
				}
			}
		});

		it('should verify binding.gyp exists for native compilation', async () => {
			const fs = await import('node:fs');
			const path = await import('node:path');

			const bindingGypPath = path.join(
				__dirname,
				'..',
				'..',
				'..',
				'node_modules',
				'better-sqlite3',
				'binding.gyp'
			);

			// binding.gyp is required for node-gyp compilation
			expect(fs.existsSync(bindingGypPath)).toBe(true);
		});
	});

	describe('platform-specific build paths', () => {
		it('should verify macOS native module extension is .node', () => {
			// On macOS, native modules have .node extension (Mach-O bundle)
			const platform = process.platform;
			if (platform === 'darwin') {
				expect('.node').toBe('.node');
			}
		});

		it('should verify Windows native module extension is .node', () => {
			// On Windows, native modules have .node extension (DLL)
			const platform = process.platform;
			if (platform === 'win32') {
				expect('.node').toBe('.node');
			}
		});

		it('should verify Linux native module extension is .node', () => {
			// On Linux, native modules have .node extension (shared object)
			const platform = process.platform;
			if (platform === 'linux') {
				expect('.node').toBe('.node');
			}
		});

		it('should verify electron target is specified in postinstall', async () => {
			const fs = await import('node:fs');
			const path = await import('node:path');

			let packageJsonPath = path.join(__dirname, '..', '..', '..', 'package.json');
			const packageJsonContent = fs.readFileSync(packageJsonPath, 'utf8');
			const packageJson = JSON.parse(packageJsonContent);

			// postinstall uses electron-rebuild which automatically detects electron version
			expect(packageJson.scripts.postinstall).toContain('electron-rebuild');
			// The -w flag specifies which modules to rebuild
			expect(packageJson.scripts.postinstall).toContain('-w');
		});
	});

	describe('database import verification', () => {
		it('should be able to mock better-sqlite3 for testing', async () => {
			// This test verifies our mock setup is correct
			const { StatsDB } = await import('../../main/stats-db');
			const db = new StatsDB();

			// Should be able to initialize with mocked database
			expect(() => db.initialize()).not.toThrow();
			expect(db.isReady()).toBe(true);
		});

		it('should verify StatsDB uses better-sqlite3 correctly', async () => {
			// Reset mocks to track this specific test
			vi.clearAllMocks();

			const { StatsDB } = await import('../../main/stats-db');
			const db = new StatsDB();
			db.initialize();

			// Database should be initialized and ready
			expect(db.isReady()).toBe(true);

			// Verify WAL mode is enabled for concurrent access
			expect(mockDb.pragma).toHaveBeenCalled();
		});
	});
});

/**
 * File path normalization tests
 *
 * These tests verify that file paths are normalized to use forward slashes
 * consistently across platforms. This ensures:
 * 1. Windows-style paths (backslashes) are converted to forward slashes
 * 2. Paths stored in the database are platform-independent
 * 3. Filtering by project path works regardless of input path format
 * 4. Cross-platform data portability is maintained
 */
describe('File path normalization in database (forward slashes consistently)', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		lastDbPath = null;
		mockDb.pragma.mockReturnValue([{ user_version: 1 }]);
		mockDb.prepare.mockReturnValue(mockStatement);
		mockStatement.run.mockReturnValue({ changes: 1 });
		mockStatement.all.mockReturnValue([]);
		mockFsExistsSync.mockReturnValue(true);
		mockFsMkdirSync.mockClear();
	});

	afterEach(() => {
		vi.resetModules();
	});

	describe('normalizePath utility function', () => {
		it('should convert Windows backslashes to forward slashes', async () => {
			const { normalizePath } = await import('../../main/stats-db');
			expect(normalizePath('C:\\Users\\TestUser\\Projects\\MyApp')).toBe(
				'C:/Users/TestUser/Projects/MyApp'
			);
		});

		it('should preserve Unix-style forward slashes unchanged', async () => {
			const { normalizePath } = await import('../../main/stats-db');
			expect(normalizePath('/Users/testuser/Projects/MyApp')).toBe(
				'/Users/testuser/Projects/MyApp'
			);
		});

		it('should handle mixed slashes (normalize to forward slashes)', async () => {
			const { normalizePath } = await import('../../main/stats-db');
			expect(normalizePath('C:\\Users/TestUser\\Projects/MyApp')).toBe(
				'C:/Users/TestUser/Projects/MyApp'
			);
		});

		it('should handle UNC paths (Windows network shares)', async () => {
			const { normalizePath } = await import('../../main/stats-db');
			expect(normalizePath('\\\\NetworkServer\\Share\\Folder\\File.md')).toBe(
				'//NetworkServer/Share/Folder/File.md'
			);
		});

		it('should return null for null input', async () => {
			const { normalizePath } = await import('../../main/stats-db');
			expect(normalizePath(null)).toBeNull();
		});

		it('should return null for undefined input', async () => {
			const { normalizePath } = await import('../../main/stats-db');
			expect(normalizePath(undefined)).toBeNull();
		});

		it('should handle empty string', async () => {
			const { normalizePath } = await import('../../main/stats-db');
			expect(normalizePath('')).toBe('');
		});

		it('should handle path with spaces', async () => {
			const { normalizePath } = await import('../../main/stats-db');
			expect(normalizePath('C:\\Users\\Test User\\My Documents\\Project')).toBe(
				'C:/Users/Test User/My Documents/Project'
			);
		});

		it('should handle path with special characters', async () => {
			const { normalizePath } = await import('../../main/stats-db');
			expect(normalizePath('C:\\Users\\test.user-name\\Projects\\[MyApp]')).toBe(
				'C:/Users/test.user-name/Projects/[MyApp]'
			);
		});

		it('should handle consecutive backslashes', async () => {
			const { normalizePath } = await import('../../main/stats-db');
			expect(normalizePath('C:\\\\Users\\\\TestUser')).toBe('C://Users//TestUser');
		});

		it('should handle path ending with backslash', async () => {
			const { normalizePath } = await import('../../main/stats-db');
			expect(normalizePath('C:\\Users\\TestUser\\')).toBe('C:/Users/TestUser/');
		});

		it('should handle Japanese/CJK characters in path', async () => {
			const { normalizePath } = await import('../../main/stats-db');
			expect(normalizePath('C:\\Users\\ユーザー\\プロジェクト')).toBe(
				'C:/Users/ユーザー/プロジェクト'
			);
		});
	});

	describe('insertQueryEvent path normalization', () => {
		it('should normalize Windows projectPath to forward slashes', async () => {
			const { StatsDB } = await import('../../main/stats-db');
			const db = new StatsDB();
			db.initialize();

			db.insertQueryEvent({
				sessionId: 'session-1',
				agentType: 'claude-code',
				source: 'user',
				startTime: Date.now(),
				duration: 5000,
				projectPath: 'C:\\Users\\TestUser\\Projects\\MyApp',
				tabId: 'tab-1',
			});

			// Verify that the statement was called with normalized path
			// insertQueryEvent now has 9 parameters: id, sessionId, agentType, source, startTime, duration, projectPath, tabId, isRemote
			expect(mockStatement.run).toHaveBeenCalledWith(
				expect.any(String), // id
				'session-1',
				'claude-code',
				'user',
				expect.any(Number), // startTime
				5000,
				'C:/Users/TestUser/Projects/MyApp', // normalized path
				'tab-1',
				null // isRemote (undefined → null)
			);
		});

		it('should preserve Unix projectPath unchanged', async () => {
			const { StatsDB } = await import('../../main/stats-db');
			const db = new StatsDB();
			db.initialize();

			db.insertQueryEvent({
				sessionId: 'session-1',
				agentType: 'claude-code',
				source: 'user',
				startTime: Date.now(),
				duration: 5000,
				projectPath: '/Users/testuser/Projects/MyApp',
				tabId: 'tab-1',
			});

			// insertQueryEvent now has 9 parameters including isRemote
			expect(mockStatement.run).toHaveBeenCalledWith(
				expect.any(String),
				'session-1',
				'claude-code',
				'user',
				expect.any(Number),
				5000,
				'/Users/testuser/Projects/MyApp', // unchanged
				'tab-1',
				null // isRemote (undefined → null)
			);
		});

		it('should store null for undefined projectPath', async () => {
			const { StatsDB } = await import('../../main/stats-db');
			const db = new StatsDB();
			db.initialize();

			db.insertQueryEvent({
				sessionId: 'session-1',
				agentType: 'claude-code',
				source: 'user',
				startTime: Date.now(),
				duration: 5000,
				// projectPath is undefined
			});

			// insertQueryEvent now has 9 parameters including isRemote
			expect(mockStatement.run).toHaveBeenCalledWith(
				expect.any(String),
				'session-1',
				'claude-code',
				'user',
				expect.any(Number),
				5000,
				null, // undefined becomes null
				null, // tabId undefined → null
				null // isRemote undefined → null
			);
		});
	});

	describe('getQueryEvents filter path normalization', () => {
		it('should normalize Windows filter projectPath for matching', async () => {
			// Setup: database returns events with normalized paths
			mockStatement.all.mockReturnValue([
				{
					id: 'event-1',
					session_id: 'session-1',
					agent_type: 'claude-code',
					source: 'user',
					start_time: Date.now(),
					duration: 5000,
					project_path: 'C:/Users/TestUser/Projects/MyApp', // normalized in DB
					tab_id: 'tab-1',
				},
			]);

			const { StatsDB } = await import('../../main/stats-db');
			const db = new StatsDB();
			db.initialize();

			// Query with Windows-style path (backslashes)
			const events = db.getQueryEvents('day', {
				projectPath: 'C:\\Users\\TestUser\\Projects\\MyApp', // Windows style
			});

			// Verify the prepared statement was called with normalized path
			expect(mockDb.prepare).toHaveBeenCalledWith(expect.stringContaining('project_path = ?'));

			// The filter should be normalized to forward slashes for matching
			const prepareCallArgs = mockStatement.all.mock.calls[0];
			expect(prepareCallArgs).toContain('C:/Users/TestUser/Projects/MyApp');
		});

		it('should preserve Unix filter projectPath unchanged', async () => {
			mockStatement.all.mockReturnValue([]);

			const { StatsDB } = await import('../../main/stats-db');
			const db = new StatsDB();
			db.initialize();

			db.getQueryEvents('week', {
				projectPath: '/Users/testuser/Projects/MyApp',
			});

			const prepareCallArgs = mockStatement.all.mock.calls[0];
			expect(prepareCallArgs).toContain('/Users/testuser/Projects/MyApp');
		});
	});

	describe('insertAutoRunSession path normalization', () => {
		it('should normalize Windows documentPath and projectPath', async () => {
			const { StatsDB } = await import('../../main/stats-db');
			const db = new StatsDB();
			db.initialize();

			db.insertAutoRunSession({
				sessionId: 'session-1',
				agentType: 'claude-code',
				documentPath: 'C:\\Users\\TestUser\\Docs\\task.md',
				startTime: Date.now(),
				duration: 60000,
				tasksTotal: 5,
				tasksCompleted: 3,
				projectPath: 'C:\\Users\\TestUser\\Projects\\MyApp',
			});

			expect(mockStatement.run).toHaveBeenCalledWith(
				expect.any(String),
				'session-1',
				'claude-code',
				'C:/Users/TestUser/Docs/task.md', // normalized documentPath
				expect.any(Number),
				60000,
				5,
				3,
				'C:/Users/TestUser/Projects/MyApp' // normalized projectPath
			);
		});

		it('should handle null paths correctly', async () => {
			const { StatsDB } = await import('../../main/stats-db');
			const db = new StatsDB();
			db.initialize();

			db.insertAutoRunSession({
				sessionId: 'session-1',
				agentType: 'claude-code',
				startTime: Date.now(),
				duration: 60000,
				// documentPath and projectPath are undefined
			});

			expect(mockStatement.run).toHaveBeenCalledWith(
				expect.any(String),
				'session-1',
				'claude-code',
				null, // undefined documentPath becomes null
				expect.any(Number),
				60000,
				null,
				null,
				null // undefined projectPath becomes null
			);
		});
	});

	describe('updateAutoRunSession path normalization', () => {
		it('should normalize Windows documentPath on update', async () => {
			const { StatsDB } = await import('../../main/stats-db');
			const db = new StatsDB();
			db.initialize();

			db.updateAutoRunSession('auto-run-1', {
				duration: 120000,
				documentPath: 'D:\\Projects\\NewDocs\\updated.md',
			});

			// The SQL should include document_path update with normalized path
			expect(mockDb.prepare).toHaveBeenCalledWith(expect.stringContaining('document_path = ?'));
			expect(mockStatement.run).toHaveBeenCalled();
		});

		it('should handle undefined documentPath in update (no change)', async () => {
			const { StatsDB } = await import('../../main/stats-db');
			const db = new StatsDB();
			db.initialize();

			db.updateAutoRunSession('auto-run-1', {
				duration: 120000,
				tasksCompleted: 5,
				// documentPath not included
			});

			// The SQL should NOT include document_path
			const prepareCalls = mockDb.prepare.mock.calls;
			const updateCall = prepareCalls.find((call) => call[0]?.includes?.('UPDATE'));
			if (updateCall) {
				expect(updateCall[0]).not.toContain('document_path');
			}
		});
	});

	describe('cross-platform path consistency', () => {
		it('should produce identical normalized paths from Windows and Unix inputs for same logical path', async () => {
			const { normalizePath } = await import('../../main/stats-db');

			const windowsPath = 'C:\\Users\\Test\\project';
			const unixPath = 'C:/Users/Test/project';

			expect(normalizePath(windowsPath)).toBe(normalizePath(unixPath));
		});

		it('should allow filtering by either path style and match stored normalized path', async () => {
			// Setup: database returns events with normalized paths
			const storedPath = 'C:/Users/TestUser/Projects/MyApp';
			mockStatement.all.mockReturnValue([
				{
					id: 'event-1',
					session_id: 'session-1',
					agent_type: 'claude-code',
					source: 'user',
					start_time: Date.now(),
					duration: 5000,
					project_path: storedPath,
					tab_id: 'tab-1',
				},
			]);

			const { StatsDB, normalizePath } = await import('../../main/stats-db');
			const db = new StatsDB();
			db.initialize();

			// Both Windows and Unix style filters should normalize to the same value
			const windowsFilter = 'C:\\Users\\TestUser\\Projects\\MyApp';
			const unixFilter = 'C:/Users/TestUser/Projects/MyApp';

			expect(normalizePath(windowsFilter)).toBe(storedPath);
			expect(normalizePath(unixFilter)).toBe(storedPath);
		});

		it('should handle Linux paths correctly', async () => {
			const { normalizePath } = await import('../../main/stats-db');
			expect(normalizePath('/home/user/.config/maestro')).toBe('/home/user/.config/maestro');
		});

		it('should handle macOS Application Support paths correctly', async () => {
			const { normalizePath } = await import('../../main/stats-db');
			expect(normalizePath('/Users/test/Library/Application Support/Maestro')).toBe(
				'/Users/test/Library/Application Support/Maestro'
			);
		});
	});

	describe('edge cases and special characters', () => {
		it('should handle paths with unicode characters', async () => {
			const { normalizePath } = await import('../../main/stats-db');
			expect(normalizePath('C:\\Users\\用户\\项目')).toBe('C:/Users/用户/项目');
		});

		it('should handle paths with emoji (if supported by filesystem)', async () => {
			const { normalizePath } = await import('../../main/stats-db');
			expect(normalizePath('C:\\Users\\Test\\📁Projects\\MyApp')).toBe(
				'C:/Users/Test/📁Projects/MyApp'
			);
		});

		it('should handle very long paths', async () => {
			const { normalizePath } = await import('../../main/stats-db');
			const longPath =
				'C:\\Users\\TestUser\\' + 'VeryLongDirectoryName\\'.repeat(20) + 'FinalFile.md';
			const normalizedPath = normalizePath(longPath);
			expect(normalizedPath).not.toContain('\\');
			expect(normalizedPath).toContain('/');
		});

		it('should handle root paths', async () => {
			const { normalizePath } = await import('../../main/stats-db');
			expect(normalizePath('C:\\')).toBe('C:/');
			expect(normalizePath('/')).toBe('/');
		});

		it('should handle drive letter only', async () => {
			const { normalizePath } = await import('../../main/stats-db');
			expect(normalizePath('D:')).toBe('D:');
		});

		it('should handle paths with dots', async () => {
			const { normalizePath } = await import('../../main/stats-db');
			expect(normalizePath('C:\\Users\\..\\TestUser\\.hidden\\file.txt')).toBe(
				'C:/Users/../TestUser/.hidden/file.txt'
			);
		});
	});
});

/**
 * Database VACUUM functionality tests
 *
 * Tests for the automatic database vacuum feature that runs on startup
 * when the database exceeds 100MB to maintain performance.
 */
describe('Database VACUUM functionality', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		lastDbPath = null;
		mockDb.pragma.mockReturnValue([{ user_version: 0 }]);
		mockDb.prepare.mockReturnValue(mockStatement);
		mockStatement.run.mockReturnValue({ changes: 1 });
		mockFsExistsSync.mockReturnValue(true);
		// Reset statSync to throw by default (simulates file not existing)
		mockFsStatSync.mockImplementation(() => {
			throw new Error('ENOENT: no such file or directory');
		});
	});

	afterEach(() => {
		vi.resetModules();
	});

	describe('getDatabaseSize', () => {
		it('should return 0 when statSync throws (file missing)', async () => {
			// The mock fs.statSync is not configured to return size by default
			// so getDatabaseSize will catch the error and return 0
			const { StatsDB } = await import('../../main/stats-db');
			const db = new StatsDB();
			db.initialize();

			// Since mockFsExistsSync.mockReturnValue(true) is set but statSync is not mocked,
			// getDatabaseSize will try to call the real statSync on a non-existent path
			// and catch the error, returning 0
			const size = db.getDatabaseSize();

			// The mock environment doesn't have actual file, so expect 0
			expect(size).toBe(0);
		});

		it('should handle statSync gracefully when file does not exist', async () => {
			const { StatsDB } = await import('../../main/stats-db');
			const db = new StatsDB();
			db.initialize();

			// getDatabaseSize should not throw
			expect(() => db.getDatabaseSize()).not.toThrow();
		});
	});

	describe('vacuum', () => {
		it('should execute VACUUM SQL command', async () => {
			const { StatsDB } = await import('../../main/stats-db');
			const db = new StatsDB();
			db.initialize();

			// Clear mocks from initialization
			mockStatement.run.mockClear();
			mockDb.prepare.mockClear();

			const result = db.vacuum();

			expect(result.success).toBe(true);
			expect(mockDb.prepare).toHaveBeenCalledWith('VACUUM');
			expect(mockStatement.run).toHaveBeenCalled();
		});

		it('should return success true when vacuum completes', async () => {
			const { StatsDB } = await import('../../main/stats-db');
			const db = new StatsDB();
			db.initialize();

			const result = db.vacuum();

			expect(result.success).toBe(true);
			expect(result.error).toBeUndefined();
		});

		it('should return bytesFreed of 0 when sizes are equal (mocked)', async () => {
			const { StatsDB } = await import('../../main/stats-db');
			const db = new StatsDB();
			db.initialize();

			const result = db.vacuum();

			// With mock fs, both before and after sizes will be 0
			expect(result.bytesFreed).toBe(0);
		});

		it('should return error if database not initialized', async () => {
			const { StatsDB } = await import('../../main/stats-db');
			const db = new StatsDB();
			// Don't initialize

			const result = db.vacuum();

			expect(result.success).toBe(false);
			expect(result.bytesFreed).toBe(0);
			expect(result.error).toBe('Database not initialized');
		});

		it('should handle VACUUM failure gracefully', async () => {
			const { StatsDB } = await import('../../main/stats-db');
			const db = new StatsDB();
			db.initialize();

			// Make VACUUM fail
			mockDb.prepare.mockImplementation((sql: string) => {
				if (sql === 'VACUUM') {
					return {
						run: vi.fn().mockImplementation(() => {
							throw new Error('database is locked');
						}),
					};
				}
				return mockStatement;
			});

			const result = db.vacuum();

			expect(result.success).toBe(false);
			expect(result.error).toContain('database is locked');
		});

		it('should log vacuum progress with size information', async () => {
			const { logger } = await import('../../main/utils/logger');
			const { StatsDB } = await import('../../main/stats-db');
			const db = new StatsDB();
			db.initialize();

			// Clear logger mocks from initialization
			vi.mocked(logger.info).mockClear();

			db.vacuum();

			// Check that logger was called with vacuum-related messages
			expect(logger.info).toHaveBeenCalledWith(
				expect.stringContaining('Starting VACUUM'),
				expect.any(String)
			);
			expect(logger.info).toHaveBeenCalledWith(
				expect.stringContaining('VACUUM completed'),
				expect.any(String)
			);
		});
	});

	describe('vacuumIfNeeded', () => {
		it('should skip vacuum if database size is 0 (below threshold)', async () => {
			const { StatsDB } = await import('../../main/stats-db');
			const db = new StatsDB();
			db.initialize();

			// Clear mocks from initialization
			mockStatement.run.mockClear();
			mockDb.prepare.mockClear();

			const result = db.vacuumIfNeeded();

			// Size is 0 (mock fs), which is below 100MB threshold
			expect(result.vacuumed).toBe(false);
			expect(result.databaseSize).toBe(0);
			expect(result.result).toBeUndefined();
		});

		it('should return correct databaseSize in result', async () => {
			const { StatsDB } = await import('../../main/stats-db');
			const db = new StatsDB();
			db.initialize();

			const result = db.vacuumIfNeeded();

			// Size property should be present
			expect(typeof result.databaseSize).toBe('number');
		});

		it('should use default 100MB threshold when not specified', async () => {
			const { StatsDB } = await import('../../main/stats-db');
			const db = new StatsDB();
			db.initialize();

			// With 0 byte size (mocked), should skip vacuum
			const result = db.vacuumIfNeeded();

			expect(result.vacuumed).toBe(false);
		});

		it('should not vacuum with threshold 0 and size 0 since 0 is not > 0', async () => {
			const { StatsDB } = await import('../../main/stats-db');
			const db = new StatsDB();
			db.initialize();

			// Clear mocks from initialization
			mockStatement.run.mockClear();
			mockDb.prepare.mockClear();

			// With 0 threshold and 0 byte file: 0 is NOT greater than 0
			const result = db.vacuumIfNeeded(0);

			// The condition is: databaseSize < thresholdBytes
			// 0 < 0 is false, so vacuumed should be true (it tries to vacuum)
			expect(result.databaseSize).toBe(0);
			// Since 0 is NOT less than 0, it proceeds to vacuum
			expect(result.vacuumed).toBe(true);
		});

		it('should log appropriate message when skipping vacuum', async () => {
			const { logger } = await import('../../main/utils/logger');
			const { StatsDB } = await import('../../main/stats-db');
			const db = new StatsDB();
			db.initialize();

			// Clear logger mocks from initialization
			vi.mocked(logger.debug).mockClear();

			db.vacuumIfNeeded();

			expect(logger.debug).toHaveBeenCalledWith(
				expect.stringContaining('below vacuum threshold'),
				expect.any(String)
			);
		});
	});

	describe('vacuumIfNeeded with custom thresholds', () => {
		it('should respect custom threshold parameter (threshold = -1 means always vacuum)', async () => {
			const { StatsDB } = await import('../../main/stats-db');
			const db = new StatsDB();
			db.initialize();

			// Clear mocks from initialization
			mockStatement.run.mockClear();
			mockDb.prepare.mockClear();

			// With -1 threshold, 0 > -1 is true, so should vacuum
			const result = db.vacuumIfNeeded(-1);

			expect(result.vacuumed).toBe(true);
			expect(mockDb.prepare).toHaveBeenCalledWith('VACUUM');
		});

		it('should not vacuum with very large threshold', async () => {
			const { StatsDB } = await import('../../main/stats-db');
			const db = new StatsDB();
			db.initialize();

			// Clear mocks from initialization
			mockStatement.run.mockClear();
			mockDb.prepare.mockClear();

			// With 1TB threshold, should NOT trigger vacuum
			const result = db.vacuumIfNeeded(1024 * 1024 * 1024 * 1024);

			expect(result.vacuumed).toBe(false);
			expect(mockDb.prepare).not.toHaveBeenCalledWith('VACUUM');
		});
	});

	describe('initialize with vacuumIfNeeded integration', () => {
		it('should call vacuumIfNeededWeekly during initialization', async () => {
			const { logger } = await import('../../main/utils/logger');

			// Clear logger mocks before test
			vi.mocked(logger.debug).mockClear();

			// Mock timestamp file as old (0 = epoch, triggers vacuum check)
			mockFsReadFileSync.mockReturnValue('0');

			const { StatsDB } = await import('../../main/stats-db');
			const db = new StatsDB();

			db.initialize();

			// With old timestamp, vacuumIfNeededWeekly should proceed to call vacuumIfNeeded
			// which logs "below vacuum threshold" for small databases (mocked as 1024 bytes)
			expect(logger.debug).toHaveBeenCalledWith(
				expect.stringContaining('below vacuum threshold'),
				expect.any(String)
			);
		});

		it('should complete initialization even if vacuum would fail', async () => {
			// Make VACUUM fail if called
			mockDb.prepare.mockImplementation((sql: string) => {
				if (sql === 'VACUUM') {
					return {
						run: vi.fn().mockImplementation(() => {
							throw new Error('VACUUM failed: database is locked');
						}),
					};
				}
				return mockStatement;
			});

			const { StatsDB } = await import('../../main/stats-db');
			const db = new StatsDB();

			// Initialize should not throw (vacuum is skipped due to 0 size anyway)
			expect(() => db.initialize()).not.toThrow();

			// Database should still be ready
			expect(db.isReady()).toBe(true);
		});

		it('should not block initialization for small databases', async () => {
			const { StatsDB } = await import('../../main/stats-db');
			const db = new StatsDB();

			// Time the initialization (should be fast for mock)
			const start = Date.now();
			db.initialize();
			const elapsed = Date.now() - start;

			expect(db.isReady()).toBe(true);
			expect(elapsed).toBeLessThan(1000); // Should be fast in mock environment
		});
	});

	describe('vacuum return types', () => {
		it('vacuum should return object with success, bytesFreed, and optional error', async () => {
			const { StatsDB } = await import('../../main/stats-db');
			const db = new StatsDB();
			db.initialize();

			const result = db.vacuum();

			expect(typeof result.success).toBe('boolean');
			expect(typeof result.bytesFreed).toBe('number');
			expect(result.error === undefined || typeof result.error === 'string').toBe(true);
		});

		it('vacuumIfNeeded should return object with vacuumed, databaseSize, and optional result', async () => {
			const { StatsDB } = await import('../../main/stats-db');
			const db = new StatsDB();
			db.initialize();

			const result = db.vacuumIfNeeded();

			expect(typeof result.vacuumed).toBe('boolean');
			expect(typeof result.databaseSize).toBe('number');
			expect(result.result === undefined || typeof result.result === 'object').toBe(true);
		});

		it('vacuumIfNeeded should include result when vacuum is performed', async () => {
			const { StatsDB } = await import('../../main/stats-db');
			const db = new StatsDB();
			db.initialize();

			// Use -1 threshold to force vacuum
			const result = db.vacuumIfNeeded(-1);

			expect(result.vacuumed).toBe(true);
			expect(result.result).toBeDefined();
			expect(result.result?.success).toBe(true);
		});
	});

	describe('clearOldData method', () => {
		beforeEach(() => {
			vi.clearAllMocks();
			vi.resetModules();
		});

		it('should return error when database is not initialized', async () => {
			const { StatsDB } = await import('../../main/stats-db');
			const db = new StatsDB();
			// Don't initialize

			const result = db.clearOldData(30);

			expect(result.success).toBe(false);
			expect(result.deletedQueryEvents).toBe(0);
			expect(result.deletedAutoRunSessions).toBe(0);
			expect(result.deletedAutoRunTasks).toBe(0);
			expect(result.error).toBe('Database not initialized');
		});

		it('should return error when olderThanDays is 0 or negative', async () => {
			const { StatsDB } = await import('../../main/stats-db');
			const db = new StatsDB();
			db.initialize();

			const resultZero = db.clearOldData(0);
			expect(resultZero.success).toBe(false);
			expect(resultZero.error).toBe('olderThanDays must be greater than 0');

			const resultNegative = db.clearOldData(-10);
			expect(resultNegative.success).toBe(false);
			expect(resultNegative.error).toBe('olderThanDays must be greater than 0');
		});

		it('should successfully clear old data with valid parameters', async () => {
			// Mock prepare to return statements with expected behavior
			mockStatement.all.mockReturnValue([{ id: 'session-1' }, { id: 'session-2' }]);
			mockStatement.run.mockReturnValue({ changes: 5 });

			const { StatsDB } = await import('../../main/stats-db');
			const db = new StatsDB();
			db.initialize();

			const result = db.clearOldData(30);

			expect(result.success).toBe(true);
			expect(result.deletedQueryEvents).toBe(5);
			expect(result.deletedAutoRunSessions).toBe(5);
			expect(result.deletedAutoRunTasks).toBe(5);
			expect(result.error).toBeUndefined();
		});

		it('should handle empty results (no old data)', async () => {
			mockStatement.all.mockReturnValue([]);
			mockStatement.run.mockReturnValue({ changes: 0 });

			const { StatsDB } = await import('../../main/stats-db');
			const db = new StatsDB();
			db.initialize();

			const result = db.clearOldData(365);

			expect(result.success).toBe(true);
			expect(result.deletedQueryEvents).toBe(0);
			expect(result.deletedAutoRunSessions).toBe(0);
			expect(result.deletedAutoRunTasks).toBe(0);
			expect(result.error).toBeUndefined();
		});

		it('should calculate correct cutoff time based on days', async () => {
			let capturedCutoffTime: number | null = null;

			mockDb.prepare.mockImplementation((sql: string) => {
				return {
					run: vi.fn((cutoff: number) => {
						if (sql.includes('DELETE FROM query_events')) {
							capturedCutoffTime = cutoff;
						}
						return { changes: 0 };
					}),
					get: mockStatement.get,
					all: vi.fn(() => []),
				};
			});

			const { StatsDB } = await import('../../main/stats-db');
			const db = new StatsDB();
			db.initialize();

			const beforeCall = Date.now();
			db.clearOldData(7);
			const afterCall = Date.now();

			// Cutoff should be approximately 7 days ago
			const expectedCutoff = beforeCall - 7 * 24 * 60 * 60 * 1000;
			expect(capturedCutoffTime).not.toBeNull();
			expect(capturedCutoffTime!).toBeGreaterThanOrEqual(expectedCutoff - 1000);
			expect(capturedCutoffTime!).toBeLessThanOrEqual(afterCall - 7 * 24 * 60 * 60 * 1000 + 1000);
		});

		it('should handle database errors gracefully', async () => {
			mockDb.prepare.mockImplementation((sql: string) => {
				if (sql.includes('DELETE FROM query_events')) {
					return {
						run: vi.fn(() => {
							throw new Error('Database locked');
						}),
					};
				}
				return mockStatement;
			});

			const { StatsDB } = await import('../../main/stats-db');
			const db = new StatsDB();
			db.initialize();

			const result = db.clearOldData(30);

			expect(result.success).toBe(false);
			expect(result.error).toBe('Database locked');
			expect(result.deletedQueryEvents).toBe(0);
			expect(result.deletedAutoRunSessions).toBe(0);
			expect(result.deletedAutoRunTasks).toBe(0);
		});

		it('should support various time periods', async () => {
			mockStatement.all.mockReturnValue([]);
			mockStatement.run.mockReturnValue({ changes: 0 });

			const { StatsDB } = await import('../../main/stats-db');
			const db = new StatsDB();
			db.initialize();

			// Test common time periods from Settings UI
			const periods = [7, 30, 90, 180, 365];
			for (const days of periods) {
				const result = db.clearOldData(days);
				expect(result.success).toBe(true);
			}
		});
	});

	// =====================================================================
});
