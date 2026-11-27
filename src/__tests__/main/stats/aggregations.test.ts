/**
 * Tests for time range filtering and the Usage Dashboard aggregation.
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
import { addLocalDays, startOfLocalDay, toLocalYmd } from '../../../shared/localDay';
import { getTimeRangeStart } from '../../../shared/statsTimeRange';
import { computePercentiles, emptyPercentiles } from '../../../shared/percentiles';

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

import type Database from 'better-sqlite3';
import type { StatsTimeRange } from '../../../shared/stats-types';

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
		it('should filter by "day" range (since local midnight)', async () => {
			const now = Date.now();

			const { StatsDB } = await import('../../../main/stats');
			const db = new StatsDB();
			db.initialize();

			db.getQueryEvents('day');

			// Verify the start_time parameter is local midnight today
			const allCalls = mockStatement.all.mock.calls;
			expect(allCalls.length).toBeGreaterThan(0);

			const lastCall = allCalls[allCalls.length - 1];
			const startTimeParam = lastCall[0] as number;

			// "Today" is the local calendar day, not a rolling 24 hours (#1960)
			expect(startTimeParam).toBe(startOfLocalDay(now));
		});

		it('should filter by "week" range (last 7 days)', async () => {
			const now = Date.now();

			const { StatsDB } = await import('../../../main/stats');
			const db = new StatsDB();
			db.initialize();

			db.getQueryEvents('week');

			const allCalls = mockStatement.all.mock.calls;
			expect(allCalls.length).toBeGreaterThan(0);

			const lastCall = allCalls[allCalls.length - 1];
			const startTimeParam = lastCall[0] as number;

			// The start time should be approximately now - 7 days (within a few seconds tolerance)
			// Calendar-aligned: local midnight N-1 days back, today included
			expect(startTimeParam).toBe(getTimeRangeStart('week', now));
		});

		it('should filter by "month" range (last 30 days)', async () => {
			const now = Date.now();

			const { StatsDB } = await import('../../../main/stats');
			const db = new StatsDB();
			db.initialize();

			db.getQueryEvents('month');

			const allCalls = mockStatement.all.mock.calls;
			expect(allCalls.length).toBeGreaterThan(0);

			const lastCall = allCalls[allCalls.length - 1];
			const startTimeParam = lastCall[0] as number;

			// The start time should be approximately now - 30 days (within a few seconds tolerance)
			// Calendar-aligned: local midnight N-1 days back, today included
			expect(startTimeParam).toBe(getTimeRangeStart('month', now));
		});

		it('should filter by "year" range (last 365 days)', async () => {
			const now = Date.now();

			const { StatsDB } = await import('../../../main/stats');
			const db = new StatsDB();
			db.initialize();

			db.getQueryEvents('year');

			const allCalls = mockStatement.all.mock.calls;
			expect(allCalls.length).toBeGreaterThan(0);

			const lastCall = allCalls[allCalls.length - 1];
			const startTimeParam = lastCall[0] as number;

			// The start time should be approximately now - 365 days (within a few seconds tolerance)
			// Calendar-aligned: local midnight N-1 days back, today included
			expect(startTimeParam).toBe(getTimeRangeStart('year', now));
		});

		it('should filter by "all" range (from epoch/timestamp 0)', async () => {
			const { StatsDB } = await import('../../../main/stats');
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

			const { StatsDB } = await import('../../../main/stats');
			const db = new StatsDB();
			db.initialize();

			db.getAutoRunSessions('day');

			const allCalls = mockStatement.all.mock.calls;
			expect(allCalls.length).toBeGreaterThan(0);

			const lastCall = allCalls[allCalls.length - 1];
			const startTimeParam = lastCall[0] as number;

			// "Today" is the local calendar day, not a rolling 24 hours (#1960)
			expect(startTimeParam).toBe(startOfLocalDay(now));
		});

		it('should filter Auto Run sessions by "week" range', async () => {
			const now = Date.now();

			const { StatsDB } = await import('../../../main/stats');
			const db = new StatsDB();
			db.initialize();

			db.getAutoRunSessions('week');

			const allCalls = mockStatement.all.mock.calls;
			expect(allCalls.length).toBeGreaterThan(0);

			const lastCall = allCalls[allCalls.length - 1];
			const startTimeParam = lastCall[0] as number;

			// Calendar-aligned: local midnight N-1 days back, today included
			expect(startTimeParam).toBe(getTimeRangeStart('week', now));
		});

		it('should filter Auto Run sessions by "month" range', async () => {
			const now = Date.now();

			const { StatsDB } = await import('../../../main/stats');
			const db = new StatsDB();
			db.initialize();

			db.getAutoRunSessions('month');

			const allCalls = mockStatement.all.mock.calls;
			expect(allCalls.length).toBeGreaterThan(0);

			const lastCall = allCalls[allCalls.length - 1];
			const startTimeParam = lastCall[0] as number;

			// Calendar-aligned: local midnight N-1 days back, today included
			expect(startTimeParam).toBe(getTimeRangeStart('month', now));
		});

		it('should filter Auto Run sessions by "year" range', async () => {
			const now = Date.now();

			const { StatsDB } = await import('../../../main/stats');
			const db = new StatsDB();
			db.initialize();

			db.getAutoRunSessions('year');

			const allCalls = mockStatement.all.mock.calls;
			expect(allCalls.length).toBeGreaterThan(0);

			const lastCall = allCalls[allCalls.length - 1];
			const startTimeParam = lastCall[0] as number;

			// Calendar-aligned: local midnight N-1 days back, today included
			expect(startTimeParam).toBe(getTimeRangeStart('year', now));
		});

		it('should filter Auto Run sessions by "all" range', async () => {
			const { StatsDB } = await import('../../../main/stats');
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

	describe('getQueryEvents time range calculations', () => {
		it('should query events for the "day" range only', async () => {
			const now = Date.now();

			const { StatsDB } = await import('../../../main/stats');
			const db = new StatsDB();
			db.initialize();

			db.getQueryEvents('day');

			const allCalls = mockStatement.all.mock.calls;
			expect(allCalls.length).toBeGreaterThan(0);

			const lastCall = allCalls[allCalls.length - 1];
			const startTimeParam = lastCall[0] as number;

			// "Today" is the local calendar day, not a rolling 24 hours (#1960)
			expect(startTimeParam).toBe(startOfLocalDay(now));
		});

		it('should query events for the "all" range', async () => {
			const { StatsDB } = await import('../../../main/stats');
			const db = new StatsDB();
			db.initialize();

			db.getQueryEvents('all');

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
			const { StatsDB } = await import('../../../main/stats');
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
			db.initialize();

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
			const { StatsDB } = await import('../../../main/stats');
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
			const { StatsDB } = await import('../../../main/stats');
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
			const { StatsDB } = await import('../../../main/stats');
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
			const { StatsDB } = await import('../../../main/stats');
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
 * getAggregatedStats: the grouped passes, their JS rollups, and the memo.
 *
 * The aggregation module is driven with a fake database whose `prepare`
 * routes each statement by a fragment of its SQL, so a test states the rows a
 * pass returns instead of relying on the order statements happen to run in.
 * The SQL itself (window-function percentile ranks, the positional GROUP BY)
 * was checked against a real SQLite; better-sqlite3 cannot load under vitest.
 */
