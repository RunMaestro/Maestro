/**
 * Tests for the Cue Database module (cue-db.ts).
 *
 * Note: better-sqlite3 is a native module compiled for Electron's Node version.
 * These tests use a mocked database to verify the logic without requiring the
 * native module. The mock validates that the correct SQL statements and parameters
 * are passed to better-sqlite3.
 *
 * Tests cover:
 * - Database initialization and lifecycle
 * - Event recording, status updates, and retrieval
 * - Heartbeat write and read
 * - Event pruning (housekeeping)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as path from 'path';
import * as os from 'os';

// Store parameters passed to mock statement methods
const runCalls: unknown[][] = [];
const getCalls: unknown[][] = [];
const allCalls: unknown[][] = [];
let mockGetReturn: unknown = undefined;
let mockAllReturn: unknown[] = [];

const mockStatement = {
	run: vi.fn((...args: unknown[]) => {
		runCalls.push(args);
		return { changes: 1 };
	}),
	get: vi.fn((...args: unknown[]) => {
		getCalls.push(args);
		return mockGetReturn;
	}),
	all: vi.fn((...args: unknown[]) => {
		allCalls.push(args);
		return mockAllReturn;
	}),
};

const prepareCalls: string[] = [];

const mockDb = {
	pragma: vi.fn((query: string) => {
		// `table_info(<table>)` returns one row per column. Return the full
		// column set for cue_events so the additive-column migration in
		// initCueDb() sees no missing columns and stays a no-op under the
		// mocked DB. Other pragmas (`journal_mode = WAL`, etc.) don't need
		// a return value.
		if (query.startsWith('table_info(cue_events)')) {
			return [
				{ name: 'id' },
				{ name: 'type' },
				{ name: 'trigger_name' },
				{ name: 'session_id' },
				{ name: 'subscription_name' },
				{ name: 'status' },
				{ name: 'created_at' },
				{ name: 'completed_at' },
				{ name: 'payload' },
				{ name: 'pipeline_id' },
				{ name: 'chain_root_id' },
				{ name: 'parent_event_id' },
			];
		}
		// Same idea for cue_event_queue - Phase 01 added chain_root_id /
		// parent_event_id so persisted queue rows survive restart with
		// lineage intact. Returning the full column set keeps the additive
		// migration a no-op under the mock.
		if (query.startsWith('table_info(cue_event_queue)')) {
			return [
				{ name: 'id' },
				{ name: 'session_id' },
				{ name: 'subscription_name' },
				{ name: 'event_json' },
				{ name: 'prompt' },
				{ name: 'output_prompt' },
				{ name: 'cli_output_json' },
				{ name: 'action' },
				{ name: 'command_json' },
				{ name: 'chain_depth' },
				{ name: 'queued_at' },
				{ name: 'chain_root_id' },
				{ name: 'parent_event_id' },
			];
		}
		// cue_github_seen - the GitHub re-trigger feature added `last_revision`
		// and `fire_count` columns. Returning the full column set keeps the
		// additive migration a no-op under the mock.
		if (query.startsWith('table_info(cue_github_seen)')) {
			return [
				{ name: 'subscription_id' },
				{ name: 'item_key' },
				{ name: 'seen_at' },
				{ name: 'last_revision' },
				{ name: 'fire_count' },
			];
		}
		return undefined;
	}),
	prepare: vi.fn((sql: string) => {
		prepareCalls.push(sql);
		return mockStatement;
	}),
	close: vi.fn(),
};

vi.mock('better-sqlite3', () => ({
	default: class MockDatabase {
		constructor() {
			/* noop */
		}
		pragma = mockDb.pragma;
		prepare = mockDb.prepare;
		close = mockDb.close;
	},
}));

vi.mock('electron', () => ({
	app: {
		getPath: vi.fn(() => os.tmpdir()),
	},
}));

import {
	initCueDb,
	closeCueDb,
	isCueDbReady,
	recordCueEvent,
	updateCueEventStatus,
	getRecentCueEvents,
	updateHeartbeat,
	getLastHeartbeat,
	pruneCueEvents,
	isGitHubItemSeen,
	markGitHubItemSeen,
	setGitHubItemRevision,
	hasAnyGitHubSeen,
	pruneGitHubSeen,
	clearGitHubSeenForSubscription,
	safeRecordCueEvent,
	safeUpdateCueEventStatus,
} from '../../../main/cue/cue-db';

