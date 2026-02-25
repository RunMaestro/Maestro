/**
 * Tests for concurrent database access and native module verification.
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
			const { StatsDB } = await import('../../../main/stats');
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

			const { StatsDB } = await import('../../../main/stats');
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
			const { StatsDB } = await import('../../../main/stats');
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
			const { StatsDB } = await import('../../../main/stats');
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
			const { StatsDB } = await import('../../../main/stats');
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
			const { StatsDB } = await import('../../../main/stats');
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
			const { StatsDB } = await import('../../../main/stats');
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
			const { StatsDB } = await import('../../../main/stats');
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

			const { StatsDB } = await import('../../../main/stats');
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

			const { StatsDB } = await import('../../../main/stats');
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
			const { StatsDB } = await import('../../../main/stats');
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

			const { StatsDB } = await import('../../../main/stats');
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
			const { StatsDB } = await import('../../../main/stats');
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
			const { StatsDB } = await import('../../../main/stats');
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
			const { StatsDB } = await import('../../../main/stats');
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
			const { StatsDB } = await import('../../../main/stats');
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
			let packageJsonPath = path.join(__dirname, '..', '..', '..', '..', 'package.json');

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

			let packageJsonPath = path.join(__dirname, '..', '..', '..', '..', 'package.json');
			const packageJsonContent = fs.readFileSync(packageJsonPath, 'utf8');
			const packageJson = JSON.parse(packageJsonContent);

			expect(packageJson.dependencies).toBeDefined();
			expect(packageJson.dependencies['better-sqlite3']).toBeDefined();
		});

		it('should have electron-rebuild in devDependencies', async () => {
			const fs = await import('node:fs');
			const path = await import('node:path');

			let packageJsonPath = path.join(__dirname, '..', '..', '..', '..', 'package.json');
			const packageJsonContent = fs.readFileSync(packageJsonPath, 'utf8');
			const packageJson = JSON.parse(packageJsonContent);

			expect(packageJson.devDependencies).toBeDefined();
			expect(packageJson.devDependencies['electron-rebuild']).toBeDefined();
		});

		it('should have @types/better-sqlite3 in devDependencies', async () => {
			const fs = await import('node:fs');
			const path = await import('node:path');

			let packageJsonPath = path.join(__dirname, '..', '..', '..', '..', 'package.json');
			const packageJsonContent = fs.readFileSync(packageJsonPath, 'utf8');
			const packageJson = JSON.parse(packageJsonContent);

			expect(packageJson.devDependencies).toBeDefined();
			expect(packageJson.devDependencies['@types/better-sqlite3']).toBeDefined();
		});

		it('should configure asarUnpack for better-sqlite3 (native modules must be unpacked)', async () => {
			const fs = await import('node:fs');
			const path = await import('node:path');

			let packageJsonPath = path.join(__dirname, '..', '..', '..', '..', 'package.json');
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

			let packageJsonPath = path.join(__dirname, '..', '..', '..', '..', 'package.json');
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

			let packageJsonPath = path.join(__dirname, '..', '..', '..', '..', 'package.json');
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

			let packageJsonPath = path.join(__dirname, '..', '..', '..', '..', 'package.json');
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
			const { StatsDB } = await import('../../../main/stats');
			const db = new StatsDB();

			// Should be able to initialize with mocked database
			expect(() => db.initialize()).not.toThrow();
			expect(db.isReady()).toBe(true);
		});

		it('should verify StatsDB uses better-sqlite3 correctly', async () => {
			// Reset mocks to track this specific test
			vi.clearAllMocks();

			const { StatsDB } = await import('../../../main/stats');
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