type Row = Record<string, unknown>;

interface AggregationFixture {
	totalChanges: number;
	bounds: { first_query: number | null; first_prompt: number | null };
	cube: Row[];
	perAgent: Row[];
	queryPercentiles: Row[];
	taskPercentiles: Row[];
	promptTimes: Row[];
	activeDays: Row[];
	imageAnnotations: number;
}

type Pass = keyof Omit<AggregationFixture, 'totalChanges' | 'bounds' | 'imageAnnotations'>;

/** Which pass a prepared statement belongs to, by a fragment of its SQL. */
function passFor(sql: string): Pass | 'changes' | 'bounds' | 'annotations' | null {
	if (sql.includes('total_changes()')) return 'changes';
	if (sql.includes('AS first_prompt')) return 'bounds';
	if (sql.includes('GROUP BY 1, 2, 3, 4, 5, 6')) return 'cube';
	if (sql.includes('AS priced_queries')) return 'perAgent';
	if (sql.includes('agent_rank')) return 'queryPercentiles';
	if (sql.includes('task_rank')) return 'taskPercentiles';
	if (sql.includes("source != 'auto' AND start_time >= ?")) return 'promptTimes';
	if (sql.includes('SELECT DISTINCT')) return 'activeDays';
	if (sql.includes('FROM image_annotations')) return 'annotations';
	return null;
}

