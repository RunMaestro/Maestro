import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { setupWakaTimeListener } from '../../main/process-listeners/wakatime-listener';
import type {
	ManagedProcess,
	QueryCompleteData,
	ToolExecution,
	UsageStats,
} from '../../main/process-manager/types';
import type { ProcessManager } from '../../main/process-manager';
import type { MaestroSettings } from '../../main/stores/types';
import type { WakaTimeManager } from '../../main/wakatime-manager';

type Handler = (...args: unknown[]) => void;
type SettingsKey = keyof MaestroSettings;
type SettingHandler = (value: unknown) => void;

function queryComplete(overrides: Partial<QueryCompleteData> = {}): QueryCompleteData {
	return {
		sessionId: 'agent-1',
		agentType: 'claude-code',
		source: 'user',
		startTime: 1000,
		duration: 2000,
		projectPath: '/workspace/project',
		tabId: 'tab-1',
		...overrides,
	};
}

function toolExecution(overrides: Partial<ToolExecution> = {}): ToolExecution {
	return {
		toolName: 'Write',
		state: { input: { file_path: 'src/app.ts' } },
		timestamp: 1_700_000_000_000,
		...overrides,
	};
}

function usageStats(): UsageStats {
	return {
		inputTokens: 100,
		outputTokens: 50,
		cacheReadInputTokens: 10,
		cacheCreationInputTokens: 5,
		totalCostUsd: 0.01,
		contextWindow: 200_000,
	};
}

