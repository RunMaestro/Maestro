/**
 * Tests for time range filtering and aggregation calculations.
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

			const { StatsDB } = await import('../../../main/stats');
			const db = new StatsDB();
			await db.initialize();

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

			const { StatsDB } = await import('../../../main/stats');
			const db = new StatsDB();
			await db.initialize();

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

			const { StatsDB } = await import('../../../main/stats');
			const db = new StatsDB();
			await db.initialize();

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

			const { StatsDB } = await import('../../../main/stats');
			const db = new StatsDB();
			await db.initialize();

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
			const { StatsDB } = await import('../../../main/stats');
			const db = new StatsDB();
			await db.initialize();

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

			const { StatsDB } = await import('../../../main/stats');
			const db = new StatsDB();
			await db.initialize();

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

			const { StatsDB } = await import('../../../main/stats');
			const db = new StatsDB();
			await db.initialize();

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

			const { StatsDB } = await import('../../../main/stats');
			const db = new StatsDB();
			await db.initialize();

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

			const { StatsDB } = await import('../../../main/stats');
			const db = new StatsDB();
			await db.initialize();

			db.getAutoRunSessions('year');

			const allCalls = mockStatement.all.mock.calls;
			expect(allCalls.length).toBeGreaterThan(0);

			const lastCall = allCalls[allCalls.length - 1];
			const startTimeParam = lastCall[0] as number;

			expect(startTimeParam).toBeGreaterThanOrEqual(now - oneYearMs - 5000);
			expect(startTimeParam).toBeLessThanOrEqual(now - oneYearMs + 5000);
		});

		it('should filter Auto Run sessions by "all" range', async () => {
			const { StatsDB } = await import('../../../main/stats');
			const db = new StatsDB();
			await db.initialize();

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

			const { StatsDB } = await import('../../../main/stats');
			const db = new StatsDB();
			await db.initialize();
			mockStatement.get.mockClear();

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

			const { StatsDB } = await import('../../../main/stats');
			const db = new StatsDB();
			await db.initialize();
			mockStatement.get.mockClear();

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

			const { StatsDB } = await import('../../../main/stats');
			const db = new StatsDB();
			await db.initialize();
			mockStatement.get.mockClear();

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

			const { StatsDB } = await import('../../../main/stats');
			const db = new StatsDB();
			await db.initialize();
			mockStatement.get.mockClear();

			db.getAggregatedStats('year');

			const getCalls = mockStatement.get.mock.calls;
			expect(getCalls.length).toBeGreaterThan(0);

			const firstCall = getCalls[0];
			const startTimeParam = firstCall[0] as number;

			expect(startTimeParam).toBeGreaterThanOrEqual(now - oneYearMs - 5000);
			expect(startTimeParam).toBeLessThanOrEqual(now - oneYearMs + 5000);
		});

		it('should aggregate stats for "all" range', async () => {
			const { StatsDB } = await import('../../../main/stats');
			const db = new StatsDB();
			await db.initialize();
			mockStatement.get.mockClear();

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

			const { StatsDB } = await import('../../../main/stats');
			const db = new StatsDB();
			await db.initialize();

			db.exportToCsv('day');

			const allCalls = mockStatement.all.mock.calls;
			expect(allCalls.length).toBeGreaterThan(0);

			const lastCall = allCalls[allCalls.length - 1];
			const startTimeParam = lastCall[0] as number;

			expect(startTimeParam).toBeGreaterThanOrEqual(now - oneDayMs - 5000);
			expect(startTimeParam).toBeLessThanOrEqual(now - oneDayMs + 5000);
		});

		it('should export CSV for "all" range', async () => {
			const { StatsDB } = await import('../../../main/stats');
			const db = new StatsDB();
			await db.initialize();

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
			const { StatsDB } = await import('../../../main/stats');
			const db = new StatsDB();
			await db.initialize();

			db.getQueryEvents('week');

			const prepareCalls = mockDb.prepare.mock.calls;
			const selectCall = prepareCalls.find((call) =>
				(call[0] as string).includes('SELECT * FROM query_events')
			);

			expect(selectCall).toBeDefined();
			expect(selectCall![0]).toContain('start_time >= ?');
		});

		it('should include start_time >= ? in getAutoRunSessions SQL', async () => {
			const { StatsDB } = await import('../../../main/stats');
			const db = new StatsDB();
			await db.initialize();

			db.getAutoRunSessions('month');

			const prepareCalls = mockDb.prepare.mock.calls;
			const selectCall = prepareCalls.find((call) =>
				(call[0] as string).includes('SELECT * FROM auto_run_sessions')
			);

			expect(selectCall).toBeDefined();
			expect(selectCall![0]).toContain('start_time >= ?');
		});

		it('should include start_time >= ? in aggregation queries', async () => {
			const { StatsDB } = await import('../../../main/stats');
			const db = new StatsDB();
			await db.initialize();

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

			const { StatsDB } = await import('../../../main/stats');
			const db = new StatsDB();
			await db.initialize();

			const events = db.getQueryEvents('day');

			// Event at the boundary should be included (start_time >= boundary)
			expect(events).toHaveLength(1);
			expect(events[0].id).toBe('boundary-event');
		});

		it('should exclude events before the range boundary', async () => {
			// The actual filtering happens in the SQL query via WHERE clause
			// We verify this by checking the SQL structure
			const { StatsDB } = await import('../../../main/stats');
			const db = new StatsDB();
			await db.initialize();

			db.getQueryEvents('day');

			const prepareCalls = mockDb.prepare.mock.calls;
			const selectCall = prepareCalls.find((call) =>
				(call[0] as string).includes('SELECT * FROM query_events')
			);

			// Verify it uses >= (greater than or equal), not just > (greater than)
			expect(selectCall![0]).toContain('start_time >= ?');
		});

		it('should return consistent results for multiple calls with same range', async () => {
			const { StatsDB } = await import('../../../main/stats');
			const db = new StatsDB();
			await db.initialize();

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
			const { StatsDB } = await import('../../../main/stats');
			const db = new StatsDB();
			await db.initialize();

			db.getQueryEvents('week', { agentType: 'claude-code' });

			const allCalls = mockStatement.all.mock.calls;
			expect(allCalls.length).toBeGreaterThan(0);

			const lastCall = allCalls[allCalls.length - 1];
			// Should have 2 parameters: start_time and agentType
			expect(lastCall).toHaveLength(2);
			expect(lastCall[1]).toBe('claude-code');
		});

		it('should combine time range with source filter', async () => {
			const { StatsDB } = await import('../../../main/stats');
			const db = new StatsDB();
			await db.initialize();

			db.getQueryEvents('month', { source: 'auto' });

			const allCalls = mockStatement.all.mock.calls;
			expect(allCalls.length).toBeGreaterThan(0);

			const lastCall = allCalls[allCalls.length - 1];
			// Should have 2 parameters: start_time and source
			expect(lastCall).toHaveLength(2);
			expect(lastCall[1]).toBe('auto');
		});

		it('should combine time range with multiple filters', async () => {
			const { StatsDB } = await import('../../../main/stats');
			const db = new StatsDB();
			await db.initialize();

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

			const { StatsDB } = await import('../../../main/stats');
			const db = new StatsDB();
			await db.initialize();

			const stats = db.getAggregatedStats('week');

			expect(stats.totalQueries).toBe(42);
		});

		it('should return correct totalDuration sum from database', async () => {
			mockStatement.get.mockReturnValue({ count: 10, total_duration: 50000 });
			mockStatement.all.mockReturnValue([]);

			const { StatsDB } = await import('../../../main/stats');
			const db = new StatsDB();
			await db.initialize();

			const stats = db.getAggregatedStats('month');

			expect(stats.totalDuration).toBe(50000);
		});

		it('should handle zero queries correctly', async () => {
			mockStatement.get.mockReturnValue({ count: 0, total_duration: 0 });
			mockStatement.all.mockReturnValue([]);

			const { StatsDB } = await import('../../../main/stats');
			const db = new StatsDB();
			await db.initialize();

			const stats = db.getAggregatedStats('day');

			expect(stats.totalQueries).toBe(0);
			expect(stats.totalDuration).toBe(0);
		});

		it('should handle large query counts correctly', async () => {
			mockStatement.get.mockReturnValue({ count: 10000, total_duration: 5000000 });
			mockStatement.all.mockReturnValue([]);

			const { StatsDB } = await import('../../../main/stats');
			const db = new StatsDB();
			await db.initialize();

			const stats = db.getAggregatedStats('year');

			expect(stats.totalQueries).toBe(10000);
			expect(stats.totalDuration).toBe(5000000);
		});

		it('should handle very large durations correctly', async () => {
			// 1 day of continuous usage = 86400000ms
			const largeDuration = 86400000;
			mockStatement.get.mockReturnValue({ count: 100, total_duration: largeDuration });
			mockStatement.all.mockReturnValue([]);

			const { StatsDB } = await import('../../../main/stats');
			const db = new StatsDB();
			await db.initialize();

			const stats = db.getAggregatedStats('all');

			expect(stats.totalDuration).toBe(largeDuration);
		});
	});

	describe('avgDuration calculation', () => {
		it('should calculate correct average duration', async () => {
			// 100 queries, 500000ms total = 5000ms average
			mockStatement.get.mockReturnValue({ count: 100, total_duration: 500000 });
			mockStatement.all.mockReturnValue([]);

			const { StatsDB } = await import('../../../main/stats');
			const db = new StatsDB();
			await db.initialize();

			const stats = db.getAggregatedStats('week');

			expect(stats.avgDuration).toBe(5000);
		});

		it('should return 0 average duration when no queries', async () => {
			mockStatement.get.mockReturnValue({ count: 0, total_duration: 0 });
			mockStatement.all.mockReturnValue([]);

			const { StatsDB } = await import('../../../main/stats');
			const db = new StatsDB();
			await db.initialize();

			const stats = db.getAggregatedStats('day');

			// Avoid division by zero - should return 0
			expect(stats.avgDuration).toBe(0);
		});

		it('should round average duration to nearest integer', async () => {
			// 3 queries, 10000ms total = 3333.33... average, should round to 3333
			mockStatement.get.mockReturnValue({ count: 3, total_duration: 10000 });
			mockStatement.all.mockReturnValue([]);

			const { StatsDB } = await import('../../../main/stats');
			const db = new StatsDB();
			await db.initialize();

			const stats = db.getAggregatedStats('month');

			// Math.round(10000 / 3) = 3333
			expect(stats.avgDuration).toBe(3333);
		});

		it('should handle single query average correctly', async () => {
			mockStatement.get.mockReturnValue({ count: 1, total_duration: 12345 });
			mockStatement.all.mockReturnValue([]);

			const { StatsDB } = await import('../../../main/stats');
			const db = new StatsDB();
			await db.initialize();

			const stats = db.getAggregatedStats('day');

			expect(stats.avgDuration).toBe(12345);
		});

		it('should handle edge case of tiny durations', async () => {
			// 5 queries with 1ms each = 5ms total, 1ms average
			mockStatement.get.mockReturnValue({ count: 5, total_duration: 5 });
			mockStatement.all.mockReturnValue([]);

			const { StatsDB } = await import('../../../main/stats');
			const db = new StatsDB();
			await db.initialize();

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

			const { StatsDB } = await import('../../../main/stats');
			const db = new StatsDB();
			await db.initialize();

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

			const { StatsDB } = await import('../../../main/stats');
			const db = new StatsDB();
			await db.initialize();

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

			const { StatsDB } = await import('../../../main/stats');
			const db = new StatsDB();
			await db.initialize();

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

			const { StatsDB } = await import('../../../main/stats');
			const db = new StatsDB();
			await db.initialize();

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

			const { StatsDB } = await import('../../../main/stats');
			const db = new StatsDB();
			await db.initialize();

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

			const { StatsDB } = await import('../../../main/stats');
			const db = new StatsDB();
			await db.initialize();

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

			const { StatsDB } = await import('../../../main/stats');
			const db = new StatsDB();
			await db.initialize();

			const stats = db.getAggregatedStats('year');

			expect(stats.bySource.user).toBe(0);
			expect(stats.bySource.auto).toBe(200);
		});

		it('should initialize bySource with zeros when no data', async () => {
			mockStatement.get.mockReturnValue({ count: 0, total_duration: 0 });
			mockStatement.all.mockReturnValue([]);

			const { StatsDB } = await import('../../../main/stats');
			const db = new StatsDB();
			await db.initialize();

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

			const { StatsDB } = await import('../../../main/stats');
			const db = new StatsDB();
			await db.initialize();

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

			const { StatsDB } = await import('../../../main/stats');
			const db = new StatsDB();
			await db.initialize();

			const stats = db.getAggregatedStats('week');

			expect(stats.byDay).toHaveLength(3);
			expect(stats.byDay[0]).toEqual({ date: '2024-01-01', count: 10, duration: 50000 });
			expect(stats.byDay[1]).toEqual({ date: '2024-01-02', count: 12, duration: 60000 });
			expect(stats.byDay[2]).toEqual({ date: '2024-01-03', count: 8, duration: 40000 });
		});

		it('should return empty array when no daily data exists', async () => {
			mockStatement.get.mockReturnValue({ count: 0, total_duration: 0 });
			mockStatement.all.mockReturnValue([]);

			const { StatsDB } = await import('../../../main/stats');
			const db = new StatsDB();
			await db.initialize();

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

			const { StatsDB } = await import('../../../main/stats');
			const db = new StatsDB();
			await db.initialize();

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

			const { StatsDB } = await import('../../../main/stats');
			const db = new StatsDB();
			await db.initialize();

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

			const { StatsDB } = await import('../../../main/stats');
			const db = new StatsDB();
			await db.initialize();

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

			const { StatsDB } = await import('../../../main/stats');
			const db = new StatsDB();
			await db.initialize();

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

			const { StatsDB } = await import('../../../main/stats');
			const db = new StatsDB();
			await db.initialize();

			const stats1 = db.getAggregatedStats('week');
			const stats2 = db.getAggregatedStats('week');

			expect(stats1.totalQueries).toBe(stats2.totalQueries);
			expect(stats1.totalDuration).toBe(stats2.totalDuration);
			expect(stats1.avgDuration).toBe(stats2.avgDuration);
		});

		it('should handle concurrent access correctly', async () => {
			mockStatement.get.mockReturnValue({ count: 100, total_duration: 500000 });
			mockStatement.all.mockReturnValue([]);

			const { StatsDB } = await import('../../../main/stats');
			const db = new StatsDB();
			await db.initialize();

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

			const { StatsDB } = await import('../../../main/stats');
			const db = new StatsDB();
			await db.initialize();

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

			const { StatsDB } = await import('../../../main/stats');
			const db = new StatsDB();
			await db.initialize();

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

			const { StatsDB } = await import('../../../main/stats');
			const db = new StatsDB();
			await db.initialize();

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

			const { StatsDB } = await import('../../../main/stats');
			const db = new StatsDB();
			await db.initialize();

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

			const { StatsDB } = await import('../../../main/stats');
			const db = new StatsDB();
			await db.initialize();

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

			const { StatsDB } = await import('../../../main/stats');
			const db = new StatsDB();
			await db.initialize();

			const stats = db.getAggregatedStats('day');

			// Math.round(5 / 10) = 1
			expect(stats.avgDuration).toBe(1);
		});

		it('should handle maximum JavaScript safe integer values', async () => {
			const maxSafe = Number.MAX_SAFE_INTEGER;
			// Use a count that divides evenly to avoid rounding issues
			mockStatement.get.mockReturnValue({ count: 1, total_duration: maxSafe });
			mockStatement.all.mockReturnValue([]);

			const { StatsDB } = await import('../../../main/stats');
			const db = new StatsDB();
			await db.initialize();

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

			const { StatsDB } = await import('../../../main/stats');
			const db = new StatsDB();
			await db.initialize();

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

			const { StatsDB } = await import('../../../main/stats');
			const db = new StatsDB();
			await db.initialize();

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
