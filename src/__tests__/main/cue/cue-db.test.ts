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
	pragma: vi.fn(),
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
	});

	it('should throw when accessing before initialization', () => {
		expect(() =>
			recordCueEvent({
				id: 'test-1',
				type: 'time.interval',
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
			type: 'time.interval',
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
		expect(lastRun[1]).toBe('time.interval'); // type
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
			type: 'time.interval',
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