beforeEach(() => {
	vi.clearAllMocks();
	runCalls.length = 0;
	getCalls.length = 0;
	allCalls.length = 0;
	prepareCalls.length = 0;
	mockGetReturn = undefined;
	mockAllReturn = [];

	// Ensure the module's internal db is reset
	closeCueDb();
});

afterEach(() => {
	closeCueDb();
});

describe('cue-db lifecycle', () => {
	it('should report ready after initialization', () => {
		initCueDb(undefined, path.join(os.tmpdir(), 'test-cue.db'));
		expect(isCueDbReady()).toBe(true);
	});

	it('should report not ready after close', () => {
		initCueDb(undefined, path.join(os.tmpdir(), 'test-cue.db'));
		closeCueDb();
		expect(isCueDbReady()).toBe(false);
	});

	it('should not double-initialize', () => {
		const dbPath = path.join(os.tmpdir(), 'test-cue.db');
		initCueDb(undefined, dbPath);
		const callCountAfterFirst = mockDb.pragma.mock.calls.length;

		initCueDb(undefined, dbPath);
		// No new pragma calls because it short-circuited
		expect(mockDb.pragma.mock.calls.length).toBe(callCountAfterFirst);
	});

	it('should set WAL mode on initialization', () => {
		initCueDb(undefined, path.join(os.tmpdir(), 'test-cue.db'));
		expect(mockDb.pragma).toHaveBeenCalledWith('journal_mode = WAL');
	});

	it('should create tables and indexes on initialization', () => {
		initCueDb(undefined, path.join(os.tmpdir(), 'test-cue.db'));

		// Should have prepared CREATE TABLE and CREATE INDEX statements
		expect(prepareCalls.some((sql) => sql.includes('CREATE TABLE IF NOT EXISTS cue_events'))).toBe(
			true
		);
		expect(
			prepareCalls.some((sql) => sql.includes('CREATE TABLE IF NOT EXISTS cue_heartbeat'))
		).toBe(true);
		expect(prepareCalls.some((sql) => sql.includes('idx_cue_events_created'))).toBe(true);
		expect(prepareCalls.some((sql) => sql.includes('idx_cue_events_session'))).toBe(true);
		expect(
			prepareCalls.some((sql) => sql.includes('CREATE TABLE IF NOT EXISTS cue_github_seen'))
		).toBe(true);
		expect(prepareCalls.some((sql) => sql.includes('idx_cue_github_seen_at'))).toBe(true);
	});

	it('should throw when accessing before initialization', () => {
		expect(() =>
			recordCueEvent({
				id: 'test-1',
				type: 'time.heartbeat',
				triggerName: 'test',
				sessionId: 'session-1',
				subscriptionName: 'test-sub',
				status: 'running',
			})
		).toThrow('Cue database not initialized');
	});

	it('should close the database', () => {
		initCueDb(undefined, path.join(os.tmpdir(), 'test-cue.db'));
		closeCueDb();
		expect(mockDb.close).toHaveBeenCalled();
	});
});

describe('cue-db additive column migration', () => {
	const dbPath = path.join(os.tmpdir(), 'test-cue.db');

	it('declares the Cue-history output columns in CREATE TABLE', () => {
		initCueDb(undefined, dbPath);

		const createSql = prepareCalls.find((sql) =>
			sql.includes('CREATE TABLE IF NOT EXISTS cue_events')
		);
		expect(createSql).toBeDefined();
		expect(createSql).toContain('output_excerpt TEXT');
		expect(createSql).toContain('full_output TEXT');
	});

	it('ALTERs an existing database that predates the output columns', () => {
		// The mocked `table_info(cue_events)` reports the pre-output column
		// set, i.e. a database created before this phase. The idempotent
		// migration must backfill both columns rather than leave the table
		// behind the CREATE TABLE schema.
		initCueDb(undefined, dbPath);

		expect(
			prepareCalls.some((sql) => sql === 'ALTER TABLE cue_events ADD COLUMN output_excerpt TEXT')
		).toBe(true);
		expect(
			prepareCalls.some((sql) => sql === 'ALTER TABLE cue_events ADD COLUMN full_output TEXT')
		).toBe(true);
	});

	it('skips the ALTER when the columns are already present', () => {
		const originalPragma = mockDb.pragma.getMockImplementation();
		mockDb.pragma.mockImplementation((query: string) => {
			if (query.startsWith('table_info(cue_events)')) {
				return [
					{ name: 'id' },
					{ name: 'type' },
					{ name: 'trigger_name' },
					{ name: 'session_id' },
					{ name: 'subscription_name' },
					{ name: 'status' },
					{ name: 'created_at' },
					{ name: 'completed_at' },
					{ name: 'payload' },
					{ name: 'pipeline_id' },
					{ name: 'chain_root_id' },
					{ name: 'parent_event_id' },
					{ name: 'provider_session_id' },
					{ name: 'error_message' },
					{ name: 'exit_code' },
					{ name: 'output_excerpt' },
					{ name: 'full_output' },
					{ name: 'stream_usage_json' },
				];
			}
			return originalPragma?.(query);
		});

		try {
			initCueDb(undefined, dbPath);
			expect(prepareCalls.some((sql) => sql.startsWith('ALTER TABLE cue_events'))).toBe(false);
		} finally {
			if (originalPragma) mockDb.pragma.mockImplementation(originalPragma);
		}
	});
});

