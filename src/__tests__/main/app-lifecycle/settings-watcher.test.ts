import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { FSWatcher, WatchEventType } from 'fs';

const { mockExistsSync, mockMkdirSync, mockSafeSend, mockWatchers, mockWatch } = vi.hoisted(() => {
	const mockWatchers: Array<{
		callback: (eventType: WatchEventType, filename: string | null) => void;
		close: () => void;
		on: () => void;
	}> = [];
	const mockWatch = vi.fn(
		(
			_dirPath: string,
			callback: (eventType: WatchEventType, filename: string | null) => void
		): FSWatcher => {
			const watcher = { callback, close: vi.fn(), on: vi.fn() };
			mockWatchers.push(watcher);
			return watcher as unknown as FSWatcher;
		}
	);
	return {
		mockExistsSync: vi.fn(),
		mockMkdirSync: vi.fn(),
		mockSafeSend: vi.fn(),
		mockWatchers,
		mockWatch,
	};
});

vi.mock('fs', () => ({
	default: { existsSync: mockExistsSync, mkdirSync: mockMkdirSync, watch: mockWatch },
	existsSync: mockExistsSync,
	mkdirSync: mockMkdirSync,
	watch: mockWatch,
}));

vi.mock('../../../main/utils/logger', () => ({
	logger: { debug: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

vi.mock('../../../main/utils/safe-send', () => ({
	createSafeSend: vi.fn(() => mockSafeSend),
}));

import { createSettingsWatcher } from '../../../main/app-lifecycle/settings-watcher';

describe('createSettingsWatcher', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.useFakeTimers();
		mockWatchers.length = 0;
		mockExistsSync.mockReturnValue(true);
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it('debounces each watched settings file independently on the trailing edge', () => {
		const watcher = createSettingsWatcher({
			getBroadcastWindows: vi.fn(() => []),
			getSettingsPath: () => '/settings',
			getAgentConfigsPath: () => '/agents',
		});
		watcher.start();

		mockWatchers[0].callback('change', 'maestro-settings.json');
		vi.advanceTimersByTime(299);
		expect(mockSafeSend).not.toHaveBeenCalled();

		mockWatchers[1].callback('change', 'maestro-agent-configs.json');
		vi.advanceTimersByTime(1);
		expect(mockSafeSend).toHaveBeenCalledTimes(1);

		vi.advanceTimersByTime(298);
		expect(mockSafeSend).toHaveBeenCalledTimes(1);
		vi.advanceTimersByTime(1);
		expect(mockSafeSend).toHaveBeenCalledTimes(2);
	});

	it('cancels pending notifications when stopped', () => {
		const watcher = createSettingsWatcher({
			getBroadcastWindows: vi.fn(() => []),
			getSettingsPath: () => '/settings',
			getAgentConfigsPath: () => '/agents',
		});
		watcher.start();

		mockWatchers[0].callback('change', 'maestro-settings.json');
		watcher.stop();
		vi.advanceTimersByTime(300);

		expect(mockSafeSend).not.toHaveBeenCalled();
		for (const { close } of mockWatchers) {
			expect(close).toHaveBeenCalledOnce();
		}
	});
});
