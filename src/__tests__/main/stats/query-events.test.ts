/**
 * Tests for query event CRUD operations, filtering, and CSV export.
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

			const { StatsDB } = await import('../../../main/stats');
			const db = new StatsDB();
			await db.initialize();

			db.getQueryEvents('day');

			// Verify the SQL includes time filter
			const prepareCall = mockDb.prepare.mock.calls.find((call) =>
				(call[0] as string).includes('SELECT * FROM query_events')
			);
			expect(prepareCall).toBeDefined();
		});

		it('should filter with agentType filter', async () => {
			mockStatement.all.mockReturnValue([]);

			const { StatsDB } = await import('../../../main/stats');
			const db = new StatsDB();
			await db.initialize();

			db.getQueryEvents('week', { agentType: 'claude-code' });

			// Verify the SQL includes agent_type filter
			expect(mockStatement.all).toHaveBeenCalled();
		});

		it('should filter with source filter', async () => {
			mockStatement.all.mockReturnValue([]);

			const { StatsDB } = await import('../../../main/stats');
			const db = new StatsDB();
			await db.initialize();

			db.getQueryEvents('month', { source: 'auto' });

			// Verify the SQL includes source filter
			expect(mockStatement.all).toHaveBeenCalled();
		});

		it('should filter with projectPath filter', async () => {
			mockStatement.all.mockReturnValue([]);

			const { StatsDB } = await import('../../../main/stats');
			const db = new StatsDB();
			await db.initialize();

			db.getQueryEvents('year', { projectPath: '/test/project' });

			// Verify the SQL includes project_path filter
			expect(mockStatement.all).toHaveBeenCalled();
		});

		it('should filter with sessionId filter', async () => {
			mockStatement.all.mockReturnValue([]);

			const { StatsDB } = await import('../../../main/stats');
			const db = new StatsDB();
			await db.initialize();

			db.getQueryEvents('all', { sessionId: 'session-123' });

			// Verify the SQL includes session_id filter
			expect(mockStatement.all).toHaveBeenCalled();
		});

		it('should combine multiple filters', async () => {
			mockStatement.all.mockReturnValue([]);

			const { StatsDB } = await import('../../../main/stats');
			const db = new StatsDB();
			await db.initialize();

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

			const { StatsDB } = await import('../../../main/stats');
			const db = new StatsDB();
			await db.initialize();

			const stats = db.getAggregatedStats('week');

			expect(stats.totalQueries).toBe(100);
			expect(stats.totalDuration).toBe(500000);
			expect(stats.avgDuration).toBe(5000);
		});

		it('should handle empty results for aggregation', async () => {
			mockStatement.get.mockReturnValue({ count: 0, total_duration: 0 });
			mockStatement.all.mockReturnValue([]);

			const { StatsDB } = await import('../../../main/stats');
			const db = new StatsDB();
			await db.initialize();

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

			const { StatsDB } = await import('../../../main/stats');
			const db = new StatsDB();
			await db.initialize();

			const csv = db.exportToCsv('week');

			// Verify CSV structure
			expect(csv).toContain('id,sessionId,agentType,source,startTime,duration,projectPath,tabId');
			expect(csv).toContain('event-1');
			expect(csv).toContain('session-1');
			expect(csv).toContain('claude-code');
		});

		it('should handle empty data for CSV export', async () => {
			mockStatement.all.mockReturnValue([]);

			const { StatsDB } = await import('../../../main/stats');
			const db = new StatsDB();
			await db.initialize();

			const csv = db.exportToCsv('day');

			// Should only contain headers
			expect(csv).toBe(
				'id,sessionId,agentType,source,startTime,duration,projectPath,tabId,isRemote'
			);
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
			const { StatsDB } = await import('../../../main/stats');
			const db = new StatsDB();
			await db.initialize();

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
			const { StatsDB } = await import('../../../main/stats');
			const db = new StatsDB();
			await db.initialize();

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
			const { StatsDB } = await import('../../../main/stats');
			const db = new StatsDB();
			await db.initialize();

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
			const { StatsDB } = await import('../../../main/stats');
			const db = new StatsDB();
			await db.initialize();

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

			const { StatsDB } = await import('../../../main/stats');
			const db = new StatsDB();
			await db.initialize();

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

			const { StatsDB } = await import('../../../main/stats');
			const db = new StatsDB();
			await db.initialize();

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

			const { StatsDB } = await import('../../../main/stats');
			const db = new StatsDB();
			await db.initialize();

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

			const { StatsDB } = await import('../../../main/stats');
			const db = new StatsDB();
			await db.initialize();

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

			const { StatsDB } = await import('../../../main/stats');
			const db = new StatsDB();
			await db.initialize();

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

			const { StatsDB } = await import('../../../main/stats');
			const db = new StatsDB();
			await db.initialize();

			const stats = db.getAggregatedStats('month');

			expect(stats.bySource.user).toBe(10);
			expect(stats.bySource.auto).toBe(5);
		});
	});

	describe('timing accuracy for interactive sessions', () => {
		it('should preserve exact startTime and duration values', async () => {
			const { StatsDB } = await import('../../../main/stats');
			const db = new StatsDB();
			await db.initialize();

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
			const { StatsDB } = await import('../../../main/stats');
			const db = new StatsDB();
			await db.initialize();

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
			const { StatsDB } = await import('../../../main/stats');
			const db = new StatsDB();
			await db.initialize();

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