describe('cue-db event journal', () => {
	beforeEach(() => {
		initCueDb(undefined, path.join(os.tmpdir(), 'test-cue.db'));
		vi.clearAllMocks();
		runCalls.length = 0;
		prepareCalls.length = 0;
	});

	it('should record an event with correct parameters', () => {
		recordCueEvent({
			id: 'evt-1',
			type: 'time.heartbeat',
			triggerName: 'my-trigger',
			sessionId: 'session-1',
			subscriptionName: 'periodic-check',
			status: 'running',
		});

		expect(mockDb.prepare).toHaveBeenCalledWith(
			expect.stringContaining('INSERT OR REPLACE INTO cue_events')
		);
		expect(runCalls.length).toBeGreaterThan(0);
		const lastRun = runCalls[runCalls.length - 1];
		expect(lastRun[0]).toBe('evt-1'); // id
		expect(lastRun[1]).toBe('time.heartbeat'); // type
		expect(lastRun[2]).toBe('my-trigger'); // trigger_name
		expect(lastRun[3]).toBe('session-1'); // session_id
		expect(lastRun[4]).toBe('periodic-check'); // subscription_name
		expect(lastRun[5]).toBe('running'); // status
		expect(typeof lastRun[6]).toBe('number'); // created_at (timestamp)
		expect(lastRun[7]).toBeNull(); // payload (null when not provided)
	});

	it('should record an event with payload', () => {
		const payload = JSON.stringify({ reconciled: true, missedCount: 3 });
		recordCueEvent({
			id: 'evt-2',
			type: 'time.heartbeat',
			triggerName: 'cron-trigger',
			sessionId: 'session-2',
			subscriptionName: 'cron-sub',
			status: 'completed',
			payload,
		});

		const lastRun = runCalls[runCalls.length - 1];
		expect(lastRun[7]).toBe(payload);
	});

	it('should update event status with completed_at timestamp', () => {
		updateCueEventStatus('evt-3', 'completed');

		expect(mockDb.prepare).toHaveBeenCalledWith(
			expect.stringContaining('UPDATE cue_events SET status')
		);
		const lastRun = runCalls[runCalls.length - 1];
		expect(lastRun[0]).toBe('completed'); // status
		expect(typeof lastRun[1]).toBe('number'); // completed_at
		expect(lastRun[2]).toBe('evt-3'); // id
	});

	it('should leave output columns untouched when no completion info is given', () => {
		// A bare status flip ('stopped') must not clobber a previously-written
		// excerpt with NULL - only completion-time writes touch these columns.
		updateCueEventStatus('evt-4', 'stopped');

		const lastPrepare = prepareCalls[prepareCalls.length - 1];
		expect(lastPrepare).not.toContain('output_excerpt');
		expect(lastPrepare).not.toContain('full_output');
	});

	it('should write output_excerpt and full_output on completion', () => {
		updateCueEventStatus('evt-5', 'completed', 'provider-1', {
			errorMessage: null,
			exitCode: 0,
			outputExcerpt: 'Merged PR #12.',
			fullOutput: 'Merged PR #12.\nDetails follow.',
		});

		const lastPrepare = prepareCalls[prepareCalls.length - 1];
		expect(lastPrepare).toContain('output_excerpt = ?');
		expect(lastPrepare).toContain('full_output = ?');
		expect(lastPrepare).toContain('stream_usage_json = ?');
		const lastRun = runCalls[runCalls.length - 1];
		// status, completed_at, provider_session_id, error_message, exit_code,
		// output_excerpt, full_output, stream_usage_json, id
		expect(lastRun[5]).toBe('Merged PR #12.');
		expect(lastRun[6]).toBe('Merged PR #12.\nDetails follow.');
		expect(lastRun[7]).toBeNull(); // stream_usage_json (not passed by this call)
		expect(lastRun[8]).toBe('evt-5');
	});

	it('should write NULL output columns for a silent run', () => {
		updateCueEventStatus('evt-6', 'completed', null, { errorMessage: null, exitCode: 0 });

		const lastRun = runCalls[runCalls.length - 1];
		// No provider session id, so the columns shift left by one.
		expect(lastRun[4]).toBeNull(); // output_excerpt
		expect(lastRun[5]).toBeNull(); // full_output
		expect(lastRun[6]).toBeNull(); // stream_usage_json
		expect(lastRun[7]).toBe('evt-6');
	});

	it('should query recent events with correct since parameter', () => {
		const since = Date.now() - 1000;
		getRecentCueEvents(since);

		expect(mockDb.prepare).toHaveBeenCalledWith(
			expect.stringContaining('FROM cue_events WHERE created_at >=')
		);
		const lastAll = allCalls[allCalls.length - 1];
		expect(lastAll[0]).toBe(since);
	});

	it('should query recent events with limit', () => {
		const since = Date.now() - 1000;
		getRecentCueEvents(since, 10);

		expect(mockDb.prepare).toHaveBeenCalledWith(expect.stringContaining('LIMIT'));
		const lastAll = allCalls[allCalls.length - 1];
		expect(lastAll[0]).toBe(since);
		expect(lastAll[1]).toBe(10);
	});

	it('should map row data to CueEventRecord correctly', () => {
		mockAllReturn = [
			{
				id: 'evt-mapped',
				type: 'file.changed',
				trigger_name: 'file-trigger',
				session_id: 'session-1',
				subscription_name: 'file-sub',
				status: 'completed',
				created_at: 1000000,
				completed_at: 1000500,
				payload: '{"file":"test.ts"}',
				output_excerpt: 'Reformatted test.ts.',
				full_output: 'Reformatted test.ts.\nNothing else to do.',
			},
		];

		const events = getRecentCueEvents(0);
		expect(events).toHaveLength(1);
		expect(events[0]).toEqual({
			id: 'evt-mapped',
			type: 'file.changed',
			triggerName: 'file-trigger',
			sessionId: 'session-1',
			subscriptionName: 'file-sub',
			status: 'completed',
			createdAt: 1000000,
			completedAt: 1000500,
			payload: '{"file":"test.ts"}',
			outputExcerpt: 'Reformatted test.ts.',
			fullOutput: 'Reformatted test.ts.\nNothing else to do.',
		});
	});
});

