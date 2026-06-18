/**
 * Tests for stats listener.
 * Handles query-complete events for usage statistics tracking.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { setupStatsListener } from '../../../main/process-listeners/stats-listener';
import type { ProcessManager } from '../../../main/process-manager';
import type { SafeSendFn } from '../../../main/utils/safe-send';
import type { QueryCompleteData } from '../../../main/process-manager/types';
import type { StatsDB } from '../../../main/stats';
import type { ProcessListenerDependencies } from '../../../main/process-listeners/types';

describe('Stats Listener', () => {
	let mockProcessManager: ProcessManager;
	let mockSafeSend: SafeSendFn;
	let mockStatsDB: StatsDB;
	let mockLogger: ProcessListenerDependencies['logger'];
	let eventHandlers: Map<string, (...args: unknown[]) => void>;

	beforeEach(() => {
		vi.clearAllMocks();
		eventHandlers = new Map();

		mockSafeSend = vi.fn();
		mockLogger = {
			info: vi.fn(),
			error: vi.fn(),
			warn: vi.fn(),
			debug: vi.fn(),
		};

		mockStatsDB = {
			isReady: vi.fn(() => true),
			insertQueryEvent: vi.fn(() => 'event-id-123'),
		} as unknown as StatsDB;

		mockProcessManager = {
			on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
				eventHandlers.set(event, handler);
			}),
		} as unknown as ProcessManager;
	});

	it('should register the query-complete event listener', () => {
		setupStatsListener(mockProcessManager, {
			safeSend: mockSafeSend,
			getStatsDB: () => mockStatsDB,
			logger: mockLogger,
		});

		expect(mockProcessManager.on).toHaveBeenCalledWith('query-complete', expect.any(Function));
	});

	it('should record query event to stats database when ready', async () => {
		setupStatsListener(mockProcessManager, {
			safeSend: mockSafeSend,
			getStatsDB: () => mockStatsDB,
			logger: mockLogger,
		});

		const handler = eventHandlers.get('query-complete');
		const testSessionId = 'test-session-123';
		const testQueryData: QueryCompleteData = {
			sessionId: testSessionId,
			agentType: 'claude-code',
			source: 'user',
			startTime: Date.now() - 5000,
			duration: 5000,
			projectPath: '/test/project',
			tabId: 'tab-123',
		};

		handler?.(testSessionId, testQueryData);

		// Wait for async processing
		await vi.waitFor(() => {
			expect(mockStatsDB.isReady).toHaveBeenCalled();
			expect(mockStatsDB.insertQueryEvent).toHaveBeenCalledWith({
				sessionId: testQueryData.sessionId,
				agentType: testQueryData.agentType,
				source: testQueryData.source,
				startTime: testQueryData.startTime,
				duration: testQueryData.duration,
				projectPath: testQueryData.projectPath,
				tabId: testQueryData.tabId,
			});
			expect(mockSafeSend).toHaveBeenCalledWith('stats:updated');
		});
	});

	it('should not record event when stats database is not ready', () => {
		vi.mocked(mockStatsDB.isReady).mockReturnValue(false);

		setupStatsListener(mockProcessManager, {
			safeSend: mockSafeSend,
			getStatsDB: () => mockStatsDB,
			logger: mockLogger,
		});

		const handler = eventHandlers.get('query-complete');
		const testQueryData: QueryCompleteData = {
			sessionId: 'session-456',
			agentType: 'codex',
			source: 'auto',
			startTime: Date.now(),
			duration: 1000,
			projectPath: '/test/project',
			tabId: 'tab-456',
		};

		handler?.('session-456', testQueryData);

		expect(mockStatsDB.isReady).toHaveBeenCalled();
		expect(mockStatsDB.insertQueryEvent).not.toHaveBeenCalled();
		expect(mockSafeSend).not.toHaveBeenCalled();
	});

	it('should log error when recording fails after retries', async () => {
		vi.mocked(mockStatsDB.insertQueryEvent).mockImplementation(() => {
			throw new Error('Database error');
		});

		setupStatsListener(mockProcessManager, {
			safeSend: mockSafeSend,
			getStatsDB: () => mockStatsDB,
			logger: mockLogger,
		});

		const handler = eventHandlers.get('query-complete');
		const testQueryData: QueryCompleteData = {
			sessionId: 'session-789',
			agentType: 'opencode',
			source: 'user',
			startTime: Date.now(),
			duration: 2000,
			projectPath: '/test/project',
			tabId: 'tab-789',
		};

		handler?.('session-789', testQueryData);

		// Wait for all retries to complete (100ms + 200ms + final attempt)
		await vi.waitFor(
			() => {
				expect(mockLogger.error).toHaveBeenCalledWith(
					expect.stringContaining('Failed to record query event after 3 attempts'),
					'[Stats]',
					expect.objectContaining({
						sessionId: 'session-789',
					})
				);
			},
			{ timeout: 1000 }
		);
		// Should have tried 3 times
		expect(mockStatsDB.insertQueryEvent).toHaveBeenCalledTimes(3);
		// Should not have broadcasted update on failure
		expect(mockSafeSend).not.toHaveBeenCalled();
	});

	it('should log debug info when recording succeeds', async () => {
		setupStatsListener(mockProcessManager, {
			safeSend: mockSafeSend,
			getStatsDB: () => mockStatsDB,
			logger: mockLogger,
		});

		const handler = eventHandlers.get('query-complete');
		const testQueryData: QueryCompleteData = {
			sessionId: 'session-abc',
			agentType: 'claude-code',
			source: 'user',
			startTime: Date.now(),
			duration: 3000,
			projectPath: '/test/project',
			tabId: 'tab-abc',
		};

		handler?.('session-abc', testQueryData);

		// Wait for async processing
		await vi.waitFor(() => {
			expect(mockLogger.debug).toHaveBeenCalledWith(
				expect.stringContaining('Recorded query event'),
				'[Stats]',
				expect.objectContaining({
					sessionId: 'session-abc',
					agentType: 'claude-code',
					source: 'user',
					duration: 3000,
				})
			);
		});
	});

	it('should retry on transient failure and succeed', async () => {
		// First call fails, second succeeds
		vi.mocked(mockStatsDB.insertQueryEvent)
			.mockImplementationOnce(() => {
				throw new Error('Transient error');
			})
			.mockImplementationOnce(() => 'event-id-456');

		setupStatsListener(mockProcessManager, {
			safeSend: mockSafeSend,
			getStatsDB: () => mockStatsDB,
			logger: mockLogger,
		});

		const handler = eventHandlers.get('query-complete');
		const testQueryData: QueryCompleteData = {
			sessionId: 'session-retry',
			agentType: 'claude-code',
			source: 'user',
			startTime: Date.now(),
			duration: 1000,
			projectPath: '/test/project',
			tabId: 'tab-retry',
		};

		handler?.('session-retry', testQueryData);

		// Wait for retry to complete
		await vi.waitFor(
			() => {
				expect(mockStatsDB.insertQueryEvent).toHaveBeenCalledTimes(2);
				expect(mockSafeSend).toHaveBeenCalledWith('stats:updated');
			},
			{ timeout: 500 }
		);
		// Should have logged warning for first failure
		expect(mockLogger.warn).toHaveBeenCalledWith(
			expect.stringContaining('Stats DB insert failed'),
			'[Stats]',
			expect.any(Object)
		);
	});
});