function createAggregationDb(overrides: Partial<AggregationFixture> = {}) {
	const fixture: AggregationFixture = {
		totalChanges: 0,
		bounds: { first_query: null, first_prompt: null },
		cube: [],
		perAgent: [],
		queryPercentiles: [],
		taskPercentiles: [],
		promptTimes: [],
		activeDays: [],
		imageAnnotations: 0,
		...overrides,
	};
	/** `all(...)` calls per pass, so a test can check the bound start time. */
	const calls: Record<Pass, unknown[][]> = {
		cube: [],
		perAgent: [],
		queryPercentiles: [],
		taskPercentiles: [],
		promptTimes: [],
		activeDays: [],
	};
	const preparedSql: string[] = [];
	const db = {
		prepare: vi.fn((sql: string) => {
			preparedSql.push(sql);
			const pass = passFor(sql);
			return {
				run: vi.fn(),
				// Read the fixture at call time so a test can change the data
				// between two aggregations.
				get: vi.fn(() => {
					if (pass === 'changes') return { n: fixture.totalChanges };
					if (pass === 'bounds') return fixture.bounds;
					if (pass === 'annotations') return { count: fixture.imageAnnotations };
					return undefined;
				}),
				all: vi.fn((...args: unknown[]) => {
					if (!pass || pass === 'changes' || pass === 'bounds' || pass === 'annotations') {
						return [];
					}
					calls[pass].push(args);
					return fixture[pass];
				}),
			};
		}),
		pragma: vi.fn(() => 1),
	};
	return { db: db as unknown as Database.Database, fixture, calls, preparedSql };
}

/** Local epoch ms `daysAgo` days before `now`, at `hour`. */
function atLocal(now: number, daysAgo: number, hour: number): number {
	const d = new Date(now);
	return new Date(d.getFullYear(), d.getMonth(), d.getDate() - daysAgo, hour).getTime();
}

function cubeRow(row: Partial<Row> & { date: string }): Row {
	return {
		hour: 9,
		agent_type: 'claude-code',
		source: 'user',
		remote: 0,
		worktree: 0,
		count: 1,
		duration: 1000,
		...row,
	};
}

function agentRow(row: Partial<Row> & { session_id: string; date: string }): Row {
	return {
		source: 'user',
		count: 1,
		duration: 1000,
		last_query: 0,
		input_tokens: 0,
		output_tokens: 0,
		cache_read_tokens: 0,
		cache_creation_tokens: 0,
		cost_usd: 0,
		priced_queries: 0,
		...row,
	};
}