describe('cue-db heartbeat', () => {
	beforeEach(() => {
		initCueDb(undefined, path.join(os.tmpdir(), 'test-cue.db'));
		vi.clearAllMocks();
		runCalls.length = 0;
		getCalls.length = 0;
		prepareCalls.length = 0;
	});

	it('should write heartbeat with INSERT OR REPLACE', () => {
		updateHeartbeat();

		expect(mockDb.prepare).toHaveBeenCalledWith(
			expect.stringContaining('INSERT OR REPLACE INTO cue_heartbeat')
		);
		const lastRun = runCalls[runCalls.length - 1];
		expect(typeof lastRun[0]).toBe('number'); // current timestamp
	});

	it('should return null when no heartbeat exists', () => {
		mockGetReturn = undefined;
		const result = getLastHeartbeat();
		expect(result).toBeNull();
	});

	it('should return the last_seen value when heartbeat exists', () => {
		mockGetReturn = { last_seen: 1234567890 };
		const result = getLastHeartbeat();
		expect(result).toBe(1234567890);
	});
});

describe('cue-db pruning', () => {
	beforeEach(() => {
		initCueDb(undefined, path.join(os.tmpdir(), 'test-cue.db'));
		vi.clearAllMocks();
		runCalls.length = 0;
		prepareCalls.length = 0;
	});

	it('should delete events older than specified age', () => {
		const olderThanMs = 7 * 24 * 60 * 60 * 1000;
		const before = Date.now();
		pruneCueEvents(olderThanMs);

		expect(mockDb.prepare).toHaveBeenCalledWith(
			expect.stringContaining('DELETE FROM cue_events WHERE created_at < ?')
		);
		const lastRun = runCalls[runCalls.length - 1];
		const cutoff = lastRun[0] as number;
		// The cutoff should be approximately Date.now() - olderThanMs
		expect(cutoff).toBeLessThanOrEqual(before);
		expect(cutoff).toBeGreaterThan(before - olderThanMs - 1000);
	});
});

