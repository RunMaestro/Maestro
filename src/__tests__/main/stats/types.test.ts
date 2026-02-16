/**
 * Tests for shared stats type definitions.
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
const mockFsReaddirSync = vi.fn(() => [] as string[]);

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
	promises: {
		access: async (pathArg: unknown) => {
			if (!mockFsExistsSync(pathArg)) {
				const error = new Error('ENOENT');
				(error as NodeJS.ErrnoException).code = 'ENOENT';
				throw error;
			}
		},
		mkdir: async (...args: unknown[]) => mockFsMkdirSync(...args),
		stat: async (...args: unknown[]) => mockFsStatSync(...args),
		readdir: async (...args: unknown[]) => mockFsReaddirSync(...args),
		unlink: async (...args: unknown[]) => mockFsUnlinkSync(...args),
	},
	constants: { F_OK: 0 },
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
			const ranges: StatsTimeRange[] = ['day', 'week', 'month', 'quarter', 'year', 'all'];

			expect(ranges).toHaveLength(6);
			expect(ranges).toContain('day');
			expect(ranges).toContain('quarter');
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
