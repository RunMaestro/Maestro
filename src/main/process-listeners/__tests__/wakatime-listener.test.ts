/**
 * Tests for WakaTime heartbeat listener.
 * Verifies that data and thinking-chunk events trigger heartbeats for interactive sessions,
 * query-complete events trigger heartbeats for batch/auto-run,
 * tool-execution events accumulate file paths for file-level heartbeats,
 * usage events flush file heartbeats for interactive sessions (debounced),
 * and exit events clean up sessions and pending file data.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { setupWakaTimeListener } from '../wakatime-listener';
import type { ProcessManager } from '../../process-manager';
import type { WakaTimeManager } from '../../wakatime-manager';
import type { QueryCompleteData } from '../../process-manager/types';

describe('WakaTime Listener', () => {
	let mockProcessManager: ProcessManager;
	let mockWakaTimeManager: WakaTimeManager;
	let mockSettingsStore: any;
	let eventHandlers: Map<string, (...args: unknown[]) => void>;

	beforeEach(() => {
		vi.clearAllMocks();
		eventHandlers = new Map();

		let eventCounter = 0;
		mockProcessManager = {
			on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
				const key = eventHandlers.has(event) ? `${event}:${++eventCounter}` : event;
				eventHandlers.set(key, handler);
			}),
			get: vi.fn(),
		} as unknown as ProcessManager;

		mockWakaTimeManager = {
			sendHeartbeat: vi.fn().mockResolvedValue(undefined),
			sendFileHeartbeats: vi.fn().mockResolvedValue(undefined),
			removeSession: vi.fn(),
		} as unknown as WakaTimeManager;

		mockSettingsStore = {
			get: vi.fn((key: string, defaultValue?: any) => {
				if (key === 'wakatimeEnabled') return true;
				return defaultValue;
			}),
			onDidChange: vi.fn(),
		};
	});

	it('should register data, thinking-chunk, tool-execution, query-complete, usage, and exit event listeners', () => {
		setupWakaTimeListener(mockProcessManager, mockWakaTimeManager, mockSettingsStore);

		expect(mockProcessManager.on).toHaveBeenCalledWith('data', expect.any(Function));
		expect(mockProcessManager.on).toHaveBeenCalledWith('thinking-chunk', expect.any(Function));
		expect(mockProcessManager.on).toHaveBeenCalledWith('tool-execution', expect.any(Function));
		expect(mockProcessManager.on).toHaveBeenCalledWith('query-complete', expect.any(Function));
		expect(mockProcessManager.on).toHaveBeenCalledWith('usage', expect.any(Function));
		expect(mockProcessManager.on).toHaveBeenCalledWith('exit', expect.any(Function));
	});

	it('should send heartbeat on data event for AI sessions', () => {
		vi.mocked(mockProcessManager.get).mockReturnValue({
			sessionId: 'session-abc',
			toolType: 'claude-code',
			cwd: '/home/user/project',
			pid: 1234,
			isTerminal: false,
			startTime: Date.now(),
			projectPath: '/home/user/project',
		} as any);

		setupWakaTimeListener(mockProcessManager, mockWakaTimeManager, mockSettingsStore);

		const handler = eventHandlers.get('data');
		handler?.('session-abc', 'some output data');

		expect(mockWakaTimeManager.sendHeartbeat).toHaveBeenCalledWith(
			'session-abc',
			'project',
			'/home/user/project'
		);
	});

	it('should send heartbeat on thinking-chunk event', () => {
		vi.mocked(mockProcessManager.get).mockReturnValue({
			sessionId: 'session-thinking',
			toolType: 'claude-code',
			cwd: '/home/user/project',
			pid: 1234,
			isTerminal: false,
			startTime: Date.now(),
			projectPath: '/home/user/project',
		} as any);

		setupWakaTimeListener(mockProcessManager, mockWakaTimeManager, mockSettingsStore);

		const handler = eventHandlers.get('thinking-chunk');
		handler?.('session-thinking', 'reasoning text...');

		expect(mockWakaTimeManager.sendHeartbeat).toHaveBeenCalledWith(
			'session-thinking',
			'project',
			'/home/user/project'
		);
	});

	it('should skip heartbeat on data event for terminal sessions', () => {
		vi.mocked(mockProcessManager.get).mockReturnValue({
			sessionId: 'session-terminal',
			toolType: 'terminal',
			cwd: '/home/user',
			pid: 1234,
			isTerminal: true,
			startTime: Date.now(),
		} as any);

		setupWakaTimeListener(mockProcessManager, mockWakaTimeManager, mockSettingsStore);

		const handler = eventHandlers.get('data');
		handler?.('session-terminal', 'terminal output');

		expect(mockWakaTimeManager.sendHeartbeat).not.toHaveBeenCalled();
	});

	it('should skip heartbeat on data event when process not found', () => {
		vi.mocked(mockProcessManager.get).mockReturnValue(undefined);

		setupWakaTimeListener(mockProcessManager, mockWakaTimeManager, mockSettingsStore);

		const handler = eventHandlers.get('data');
		handler?.('session-unknown', 'data');

		expect(mockWakaTimeManager.sendHeartbeat).not.toHaveBeenCalled();
	});

	it('should fall back to cwd when projectPath is missing on data event', () => {
		vi.mocked(mockProcessManager.get).mockReturnValue({
			sessionId: 'session-no-path',
			toolType: 'codex',
			cwd: '/home/user/fallback',
			pid: 1234,
			isTerminal: false,
			startTime: Date.now(),
		} as any);

		setupWakaTimeListener(mockProcessManager, mockWakaTimeManager, mockSettingsStore);

		const handler = eventHandlers.get('data');
		handler?.('session-no-path', 'output');

		expect(mockWakaTimeManager.sendHeartbeat).toHaveBeenCalledWith(
			'session-no-path',
			'fallback',
			'/home/user/fallback'
		);
	});

	it('should send heartbeat on query-complete with projectPath', () => {
		setupWakaTimeListener(mockProcessManager, mockWakaTimeManager, mockSettingsStore);

		const handler = eventHandlers.get('query-complete');
		const queryData: QueryCompleteData = {
			sessionId: 'session-abc',
			agentType: 'claude-code',
			source: 'user',
			startTime: Date.now(),
			duration: 5000,
			projectPath: '/home/user/project',
			tabId: 'My Project Tab',
		};

		handler?.('session-abc', queryData);

		expect(mockWakaTimeManager.sendHeartbeat).toHaveBeenCalledWith(
			'session-abc',
			'project',
			'/home/user/project'
		);
	});

	it('should fallback to sessionId when projectPath is missing on query-complete', () => {
		setupWakaTimeListener(mockProcessManager, mockWakaTimeManager, mockSettingsStore);

		const handler = eventHandlers.get('query-complete');
		const queryData: QueryCompleteData = {
			sessionId: 'session-fallback',
			agentType: 'claude-code',
			source: 'user',
			startTime: Date.now(),
			duration: 1000,
		};

		handler?.('session-fallback', queryData);

		expect(mockWakaTimeManager.sendHeartbeat).toHaveBeenCalledWith(
			'session-fallback',
			'session-fallback',
			undefined
		);
	});

	it('should remove session on exit event', () => {
		setupWakaTimeListener(mockProcessManager, mockWakaTimeManager, mockSettingsStore);

		const handler = eventHandlers.get('exit');
		handler?.('session-exit-123');

		expect(mockWakaTimeManager.removeSession).toHaveBeenCalledWith('session-exit-123');
	});

	it('should skip heartbeat on data event when WakaTime is disabled', () => {
		mockSettingsStore.get.mockImplementation((key: string, defaultValue?: any) => {
			if (key === 'wakatimeEnabled') return false;
			return defaultValue;
		});

		vi.mocked(mockProcessManager.get).mockReturnValue({
			sessionId: 'session-abc',
			toolType: 'claude-code',
			cwd: '/home/user/project',
			pid: 1234,
			isTerminal: false,
			startTime: Date.now(),
			projectPath: '/home/user/project',
		} as any);

		setupWakaTimeListener(mockProcessManager, mockWakaTimeManager, mockSettingsStore);

		const handler = eventHandlers.get('data');
		handler?.('session-abc', 'some output data');

		expect(mockProcessManager.get).not.toHaveBeenCalled();
		expect(mockWakaTimeManager.sendHeartbeat).not.toHaveBeenCalled();
	});

	it('should skip heartbeat on thinking-chunk event when WakaTime is disabled', () => {
		mockSettingsStore.get.mockImplementation((key: string, defaultValue?: any) => {
			if (key === 'wakatimeEnabled') return false;
			return defaultValue;
		});

		setupWakaTimeListener(mockProcessManager, mockWakaTimeManager, mockSettingsStore);

		const handler = eventHandlers.get('thinking-chunk');
		handler?.('session-thinking', 'reasoning...');

		expect(mockProcessManager.get).not.toHaveBeenCalled();
		expect(mockWakaTimeManager.sendHeartbeat).not.toHaveBeenCalled();
	});

	it('should skip heartbeat on query-complete event when WakaTime is disabled', () => {
		mockSettingsStore.get.mockImplementation((key: string, defaultValue?: any) => {
			if (key === 'wakatimeEnabled') return false;
			return defaultValue;
		});

		setupWakaTimeListener(mockProcessManager, mockWakaTimeManager, mockSettingsStore);

		const handler = eventHandlers.get('query-complete');
		const queryData: QueryCompleteData = {
			sessionId: 'session-abc',
			agentType: 'claude-code',
			source: 'user',
			startTime: Date.now(),
			duration: 5000,
			projectPath: '/home/user/project',
		};

		handler?.('session-abc', queryData);

		expect(mockWakaTimeManager.sendHeartbeat).not.toHaveBeenCalled();
	});

	it('should react to onDidChange for wakatimeEnabled', () => {
		setupWakaTimeListener(mockProcessManager, mockWakaTimeManager, mockSettingsStore);

		// Verify onDidChange was registered
		expect(mockSettingsStore.onDidChange).toHaveBeenCalledWith(
			'wakatimeEnabled',
			expect.any(Function)
		);

		// Simulate runtime toggle: disable WakaTime
		const changeCallback = mockSettingsStore.onDidChange.mock.calls[0][1];
		changeCallback(false);

		vi.mocked(mockProcessManager.get).mockReturnValue({
			sessionId: 'session-abc',
			toolType: 'claude-code',
			cwd: '/home/user/project',
			pid: 1234,
			isTerminal: false,
			startTime: Date.now(),
			projectPath: '/home/user/project',
		} as any);

		const handler = eventHandlers.get('data');
		handler?.('session-abc', 'output');

		expect(mockWakaTimeManager.sendHeartbeat).not.toHaveBeenCalled();
	});

	it('should subscribe to wakatimeDetailedTracking changes', () => {
		setupWakaTimeListener(mockProcessManager, mockWakaTimeManager, mockSettingsStore);

		expect(mockSettingsStore.onDidChange).toHaveBeenCalledWith(
			'wakatimeDetailedTracking',
			expect.any(Function)
		);
	});

	describe('tool-execution file collection', () => {
		let toolExecutionHandler: (...args: unknown[]) => void;
		let queryCompleteHandler: (...args: unknown[]) => void;

		beforeEach(() => {
			// Enable both wakatime and detailed tracking
			mockSettingsStore.get.mockImplementation((key: string, defaultValue?: any) => {
				if (key === 'wakatimeEnabled') return true;
				if (key === 'wakatimeDetailedTracking') return true;
				return defaultValue;
			});

			setupWakaTimeListener(mockProcessManager, mockWakaTimeManager, mockSettingsStore);

			toolExecutionHandler = eventHandlers.get('tool-execution')!;
			queryCompleteHandler = eventHandlers.get('query-complete')!;
		});

		it('should accumulate file paths from write tool executions', () => {
			toolExecutionHandler('session-1', {
				toolName: 'Write',
				state: { input: { file_path: '/home/user/project/src/index.ts' } },
				timestamp: 1000,
			});

			// Trigger query-complete to flush
			queryCompleteHandler('session-1', {
				sessionId: 'session-1',
				agentType: 'claude-code',
				source: 'user',
				startTime: 0,
				duration: 5000,
				projectPath: '/home/user/project',
			} as QueryCompleteData);

			expect(mockWakaTimeManager.sendFileHeartbeats).toHaveBeenCalledWith(
				[{ filePath: '/home/user/project/src/index.ts', timestamp: 1000 }],
				'project',
				'/home/user/project'
			);
		});

		it('should ignore non-write tool executions', () => {
			toolExecutionHandler('session-1', {
				toolName: 'Read',
				state: { input: { file_path: '/home/user/project/src/index.ts' } },
				timestamp: 1000,
			});

			queryCompleteHandler('session-1', {
				sessionId: 'session-1',
				agentType: 'claude-code',
				source: 'user',
				startTime: 0,
				duration: 5000,
				projectPath: '/home/user/project',
			} as QueryCompleteData);

			expect(mockWakaTimeManager.sendFileHeartbeats).not.toHaveBeenCalled();
		});

		it('should deduplicate file paths keeping latest timestamp', () => {
			toolExecutionHandler('session-1', {
				toolName: 'Edit',
				state: { input: { file_path: '/home/user/project/src/app.ts' } },
				timestamp: 1000,
			});
			toolExecutionHandler('session-1', {
				toolName: 'Edit',
				state: { input: { file_path: '/home/user/project/src/app.ts' } },
				timestamp: 2000,
			});

			queryCompleteHandler('session-1', {
				sessionId: 'session-1',
				agentType: 'claude-code',
				source: 'user',
				startTime: 0,
				duration: 5000,
				projectPath: '/home/user/project',
			} as QueryCompleteData);

			expect(mockWakaTimeManager.sendFileHeartbeats).toHaveBeenCalledWith(
				[{ filePath: '/home/user/project/src/app.ts', timestamp: 2000 }],
				'project',
				'/home/user/project'
			);
		});

		it('should resolve relative file paths using projectPath', () => {
			toolExecutionHandler('session-1', {
				toolName: 'Write',
				state: { input: { file_path: 'src/utils.ts' } },
				timestamp: 1000,
			});

			queryCompleteHandler('session-1', {
				sessionId: 'session-1',
				agentType: 'claude-code',
				source: 'user',
				startTime: 0,
				duration: 5000,
				projectPath: '/home/user/project',
			} as QueryCompleteData);

			expect(mockWakaTimeManager.sendFileHeartbeats).toHaveBeenCalledWith(
				[{ filePath: '/home/user/project/src/utils.ts', timestamp: 1000 }],
				'project',
				'/home/user/project'
			);
		});

		it('should not resolve already-absolute file paths', () => {
			toolExecutionHandler('session-1', {
				toolName: 'Write',
				state: { input: { file_path: '/absolute/path/file.ts' } },
				timestamp: 1000,
			});

			queryCompleteHandler('session-1', {
				sessionId: 'session-1',
				agentType: 'claude-code',
				source: 'user',
				startTime: 0,
				duration: 5000,
				projectPath: '/home/user/project',
			} as QueryCompleteData);

			expect(mockWakaTimeManager.sendFileHeartbeats).toHaveBeenCalledWith(
				[{ filePath: '/absolute/path/file.ts', timestamp: 1000 }],
				'project',
				'/home/user/project'
			);
		});

		it('should clear pending files after flushing on query-complete', () => {
			toolExecutionHandler('session-1', {
				toolName: 'Write',
				state: { input: { file_path: '/home/user/project/a.ts' } },
				timestamp: 1000,
			});

			// First query-complete should flush
			queryCompleteHandler('session-1', {
				sessionId: 'session-1',
				agentType: 'claude-code',
				source: 'user',
				startTime: 0,
				duration: 5000,
				projectPath: '/home/user/project',
			} as QueryCompleteData);

			expect(mockWakaTimeManager.sendFileHeartbeats).toHaveBeenCalledTimes(1);

			// Second query-complete should NOT call sendFileHeartbeats (already flushed)
			queryCompleteHandler('session-1', {
				sessionId: 'session-1',
				agentType: 'claude-code',
				source: 'user',
				startTime: 0,
				duration: 5000,
				projectPath: '/home/user/project',
			} as QueryCompleteData);

			expect(mockWakaTimeManager.sendFileHeartbeats).toHaveBeenCalledTimes(1);
		});

		it('should skip tool-execution collection when wakatime is disabled', () => {
			// Disable wakatime via onDidChange callback
			const enabledCallback = mockSettingsStore.onDidChange.mock.calls.find(
				(c: any[]) => c[0] === 'wakatimeEnabled'
			)[1];
			enabledCallback(false);

			toolExecutionHandler('session-1', {
				toolName: 'Write',
				state: { input: { file_path: '/home/user/project/a.ts' } },
				timestamp: 1000,
			});

			// Re-enable for query-complete to fire
			enabledCallback(true);

			queryCompleteHandler('session-1', {
				sessionId: 'session-1',
				agentType: 'claude-code',
				source: 'user',
				startTime: 0,
				duration: 5000,
				projectPath: '/home/user/project',
			} as QueryCompleteData);

			expect(mockWakaTimeManager.sendFileHeartbeats).not.toHaveBeenCalled();
		});

		it('should skip tool-execution collection when detailed tracking is disabled', () => {
			// Disable detailed tracking via onDidChange callback
			const detailedCallback = mockSettingsStore.onDidChange.mock.calls.find(
				(c: any[]) => c[0] === 'wakatimeDetailedTracking'
			)[1];
			detailedCallback(false);

			toolExecutionHandler('session-1', {
				toolName: 'Write',
				state: { input: { file_path: '/home/user/project/a.ts' } },
				timestamp: 1000,
			});

			queryCompleteHandler('session-1', {
				sessionId: 'session-1',
				agentType: 'claude-code',
				source: 'user',
				startTime: 0,
				duration: 5000,
				projectPath: '/home/user/project',
			} as QueryCompleteData);

			expect(mockWakaTimeManager.sendFileHeartbeats).not.toHaveBeenCalled();
		});

		it('should not flush file heartbeats on query-complete when detailed tracking is disabled', () => {
			toolExecutionHandler('session-1', {
				toolName: 'Write',
				state: { input: { file_path: '/home/user/project/a.ts' } },
				timestamp: 1000,
			});

			// Disable detailed tracking before query-complete
			const detailedCallback = mockSettingsStore.onDidChange.mock.calls.find(
				(c: any[]) => c[0] === 'wakatimeDetailedTracking'
			)[1];
			detailedCallback(false);

			queryCompleteHandler('session-1', {
				sessionId: 'session-1',
				agentType: 'claude-code',
				source: 'user',
				startTime: 0,
				duration: 5000,
				projectPath: '/home/user/project',
			} as QueryCompleteData);

			// Regular heartbeat should still be sent
			expect(mockWakaTimeManager.sendHeartbeat).toHaveBeenCalled();
			// But file heartbeats should not
			expect(mockWakaTimeManager.sendFileHeartbeats).not.toHaveBeenCalled();
		});
	});

	describe('exit cleanup of pending files', () => {
		it('should clean up pending files on exit', () => {
			mockSettingsStore.get.mockImplementation((key: string, defaultValue?: any) => {
				if (key === 'wakatimeEnabled') return true;
				if (key === 'wakatimeDetailedTracking') return true;
				return defaultValue;
			});

			setupWakaTimeListener(mockProcessManager, mockWakaTimeManager, mockSettingsStore);

			const toolExecutionHandler = eventHandlers.get('tool-execution')!;
			const exitHandler = eventHandlers.get('exit')!;
			const queryCompleteHandler = eventHandlers.get('query-complete')!;

			// Accumulate a file
			toolExecutionHandler('session-1', {
				toolName: 'Write',
				state: { input: { file_path: '/home/user/project/a.ts' } },
				timestamp: 1000,
			});

			// Exit cleans up
			exitHandler('session-1');

			// query-complete should not find any pending files
			queryCompleteHandler('session-1', {
				sessionId: 'session-1',
				agentType: 'claude-code',
				source: 'user',
				startTime: 0,
				duration: 5000,
				projectPath: '/home/user/project',
			} as QueryCompleteData);

			expect(mockWakaTimeManager.sendFileHeartbeats).not.toHaveBeenCalled();
		});
	});

	describe('usage-based file flush', () => {
		let toolExecutionHandler: (...args: unknown[]) => void;
		let usageHandler: (...args: unknown[]) => void;
		let queryCompleteHandler: (...args: unknown[]) => void;
		let exitHandler: (...args: unknown[]) => void;

		const usageStats = {
			inputTokens: 100,
			outputTokens: 50,
			cacheReadInputTokens: 0,
			cacheCreationInputTokens: 0,
			totalCostUsd: 0.01,
			contextWindow: 200000,
		};

		beforeEach(() => {
			vi.useFakeTimers();

			// Enable both wakatime and detailed tracking
			mockSettingsStore.get.mockImplementation((key: string, defaultValue?: any) => {
				if (key === 'wakatimeEnabled') return true;
				if (key === 'wakatimeDetailedTracking') return true;
				return defaultValue;
			});

			vi.mocked(mockProcessManager.get).mockReturnValue({
				sessionId: 'session-interactive',
				toolType: 'claude-code',
				cwd: '/home/user/project',
				pid: 1234,
				isTerminal: false,
				startTime: Date.now(),
				projectPath: '/home/user/project',
			} as any);

			setupWakaTimeListener(mockProcessManager, mockWakaTimeManager, mockSettingsStore);

			toolExecutionHandler = eventHandlers.get('tool-execution')!;
			usageHandler = eventHandlers.get('usage')!;
			queryCompleteHandler = eventHandlers.get('query-complete')!;
			exitHandler = eventHandlers.get('exit')!;
		});

		afterEach(() => {
			vi.useRealTimers();
		});

		it('should flush file heartbeats after usage event debounce', () => {
			toolExecutionHandler('session-interactive', {
				toolName: 'Write',
				state: { input: { file_path: '/home/user/project/src/app.ts' } },
				timestamp: 1000,
			});

			usageHandler('session-interactive', usageStats);

			// Should NOT have flushed yet (debounce pending)
			expect(mockWakaTimeManager.sendFileHeartbeats).not.toHaveBeenCalled();

			// Advance past debounce delay
			vi.advanceTimersByTime(500);

			expect(mockWakaTimeManager.sendFileHeartbeats).toHaveBeenCalledWith(
				[{ filePath: '/home/user/project/src/app.ts', timestamp: 1000 }],
				'project',
				'/home/user/project'
			);
		});

		it('should debounce multiple rapid usage events into one flush', () => {
			toolExecutionHandler('session-interactive', {
				toolName: 'Write',
				state: { input: { file_path: '/home/user/project/a.ts' } },
				timestamp: 1000,
			});

			// Fire usage three times in quick succession
			usageHandler('session-interactive', usageStats);
			vi.advanceTimersByTime(200);
			usageHandler('session-interactive', usageStats);
			vi.advanceTimersByTime(200);

			// Add another file between usage events
			toolExecutionHandler('session-interactive', {
				toolName: 'Edit',
				state: { input: { file_path: '/home/user/project/b.ts' } },
				timestamp: 2000,
			});

			usageHandler('session-interactive', usageStats);

			// Still not flushed
			expect(mockWakaTimeManager.sendFileHeartbeats).not.toHaveBeenCalled();

			// Advance past the final debounce
			vi.advanceTimersByTime(500);

			// Should flush once with both files
			expect(mockWakaTimeManager.sendFileHeartbeats).toHaveBeenCalledTimes(1);
			expect(mockWakaTimeManager.sendFileHeartbeats).toHaveBeenCalledWith(
				expect.arrayContaining([
					{ filePath: '/home/user/project/a.ts', timestamp: 1000 },
					{ filePath: '/home/user/project/b.ts', timestamp: 2000 },
				]),
				'project',
				'/home/user/project'
			);
		});

		it('should not double-flush when query-complete fires after usage accumulation', () => {
			toolExecutionHandler('session-interactive', {
				toolName: 'Write',
				state: { input: { file_path: '/home/user/project/a.ts' } },
				timestamp: 1000,
			});

			// usage fires (starts debounce timer)
			usageHandler('session-interactive', usageStats);

			// Before debounce fires, query-complete fires (batch scenario)
			queryCompleteHandler('session-interactive', {
				sessionId: 'session-interactive',
				agentType: 'claude-code',
				source: 'user',
				startTime: 0,
				duration: 5000,
				projectPath: '/home/user/project',
			} as QueryCompleteData);

			// query-complete already flushed
			expect(mockWakaTimeManager.sendFileHeartbeats).toHaveBeenCalledTimes(1);

			// Advance past debounce -- should NOT flush again
			vi.advanceTimersByTime(500);
			expect(mockWakaTimeManager.sendFileHeartbeats).toHaveBeenCalledTimes(1);
		});

		it('should skip usage flush when no pending files exist', () => {
			usageHandler('session-interactive', usageStats);
			vi.advanceTimersByTime(500);

			expect(mockWakaTimeManager.sendFileHeartbeats).not.toHaveBeenCalled();
		});

		it('should skip usage flush when wakatime is disabled', () => {
			const enabledCallback = mockSettingsStore.onDidChange.mock.calls.find(
				(c: any[]) => c[0] === 'wakatimeEnabled'
			)[1];
			enabledCallback(false);

			toolExecutionHandler('session-interactive', {
				toolName: 'Write',
				state: { input: { file_path: '/home/user/project/a.ts' } },
				timestamp: 1000,
			});

			// Re-enable so usage handler runs, but no files accumulated
			enabledCallback(true);

			usageHandler('session-interactive', usageStats);
			vi.advanceTimersByTime(500);

			expect(mockWakaTimeManager.sendFileHeartbeats).not.toHaveBeenCalled();
		});

		it('should skip usage flush when detailed tracking is disabled', () => {
			const detailedCallback = mockSettingsStore.onDidChange.mock.calls.find(
				(c: any[]) => c[0] === 'wakatimeDetailedTracking'
			)[1];
			detailedCallback(false);

			toolExecutionHandler('session-interactive', {
				toolName: 'Write',
				state: { input: { file_path: '/home/user/project/a.ts' } },
				timestamp: 1000,
			});

			usageHandler('session-interactive', usageStats);
			vi.advanceTimersByTime(500);

			expect(mockWakaTimeManager.sendFileHeartbeats).not.toHaveBeenCalled();
		});

		it('should resolve relative file paths using managedProcess.projectPath', () => {
			toolExecutionHandler('session-interactive', {
				toolName: 'Write',
				state: { input: { file_path: 'src/utils.ts' } },
				timestamp: 1000,
			});

			usageHandler('session-interactive', usageStats);
			vi.advanceTimersByTime(500);

			expect(mockWakaTimeManager.sendFileHeartbeats).toHaveBeenCalledWith(
				[{ filePath: '/home/user/project/src/utils.ts', timestamp: 1000 }],
				'project',
				'/home/user/project'
			);
		});

		it('should fall back to cwd when projectPath is missing', () => {
			vi.mocked(mockProcessManager.get).mockReturnValue({
				sessionId: 'session-interactive',
				toolType: 'claude-code',
				cwd: '/home/user/fallback',
				pid: 1234,
				isTerminal: false,
				startTime: Date.now(),
			} as any);

			toolExecutionHandler('session-interactive', {
				toolName: 'Write',
				state: { input: { file_path: 'src/utils.ts' } },
				timestamp: 1000,
			});

			usageHandler('session-interactive', usageStats);
			vi.advanceTimersByTime(500);

			expect(mockWakaTimeManager.sendFileHeartbeats).toHaveBeenCalledWith(
				[{ filePath: '/home/user/fallback/src/utils.ts', timestamp: 1000 }],
				'fallback',
				'/home/user/fallback'
			);
		});

		it('should clean up usage flush timer on exit', () => {
			toolExecutionHandler('session-interactive', {
				toolName: 'Write',
				state: { input: { file_path: '/home/user/project/a.ts' } },
				timestamp: 1000,
			});

			usageHandler('session-interactive', usageStats);

			// Exit before debounce fires
			exitHandler('session-interactive');

			// Advance past debounce -- should NOT flush
			vi.advanceTimersByTime(500);
			expect(mockWakaTimeManager.sendFileHeartbeats).not.toHaveBeenCalled();
		});

		it('should skip flush for terminal sessions', () => {
			vi.mocked(mockProcessManager.get).mockReturnValue({
				sessionId: 'session-interactive',
				toolType: 'terminal',
				cwd: '/home/user',
				pid: 1234,
				isTerminal: true,
				startTime: Date.now(),
			} as any);

			toolExecutionHandler('session-interactive', {
				toolName: 'Write',
				state: { input: { file_path: '/home/user/project/a.ts' } },
				timestamp: 1000,
			});

			usageHandler('session-interactive', usageStats);
			vi.advanceTimersByTime(500);

			expect(mockWakaTimeManager.sendFileHeartbeats).not.toHaveBeenCalled();
		});
	});
});