describe('getAggregatedStats', () => {
	afterEach(() => {
		vi.resetModules();
	});

	async function loadAggregations() {
		return import('../../../main/stats/aggregations');
	}

	describe('calendar-aligned range', () => {
		it.each<StatsTimeRange>(['day', 'week', 'month', 'quarter', 'year', 'all'])(
			'binds every range-scoped pass to getTimeRangeStart(%s)',
			async (range) => {
				const now = Date.now();
				const { getAggregatedStats } = await loadAggregations();
				const { db, calls } = createAggregationDb();

				getAggregatedStats(db, range, now);

				const start = getTimeRangeStart(range, now);
				expect(calls.cube[0]).toEqual([start]);
				expect(calls.perAgent[0]).toEqual([start]);
				expect(calls.queryPercentiles[0]).toEqual([start]);
				expect(calls.taskPercentiles[0]).toEqual([start]);
			}
		);

		it('gap-fills byDay over the seven local days of a week, today last', async () => {
			const now = Date.now();
			const today = toLocalYmd(now);
			const twoDaysAgo = addLocalDays(today, -2);
			const { getAggregatedStats } = await loadAggregations();
			const { db } = createAggregationDb({
				cube: [
					cubeRow({ date: twoDaysAgo, count: 3, duration: 300 }),
					cubeRow({ date: today, hour: 14, count: 1, duration: 50 }),
				],
			});

			const stats = getAggregatedStats(db, 'week', now);

			expect(stats.window).toEqual({ startYmd: addLocalDays(today, -6), endYmd: today });
			expect(stats.byDay).toHaveLength(7);
			expect(stats.byDay[0]).toEqual({ date: addLocalDays(today, -6), count: 0, duration: 0 });
			expect(stats.byDay[4]).toEqual({ date: twoDaysAgo, count: 3, duration: 300 });
			expect(stats.byDay[6]).toEqual({ date: today, count: 1, duration: 50 });
			expect(stats.byDay.filter((d) => d.count === 0)).toHaveLength(5);
		});

		it('opens All Time on the day of the first recorded query', async () => {
			const now = Date.now();
			const first = atLocal(now, 3, 8);
			const { getAggregatedStats } = await loadAggregations();
			const { db } = createAggregationDb({ bounds: { first_query: first, first_prompt: first } });

			const stats = getAggregatedStats(db, 'all', now);

			expect(stats.earliestQueryAt).toBe(first);
			expect(stats.window).toEqual({ startYmd: toLocalYmd(first), endYmd: toLocalYmd(now) });
			expect(stats.byDay).toHaveLength(4);
		});

		it('opens All Time on today when nothing was ever recorded', async () => {
			const now = Date.now();
			const { getAggregatedStats } = await loadAggregations();
			const { db } = createAggregationDb();

			const stats = getAggregatedStats(db, 'all', now);

			expect(stats.earliestQueryAt).toBeNull();
			expect(stats.window).toEqual({ startYmd: toLocalYmd(now), endYmd: toLocalYmd(now) });
			expect(stats.byDay).toEqual([{ date: toLocalYmd(now), count: 0, duration: 0 }]);
		});
	});

	describe('activity cube rollups', () => {
		it('rolls one grouped pass up into totals, provider, source, location and worktree splits', async () => {
			const now = Date.now();
			const today = toLocalYmd(now);
			const { getAggregatedStats } = await loadAggregations();
			const { db } = createAggregationDb({
				cube: [
					cubeRow({ date: today, hour: 9, count: 4, duration: 4000 }),
					cubeRow({ date: today, hour: 9, source: 'auto', worktree: 1, count: 2, duration: 6000 }),
					cubeRow({
						date: today,
						hour: 22,
						agent_type: 'codex',
						remote: 1,
						count: 1,
						duration: 500,
					}),
				],
			});

			const stats = getAggregatedStats(db, 'day', now);

			expect(stats.totalQueries).toBe(7);
			expect(stats.totalDuration).toBe(10500);
			expect(stats.avgDuration).toBe(1500);
			expect(stats.byAgent).toEqual({
				'claude-code': { count: 6, duration: 10000 },
				codex: { count: 1, duration: 500 },
			});
			expect(stats.bySource).toEqual({ user: 5, auto: 2 });
			expect(stats.byLocation).toEqual({ local: 6, remote: 1 });
			expect(stats.worktreeQueries).toBe(2);
			expect(stats.parentQueries).toBe(5);
			expect(stats.byAgentWorktree).toEqual({
				'claude-code': {
					worktree: { count: 2, duration: 6000 },
					parent: { count: 4, duration: 4000 },
				},
				codex: {
					worktree: { count: 0, duration: 0 },
					parent: { count: 1, duration: 500 },
				},
			});
		});

		it('merges providers into sparse, sorted hour and day-hour series', async () => {
			const now = Date.now();
			const today = toLocalYmd(now);
			const yesterday = addLocalDays(today, -1);
			const { getAggregatedStats } = await loadAggregations();
			const { db } = createAggregationDb({
				cube: [
					cubeRow({ date: today, hour: 14, count: 1, duration: 100 }),
					cubeRow({ date: yesterday, hour: 14, agent_type: 'codex', count: 2, duration: 200 }),
					cubeRow({ date: yesterday, hour: 9, count: 3, duration: 300 }),
					cubeRow({ date: yesterday, hour: 9, agent_type: 'codex', count: 1, duration: 10 }),
				],
			});

			const stats = getAggregatedStats(db, 'week', now);

			expect(stats.byHour).toEqual([
				{ hour: 9, count: 4, duration: 310 },
				{ hour: 14, count: 3, duration: 300 },
			]);
			expect(stats.byDayHour).toEqual([
				{ date: yesterday, hour: 9, count: 4, duration: 310 },
				{ date: yesterday, hour: 14, count: 2, duration: 200 },
				{ date: today, hour: 14, count: 1, duration: 100 },
			]);
			expect(stats.byAgentByDay).toEqual({
				'claude-code': [
					{ date: yesterday, count: 3, duration: 300 },
					{ date: today, count: 1, duration: 100 },
				],
				codex: [{ date: yesterday, count: 3, duration: 210 }],
			});
		});

		it('reports zero averages for an empty range', async () => {
			const { getAggregatedStats } = await loadAggregations();
			const { db } = createAggregationDb();

			const stats = getAggregatedStats(db, 'month', Date.now());

			expect(stats.totalQueries).toBe(0);
			expect(stats.avgDuration).toBe(0);
			expect(stats.byAgent).toEqual({});
			expect(stats.byHour).toEqual([]);
			expect(stats.byDayHour).toEqual([]);
			expect(stats.byAgentWorktree).toEqual({});
		});
	});

	describe('per-agent pass', () => {
		it('counts distinct agents and rolls their rows up by day, source, last query and tokens', async () => {
			const now = Date.now();
			const today = toLocalYmd(now);
			const yesterday = addLocalDays(today, -1);
			const { getAggregatedStats } = await loadAggregations();
			const { db } = createAggregationDb({
				perAgent: [
					agentRow({
						session_id: 'agent-a',
						date: yesterday,
						count: 2,
						duration: 200,
						last_query: 1000,
						input_tokens: 10,
						cost_usd: 0.5,
						priced_queries: 2,
					}),
					agentRow({
						session_id: 'agent-a',
						date: yesterday,
						source: 'auto',
						count: 3,
						duration: 900,
						last_query: 5000,
						output_tokens: 7,
						priced_queries: 1,
					}),
					agentRow({
						session_id: 'agent-a',
						date: today,
						count: 1,
						duration: 50,
						last_query: 3000,
					}),
					agentRow({
						session_id: 'agent-b',
						date: today,
						count: 4,
						duration: 40,
						last_query: 9000,
					}),
				],
			});

			const stats = getAggregatedStats(db, 'week', now);

			expect(stats.totalSessions).toBe(2);
			expect(stats.bySessionByDay).toEqual({
				'agent-a': [
					{ date: yesterday, count: 5, duration: 1100 },
					{ date: today, count: 1, duration: 50 },
				],
				'agent-b': [{ date: today, count: 4, duration: 40 }],
			});
			expect(stats.bySessionSource).toEqual({
				'agent-a': { user: 3, auto: 3 },
				'agent-b': { user: 4, auto: 0 },
			});
			expect(stats.bySessionLastQuery).toEqual({ 'agent-a': 5000, 'agent-b': 9000 });
			// agent-b reported no usage at all, so it has no token entry
			expect(stats.bySessionTokens).toEqual({
				'agent-a': {
					inputTokens: 10,
					outputTokens: 7,
					cacheReadTokens: 0,
					cacheCreationTokens: 0,
					costUsd: 0.5,
					pricedQueries: 3,
				},
			});
		});
	});

	describe('duration percentiles', () => {
		it('rebuilds the nearest-rank distribution from the ranks SQL returned', async () => {
			// What the window-function query returns for durations [10, 20, 30, 40]
			// (one agent): ranks 0 (min), 2 (p50) and 3 (p75 and above, max).
			const { getAggregatedStats } = await loadAggregations();
			const ranked = [
				{ duration: 10, rank: 0 },
				{ duration: 30, rank: 2 },
				{ duration: 40, rank: 3 },
			];
			const { db } = createAggregationDb({
				queryPercentiles: ranked.map(({ duration, rank }) => ({
					agent_type: 'claude-code',
					duration,
					overall_rank: rank,
					overall_n: 4,
					agent_rank: rank,
					agent_n: 4,
				})),
				taskPercentiles: ranked.map(({ duration, rank }) => ({
					duration,
					task_rank: rank,
					task_n: 4,
				})),
			});

			const stats = getAggregatedStats(db, 'week', Date.now());

			const expected = computePercentiles([10, 20, 30, 40]);
			expect(stats.queryDurationPercentiles).toEqual(expected);
			expect(stats.queryDurationPercentilesByAgent).toEqual({ 'claude-code': expected });
			expect(stats.autoRunTaskDurationPercentiles).toEqual(expected);
		});

		it('keeps per-agent ranks separate from the overall ranks', async () => {
			// Overall [5, 10, 50]; claude-code [10, 50]; codex [5].
			const { getAggregatedStats } = await loadAggregations();
			const { db } = createAggregationDb({
				queryPercentiles: [
					{
						agent_type: 'codex',
						duration: 5,
						overall_rank: 0,
						overall_n: 3,
						agent_rank: 0,
						agent_n: 1,
					},
					{
						agent_type: 'claude-code',
						duration: 10,
						overall_rank: 1,
						overall_n: 3,
						agent_rank: 0,
						agent_n: 2,
					},
					{
						agent_type: 'claude-code',
						duration: 50,
						overall_rank: 2,
						overall_n: 3,
						agent_rank: 1,
						agent_n: 2,
					},
				],
			});

			const stats = getAggregatedStats(db, 'week', Date.now());

			expect(stats.queryDurationPercentiles).toEqual(computePercentiles([5, 10, 50]));
			expect(stats.queryDurationPercentilesByAgent).toEqual({
				'claude-code': computePercentiles([10, 50]),
				codex: computePercentiles([5]),
			});
		});

		it('returns the empty distribution when the range has no rows', async () => {
			const { getAggregatedStats } = await loadAggregations();
			const { db } = createAggregationDb();

			const stats = getAggregatedStats(db, 'day', Date.now());

			expect(stats.queryDurationPercentiles).toEqual(emptyPercentiles());
			expect(stats.queryDurationPercentilesByAgent).toEqual({});
			expect(stats.autoRunTaskDurationPercentiles).toEqual(emptyPercentiles());
		});

		it('selects only percentile ranks in SQL instead of every duration', async () => {
			const { getAggregatedStats } = await loadAggregations();
			const { db, preparedSql } = createAggregationDb();

			getAggregatedStats(db, 'week', Date.now());

			const sql = preparedSql.find((s) => s.includes('agent_rank'))!;
			expect(sql).toContain('ROW_NUMBER() OVER (PARTITION BY agent_type ORDER BY duration)');
			for (const p of [0.5, 0.75, 0.9, 0.95, 0.99]) {
				expect(sql).toContain(`CAST(${p} * agent_n AS INTEGER)`);
				expect(sql).toContain(`CAST(${p} * overall_n AS INTEGER)`);
			}
		});
	});

	describe('streak over all history', () => {
		it('reads every active day for a bounded range, so the range cannot cut a streak', async () => {
			const now = Date.now();
			const today = toLocalYmd(now);
			const { getAggregatedStats } = await loadAggregations();
			const { db, calls } = createAggregationDb({
				activeDays: [-12, -11, -10, -9, -8, -7, -6, -1, 0].map((d) => ({
					date: addLocalDays(today, d),
				})),
			});

			const stats = getAggregatedStats(db, 'day', now);

			expect(calls.activeDays).toHaveLength(1);
			expect(stats.streak).toEqual({ current: 2, longest: 7 });
		});

		it('takes All Time active days from the cube instead of a second scan', async () => {
			const now = Date.now();
			const today = toLocalYmd(now);
			const { getAggregatedStats } = await loadAggregations();
			const { db, calls } = createAggregationDb({
				cube: [cubeRow({ date: addLocalDays(today, -1) }), cubeRow({ date: today })],
			});

			const stats = getAggregatedStats(db, 'all', now);

			expect(calls.activeDays).toHaveLength(0);
			expect(stats.streak).toEqual({ current: 2, longest: 2 });
		});
	});

	describe('prompt cadence', () => {
		it('counts interactive turns over the same calendar window', async () => {
			const now = Date.now();
			const { getAggregatedStats } = await loadAggregations();
			const { db, calls } = createAggregationDb({
				bounds: { first_query: atLocal(now, 20, 8), first_prompt: atLocal(now, 20, 8) },
				promptTimes: [
					{ start_time: atLocal(now, 2, 9) },
					{ start_time: atLocal(now, 2, 10) },
					{ start_time: atLocal(now, 1, 9) },
				],
			});

			const stats = getAggregatedStats(db, 'week', now);

			expect(stats.prompts.total).toBe(3);
			expect(stats.prompts.calendarDays).toBe(7);
			expect(stats.prompts.busiestDay?.count).toBe(2);
			expect(calls.promptTimes[0]).toEqual([getTimeRangeStart('week', now)]);
		});

		it('skips the prompt scan when nothing was ever prompted', async () => {
			const { getAggregatedStats } = await loadAggregations();
			const { db, calls } = createAggregationDb();

			const stats = getAggregatedStats(db, 'all', Date.now());

			expect(calls.promptTimes).toHaveLength(0);
			expect(stats.prompts.total).toBe(0);
			expect(stats.prompts.days).toEqual([]);
		});
	});

	describe('memo', () => {
		it('serves a repeat call from the memo while the database is unchanged', async () => {
			const now = Date.now();
			const { getAggregatedStats } = await loadAggregations();
			const { db, calls } = createAggregationDb({
				cube: [cubeRow({ date: toLocalYmd(now) })],
			});

			const first = getAggregatedStats(db, 'week', now);
			const second = getAggregatedStats(db, 'week', now + 1000);

			expect(second).toBe(first);
			expect(calls.cube).toHaveLength(1);
		});

		it('recomputes after any write on the connection', async () => {
			const now = Date.now();
			const { getAggregatedStats } = await loadAggregations();
			const { db, fixture, calls } = createAggregationDb({
				cube: [cubeRow({ date: toLocalYmd(now), count: 1 })],
			});

			expect(getAggregatedStats(db, 'week', now).totalQueries).toBe(1);
			fixture.totalChanges = 5;
			fixture.cube = [cubeRow({ date: toLocalYmd(now), count: 6 })];

			expect(getAggregatedStats(db, 'week', now).totalQueries).toBe(6);
			expect(calls.cube).toHaveLength(2);
		});

		it('recomputes when the local day rolls over', async () => {
			const now = Date.now();
			const { getAggregatedStats } = await loadAggregations();
			const { db, calls } = createAggregationDb();

			const first = getAggregatedStats(db, 'week', now);
			const nextDay = getAggregatedStats(db, 'week', now + 24 * 60 * 60 * 1000);

			expect(nextDay).not.toBe(first);
			expect(nextDay.window.endYmd).toBe(addLocalDays(first.window.endYmd, 1));
			expect(calls.cube).toHaveLength(2);
		});

		it('memoizes each range separately but reads the all-history streak once', async () => {
			const now = Date.now();
			const { getAggregatedStats } = await loadAggregations();
			const { db, calls } = createAggregationDb();

			getAggregatedStats(db, 'week', now);
			getAggregatedStats(db, 'month', now);

			expect(calls.cube).toHaveLength(2);
			expect(calls.activeDays).toHaveLength(1);
		});

		it('prepares each statement once across recomputes', async () => {
			const now = Date.now();
			const { getAggregatedStats } = await loadAggregations();
			const { db, fixture, preparedSql } = createAggregationDb();

			getAggregatedStats(db, 'week', now);
			fixture.totalChanges = 1;
			getAggregatedStats(db, 'week', now);

			const cubePrepares = preparedSql.filter((s) => s.includes('GROUP BY 1, 2, 3, 4, 5, 6'));
			expect(cubePrepares).toHaveLength(1);
		});

		it('starts over on a new connection', async () => {
			const now = Date.now();
			const { getAggregatedStats } = await loadAggregations();
			const a = createAggregationDb({ cube: [cubeRow({ date: toLocalYmd(now), count: 1 })] });
			const b = createAggregationDb({ cube: [cubeRow({ date: toLocalYmd(now), count: 9 })] });

			expect(getAggregatedStats(a.db, 'week', now).totalQueries).toBe(1);
			expect(getAggregatedStats(b.db, 'week', now).totalQueries).toBe(9);
		});
	});

	describe('result shape', () => {
		it('no longer carries the removed session-lifecycle fields or queries', async () => {
			const { getAggregatedStats } = await loadAggregations();
			const { db, preparedSql } = createAggregationDb({ imageAnnotations: 3 });

			const stats = getAggregatedStats(db, 'week', Date.now());

			for (const removed of [
				'sessionsByAgent',
				'sessionsByDay',
				'avgSessionDuration',
				'byWorktreeStatus',
			]) {
				expect(stats).not.toHaveProperty(removed);
			}
			expect(preparedSql.some((s) => s.includes('session_lifecycle'))).toBe(false);
			expect(stats.imageAnnotations).toBe(3);
		});
	});
});

