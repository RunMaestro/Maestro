/**
 * Tests for WakaTime heartbeat listener.
 * Verifies that data and thinking-chunk events trigger heartbeats for interactive sessions,
 * query-complete events trigger heartbeats for batch/auto-run,
 * and exit events clean up sessions.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
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

	it('should register data, thinking-chunk, query-complete, and exit event listeners', () => {
		setupWakaTimeListener(mockProcessManager, mockWakaTimeManager, mockSettingsStore);

		expect(mockProcessManager.on).toHaveBeenCalledWith('data', expect.any(Function));
		expect(mockProcessManager.on).toHaveBeenCalledWith('thinking-chunk', expect.any(Function));
		expect(mockProcessManager.on).toHaveBeenCalledWith('query-complete', expect.any(Function));
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
			'/home/user/project',
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
			'/home/user/project',
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
			'/home/user/fallback',
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
			'/home/user/project',
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
			undefined,
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
		expect(mockSettingsStore.onDidChange).toHaveBeenCalledWith('wakatimeEnabled', expect.any(Function));

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
});