describe('cue-db github seen tracking', () => {
	beforeEach(() => {
		initCueDb(undefined, path.join(os.tmpdir(), 'test-cue.db'));
		vi.clearAllMocks();
		runCalls.length = 0;
		getCalls.length = 0;
		prepareCalls.length = 0;
		mockGetReturn = undefined;
	});

	it('isGitHubItemSeen should return false when item not found', () => {
		mockGetReturn = undefined;
		const result = isGitHubItemSeen('sub-1', 'pr:owner/repo:123');
		expect(result).toBe(false);
		expect(mockDb.prepare).toHaveBeenCalledWith(
			expect.stringContaining(
				'SELECT 1 FROM cue_github_seen WHERE subscription_id = ? AND item_key = ?'
			)
		);
		const lastGet = getCalls[getCalls.length - 1];
		expect(lastGet[0]).toBe('sub-1');
		expect(lastGet[1]).toBe('pr:owner/repo:123');
	});

	it('isGitHubItemSeen should return true when item exists', () => {
		mockGetReturn = { '1': 1 };
		const result = isGitHubItemSeen('sub-1', 'pr:owner/repo:123');
		expect(result).toBe(true);
	});

	it('markGitHubItemSeen should INSERT OR IGNORE with correct parameters', () => {
		markGitHubItemSeen('sub-1', 'pr:owner/repo:456');

		expect(mockDb.prepare).toHaveBeenCalledWith(
			expect.stringContaining('INSERT OR IGNORE INTO cue_github_seen')
		);
		const lastRun = runCalls[runCalls.length - 1];
		expect(lastRun[0]).toBe('sub-1');
		expect(lastRun[1]).toBe('pr:owner/repo:456');
		expect(typeof lastRun[2]).toBe('number'); // seen_at
	});

	it('hasAnyGitHubSeen should return false when no records exist', () => {
		mockGetReturn = undefined;
		const result = hasAnyGitHubSeen('sub-1');
		expect(result).toBe(false);
		expect(mockDb.prepare).toHaveBeenCalledWith(
			expect.stringContaining('SELECT 1 FROM cue_github_seen WHERE subscription_id = ? LIMIT 1')
		);
		const lastGet = getCalls[getCalls.length - 1];
		expect(lastGet[0]).toBe('sub-1');
	});

	it('hasAnyGitHubSeen should return true when records exist', () => {
		mockGetReturn = { '1': 1 };
		const result = hasAnyGitHubSeen('sub-1');
		expect(result).toBe(true);
	});

	it('pruneGitHubSeen should delete old records with correct cutoff', () => {
		const olderThanMs = 30 * 24 * 60 * 60 * 1000;
		const before = Date.now();
		pruneGitHubSeen(olderThanMs);

		expect(mockDb.prepare).toHaveBeenCalledWith(
			expect.stringContaining('DELETE FROM cue_github_seen WHERE seen_at < ?')
		);
		const lastRun = runCalls[runCalls.length - 1];
		const cutoff = lastRun[0] as number;
		expect(cutoff).toBeLessThanOrEqual(before);
		expect(cutoff).toBeGreaterThan(before - olderThanMs - 1000);
	});

	it('github seen reads should be conservative when the database is closed', () => {
		closeCueDb();

		expect(isGitHubItemSeen('sub-1', 'pr:owner/repo:123')).toBe(true);
		expect(hasAnyGitHubSeen('sub-1')).toBe(true);
		expect(mockDb.prepare).not.toHaveBeenCalled();
	});

	it('github seen writes should no-op when the database is closed', () => {
		closeCueDb();

		markGitHubItemSeen('sub-1', 'pr:owner/repo:123');
		pruneGitHubSeen(30 * 24 * 60 * 60 * 1000);

		expect(mockDb.prepare).not.toHaveBeenCalled();
	});

	it('setGitHubItemRevision should upsert the revision without touching fire_count', () => {
		setGitHubItemRevision('sub-1', '__label_watermark__', '6000');

		const sql = prepareCalls[prepareCalls.length - 1] as string;
		expect(sql).toContain('INSERT INTO cue_github_seen');
		expect(sql).toContain('ON CONFLICT(subscription_id, item_key)');
		expect(sql).toContain('DO UPDATE SET last_revision = excluded.last_revision');
		// The watermark must never bump the re-trigger counter - that field
		// belongs to recordGitHubRetrigger's cap accounting.
		expect(sql).not.toContain('fire_count = fire_count + 1');

		const lastRun = runCalls[runCalls.length - 1];
		expect(lastRun[0]).toBe('sub-1');
		expect(lastRun[1]).toBe('__label_watermark__');
		expect(typeof lastRun[2]).toBe('number'); // seen_at, refreshed so prune spares it
		expect(lastRun[3]).toBe('6000');
	});

	it('setGitHubItemRevision should no-op when the database is closed', () => {
		closeCueDb();

		setGitHubItemRevision('sub-1', '__label_watermark__', '6000');

		expect(mockDb.prepare).not.toHaveBeenCalled();
	});

	it('clearGitHubSeenForSubscription should delete all records for a subscription', () => {
		clearGitHubSeenForSubscription('sub-1');

		expect(mockDb.prepare).toHaveBeenCalledWith(
			expect.stringContaining('DELETE FROM cue_github_seen WHERE subscription_id = ?')
		);
		const lastRun = runCalls[runCalls.length - 1];
		expect(lastRun[0]).toBe('sub-1');
	});
});