describe('wakatime listener integration', () => {
	let eventHandlers: Map<string, Handler>;
	let settingsHandlers: Map<SettingsKey, SettingHandler[]>;
	let settingsValues: Partial<MaestroSettings>;
	let managedProcesses: Map<string, Partial<ManagedProcess>>;
	let processManager: ProcessManager;
	let wakaTimeManager: WakaTimeManager;

	beforeEach(() => {
		vi.useRealTimers();
		vi.clearAllMocks();
		eventHandlers = new Map();
		settingsHandlers = new Map();
		settingsValues = {
			wakatimeEnabled: true,
			wakatimeDetailedTracking: true,
		};
		managedProcesses = new Map();
		processManager = {
			on: vi.fn((event: string, handler: Handler) => {
				eventHandlers.set(event, handler);
			}),
			get: vi.fn((sessionId: string) => managedProcesses.get(sessionId)),
		} as unknown as ProcessManager;
		wakaTimeManager = {
			sendHeartbeat: vi.fn().mockResolvedValue(undefined),
			sendFileHeartbeats: vi.fn().mockResolvedValue(undefined),
			removeSession: vi.fn(),
		} as unknown as WakaTimeManager;
	});

	afterEach(() => {
		if (vi.isFakeTimers()) {
			vi.runOnlyPendingTimers();
		}
		vi.clearAllTimers();
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	function setupListener() {
		const settingsStore = {
			get: vi.fn((key: SettingsKey, defaultValue?: unknown) => {
				return key in settingsValues ? settingsValues[key] : defaultValue;
			}),
			onDidChange: vi.fn((key: SettingsKey, handler: SettingHandler) => {
				const handlers = settingsHandlers.get(key) ?? [];
				handlers.push(handler);
				settingsHandlers.set(key, handlers);
				return () => {
					settingsHandlers.set(
						key,
						(settingsHandlers.get(key) ?? []).filter((item) => item !== handler)
					);
				};
			}),
		};

		setupWakaTimeListener(
			processManager,
			wakaTimeManager,
			settingsStore as unknown as Parameters<typeof setupWakaTimeListener>[2]
		);
		return settingsStore;
	}

	function changeSetting(key: SettingsKey, value: unknown) {
		settingsValues[key] = value as never;
		for (const handler of settingsHandlers.get(key) ?? []) {
			handler(value);
		}
	}

	function emit(event: string, ...args: unknown[]) {
		eventHandlers.get(event)?.(...args);
	}

	function setManagedProcess(sessionId: string, overrides: Partial<ManagedProcess> = {}) {
		managedProcesses.set(sessionId, {
			sessionId,
			toolType: 'claude-code',
			cwd: '/workspace/fallback',
			pid: 123,
			isTerminal: false,
			startTime: 1000,
			projectPath: '/workspace/project',
			querySource: 'user',
			...overrides,
		});
	}

	it('registers listeners and gates data and thinking heartbeats through cached settings', () => {
		settingsValues.wakatimeEnabled = false;
		const settingsStore = setupListener();

		expect(processManager.on).toHaveBeenCalledWith('data', expect.any(Function));
		expect(processManager.on).toHaveBeenCalledWith('thinking-chunk', expect.any(Function));
		expect(processManager.on).toHaveBeenCalledWith('tool-execution', expect.any(Function));
		expect(processManager.on).toHaveBeenCalledWith('query-complete', expect.any(Function));
		expect(processManager.on).toHaveBeenCalledWith('usage', expect.any(Function));
		expect(processManager.on).toHaveBeenCalledWith('exit', expect.any(Function));
		expect(settingsStore.onDidChange).toHaveBeenCalledWith('wakatimeEnabled', expect.any(Function));
		expect(settingsStore.onDidChange).toHaveBeenCalledWith(
			'wakatimeDetailedTracking',
			expect.any(Function)
		);

		setManagedProcess('agent-1');
		emit('data', 'agent-1', 'ignored while disabled');
		emit('thinking-chunk', 'agent-1', 'thinking ignored while disabled');
		emit('query-complete', 'agent-1', queryComplete({ sessionId: 'agent-1' }));
		expect(wakaTimeManager.sendHeartbeat).not.toHaveBeenCalled();

		changeSetting('wakatimeEnabled', true);
		emit('data', 'missing-agent', 'no managed process');
		setManagedProcess('terminal-1', { isTerminal: true });
		emit('thinking-chunk', 'terminal-1', 'terminal output is ignored');
		expect(wakaTimeManager.sendHeartbeat).not.toHaveBeenCalled();

		emit('data', 'agent-1', 'stdout');
		expect(wakaTimeManager.sendHeartbeat).toHaveBeenCalledWith(
			'agent-1',
			'project',
			'/workspace/project',
			'user'
		);

		setManagedProcess('agent-2', {
			cwd: '/workspace/fallback-only',
			projectPath: undefined,
			querySource: 'auto',
		});
		emit('thinking-chunk', 'agent-2', 'thinking');
		expect(wakaTimeManager.sendHeartbeat).toHaveBeenCalledWith(
			'agent-2',
			'fallback-only',
			'/workspace/fallback-only',
			'auto'
		);
	});

	it('accumulates detailed write tools and flushes files on query completion', () => {
		setupListener();

		changeSetting('wakatimeDetailedTracking', false);
		emit('tool-execution', 'agent-1', toolExecution({ timestamp: 500 }));
		changeSetting('wakatimeDetailedTracking', true);

		emit('tool-execution', 'agent-1', toolExecution({ toolName: 'Read' }));
		emit('tool-execution', 'agent-1', toolExecution({ timestamp: 1000 }));
		emit(
			'tool-execution',
			'agent-1',
			toolExecution({
				state: { input: { file_path: 'src/app.ts' } },
				timestamp: 2000,
			})
		);
		emit(
			'tool-execution',
			'agent-1',
			toolExecution({
				toolName: 'Edit',
				state: { input: { path: '/tmp/absolute.md' } },
				timestamp: 3000,
			})
		);

		emit(
			'query-complete',
			'process-session-id',
			queryComplete({ sessionId: 'agent-1', source: 'auto' })
		);

		expect(wakaTimeManager.sendHeartbeat).toHaveBeenCalledWith(
			'agent-1',
			'project',
			'/workspace/project',
			'auto'
		);
		expect(wakaTimeManager.sendFileHeartbeats).toHaveBeenCalledWith(
			[
				{ filePath: '/workspace/project/src/app.ts', timestamp: 2000 },
				{ filePath: '/tmp/absolute.md', timestamp: 3000 },
			],
			'project',
			'/workspace/project',
			'auto'
		);

		emit(
			'query-complete',
			'process-session-id',
			queryComplete({ sessionId: 'agent-1', source: 'auto' })
		);
		expect(wakaTimeManager.sendFileHeartbeats).toHaveBeenCalledTimes(1);

		emit('tool-execution', 'agent-1', toolExecution({ timestamp: 4000 }));
		changeSetting('wakatimeDetailedTracking', false);
		emit('query-complete', 'agent-1', queryComplete({ sessionId: 'agent-1', source: 'user' }));
		expect(wakaTimeManager.sendFileHeartbeats).toHaveBeenCalledTimes(1);
	});

	it('debounces usage-triggered file heartbeats and cancels them after query completion', async () => {
		vi.useFakeTimers();
		setupListener();
		setManagedProcess('agent-1', { querySource: 'user' });

		changeSetting('wakatimeEnabled', false);
		emit('usage', 'agent-1', usageStats());
		changeSetting('wakatimeEnabled', true);

		emit('usage', 'agent-1', usageStats());
		expect(wakaTimeManager.sendFileHeartbeats).not.toHaveBeenCalled();

		emit('tool-execution', 'agent-1', toolExecution({ timestamp: 500 }));
		changeSetting('wakatimeDetailedTracking', false);
		emit('usage', 'agent-1', usageStats());
		changeSetting('wakatimeDetailedTracking', true);

		emit('tool-execution', 'agent-1', toolExecution({ timestamp: 1000 }));
		emit('usage', 'agent-1', usageStats());
		emit('tool-execution', 'agent-1', toolExecution({ timestamp: 2000 }));
		emit('usage', 'agent-1', usageStats());

		await vi.advanceTimersByTimeAsync(499);
		expect(wakaTimeManager.sendFileHeartbeats).not.toHaveBeenCalled();

		await vi.advanceTimersByTimeAsync(1);
		expect(wakaTimeManager.sendFileHeartbeats).toHaveBeenCalledWith(
			[{ filePath: '/workspace/project/src/app.ts', timestamp: 2000 }],
			'project',
			'/workspace/project',
			'user'
		);

		emit('tool-execution', 'agent-1', toolExecution({ timestamp: 3000 }));
		emit('usage', 'agent-1', usageStats());
		emit('query-complete', 'agent-1', queryComplete({ sessionId: 'agent-1', source: 'auto' }));
		await vi.advanceTimersByTimeAsync(500);
		expect(wakaTimeManager.sendFileHeartbeats).toHaveBeenCalledTimes(2);

		setManagedProcess('terminal-1', { isTerminal: true });
		emit('tool-execution', 'terminal-1', toolExecution({ timestamp: 4000 }));
		emit('usage', 'terminal-1', usageStats());
		await vi.advanceTimersByTimeAsync(500);
		expect(wakaTimeManager.sendFileHeartbeats).toHaveBeenCalledTimes(2);
	});

	it('cleans up pending files, timers, and manager state on exit', async () => {
		vi.useFakeTimers();
		setupListener();
		setManagedProcess('agent-1');

		emit('tool-execution', 'agent-1', toolExecution({ timestamp: 1000 }));
		emit('usage', 'agent-1', usageStats());
		emit('exit', 'agent-1', 0);

		expect(wakaTimeManager.removeSession).toHaveBeenCalledWith('agent-1');

		await vi.advanceTimersByTimeAsync(500);
		expect(wakaTimeManager.sendFileHeartbeats).not.toHaveBeenCalled();

		emit('query-complete', 'agent-1', queryComplete({ sessionId: 'agent-1' }));
		expect(wakaTimeManager.sendHeartbeat).toHaveBeenCalledWith(
			'agent-1',
			'project',
			'/workspace/project',
			'user'
		);
		expect(wakaTimeManager.sendFileHeartbeats).not.toHaveBeenCalled();
	});
});
