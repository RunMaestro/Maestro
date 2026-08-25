/**
 * Tests for the stats query-event write buffer (PR-B 1.5).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
	enqueueQueryEvent,
	flushQueryEventsSync,
	getQueryEventBufferSize,
	resetQueryEventBufferForTests,
	QUERY_EVENT_BATCH_SIZE,
	QUERY_EVENT_FLUSH_INTERVAL_MS,
} from '../../../main/stats/query-events-buffer';
import type { QueryEvent } from '../../../shared/stats-types';
import { logger } from '../../../main/utils/logger';
import { captureException } from '../../../main/utils/sentry';

vi.mock('../../../main/utils/logger', () => ({
	logger: {
		debug: vi.fn(),
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
	},
}));

vi.mock('../../../main/utils/sentry', () => ({
	captureException: vi.fn(),
}));

interface MockStatement {
	run: ReturnType<typeof vi.fn>;
}
interface MockTransactionFactory {
	(fn: () => void): () => void;
}
interface MockDb {
	open: boolean;
	prepare: ReturnType<typeof vi.fn>;
	transaction: MockTransactionFactory;
}

/**
 * Fake that reproduces the two better-sqlite3 rules this module depends on:
 * a `Database` exposes a boolean `open`, and once it is closed every operation
 * throws `TypeError: The database connection is not open`. A mock that ignored
 * `open` and happily ran statements against a closed handle would stay green
 * through exactly the shutdown race MAESTRO-ZC reported from the field.
 */
function makeMockDb(): { db: MockDb; stmt: MockStatement; runs: unknown[][] } {
	const runs: unknown[][] = [];
	const assertOpen = () => {
		if (!db.open) throw new TypeError('The database connection is not open');
	};
	const stmt: MockStatement = {
		run: vi.fn((...args: unknown[]) => {
			assertOpen();
			runs.push(args);
		}),
	};
	const db: MockDb = {
		open: true,
		prepare: vi.fn(() => {
			assertOpen();
			return stmt;
		}),
		transaction: ((fn: () => void) => () => {
			assertOpen();
			fn();
		}) as MockTransactionFactory,
	};
	return { db, stmt, runs };
}

const sampleEvent: Omit<QueryEvent, 'id'> = {
	sessionId: 's1',
	agentType: 'claude-code',
	source: 'user',
	startTime: 1000,
	duration: 500,
	projectPath: '/p',
	tabId: 't1',
	isRemote: false,
};