describe('safeRecordCueEvent', () => {
	const dbPath = path.join(os.tmpdir(), 'test-cue-safe.db');

	beforeEach(() => {
		initCueDb(undefined, dbPath);
		vi.clearAllMocks();
		runCalls.length = 0;
		prepareCalls.length = 0;
	});

	const testEvent = {
		id: 'safe-evt-1',
		type: 'time.heartbeat',
		triggerName: 'test-trigger',
		sessionId: 'session-1',
		subscriptionName: 'test-sub',
		status: 'running',
	} as const;

	it('calls through successfully when DB is ready', () => {
		safeRecordCueEvent(testEvent);
		expect(mockDb.prepare).toHaveBeenCalledWith(
			expect.stringContaining('INSERT OR REPLACE INTO cue_events')
		);
	});

	it('logs warn and does not throw when underlying function throws', () => {
		mockStatement.run.mockImplementationOnce(() => {
			throw new Error('DB locked');
		});
		const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
		expect(() => safeRecordCueEvent(testEvent)).not.toThrow();
		consoleSpy.mockRestore();
	});

	it('does not throw when DB is unavailable (not initialized)', () => {
		closeCueDb();
		expect(() => safeRecordCueEvent(testEvent)).not.toThrow();
	});
});

describe('safeUpdateCueEventStatus', () => {
	const dbPath = path.join(os.tmpdir(), 'test-cue-safe-update.db');

	beforeEach(() => {
		initCueDb(undefined, dbPath);
		vi.clearAllMocks();
		runCalls.length = 0;
		prepareCalls.length = 0;
	});

	it('calls through successfully when DB is ready', () => {
		safeUpdateCueEventStatus('evt-1', 'completed');
		expect(mockDb.prepare).toHaveBeenCalledWith(
			expect.stringContaining('UPDATE cue_events SET status')
		);
	});

	it('logs warn and does not throw when underlying function throws', () => {
		mockStatement.run.mockImplementationOnce(() => {
			throw new Error('DB locked');
		});
		const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
		expect(() => safeUpdateCueEventStatus('evt-1', 'completed')).not.toThrow();
		consoleSpy.mockRestore();
	});

	it('does not throw when DB is unavailable (not initialized)', () => {
		closeCueDb();
		expect(() => safeUpdateCueEventStatus('evt-1', 'completed')).not.toThrow();
	});
});