describe('computeDayStreak', () => {
	afterEach(() => {
		vi.resetModules();
	});

	const today = '2026-03-02';

	it('is zero with no activity', async () => {
		const { computeDayStreak } = await import('../../../main/stats/aggregations');
		expect(computeDayStreak([], today)).toEqual({ current: 0, longest: 0 });
	});

	it('counts back from today when today is active', async () => {
		const { computeDayStreak } = await import('../../../main/stats/aggregations');
		expect(computeDayStreak(['2026-02-28', '2026-03-01', '2026-03-02'], today)).toEqual({
			current: 3,
			longest: 3,
		});
	});

	it('keeps a streak alive through a today with no activity yet', async () => {
		const { computeDayStreak } = await import('../../../main/stats/aggregations');
		expect(computeDayStreak(['2026-02-27', '2026-02-28', '2026-03-01'], today)).toEqual({
			current: 3,
			longest: 3,
		});
	});

	it('breaks the current streak after a whole day without activity', async () => {
		const { computeDayStreak } = await import('../../../main/stats/aggregations');
		expect(computeDayStreak(['2026-02-26', '2026-02-27', '2026-02-28'], today)).toEqual({
			current: 0,
			longest: 3,
		});
	});

	it('finds the longest run anywhere in history, across a month boundary', async () => {
		const { computeDayStreak } = await import('../../../main/stats/aggregations');
		expect(
			computeDayStreak(
				['2026-01-30', '2026-01-31', '2026-02-01', '2026-02-02', '2026-02-10', '2026-03-02'],
				today
			)
		).toEqual({ current: 1, longest: 4 });
	});
});
