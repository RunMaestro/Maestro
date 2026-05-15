/**
 * Tests for the shared insertQueryEventWithRetry helper.
 *
 * Both the process-driven `setupStatsListener` and the file-driven
 * `ExternalStatsIngester` use this helper to insert into the stats DB with
 * exponential-backoff retry on transient SQLite errors. These tests exercise
 * the retry/logging behavior directly — listener-level tests don't need to
 * re-cover them.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
	insertQueryEventWithRetry,
	MAX_RETRY_ATTEMPTS,
} from '../../../main/process-listeners/insertQueryEventWithRetry';
import type { QueryCompleteData } from '../../../main/process-manager/types';
import type { StatsDB } from '../../../main/stats';
import type { ProcessListenerDependencies } from '../../../main/process-listeners/types';

function makeQueryData(overrides: Partial<QueryCompleteData> = {}): QueryCompleteData {
	return {
		sessionId: 'session-test',
		agentType: 'claude-code',
		source: 'user',
		startTime: Date.now() - 1000,
		duration: 1000,
		projectPath: '/test/project',
		tabId: 'tab-test',
		...overrides,
	};
}

describe('insertQueryEventWithRetry', () => {
	let mockDB: StatsDB;
	let mockLogger: ProcessListenerDependencies['logger'];

	beforeEach(() => {
		vi.clearAllMocks();
		mockLogger = {
			info: vi.fn(),
			error: vi.fn(),
			warn: vi.fn(),
			debug: vi.fn(),
		};
		mockDB = {
			isReady: vi.fn(() => true),
			insertQueryEvent: vi.fn(() => 'event-id-success'),
		} as unknown as StatsDB;
	});

	it('returns the inserted id on the first successful attempt', async () => {
		const id = await insertQueryEventWithRetry(mockDB, makeQueryData(), mockLogger);

		expect(id).toBe('event-id-success');
		expect(mockDB.insertQueryEvent).toHaveBeenCalledTimes(1);
		expect(mockLogger.warn).not.toHaveBeenCalled();
		expect(mockLogger.error).not.toHaveBeenCalled();
	});

	it('passes through all QueryCompleteData fields to db.insertQueryEvent', async () => {
		const data = makeQueryData({
			sessionId: 'sess-1',
			agentType: 'codex',
			source: 'auto',
			startTime: 12345,
			duration: 6789,
			projectPath: '/proj',
			tabId: 'tab-1',
		});
		await insertQueryEventWithRetry(mockDB, data, mockLogger);

		expect(mockDB.insertQueryEvent).toHaveBeenCalledWith({
			sessionId: 'sess-1',
			agentType: 'codex',
			source: 'auto',
			startTime: 12345,
			duration: 6789,
			projectPath: '/proj',
			tabId: 'tab-1',
		});
	});

	it("forwards the new 'external-fs' source value without alteration", async () => {
		await insertQueryEventWithRetry(mockDB, makeQueryData({ source: 'external-fs' }), mockLogger);

		expect(mockDB.insertQueryEvent).toHaveBeenCalledWith(
			expect.objectContaining({ source: 'external-fs' })
		);
	});

	it('retries on transient failure and returns the id once an attempt succeeds', async () => {
		vi.mocked(mockDB.insertQueryEvent)
			.mockImplementationOnce(() => {
				throw new Error('SQLITE_BUSY');
			})
			.mockImplementationOnce(() => 'event-id-after-retry');

		const id = await insertQueryEventWithRetry(
			mockDB,
			makeQueryData({ sessionId: 'session-retry' }),
			mockLogger
		);

		expect(id).toBe('event-id-after-retry');
		expect(mockDB.insertQueryEvent).toHaveBeenCalledTimes(2);
		expect(mockLogger.warn).toHaveBeenCalledWith(
			expect.stringContaining('Stats DB insert failed'),
			'[Stats]',
			expect.objectContaining({ sessionId: 'session-retry' })
		);
	});

	it(`returns null and logs error after ${MAX_RETRY_ATTEMPTS} consecutive failures`, async () => {
		vi.mocked(mockDB.insertQueryEvent).mockImplementation(() => {
			throw new Error('persistent failure');
		});

		const id = await insertQueryEventWithRetry(
			mockDB,
			makeQueryData({ sessionId: 'session-fail' }),
			mockLogger
		);

		expect(id).toBeNull();
		expect(mockDB.insertQueryEvent).toHaveBeenCalledTimes(MAX_RETRY_ATTEMPTS);
		expect(mockLogger.error).toHaveBeenCalledWith(
			expect.stringContaining(`Failed to record query event after ${MAX_RETRY_ATTEMPTS} attempts`),
			'[Stats]',
			expect.objectContaining({ sessionId: 'session-fail' })
		);
		// Intermediate warns: MAX_RETRY_ATTEMPTS - 1 (last failure is the final error log).
		expect(mockLogger.warn).toHaveBeenCalledTimes(MAX_RETRY_ATTEMPTS - 1);
	});

	it('never throws — even when every attempt fails, the promise resolves with null', async () => {
		vi.mocked(mockDB.insertQueryEvent).mockImplementation(() => {
			throw new Error('always fail');
		});

		await expect(
			insertQueryEventWithRetry(mockDB, makeQueryData(), mockLogger)
		).resolves.toBeNull();
	});
});