describe('query-events-buffer', () => {
	beforeEach(() => {
		vi.useFakeTimers();
		resetQueryEventBufferForTests();
		vi.mocked(captureException).mockClear();
		vi.mocked(logger.warn).mockClear();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it('buffers a single event without writing immediately', () => {
		const { db, stmt } = makeMockDb();
		enqueueQueryEvent(db as never, sampleEvent);

		expect(getQueryEventBufferSize()).toBe(1);
		expect(stmt.run).not.toHaveBeenCalled();
	});

	it('returns a generated id synchronously', () => {
		const { db } = makeMockDb();
		const id = enqueueQueryEvent(db as never, sampleEvent);

		expect(typeof id).toBe('string');
		expect(id.length).toBeGreaterThan(0);
	});

	it('flushes to the DB after the timer interval elapses', () => {
		const { db, stmt } = makeMockDb();
		enqueueQueryEvent(db as never, sampleEvent);
		expect(stmt.run).not.toHaveBeenCalled();

		vi.advanceTimersByTime(QUERY_EVENT_FLUSH_INTERVAL_MS);

		expect(stmt.run).toHaveBeenCalledTimes(1);
		expect(getQueryEventBufferSize()).toBe(0);
	});

	it('flushes when the batch threshold is reached, before the timer fires', () => {
		const { db, stmt } = makeMockDb();
		for (let i = 0; i < QUERY_EVENT_BATCH_SIZE; i++) {
			enqueueQueryEvent(db as never, sampleEvent);
		}

		// Threshold-flush should happen synchronously inside the last enqueue.
		expect(stmt.run).toHaveBeenCalledTimes(QUERY_EVENT_BATCH_SIZE);
		expect(getQueryEventBufferSize()).toBe(0);
	});

	it('wraps the batch in a single transaction', () => {
		const { db, stmt } = makeMockDb();
		const txSpy = vi.fn(((fn: () => void) => () => fn()) as MockTransactionFactory);
		db.transaction = txSpy;

		enqueueQueryEvent(db as never, sampleEvent);
		enqueueQueryEvent(db as never, sampleEvent);
		enqueueQueryEvent(db as never, sampleEvent);
		flushQueryEventsSync();

		expect(txSpy).toHaveBeenCalledTimes(1);
		expect(stmt.run).toHaveBeenCalledTimes(3);
	});

	it('explicit flushQueryEventsSync drains the buffer immediately', () => {
		const { db, stmt } = makeMockDb();
		enqueueQueryEvent(db as never, sampleEvent);
		enqueueQueryEvent(db as never, sampleEvent);
		expect(stmt.run).not.toHaveBeenCalled();

		flushQueryEventsSync();

		expect(stmt.run).toHaveBeenCalledTimes(2);
		expect(getQueryEventBufferSize()).toBe(0);
	});

	it('flushQueryEventsSync is a no-op when buffer is empty', () => {
		const { db, stmt } = makeMockDb();
		// Establish a DB reference but no events
		enqueueQueryEvent(db as never, sampleEvent);
		flushQueryEventsSync();
		stmt.run.mockClear();

		flushQueryEventsSync();

		expect(stmt.run).not.toHaveBeenCalled();
	});

	it('flushQueryEventsSync clears the pending timer', () => {
		const { db, stmt } = makeMockDb();
		enqueueQueryEvent(db as never, sampleEvent);
		flushQueryEventsSync();

		// Advancing time past the flush interval should NOT fire another flush
		// (no events buffered, no timer scheduled).
		stmt.run.mockClear();
		vi.advanceTimersByTime(QUERY_EVENT_FLUSH_INTERVAL_MS * 2);
		expect(stmt.run).not.toHaveBeenCalled();
	});

	it('schedules at most one timer for a stream of fast enqueues', () => {
		const { db, stmt } = makeMockDb();
		for (let i = 0; i < 5; i++) {
			enqueueQueryEvent(db as never, sampleEvent);
		}
		// One timer pending - advancing past the interval flushes everything.
		vi.advanceTimersByTime(QUERY_EVENT_FLUSH_INTERVAL_MS);
		expect(stmt.run).toHaveBeenCalledTimes(5);
	});

	it('drops events on flush failure rather than retrying', () => {
		const { db, stmt } = makeMockDb();
		// Make the transaction throw on first run.
		db.transaction = (() => () => {
			throw new Error('disk full');
		}) as MockTransactionFactory;

		enqueueQueryEvent(db as never, sampleEvent);
		enqueueQueryEvent(db as never, sampleEvent);

		expect(() => flushQueryEventsSync()).not.toThrow();
		// Buffer was cleared even though the transaction failed.
		expect(getQueryEventBufferSize()).toBe(0);
		// Subsequent flush is a no-op (buffer empty).
		flushQueryEventsSync();
		expect(stmt.run).not.toHaveBeenCalled();
	});

	it('passes the correct field shape to stmt.run', () => {
		const { db, stmt } = makeMockDb();
		enqueueQueryEvent(db as never, sampleEvent);
		flushQueryEventsSync();

		expect(stmt.run).toHaveBeenCalledTimes(1);
		const args = stmt.run.mock.calls[0];
		expect(args).toHaveLength(9);
		// args[0] is the generated id; args[1..] mirror the event fields.
		expect(args[1]).toBe('s1');
		expect(args[2]).toBe('claude-code');
		expect(args[3]).toBe('user');
		expect(args[4]).toBe(1000);
		expect(args[5]).toBe(500);
		expect(args[6]).toBe('/p');
		expect(args[7]).toBe('t1');
		expect(args[8]).toBe(0); // isRemote false → 0
	});

	it('encodes isRemote=true as 1 and missing tabId as null', () => {
		const { db, stmt } = makeMockDb();
		enqueueQueryEvent(db as never, {
			...sampleEvent,
			isRemote: true,
			tabId: undefined,
		});
		flushQueryEventsSync();

		const args = stmt.run.mock.calls[0];
		expect(args[7]).toBe(null);
		expect(args[8]).toBe(1);
	});

	it('handles undefined isRemote as null', () => {
		const { db, stmt } = makeMockDb();
		const eventWithoutRemote = { ...sampleEvent };
		delete (eventWithoutRemote as { isRemote?: unknown }).isRemote;
		enqueueQueryEvent(db as never, eventWithoutRemote);
		flushQueryEventsSync();

		const args = stmt.run.mock.calls[0];
		expect(args[8]).toBe(null);
	});

	it('survives a DB reference change between flushes', () => {
		const first = makeMockDb();
		const second = makeMockDb();

		enqueueQueryEvent(first.db as never, sampleEvent);
		flushQueryEventsSync();
		expect(first.stmt.run).toHaveBeenCalledTimes(1);

		// New DB reference - buffer module clears its statement cache and
		// prepares against the new DB.
		enqueueQueryEvent(second.db as never, sampleEvent);
		flushQueryEventsSync();
		expect(second.stmt.run).toHaveBeenCalledTimes(1);
		expect(first.stmt.run).toHaveBeenCalledTimes(1);
	});

	it('does not flush before any enqueue establishes a DB reference', () => {
		// No enqueue has happened, so flush has no DB to write to.
		expect(() => flushQueryEventsSync()).not.toThrow();
	});

	// MAESTRO-ZC: `closeStatsDB()` runs inside the quit handler's `before-quit`
	// listener, which re-enters `app.quit()`; the re-emitted `before-quit` then
	// ran this module's flush listener against an already-closed connection.
	// better-sqlite3 threw, and the catch reported it to Sentry as a crash.
	describe('flushing after the stats DB was closed (MAESTRO-ZC)', () => {
		it('does not report the closed connection to Sentry', () => {
			const { db } = makeMockDb();
			enqueueQueryEvent(db as never, sampleEvent);

			db.open = false;
			flushQueryEventsSync();

			expect(captureException).not.toHaveBeenCalled();
		});

		it('drops the batch without throwing, and empties the buffer', () => {
			const { db, stmt } = makeMockDb();
			enqueueQueryEvent(db as never, sampleEvent);
			enqueueQueryEvent(db as never, sampleEvent);

			db.open = false;

			expect(() => flushQueryEventsSync()).not.toThrow();
			expect(stmt.run).not.toHaveBeenCalled();
			expect(getQueryEventBufferSize()).toBe(0);
		});

		it('logs the dropped count so the loss is not silent', () => {
			const { db } = makeMockDb();
			enqueueQueryEvent(db as never, sampleEvent);
			enqueueQueryEvent(db as never, sampleEvent);
			enqueueQueryEvent(db as never, sampleEvent);

			db.open = false;
			flushQueryEventsSync();

			expect(logger.warn).toHaveBeenCalledWith(
				expect.stringContaining('already closed'),
				expect.anything(),
				expect.objectContaining({ count: 3 })
			);
		});

		it('still reports genuinely unexpected write failures to Sentry', () => {
			// The carve-out is for a closed handle only - a real write fault on an
			// open connection (disk full, corruption) must keep paging.
			const { db, stmt } = makeMockDb();
			stmt.run.mockImplementationOnce(() => {
				throw new Error('database disk image is malformed');
			});
			enqueueQueryEvent(db as never, sampleEvent);

			flushQueryEventsSync();

			expect(captureException).toHaveBeenCalledTimes(1);
		});

		it('swallows a statement-preparation failure instead of aborting the caller', () => {
			// `StatsDB.close()` calls this during quit cleanup, so an exception that
			// escapes the flush skips the `db.close()` and the `initialized = false`
			// that follow it. A prepare can still fail on a handle that reports
			// `open` (damaged schema, disk fault), so it has to sit inside the same
			// error boundary as the transaction.
			const { db } = makeMockDb();
			enqueueQueryEvent(db as never, sampleEvent);
			db.prepare.mockImplementationOnce(() => {
				throw new Error('no such table: query_events');
			});

			expect(() => flushQueryEventsSync()).not.toThrow();
			expect(getQueryEventBufferSize()).toBe(0);
			expect(captureException).toHaveBeenCalledTimes(1);
		});
	});
});
